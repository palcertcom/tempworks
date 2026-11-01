#!/usr/bin/env node
/**
 * SUPER USER guard regression check.
 *
 * Locks in the rule: a PlatformAdmin grant (SUPPORT/OPERATOR/SUPER)
 * may only attach to a user holding the `System Admin` role. Verifies
 * the guard exists on every grant path and the strand-a-SUPER vector
 * is closed. Static (no DB / no jest harness needed); fails CI if any
 * guard is removed.
 *
 * Exit 1 on any missing guard.
 */
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFileSync(resolve(ROOT, rel), 'utf8');

let problems = 0;
const fail = (m) => { problems++; console.log(`✗ ${m}`); };
const ok = (m) => console.log(`✓ ${m}`);

// ── 1. PlatformAdminService.grant() gates on System Admin target ─────────────
{
  const f = 'backend/src/saas/platform-admin/platform-admin.service.ts';
  const src = read(f);
  if (!/assertTargetIsSystemAdmin/.test(src)) {
    fail(`${f}: missing assertTargetIsSystemAdmin helper`);
  } else if (!/role\?\.name !== 'System Admin'/.test(src)) {
    fail(`${f}: assertTargetIsSystemAdmin doesn't compare role to 'System Admin'`);
  } else {
    // grant() must call it.
    const g = src.indexOf('async grant(');
    const slice = src.slice(g, g + 1500);
    if (!slice.includes('assertTargetIsSystemAdmin')) {
      fail(`${f}: grant() does not call assertTargetIsSystemAdmin`);
    } else {
      ok('platform-admin.service.ts grant() requires System Admin target');
    }
  }
}

// ── 2. UsersService.setPlatformAdminLevel gates non-NONE on System Admin ──────
{
  const f = 'backend/src/users/users.service.ts';
  const src = read(f);
  const m = src.indexOf('async setPlatformAdminLevel(');
  const slice = src.slice(m, m + 2500);
  if (!/level !== 'NONE' && target\.role\?\.name !== 'System Admin'/.test(slice)
      && !/TARGET_NOT_SYSTEM_ADMIN/.test(slice)) {
    fail(`${f}: setPlatformAdminLevel missing System-Admin target guard`);
  } else {
    ok('users.service.ts setPlatformAdminLevel requires System Admin target for non-NONE');
  }
}

// ── 3. update() blocks demoting a platform-admin off System Admin ────────────
{
  const f = 'backend/src/users/users.service.ts';
  const src = read(f);
  if (!/PLATFORM_ADMIN\.ROLE_CHANGE_BLOCKED/.test(src)) {
    fail(`${f}: update() missing ROLE_CHANGE_BLOCKED guard (strand-a-SUPER vector open)`);
  } else {
    ok('users.service.ts update() blocks role change away from System Admin while platform-admin row exists');
  }
}

// ── 4. Create/Update/Import DTOs do not expose platform-admin fields ─────────
const dtoFiles = [
  'backend/src/users/dto/create-user.dto.ts',
  'backend/src/users/dto/update-user.dto.ts',
];
for (const f of dtoFiles) {
  let src;
  try { src = read(f); } catch { continue; }
  if (/\b(platformAdmin|agencyIsSystem|isSystemAdmin)\b\s*[?:!]/.test(src)
      || /level\s*[?:]\s*['"]?(SUPER|OPERATOR|SUPPORT)/.test(src)) {
    fail(`${f}: exposes a platform-admin field on the DTO (spoof risk)`);
  } else {
    ok(`${f}: no platform-admin field exposed`);
  }
}

// ── 5. Frontend card gates grant options on target System Admin ──────────────
{
  const f = 'src/app/pages/users/EditUser.tsx';
  const src = read(f);
  if (!/targetIsSystemAdmin/.test(src)) {
    fail(`${f}: PlatformAdminAccessCard not gated on targetIsSystemAdmin`);
  } else if (!/disabled=\{grantBlocked\}/.test(src)) {
    fail(`${f}: SUPER/OPERATOR/SUPPORT options not disabled when target isn't System Admin`);
  } else {
    ok('EditUser.tsx gates platform-admin grant on target System Admin');
  }
}

if (problems > 0) {
  console.log(`\n${problems} SUPER USER guard issue(s) found.`);
  process.exit(1);
}
console.log('\nAll SUPER USER guard checks passed.');
