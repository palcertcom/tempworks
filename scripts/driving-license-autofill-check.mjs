#!/usr/bin/env node
/**
 * Phase 3 (#19) — Driving License license-number auto-fill regression.
 *
 * The auto-fill helper writes to Employee.licenseNumber whenever a
 * Driving License document is created or its metadata edited, but
 * only when the existing field is empty. This script statically
 * verifies every safety guard the spec requires is wired in
 * `backend/src/documents/documents.service.ts`:
 *
 *   1. Helper `syncLicenseNumberFromDrivingLicenseDocument` exists.
 *   2. Driving-License detection is by DocumentType.name (case-insensitive),
 *      not display text.
 *   3. Owner is only EMPLOYEE (Applicant skipped — no flat column).
 *   4. Empty documentNumber short-circuits.
 *   5. Employee lookup is tenant-gated when the document carries a tenant.
 *   6. Update is conditional on `licenseNumber` being empty/null —
 *      no overwrite of user-entered values.
 *   7. `create()` calls the helper after audit log.
 *   8. `update()` calls the helper only when documentNumber or
 *      documentTypeId is touched.
 *
 * Exit 1 on any failure.
 */
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SERVICE = resolve(ROOT, 'backend/src/documents/documents.service.ts');
const src = readFileSync(SERVICE, 'utf8');

let problems = 0;
const fail = (m) => { problems++; console.log(`✗ ${m}`); };
const ok = (m) => console.log(`✓ ${m}`);

const must = (re, label) => (re.test(src) ? ok(label) : fail(label));

must(
  /async\s+syncLicenseNumberFromDrivingLicenseDocument\s*\(/,
  'helper syncLicenseNumberFromDrivingLicenseDocument is defined',
);
must(
  /documentType\?\.name[\s\S]{0,40}\.toLowerCase\(\)[\s\S]{0,160}!==\s*['"]driving license['"]/,
  'driving-license detection compares DocumentType.name case-insensitively',
);
must(
  /doc\.entityType\s*!==\s*['"]EMPLOYEE['"]/,
  'auto-fill is gated to EMPLOYEE entity type',
);
must(
  /documentNumber[\s\S]{0,40}\.trim\(\)[\s\S]{0,80}!number/,
  'empty documentNumber short-circuits before any write',
);
must(
  /doc\.tenantId\s*\?\s*\{\s*tenantId:\s*doc\.tenantId\s*\}\s*:\s*\{\s*\}/,
  'employee lookup applies tenant predicate when the document carries one',
);
must(
  /licenseNumber\s*\?\?\s*['"]{2}\s*\)\.trim\(\)[\s\S]{0,80}if\s*\(\s*existing\s*\)/,
  'existing licenseNumber is checked — no overwrite when non-empty',
);
must(
  /employee\.update\(\{\s*where:\s*\{\s*id:\s*employee\.id\s*\}[\s\S]{0,80}licenseNumber:\s*number/,
  'update writes the document number to Employee.licenseNumber',
);
must(
  /AUTO_FILL_LICENSE_NUMBER/,
  'audit log uses dedicated AUTO_FILL_LICENSE_NUMBER action',
);

// Wiring checks
must(
  /UPLOAD['"][\s\S]{0,400}syncLicenseNumberFromDrivingLicenseDocument\(\s*doc\.id/,
  'create() calls the helper after the UPLOAD audit log',
);
must(
  /['"]documentNumber['"]\s+in\s+updateData[\s\S]{0,200}syncLicenseNumberFromDrivingLicenseDocument\(\s*id/,
  'update() calls the helper conditionally on documentNumber/documentTypeId',
);

console.log('');
if (problems > 0) {
  console.log(`${problems} check(s) failed.`);
  process.exit(1);
}
console.log('All driving-license auto-fill checks passed.');
