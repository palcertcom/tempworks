#!/usr/bin/env node
/**
 * Phase 1 regression check.
 *
 * Pins the small, focused fixes from the Phase 1 batch so they don't
 * regress in later passes:
 *   #2  default Check Out is 16:30
 *   #3  attendance time inputs force 24h via lang="en-GB"
 *   #6  topbar Settings gear links to /dashboard/settings
 *   #13 list actions order is View → Edit → WhatsApp → Delete
 *   #14 EmployeeProfile renders a Tenant card for SUPER
 *   #16 EmployeesList has the WhatsAppButton
 *   #18 EmployeeProfile gates the Attendance tab on can('attendance','read')
 *   #20 LogsDashboard renders dates in Europe/Bratislava with weekday
 *   #21 LogsDashboard prints the CET note
 *   #22 Agencies backend default sort is createdAt desc
 *   #28 DocumentsCompliance wraps long values (no `truncate`)
 *   #30 selecting PRESENT in Edit Attendance resets defaults
 *   #38 Applicants/Candidates/Employees lists expose a birthDate column
 */
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFileSync(resolve(ROOT, rel), 'utf8');
let problems = 0;
const fail = (m) => { problems++; console.log(`✗ ${m}`); };
const ok = (m) => console.log(`✓ ${m}`);

// #2 + #3 + #30 — AttendanceSheet defaults / 24h / PRESENT reset.
{
  const src = read('src/app/pages/attendance/AttendanceSheet.tsx');
  if (!/useState\('16:30'\)/.test(src)) fail('AttendanceSheet: default checkOut should be 16:30 (#2)');
  else ok('AttendanceSheet: default checkOut is 16:30');
  if (!/type="time" lang="en-GB"/.test(src)) fail('AttendanceSheet: time inputs missing lang="en-GB" (#3)');
  else ok('AttendanceSheet: time inputs force 24h via lang="en-GB"');
  if (!/field === 'status' && value === 'PRESENT'/.test(src) || !/updated\.checkOut = '16:30'/.test(src)) {
    fail('AttendanceSheet: selecting PRESENT does not reset defaults (#30)');
  } else {
    ok('AttendanceSheet: PRESENT resets the day to standard defaults');
  }
}

// #6 — Topbar gear icon wired.
{
  const src = read('src/app/components/layout/Topbar.tsx');
  if (!/<Link to="\/dashboard\/settings"[^>]*>\s*<Settings/.test(src)) {
    fail('Topbar: Settings gear is not linked to /dashboard/settings (#6)');
  } else {
    ok('Topbar: Settings gear links to /dashboard/settings');
  }
}

// #13 — list action order View → Edit → WhatsApp → Delete (within the
// per-row Actions cell only — skip bulk-action toolbars that also have Trash2).
for (const f of [
  'src/app/pages/applicants/ApplicantsList.tsx',
  'src/app/pages/applicants/CandidatesList.tsx',
  'src/app/pages/employees/EmployeesList.tsx',
]) {
  const src = read(f);
  const anchor = src.indexOf("View → Edit → WhatsApp → Delete");
  if (anchor === -1) { fail(`${f}: row actions block missing the order comment (#13)`); continue; }
  const slice = src.slice(anchor, anchor + 1500);
  const idxView  = slice.indexOf('<Eye ');
  const idxEdit  = slice.indexOf('<Edit ');
  const idxWhats = slice.indexOf('<WhatsAppButton');
  const idxTrash = slice.indexOf('<Trash2');
  if (idxView === -1 || idxEdit === -1 || idxWhats === -1 || idxTrash === -1) {
    fail(`${f}: one of View/Edit/WhatsApp/Delete actions is missing (#13/#16)`);
  } else if (!(idxView < idxEdit && idxEdit < idxWhats && idxWhats < idxTrash)) {
    fail(`${f}: actions are not in View → Edit → WhatsApp → Delete order (#13)`);
  } else {
    ok(`${f.split('/').pop()}: action order is View → Edit → WhatsApp → Delete`);
  }
}

// #14 — EmployeeProfile Tenant card for SUPER.
{
  const src = read('src/app/pages/employees/EmployeeProfile.tsx');
  if (!/isPlatformSuper/.test(src) || !/tenantFilter\.tenant/.test(src)) {
    fail('EmployeeProfile: missing SUPER-only Tenant card (#14)');
  } else {
    ok('EmployeeProfile: SUPER-only Tenant card present');
  }
  // #18 — Attendance tab gated on can('attendance','read').
  if (!/can\('attendance', ?'read'\) && \(\s*<TabsTrigger/.test(src) || !/can\('attendance', ?'read'\) && \(\s*<TabsContent value="attendance"/.test(src)) {
    fail('EmployeeProfile: Attendance tab is not gated on attendance:read (#18)');
  } else {
    ok('EmployeeProfile: Attendance tab gated on attendance:read');
  }
}

// #20 + #21 — Logs CET rendering + footer note.
{
  const src = read('src/app/pages/logs/LogsDashboard.tsx');
  if (!/timeZone: 'Europe\/Bratislava'/.test(src) || !/weekday: 'short'/.test(src)) {
    fail('LogsDashboard: dates not rendered in CET with weekday (#20)');
  } else {
    ok('LogsDashboard: dates render in CET with weekday');
  }
  if (!/logs\.dashboard\.cetNote/.test(src)) fail('LogsDashboard: CET note missing (#21)');
  else ok('LogsDashboard: CET note rendered');
}

// #22 — agencies backend default sort.
{
  const src = read('backend/src/agencies/agencies.service.ts');
  if (!/sortBy = 'createdAt', sortOrder = 'desc'/.test(src)) {
    fail('agencies.service.findAll: default sort should be createdAt desc (#22)');
  } else {
    ok('agencies.service.findAll: default sort is createdAt desc');
  }
}

// #28 — DocumentsCompliance long values wrap.
{
  const src = read('src/app/pages/documents/DocumentsCompliance.tsx');
  if (!/break-words whitespace-normal/.test(src)) {
    fail('DocumentsCompliance: long-value cells still use `truncate` (#28)');
  } else {
    ok('DocumentsCompliance: long-value cells wrap');
  }
}

// #38 — birthDate column present in the three lists.
for (const f of [
  'src/app/pages/applicants/ApplicantsList.tsx',
  'src/app/pages/applicants/CandidatesList.tsx',
  'src/app/pages/employees/EmployeesList.tsx',
]) {
  const src = read(f);
  if (!/'birthDate'/.test(src) || !/birthDate: false/.test(src)) {
    fail(`${f}: birthDate column not added hidden-by-default (#38)`);
  } else {
    ok(`${f.split('/').pop()}: birthDate column present (hidden by default)`);
  }
}

if (problems > 0) { console.log(`\n${problems} Phase-1 issue(s) found.`); process.exit(1); }
console.log('\nAll Phase 1 checks passed.');
