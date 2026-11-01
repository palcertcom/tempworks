#!/usr/bin/env node
/**
 * SUPER USER tenant filter regression check (Applicants / Candidates /
 * Employees).
 *
 * Locks in:
 *  1. The backend helper gates tenant override on agencyIsSystem (platform
 *     admin) and is used by the applicants + employees list services.
 *  2. The applicants DTO and employees controller accept tenantId.
 *  3. The frontend hook + component exist and the 3 list pages consume them.
 *  4. The tenantFilter i18n keys exist in every locale.
 *
 * Static (no DB / no build). Exit 1 on any failure.
 */
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFileSync(resolve(ROOT, rel), 'utf8');
let problems = 0;
const fail = (m) => { problems++; console.log(`✗ ${m}`); };
const ok = (m) => console.log(`✓ ${m}`);

// 1. Backend helper enforces the platform-admin gate.
{
  const f = 'backend/src/saas/prisma/super-user-tenant-filter.ts';
  const src = read(f);
  if (!/agencyIsSystem !== true/.test(src) || !/buildSuperUserTenantWhere/.test(src)) {
    fail(`${f}: helper missing or not gated on agencyIsSystem`);
  } else {
    ok('super-user-tenant-filter: gates tenant override on agencyIsSystem');
  }
}

// 2. Services use the helper.
for (const f of [
  'backend/src/applicants/applicants.service.ts',
  'backend/src/employees/employees.service.ts',
]) {
  const src = read(f);
  if (!/buildSuperUserTenantWhere/.test(src) || !/assertRequestedTenantExists/.test(src)) {
    fail(`${f}: list query does not apply the SUPER USER tenant filter`);
  } else {
    ok(`${f.split('/').pop()}: applies SUPER USER tenant filter`);
  }
}

// 3. tenantId accepted on the inbound contracts.
{
  const dto = read('backend/src/applicants/dto/filter-applicants.dto.ts');
  if (!/tenantId\?:/.test(dto)) fail('filter-applicants.dto.ts: missing tenantId field (whitelist would strip it)');
  else ok('filter-applicants.dto.ts: accepts tenantId');

  const ctrl = read('backend/src/employees/employees.controller.ts');
  if (!/tenantId\?:\s*string/.test(ctrl)) fail('employees.controller.ts: findAll query type missing tenantId');
  else ok('employees.controller.ts: findAll accepts tenantId');
}

// 4. Frontend hook + component + page wiring.
for (const f of ['src/app/hooks/useSuperUserTenantFilter.ts', 'src/app/components/ui/tenant-filter-select.tsx']) {
  read(f); // throws if missing
}
{
  const hook = read('src/app/hooks/useSuperUserTenantFilter.ts');
  if (!/platformAdmin\?\.\level === 'SUPER'/.test(hook) && !/platformAdmin\?\.level === 'SUPER'/.test(hook)) {
    fail('useSuperUserTenantFilter: SUPER check not based on platformAdmin.level');
  } else {
    ok('useSuperUserTenantFilter: gates on platformAdmin.level === SUPER');
  }
}
for (const f of [
  'src/app/pages/applicants/ApplicantsList.tsx',
  'src/app/pages/applicants/CandidatesList.tsx',
  'src/app/pages/employees/EmployeesList.tsx',
]) {
  const src = read(f);
  if (!/useSuperUserTenantFilter\(\)/.test(src) || !/TenantFilterSelect/.test(src) || !/applyToParams/.test(src)) {
    fail(`${f}: not wired to the tenant filter hook/component`);
  } else {
    ok(`${f.split('/').pop()}: wired to SUPER USER tenant filter`);
  }
}

// 5. Locale keys.
for (const loc of ['en', 'ar', 'de', 'ru', 'sk', 'tr']) {
  const j = JSON.parse(read(`src/i18n/locales/${loc}/pages.json`));
  const tf = j?.tenantFilter ?? {};
  const missing = ['tenant', 'allTenants', 'currentTenant', 'filterByTenant', 'unableToLoad'].filter((k) => typeof tf[k] !== 'string');
  if (missing.length) fail(`locale ${loc}: tenantFilter missing ${missing.join(', ')}`);
  else ok(`locale ${loc}: tenantFilter keys present`);
}

if (problems > 0) { console.log(`\n${problems} tenant-filter issue(s) found.`); process.exit(1); }
console.log('\nAll tenant-filter checks passed.');
