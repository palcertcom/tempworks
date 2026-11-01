#!/usr/bin/env node
/**
 * Codemod: add @RequirePermission alongside @Roles where missing.
 *
 * The RolesGuard treats `@Roles + @RequirePermission` as OR, so this
 * is purely additive — every built-in role keeps its existing access
 * via the role half, and custom roles (Officer, etc.) finally get
 * through when they hold the matching seeded permission.
 *
 * Strategy:
 *   - For each *.controller.ts under backend/src:
 *     - Parse `@Controller('module')` to get the route segment.
 *     - For each handler that has `@Roles(...)` but NO `@RequirePermission`
 *       within the next 5 lines, infer the permission from the HTTP
 *       method decorator:
 *           @Get    → '<module>:read'
 *           @Post   → '<module>:create'
 *           @Patch  → '<module>:update'
 *           @Delete → '<module>:delete'
 *     - Insert `@RequirePermission('<module>:<action>')` on a new line
 *       right after the @Roles line, matching its indentation.
 *
 * Skips:
 *   - Endpoints already declaring @RequirePermission (idempotent).
 *   - Controllers whose route segment doesn't map to a seeded module
 *     (printed as a warning so a maintainer can hand-map them).
 *   - Endpoints with HTTP methods other than the four above
 *     (specialised actions like @All, sub-paths like /:id/approve
 *     where the auto-inferred CRUD action is wrong — these stay
 *     hand-curated).
 *
 * Output: rewrites files in place and prints a per-file summary.
 * Re-running is safe — idempotent.
 */
import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BACKEND_SRC = join(ROOT, 'backend/src');

// Mirrors `modules` in backend/prisma/seed.ts. A controller whose
// @Controller route segment isn't in this set gets skipped — its
// permission keys aren't auto-seeded so an arbitrary insertion would
// be a dead key the RolesGuard could never satisfy.
const SEEDED_MODULES = new Set([
  'dashboard', 'employees', 'applicants', 'applications', 'documents',
  'workflow', 'agencies', 'compliance', 'reports', 'notifications',
  'settings', 'users', 'roles', 'logs', 'vehicles', 'finance',
  'attendance', 'job-ads', 'recycle-bin',
]);

// Route-prefix → seeded module. Most controllers name themselves
// after the module, but a handful diverge (compliance-alerts →
// compliance, employee-work-history → employees, etc.). Add aliases
// here when the route doesn't equal the seeded module name.
const ROUTE_ALIASES = {
  'compliance-alerts': 'compliance',
  'employee-work-history': 'employees',
  'document-types': 'documents',
  'system-logs': 'logs',
  'recycle-bin': 'recycle-bin',
  'job-ads': 'job-ads',
  'company-profiles': 'settings',
  'workshops': 'vehicles',
  'maintenance': 'vehicles',
  'maintenance-records': 'vehicles',
  'maintenance-types': 'vehicles',
  'workflows': 'workflow',
};

const METHOD_TO_ACTION = {
  Get: 'read',
  Post: 'create',
  Patch: 'update',
  Delete: 'delete',
};

function walk(dir, files = []) {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    const st = statSync(p);
    if (st.isDirectory()) {
      if (entry === 'node_modules' || entry === 'dist') continue;
      walk(p, files);
    } else if (p.endsWith('.controller.ts')) {
      files.push(p);
    }
  }
  return files;
}

let totalRewritten = 0;
let totalSkipped = 0;
const warnings = [];

for (const file of walk(BACKEND_SRC)) {
  const original = readFileSync(file, 'utf8');
  const lines = original.split('\n');

  // Find the @Controller('xxx') route segment.
  let routeSegment = null;
  for (const line of lines) {
    const m = line.match(/@Controller\(\s*['"]([a-z0-9_-]+)['"]\s*\)/i);
    if (m) { routeSegment = m[1]; break; }
  }
  if (!routeSegment) continue;

  const moduleName = ROUTE_ALIASES[routeSegment] ?? routeSegment;
  if (!SEEDED_MODULES.has(moduleName)) {
    warnings.push(`${file.replace(ROOT + '/', '')}: route '${routeSegment}' maps to no seeded module — skipping`);
    continue;
  }

  // Ensure RequirePermission is imported. We add it if missing later.
  const hasImport = /\bRequirePermission\b/.test(original);
  let inserted = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const rolesMatch = line.match(/^(\s*)@Roles\(/);
    if (!rolesMatch) continue;

    // Already followed by @RequirePermission within 6 lines? Skip.
    let alreadyHas = false;
    for (let j = i + 1; j < Math.min(i + 7, lines.length); j++) {
      if (/@RequirePermission\(/.test(lines[j])) { alreadyHas = true; break; }
      if (/^\s+[a-zA-Z_]\w*\s*\(/.test(lines[j])) break;
    }
    if (alreadyHas) continue;

    // Walk UP from @Roles to find the HTTP method decorator on the
    // same handler. We stop when we hit a blank line or a closing
    // brace — handlers can have multiple decorators stacked, but
    // they don't span methods.
    let httpMethod = null;
    for (let j = i - 1; j >= Math.max(i - 12, 0); j--) {
      const up = lines[j];
      if (/^\s*$/.test(up) || /^\s*}/.test(up)) break;
      const mm = up.match(/^\s*@(Get|Post|Patch|Delete)\(/);
      if (mm) { httpMethod = mm[1]; break; }
    }
    if (!httpMethod) continue;

    const action = METHOD_TO_ACTION[httpMethod];
    const indent = rolesMatch[1];
    const newLine = `${indent}@RequirePermission('${moduleName}:${action}')`;
    lines.splice(i + 1, 0, newLine);
    inserted++;
    i++; // skip the line we just inserted
  }

  if (inserted === 0) {
    totalSkipped++;
    continue;
  }

  let next = lines.join('\n');

  // Add the import if it wasn't there yet. Place it on the same
  // line block as the existing `Roles` import so subsequent diffs
  // stay small.
  if (!hasImport) {
    const importRegex = /(import\s*\{\s*Roles\s*\}\s*from\s*['"]([^'"]+)['"]\s*;)/;
    const m = next.match(importRegex);
    if (m) {
      const before = m[1];
      const fromPath = m[2];
      // Same directory as the Roles import (typically
      // '../auth/decorators/roles.decorator') — swap to
      // require-permission.decorator.
      const reqPath = fromPath.replace(/roles\.decorator$/, 'require-permission.decorator');
      next = next.replace(
        before,
        `${before}\nimport { RequirePermission } from '${reqPath}';`,
      );
    } else {
      warnings.push(`${file.replace(ROOT + '/', '')}: inserted ${inserted} @RequirePermission but couldn't find the Roles import line to extend — please add the import manually`);
    }
  }

  writeFileSync(file, next);
  console.log(`✎ ${file.replace(ROOT + '/', '')}: +${inserted} @RequirePermission`);
  totalRewritten++;
}

console.log(`\nRewrote ${totalRewritten} file(s), left ${totalSkipped} untouched.`);
if (warnings.length) {
  console.log('\nWarnings:');
  for (const w of warnings) console.log(`  ${w}`);
}
