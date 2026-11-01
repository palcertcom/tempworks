#!/usr/bin/env node
/**
 * Phase 3 (#29) — Attendance calculation consistency regression.
 *
 *   1. NON_WORKING_STATUSES constant exported from attendance.service.
 *   2. normalizeAttendancePayload helper exported (single source of truth).
 *   3. upsertRecord calls normalizeAttendancePayload (not the legacy
 *      "trust dto.workingHours" path).
 *   4. updateRecord calls normalizeAttendancePayload.
 *   5. The legacy "Auto-calc total hours … unless the caller explicitly
 *      passed workingHours" comment / branch is gone (frontend value
 *      must never be trusted).
 *   6. Non-working statuses null the time columns AND set workingHours = 0
 *      (verified through the helper body).
 *   7. AttendanceSheet's handleSave no longer sends workingHours to the
 *      backend.
 *   8. AttendanceSheet still applies the standard-day defaults on PRESENT
 *      and clears time fields on leave statuses (UX rules).
 *
 * Exit 1 on any failure.
 */
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFileSync(resolve(ROOT, rel), 'utf8');

let problems = 0;
const fail = (m) => { problems++; console.log(`✗ ${m}`); };
const ok = (m) => console.log(`✓ ${m}`);
const must = (src, re, label) => (re.test(src) ? ok(label) : fail(label));
const mustNot = (src, re, label) => (re.test(src) ? fail(label) : ok(label));

const svc = read('backend/src/attendance/attendance.service.ts');

must(svc, /export const NON_WORKING_STATUSES/, 'backend: NON_WORKING_STATUSES exported');
must(svc, /export function isNonWorkingStatus/, 'backend: isNonWorkingStatus exported');
must(svc, /export function normalizeAttendancePayload/, 'backend: normalizeAttendancePayload exported');

// Helper body: non-working branch must null every time/interruption field
// AND zero workingHours.
must(svc,
  /isNonWorkingStatus\(status\)\)\s*\{\s*return\s*\{[\s\S]{0,400}checkIn:\s*null[\s\S]{0,400}interruptionIn:\s*null[\s\S]{0,200}workingHours:\s*0/,
  'backend: non-working branch nulls time fields and zeros workingHours',
);
must(svc,
  /Math\.max\(0,\s*hours\)/,
  'backend: working branch clamps workingHours to >= 0',
);

// Mutation paths both go through the normalizer.
must(svc,
  /async\s+upsertRecord[\s\S]{0,4000}normalizeAttendancePayload\(/,
  'backend: upsertRecord routes through normalizeAttendancePayload',
);
must(svc,
  /async\s+updateRecord[\s\S]{0,3500}normalizeAttendancePayload\(/,
  'backend: updateRecord routes through normalizeAttendancePayload',
);

// The legacy "trust dto.workingHours" pattern is gone from both paths.
mustNot(svc,
  /let\s+workingHours\s*=\s*dto\.workingHours/,
  'backend: no mutation path trusts dto.workingHours',
);

// Frontend: handleSave no longer sends workingHours.
const sheet = read('src/app/pages/attendance/AttendanceSheet.tsx');
const handleSave = sheet.split(/const\s+handleSave\s*=\s*async/)[1]?.split(/const\s+handleDelete/)[0] ?? '';
mustNot(handleSave,
  /workingHours:\s*editForm\.workingHours/,
  'frontend: handleSave does not forward workingHours to the API',
);

// Frontend UX rules: leave clears time fields, PRESENT restores defaults.
must(sheet,
  /LEAVE_STATUSES\.has\(value\)[\s\S]{0,400}updated\.checkIn\s*=\s*''/,
  'frontend: switching to leave clears the time fields',
);
must(sheet,
  /value === 'PRESENT'[\s\S]{0,400}updated\.checkIn\s*=\s*'08:00'[\s\S]{0,200}updated\.checkOut\s*=\s*'16:30'/,
  'frontend: switching to PRESENT restores 08:00–16:30 defaults',
);

console.log('');
if (problems > 0) {
  console.log(`${problems} check(s) failed.`);
  process.exit(1);
}
console.log('All attendance-calc checks passed.');
