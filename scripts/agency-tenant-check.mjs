#!/usr/bin/env node
/**
 * Phase 3 (#27) — Agency tenant ownership + dropdown filtering regression.
 *
 *  1. Backend: Agency update path uses applySuperTenantReassignment.
 *  2. Backend: CreateAgencyDto whitelists tenantId.
 *  3. Frontend: EditAgency renders SuperUserTenantField and sends
 *     tenantId only when SUPER.
 *  4. Frontend: every agency dropdown that scopes by tenant uses the
 *     stricter filter `isSuperUser() ? (!!tenantId && a.tenantId === tenantId) : true`
 *     so SUPER without a selected tenant sees NO agencies.
 *  5. Audit script present at backend/scripts/saas/agency-tenant-audit.ts.
 *
 * Exit 1 on any failure.
 */
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFileSync(resolve(ROOT, rel), 'utf8');

let problems = 0;
const fail = (m) => { problems++; console.log(`✗ ${m}`); };
const ok = (m) => console.log(`✓ ${m}`);
const must = (src, re, label) => (re.test(src) ? ok(label) : fail(label));

// Backend
const svc = read('backend/src/agencies/agencies.service.ts');
must(svc, /applySuperTenantReassignment\(this\.legacyPrisma,\s*updatedById,\s*data\)/,
  'backend: agencies.update calls applySuperTenantReassignment');

const dto = read('backend/src/agencies/dto/create-agency.dto.ts');
must(dto, /@IsOptional\(\)\s*@IsString\(\)\s*tenantId\?:/,
  'backend: CreateAgencyDto whitelists optional tenantId');

// Frontend — EditAgency
const editAgency = read('src/app/pages/agencies/EditAgency.tsx');
must(editAgency, /import\s*\{\s*SuperUserTenantField\s*\}\s*from\s*'\.\.\/\.\.\/components\/ui\/super-user-tenant-field'/,
  'frontend: EditAgency imports SuperUserTenantField');
must(editAgency, /<SuperUserTenantField\s+value=\{tenantId\}/,
  'frontend: EditAgency renders SuperUserTenantField');
must(editAgency, /viewerIsSuperPa\s*&&\s*tenantId\)\s*payload\.tenantId\s*=\s*tenantId/,
  'frontend: EditAgency only sends tenantId on submit when viewer is SUPER');

// Frontend — every consumer of the agency dropdown filter
const dropdownConsumers = [
  'src/app/pages/users/AddUser.tsx',
  'src/app/pages/employees/AddEmployee.tsx',
  'src/app/pages/applicants/EditApplicant.tsx',
  'src/app/pages/applicants/AddApplicant.tsx',
  'src/app/pages/applicants/EditCandidate.tsx',
];
const strict = /isSuperUser\(\) \? \(!!tenantId && a\.tenantId === tenantId\) : true/;
const lax = /!isSuperUser\(\) \|\| !tenantId \|\| a\.tenantId === tenantId/;
for (const rel of dropdownConsumers) {
  const src = read(rel);
  if (lax.test(src)) {
    fail(`frontend: ${rel} still uses the lax dropdown filter (SUPER without tenant would see all agencies)`);
  } else if (!strict.test(src)) {
    fail(`frontend: ${rel} agency dropdown filter not found`);
  } else {
    ok(`frontend: ${rel} uses strict SUPER-must-pick-tenant filter`);
  }
}

// Audit script
const auditPath = resolve(ROOT, 'backend/scripts/saas/agency-tenant-audit.ts');
if (!existsSync(auditPath)) {
  fail('audit: backend/scripts/saas/agency-tenant-audit.ts missing');
} else {
  const audit = readFileSync(auditPath, 'utf8');
  must(audit, /AGENCY_TENANT_AUDIT_REMEDIATE/, 'audit: gated by AGENCY_TENANT_AUDIT_REMEDIATE');
  must(audit, /AGENCY_TENANT_AUDIT_APPLY/,     'audit: dry-run by default unless AGENCY_TENANT_AUDIT_APPLY=true');
  must(audit, /isStagingClassification\(env\.classification\)/, 'audit: refuses non-staging without FORCE');
  must(audit, /"tenantId"\s*=\s*\$1[\s\S]{0,80}"tenantId" IS NULL/,
    'audit: defensive UPDATE only fires when current tenantId IS NULL');
  must(audit, /observedTenants\.length === 1/,
    'audit: only proposes a tenant when exactly one inferred from children');
}

console.log('');
if (problems > 0) {
  console.log(`${problems} check(s) failed.`);
  process.exit(1);
}
console.log('All agency-tenant checks passed.');
