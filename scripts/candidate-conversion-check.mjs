#!/usr/bin/env node
/**
 * Phase 3 (#26) — Candidate→Employee conversion regression check.
 *
 * Verifies the address-validation fix:
 *
 *   1. Shared helper `extractApplicantAddressForConversion` exists and
 *      is exported from `backend/src/applicants/applicants.service.ts`.
 *   2. Helper `missingAddressFields` exists.
 *   3. Bulk `CONVERT_TO_EMPLOYEE` path uses the shared helper (no inline
 *      duplicated extraction).
 *   4. The misleading "convert this one individually" error message is
 *      gone.
 *   5. `convertToEmployee()` merges the DTO with the extracted address
 *      and raises the structured `APPLICANT.CONVERT_MISSING_ADDRESS`
 *      error code when fields are still missing.
 *   6. The frontend CandidateProfile.tsx pre-populates `convertForm`
 *      from `applicantData.applicationData` on dialog open.
 *   7. The dialog renders a validation summary banner pointing at the
 *      missing required fields.
 *
 * Exit 1 on any failure.
 */
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFileSync(resolve(ROOT, rel), 'utf8');

const service = read('backend/src/applicants/applicants.service.ts');
const profile = read('src/app/pages/applicants/CandidateProfile.tsx');

let problems = 0;
const fail = (m) => { problems++; console.log(`✗ ${m}`); };
const ok = (m) => console.log(`✓ ${m}`);

const must = (src, re, label) => (re.test(src) ? ok(label) : fail(label));

// Backend
must(service,
  /export\s+function\s+extractApplicantAddressForConversion\s*\(/,
  'backend: extractApplicantAddressForConversion helper exported',
);
must(service,
  /export\s+function\s+missingAddressFields\s*\(/,
  'backend: missingAddressFields helper exported',
);
must(service,
  /BulkActionType\.CONVERT_TO_EMPLOYEE[\s\S]{0,1600}extractApplicantAddressForConversion\(/,
  'backend: bulk converter uses shared address helper',
);
must(service,
  /APPLICANT\.CONVERT_MISSING_ADDRESS/,
  'backend: individual converter raises APPLICANT.CONVERT_MISSING_ADDRESS',
);
if (/cannot convert in bulk; convert this one individually/.test(service)) {
  fail('backend: misleading "convert this one individually" message must be removed');
} else {
  ok('backend: misleading "convert individually" hint is gone');
}
must(service,
  /merged\s*=\s*\{[\s\S]{0,400}addressLine1:\s*\(dto\.addressLine1[\s\S]{0,80}\|\|\s*extracted\.addressLine1/,
  'backend: convertToEmployee merges DTO with extracted address (DTO wins)',
);
must(service,
  /addressLine1:\s*merged\.addressLine1[\s\S]{0,200}city:\s*merged\.city/,
  'backend: employee.create uses merged address fields',
);

// Frontend
must(profile,
  /useEffect\([\s\S]{0,200}showConvertDialog[\s\S]{0,400}applicationData/,
  'frontend: convert dialog prefills from applicationData on open',
);
must(profile,
  /missingAddressBanner/,
  'frontend: validation summary banner renders missing fields',
);
must(profile,
  /homeAddress[\s\S]{0,200}currentAddress/,
  'frontend: prefill respects homeAddress→currentAddress preference',
);

console.log('');
if (problems > 0) {
  console.log(`${problems} check(s) failed.`);
  process.exit(1);
}
console.log('All candidate-conversion checks passed.');
