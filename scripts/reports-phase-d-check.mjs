#!/usr/bin/env node
/**
 * Phase 3 Reports Hardening — Phase D (business-ID columns) regression.
 *
 * Types / source definitions:
 *   1. SourceDef.FieldDef carries `hideByDefault?: boolean` (tenant-safe types).
 *   2. SourceDef carries `defaultColumns?: ReadonlyArray<string>`  (tenant-safe types).
 *   3. Legacy reports.service.ts FieldDef carries `hideByDefault?: boolean`.
 *   4. Legacy reports.service.ts SourceDef carries `defaultColumns?: readonly string[]`.
 *
 * Tenant-safe registry (backend/src/saas/reports/runtime/report-sources.ts):
 *   5. employees source advertises employeeNumber / leadNumber / candidateNumber.
 *   6. employees source: id is hideByDefault, defaultColumns starts with employeeNumber.
 *   7. applicants source advertises leadNumber + candidateNumber + tier.
 *   8. applicants source: id is hideByDefault, defaultColumns includes both numbers.
 *   9. documents source advertises `docId` + `documentNumber`.
 *  10. documents source: id is hideByDefault, defaultColumns starts with docId.
 *  11. agencies source: id is hideByDefault, defaultColumns starts with name.
 *
 * Legacy registry (backend/src/reports/reports.service.ts):
 *  12. employees source advertises employeeNumber / leadNumber / candidateNumber.
 *  13. employees source: id is hideByDefault, defaultColumns starts with employeeNumber.
 *  14. applicants source advertises leadNumber / candidateNumber / tier.
 *  15. applicants source: id is hideByDefault, defaultColumns includes both numbers.
 *  16. documents source advertises docId.
 *  17. documents source: id is hideByDefault, defaultColumns starts with docId.
 *  18. agencies source: id is hideByDefault, defaultColumns starts with name.
 *  19. compliance_alerts: id is hideByDefault, defaultColumns defined.
 *
 * getDataSources controller response:
 *  20. Each field exposes `hideByDefault`.
 *  21. Each source exposes `defaultColumns`.
 *
 * Frontend:
 *  22. ReportsDashboard: source change seeds the builder.columns from `defaultColumns`.
 *  23. ReportsDashboard: selectAllColumns skips `hideByDefault` fields.
 *  24. ReportsDashboard: column picker filters by `showAdvancedColumns` state.
 *  25. ReportsDashboard: Phase A invariants (preview, select-all, hint) still present.
 *  26. ReportsDashboard: Phase C invariants (visibility badge, share button) still present.
 *
 * i18n:
 *  27. All six real locales carry reports.showAdvancedColumns and
 *      reports.advancedColumnTag.
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

// ── Types ──────────────────────────────────────────────────────────────
const tsfTypes = read('backend/src/saas/reports/source-def.types.ts');
must(tsfTypes, /hideByDefault\?:\s*boolean/,
  'types (tenant-safe): FieldDef.hideByDefault declared');
must(tsfTypes, /defaultColumns\?:\s*ReadonlyArray<string>/,
  'types (tenant-safe): SourceDef.defaultColumns declared');

const svc = read('backend/src/reports/reports.service.ts');
must(svc, /interface FieldDef[\s\S]{0,400}hideByDefault\?:\s*boolean/,
  'types (legacy): FieldDef.hideByDefault declared');
must(svc, /interface SourceDef[\s\S]{0,800}defaultColumns\?:\s*readonly string\[\]/,
  'types (legacy): SourceDef.defaultColumns declared');

// ── Tenant-safe registry ──────────────────────────────────────────────
const tsfSources = read('backend/src/saas/reports/runtime/report-sources.ts');
must(tsfSources, /employeeFields:[\s\S]{0,1500}employeeNumber:\s*\{[\s\S]{0,150}dbCol:\s*'employeeNumber'/,
  'tenant-safe: employees advertises employeeNumber');
must(tsfSources, /employeeFields:[\s\S]{0,1500}leadNumber:\s*\{[\s\S]{0,150}dbCol:\s*'leadNumber'/,
  'tenant-safe: employees advertises carry-forward leadNumber');
must(tsfSources, /employeeFields:[\s\S]{0,1500}candidateNumber:\s*\{[\s\S]{0,150}dbCol:\s*'candidateNumber'/,
  'tenant-safe: employees advertises carry-forward candidateNumber');
must(tsfSources, /employeeFields:\s*SourceDef\['fields'\]\s*=\s*\{\s*id:\s*\{[\s\S]{0,150}hideByDefault:\s*true/,
  'tenant-safe: employees.id is hideByDefault');
must(tsfSources, /employees:\s*READY\(\{[\s\S]{0,800}defaultColumns:\s*\[\s*'employeeNumber'/,
  'tenant-safe: employees.defaultColumns starts with employeeNumber');

must(tsfSources, /applicantFields:[\s\S]{0,1500}leadNumber:\s*\{[\s\S]{0,150}dbCol:\s*'leadNumber'/,
  'tenant-safe: applicants advertises leadNumber');
must(tsfSources, /applicantFields:[\s\S]{0,1500}candidateNumber:\s*\{[\s\S]{0,150}dbCol:\s*'candidateNumber'/,
  'tenant-safe: applicants advertises candidateNumber');
must(tsfSources, /applicantFields:[\s\S]{0,1500}tier:\s*\{[\s\S]{0,150}dbCol:\s*'tier'/,
  'tenant-safe: applicants advertises tier');
must(tsfSources, /applicantFields:\s*SourceDef\['fields'\]\s*=\s*\{\s*id:\s*\{[\s\S]{0,150}hideByDefault:\s*true/,
  'tenant-safe: applicants.id is hideByDefault');
must(tsfSources, /applicants:\s*READY\(\{[\s\S]{0,800}defaultColumns:[\s\S]{0,200}'candidateNumber'[\s\S]{0,80}'leadNumber'/,
  'tenant-safe: applicants.defaultColumns includes candidateNumber + leadNumber');

must(tsfSources, /documents:\s*READY\(\{[\s\S]{0,1500}docId:\s*\{[\s\S]{0,150}dbCol:\s*'docId'/,
  'tenant-safe: documents advertises docId');
must(tsfSources, /documents:\s*READY\(\{[\s\S]{0,1500}id:\s*\{[\s\S]{0,150}hideByDefault:\s*true/,
  'tenant-safe: documents.id is hideByDefault');
must(tsfSources, /documents:\s*READY\(\{[\s\S]{0,2000}defaultColumns:\s*\[\s*'docId'/,
  'tenant-safe: documents.defaultColumns starts with docId');

must(tsfSources, /agencies:\s*READY\(\{[\s\S]{0,1500}defaultColumns:\s*\[\s*'name'/,
  'tenant-safe: agencies.defaultColumns starts with name');
must(tsfSources, /agencyFields:\s*SourceDef\['fields'\]\s*=\s*\{\s*id:\s*\{[\s\S]{0,150}hideByDefault:\s*true/,
  'tenant-safe: agencies.id is hideByDefault');

// ── Legacy registry ───────────────────────────────────────────────────
must(svc, /employees:\s*\{[\s\S]{0,2200}employeeNumber:\s*\{[\s\S]{0,150}dbCol:\s*'employeeNumber'/,
  'legacy: employees advertises employeeNumber');
must(svc, /employees:\s*\{[\s\S]{0,2200}leadNumber:\s*\{[\s\S]{0,150}dbCol:\s*'leadNumber'/,
  'legacy: employees advertises carry-forward leadNumber');
must(svc, /employees:\s*\{[\s\S]{0,2200}candidateNumber:\s*\{[\s\S]{0,150}dbCol:\s*'candidateNumber'/,
  'legacy: employees advertises carry-forward candidateNumber');
must(svc, /employees:\s*\{[\s\S]{0,400}id:\s*\{[\s\S]{0,150}hideByDefault:\s*true/,
  'legacy: employees.id is hideByDefault');
must(svc, /employees:\s*\{[\s\S]{0,2400}defaultColumns:\s*\[\s*'employeeNumber'/,
  'legacy: employees.defaultColumns starts with employeeNumber');

must(svc, /applicants:\s*\{[\s\S]{0,1800}leadNumber:\s*\{[\s\S]{0,150}dbCol:\s*'leadNumber'/,
  'legacy: applicants advertises leadNumber');
must(svc, /applicants:\s*\{[\s\S]{0,1800}candidateNumber:\s*\{[\s\S]{0,150}dbCol:\s*'candidateNumber'/,
  'legacy: applicants advertises candidateNumber');
must(svc, /applicants:\s*\{[\s\S]{0,1800}tier:\s*\{[\s\S]{0,150}dbCol:\s*'tier'/,
  'legacy: applicants advertises tier');
must(svc, /applicants:\s*\{[\s\S]{0,400}id:\s*\{[\s\S]{0,150}hideByDefault:\s*true/,
  'legacy: applicants.id is hideByDefault');
must(svc, /applicants:\s*\{[\s\S]{0,3000}defaultColumns:[\s\S]{0,200}'candidateNumber'[\s\S]{0,80}'leadNumber'/,
  'legacy: applicants.defaultColumns includes candidateNumber + leadNumber');

must(svc, /documents:\s*\{[\s\S]{0,1500}docId:\s*\{[\s\S]{0,150}dbCol:\s*'docId'/,
  'legacy: documents advertises docId');
must(svc, /documents:\s*\{[\s\S]{0,400}id:\s*\{[\s\S]{0,150}hideByDefault:\s*true/,
  'legacy: documents.id is hideByDefault');
must(svc, /documents:\s*\{[\s\S]{0,1800}defaultColumns:\s*\[\s*'docId'/,
  'legacy: documents.defaultColumns starts with docId');

must(svc, /agencies:\s*\{[\s\S]{0,400}id:\s*\{[\s\S]{0,150}hideByDefault:\s*true/,
  'legacy: agencies.id is hideByDefault');
must(svc, /agencies:\s*\{[\s\S]{0,1200}defaultColumns:\s*\[\s*'name'/,
  'legacy: agencies.defaultColumns starts with name');

must(svc, /compliance_alerts:\s*\{[\s\S]{0,400}id:\s*\{[\s\S]{0,150}hideByDefault:\s*true/,
  'legacy: compliance_alerts.id is hideByDefault');
must(svc, /compliance_alerts:\s*\{[\s\S]{0,1200}defaultColumns:\s*\[/,
  'legacy: compliance_alerts.defaultColumns defined');

// ── getDataSources response ───────────────────────────────────────────
must(svc, /async getDataSources\(caller\?:[\s\S]{0,1200}hideByDefault:\s*meta\.hideByDefault\s*\?\?\s*false/,
  'controller: getDataSources surfaces hideByDefault per field');
must(svc, /async getDataSources\(caller\?:[\s\S]{0,1200}defaultColumns:\s*def\.defaultColumns\s*\?\?\s*\[\]/,
  'controller: getDataSources surfaces defaultColumns per source');

// ── Frontend ──────────────────────────────────────────────────────────
const ui = read('src/app/pages/reports/ReportsDashboard.tsx');
must(ui, /dataSources\.find\(\(d:\s*any\)\s*=>\s*d\.key\s*===\s*v\)[\s\S]{0,400}defaultColumns/,
  'ui: source change seeds builder columns from defaultColumns');
must(ui, /selectAllColumns\s*=\s*\(\)\s*=>\s*setBuilder\(b\s*=>\s*\{[\s\S]{0,500}!f\.hideByDefault/,
  'ui: selectAllColumns skips hideByDefault fields');
must(ui, /showAdvancedColumns\b/,
  'ui: showAdvancedColumns state declared');
must(ui, /sourceFields[\s\S]{0,200}\.filter\(\(f:\s*any\)\s*=>\s*showAdvancedColumns\s*\|\|\s*!f\.hideByDefault\)/,
  'ui: column picker filters by showAdvancedColumns');
must(ui, /reports\.showAdvancedColumns/,
  'ui: "Show advanced fields" toggle uses i18n');
must(ui, /reports\.advancedColumnTag/,
  'ui: advanced-column badge uses i18n');

// Phase A invariants
must(ui, /reportsApi\.preview\(/,
  'ui: Phase A — Preview still calls reportsApi.preview');
must(ui, /reports\.previewHint/,
  'ui: Phase A — preview hint copy still present');
// Phase C invariants
must(ui, /<ShareReportDialog\b/,
  'ui: Phase C — ShareReportDialog still mounted');
must(ui, /reports\.visibility\.private/,
  'ui: Phase C — visibility badge still rendered');

// ── i18n ──────────────────────────────────────────────────────────────
const locales = ['en', 'ar', 'de', 'ru', 'sk', 'tr'];
for (const loc of locales) {
  let d;
  try { d = JSON.parse(read(`src/i18n/locales/${loc}/common.json`)); }
  catch { fail(`i18n ${loc}: cannot parse common.json`); continue; }
  const seg = d?.reports;
  if (seg && typeof seg.showAdvancedColumns === 'string' && typeof seg.advancedColumnTag === 'string') {
    ok(`i18n ${loc}: reports.{showAdvancedColumns,advancedColumnTag} present`);
  } else {
    fail(`i18n ${loc}: missing reports.{showAdvancedColumns,advancedColumnTag}`);
  }
}

console.log('');
if (problems > 0) {
  console.log(`${problems} check(s) failed.`);
  process.exit(1);
}
console.log('All reports-phase-d checks passed.');
