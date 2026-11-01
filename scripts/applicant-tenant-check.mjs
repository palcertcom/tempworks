#!/usr/bin/env node
/**
 * Job-Ad → Applicant tenant ownership regression check.
 *
 * Locks in the rule: an applicant created from a Job Ad inherits the
 * Job Ad's tenant, and the request body can never decide tenant.
 *
 * Verifies:
 *  1. publicSubmit strips a client-sent tenantId and resolves tenant
 *     from the Job Ad (resolveJobAdForApplication) when jobAdId is set.
 *  2. The authenticated create() strips client tenantId and enforces the
 *     Job Ad tenant when a jobAdId is supplied.
 *  3. convertToEmployee preserves the applicant's tenantId.
 *  4. The public application form does NOT send tenantId/agencyId.
 *  5. The audit script exists and is dry-run gated.
 *
 * Static (no DB). Exit 1 on any failure.
 */
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFileSync(resolve(ROOT, rel), 'utf8');
let problems = 0;
const fail = (m) => { problems++; console.log(`✗ ${m}`); };
const ok = (m) => console.log(`✓ ${m}`);

const svc = read('backend/src/applicants/applicants.service.ts');

// 1. Helper + publicSubmit.
if (!/resolveJobAdForApplication\s*\(/.test(svc)) {
  fail('applicants.service: missing resolveJobAdForApplication helper');
} else {
  ok('applicants.service: resolveJobAdForApplication helper present');
}
{
  const i = svc.indexOf('async publicSubmit(');
  const slice = i === -1 ? '' : svc.slice(i, i + 5000);
  if (!/tenantId:\s*_ignoredTenantId/.test(slice)) fail('publicSubmit: does not strip client-sent tenantId');
  else if (!/resolveJobAdForApplication\(\s*coreData\.jobAdId[\s\S]*?requirePublished:\s*true/.test(slice)) fail('publicSubmit: does not resolve a PUBLISHED Job Ad for tenant');
  else ok('publicSubmit: strips body tenantId + derives tenant from published Job Ad');
}

// 2. Authenticated create.
{
  const i = svc.indexOf('async create(');
  const slice = i === -1 ? '' : svc.slice(i, i + 5000);
  if (!/delete \(dto as any\)\.tenantId/.test(slice)) fail('create(): does not strip client-sent tenantId');
  else if (!/JOB_AD_TENANT_MISMATCH/.test(slice)) fail('create(): missing cross-tenant Job Ad guard');
  else ok('create(): strips body tenantId + enforces Job Ad tenant');
}

// 3. Conversion preserves tenant.
if (/\(applicant as any\)\.tenantId \? \{ tenantId: \(applicant as any\)\.tenantId \}/.test(svc)) {
  ok('convertToEmployee: preserves applicant tenantId');
} else {
  fail('convertToEmployee: does not preserve the applicant tenantId on the new Employee');
}

// 4. Public form sends no tenant/agency.
{
  const form = read('src/app/pages/public/PublicEmployeeApplication.tsx');
  if (/\btenantId\b/.test(form) || /\bagencyId\b/.test(form)) {
    fail('PublicEmployeeApplication.tsx: must not reference tenantId/agencyId in the public form');
  } else {
    ok('PublicEmployeeApplication.tsx: sends no tenantId/agencyId');
  }
}

// 5. Audit script present + gated.
{
  const a = read('backend/scripts/saas/applicant-jobad-tenant-audit.ts');
  if (!/APPLICANT_TENANT_AUDIT_APPLY/.test(a) || !/isStagingClassification/.test(a)) {
    fail('applicant-jobad-tenant-audit.ts: missing dry-run/staging gating');
  } else {
    ok('applicant-jobad-tenant-audit.ts: dry-run + staging-gated');
  }
}

// 6. SUPER-only tenant reassignment on edit.
{
  const helper = read('backend/src/saas/platform-admin/super-tenant-edit.ts');
  if (!/isSuperPlatformAdmin/.test(helper) || !/level === 'SUPER'/.test(helper) || !/applySuperTenantReassignment/.test(helper)) {
    fail('super-tenant-edit.ts: missing SUPER gate / reassignment helper');
  } else {
    ok('super-tenant-edit.ts: SUPER-gated tenant reassignment helper present');
  }
  if (!/agency\.tenantId !== tenantId/.test(helper) || !/updateData\.agencyId = null/.test(helper)) {
    fail('super-tenant-edit.ts: does not drop a foreign agency on tenant change');
  } else {
    ok('super-tenant-edit.ts: drops foreign agency when tenant changes');
  }
  if (!/applySuperTenantReassignment/.test(svc)) fail('applicants.service.update: not wired to SUPER tenant reassignment');
  else ok('applicants.service.update: SUPER tenant reassignment wired');
  const emp = read('backend/src/employees/employees.service.ts');
  if (!/applySuperTenantReassignment/.test(emp)) fail('employees.service.update: not wired to SUPER tenant reassignment');
  else ok('employees.service.update: SUPER tenant reassignment wired');
}

// 7. Frontend edit field gated on SUPER + wired into the 3 edit forms.
{
  const field = read('src/app/components/ui/super-user-tenant-field.tsx');
  if (!/platformAdmin\?\.level === 'SUPER'/.test(field)) fail('super-user-tenant-field.tsx: not gated on platformAdmin.level === SUPER');
  else ok('super-user-tenant-field.tsx: gated on SUPER');
  for (const f of [
    'src/app/pages/applicants/EditApplicant.tsx',
    'src/app/pages/applicants/EditCandidate.tsx',
    'src/app/pages/employees/EditEmployee.tsx',
  ]) {
    const src = read(f);
    if (!/SuperUserTenantField/.test(src) || !/isSuperUser\(\)/.test(src)) fail(`${f.split('/').pop()}: missing SUPER tenant edit field`);
    else ok(`${f.split('/').pop()}: SUPER tenant edit field wired`);
  }
}

if (problems > 0) { console.log(`\n${problems} applicant-tenant issue(s) found.`); process.exit(1); }
console.log('\nAll applicant-tenant checks passed.');
