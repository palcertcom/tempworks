#!/usr/bin/env node
/**
 * RBAC consistency check.
 *
 * Verifies that every permission string referenced in the frontend
 * (Sidebar permission fields, usePermissions canView/canEdit/...) and
 * backend (@RequirePermission decorators) is present in the canonical
 * seed at backend/prisma/seed.ts. Catches:
 *   • dead keys — referenced in code but never seeded (guaranteed 403)
 *   • frontend/backend mismatch on the Finance flow specifically
 *
 * Exits with code 1 on any inconsistency so CI can block.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function walk(dir, exts, files = []) {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    const st = statSync(p);
    if (st.isDirectory()) {
      if (entry === 'node_modules' || entry === 'dist' || entry === '.git') continue;
      walk(p, exts, files);
    } else if (exts.some((e) => p.endsWith(e))) {
      files.push(p);
    }
  }
  return files;
}

// ── 1. Canonical seeded permissions ──────────────────────────────────────────
const seedSrc = readFileSync(join(ROOT, 'backend/prisma/seed.ts'), 'utf8');
const seeded = new Set();
// Generated CRUD keys: `${mod}:${action}` for every module × action.
const modMatch = seedSrc.match(/const modules = \[([^\]]+)\]/);
const actMatch = seedSrc.match(/const actions = \[([^\]]+)\]/);
if (modMatch && actMatch) {
  const modules = [...modMatch[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
  const actions = [...actMatch[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
  for (const m of modules) for (const a of actions) seeded.add(`${m}:${a}`);
}
// Special permissions declared explicitly.
for (const m of seedSrc.matchAll(/name:\s*'([a-z_-]+:[a-z_-]+)'/gi)) seeded.add(m[1]);

// ── 2. Backend @RequirePermission strings ────────────────────────────────────
const backendFiles = walk(join(ROOT, 'backend/src'), ['.ts']);
const backendRefs = new Map(); // perm → [file:line]
for (const f of backendFiles) {
  const src = readFileSync(f, 'utf8');
  const lines = src.split('\n');
  lines.forEach((line, i) => {
    const m = line.match(/@RequirePermission\(\s*['"]([^'"]+)['"]\s*\)/);
    if (m) {
      if (!backendRefs.has(m[1])) backendRefs.set(m[1], []);
      backendRefs.get(m[1]).push(`${f.replace(ROOT + '/', '')}:${i + 1}`);
    }
  });
}

// ── 3. Frontend Sidebar permission fields + usePermissions calls ─────────────
const frontendFiles = walk(join(ROOT, 'src'), ['.ts', '.tsx']);
const frontendRefs = new Map();
function addRef(perm, where) {
  if (!frontendRefs.has(perm)) frontendRefs.set(perm, []);
  frontendRefs.get(perm).push(where);
}
for (const f of frontendFiles) {
  const src = readFileSync(f, 'utf8');
  const lines = src.split('\n');
  lines.forEach((line, i) => {
    const where = `${f.replace(ROOT + '/', '')}:${i + 1}`;
    // Sidebar `permission: 'module:action'`
    for (const m of line.matchAll(/permission:\s*['"]([a-z_-]+:[a-z_-]+)['"]/gi)) {
      addRef(m[1], where);
    }
    // canView('mod') / canCreate('mod') / canEdit('mod') / canDelete('mod')
    for (const m of line.matchAll(/\b(canView|canCreate|canEdit|canDelete)\(\s*['"]([a-z_-]+)['"]\s*\)/g)) {
      const action = { canView: 'read', canCreate: 'create', canEdit: 'update', canDelete: 'delete' }[m[1]];
      addRef(`${m[2]}:${action}`, where);
    }
    // can('mod', 'action')
    for (const m of line.matchAll(/\bcan\(\s*['"]([a-z_-]+)['"]\s*,\s*['"]([a-z_-]+)['"]\s*\)/g)) {
      addRef(`${m[1]}:${m[2]}`, where);
    }
  });
}

// ── 4. Report ────────────────────────────────────────────────────────────────
let problems = 0;

function check(label, refs) {
  const dead = [];
  for (const [perm, locs] of refs.entries()) {
    if (!seeded.has(perm)) dead.push({ perm, locs });
  }
  if (dead.length === 0) {
    console.log(`✓ ${label}: all ${refs.size} permission key(s) are seeded.`);
  } else {
    problems += dead.length;
    console.log(`✗ ${label}: ${dead.length} key(s) referenced but NOT in seed.ts:`);
    for (const { perm, locs } of dead) {
      console.log(`    ${perm}`);
      for (const l of locs.slice(0, 3)) console.log(`        ${l}`);
      if (locs.length > 3) console.log(`        … (${locs.length - 3} more)`);
    }
  }
}

console.log(`Seeded permission keys: ${seeded.size}`);
check('Backend @RequirePermission', backendRefs);
check('Frontend permission checks', frontendRefs);

// ── 5. Finance flow consistency ──────────────────────────────────────────────
// The Officer-can't-open-Finance bug came from FinanceDashboard
// checking role names instead of the seeded `finance:read` key. Keep
// the page guard, sidebar, and backend list endpoint aligned on
// `finance:read`. If any drifts, fail the check.
const FINANCE_KEY = 'finance:read';
const financeBackendHits = backendRefs.get(FINANCE_KEY) ?? [];
const financeFrontendHits = frontendRefs.get(FINANCE_KEY) ?? [];

if (financeBackendHits.length === 0) {
  problems++;
  console.log(`✗ Finance flow: no backend endpoint declares @RequirePermission('${FINANCE_KEY}')`);
} else {
  console.log(`✓ Finance flow: ${financeBackendHits.length} backend endpoint(s) require '${FINANCE_KEY}'`);
}
if (financeFrontendHits.length === 0) {
  problems++;
  console.log(`✗ Finance flow: no frontend code checks '${FINANCE_KEY}'`);
} else {
  console.log(`✓ Finance flow: ${financeFrontendHits.length} frontend reference(s) check '${FINANCE_KEY}'`);
}

// ── 6. Frontend should not hardcode role names for finance gating ────────────
// FinanceDashboard used to check `currentUser?.role === 'Finance'`
// directly; if that pattern reappears in the finance page or the
// employee/applicant/candidate profiles, flag it.
const ROLE_GATE_FILES = [
  'src/app/pages/finance/FinanceDashboard.tsx',
  'src/app/pages/employees/EmployeeProfile.tsx',
  'src/app/pages/applicants/ApplicantProfile.tsx',
  'src/app/pages/applicants/CandidateProfile.tsx',
];
for (const rel of ROLE_GATE_FILES) {
  const src = readFileSync(join(ROOT, rel), 'utf8');
  // Match role-name string compared to 'Finance' (the symptom).
  if (/currentUser\??\.\??role\s*===\s*['"]Finance['"]/.test(src)) {
    problems++;
    console.log(`✗ ${rel} still hardcodes role === 'Finance' for finance gating — must use can('finance', ...) instead`);
  }
}

// ── 7. Advisory: controllers gating on @Roles without @RequirePermission ─────
// These endpoints reject any custom role (e.g. "Officer") even when the
// user holds the matching seeded permission — the same bug that hid
// applicants from Officer accounts. Reported as a warning so the team
// can see the inventory without breaking CI on every commit.
const rolesOnly = [];
for (const f of backendFiles) {
  if (!f.endsWith('.controller.ts')) continue;
  const lines = readFileSync(f, 'utf8').split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (!/@Roles\(/.test(lines[i])) continue;
    // Look ahead a few lines for @RequirePermission attached to the same
    // method. Stop at the next handler signature.
    let hasPerm = false;
    for (let j = i + 1; j < Math.min(i + 6, lines.length); j++) {
      if (/@RequirePermission\(/.test(lines[j])) { hasPerm = true; break; }
      if (/^\s+[a-zA-Z_]\w*\s*\(/.test(lines[j])) break;
    }
    if (!hasPerm) rolesOnly.push(`${f.replace(ROOT + '/', '')}:${i + 1}`);
  }
}
if (rolesOnly.length > 0) {
  console.log(`\nℹ ${rolesOnly.length} endpoint(s) still gate on @Roles only — custom roles cannot reach them even with the matching permission. Add @RequirePermission alongside:`);
  for (const loc of rolesOnly.slice(0, 20)) console.log(`    ${loc}`);
  if (rolesOnly.length > 20) console.log(`    … (${rolesOnly.length - 20} more)`);
}

if (problems > 0) {
  console.log(`\n${problems} RBAC issue(s) found.`);
  process.exit(1);
}
console.log('\nAll RBAC checks passed.');
