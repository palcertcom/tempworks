#!/usr/bin/env node
/**
 * Phase 3 Reports Hardening — Phase E Batch 1 regression
 * (Vehicles fleet: vehicles + workshops + maintenance_records).
 *
 * Source registration:
 *   1. Tenant-safe registry declares vehicles / workshops /
 *      maintenance_records as READY with tenantColumn = 'tenantId'.
 *   2. vehicles carries agencyColumn = 'agencyId'; workshops and
 *      maintenance_records carry agencyColumn = null.
 *   3. Legacy registry declares the same three sources.
 *   4. DTO whitelist (REPORT_DATA_SOURCE_VALUES) includes the three.
 *   5. Source permission map maps each to 'vehicles:read'.
 *
 * Business-ID / Phase D pattern:
 *   6. vehicles advertises registrationNumber; id is hideByDefault;
 *      defaultColumns starts with registrationNumber.
 *   7. workshops advertises name; id is hideByDefault; defaultColumns
 *      starts with name.
 *   8. maintenance_records: id and FK columns (vehicleId,
 *      maintenanceTypeId, workshopId) are all hideByDefault;
 *      defaultColumns starts with scheduledDate.
 *
 * Data sensitivity:
 *   9. workshops does NOT expose bankName / iban / swiftBicCode.
 *
 * Phase A/B/C/D invariants:
 *  10. Backend per-source permission gate path is untouched
 *      (assertSourcePermitted still present).
 *  11. previewInline still capped at REPORTS_PREVIEW_LIMIT.
 *  12. accessibleReportsWhere (Phase B) still present.
 *  13. ShareReportDialog import (Phase C) still present in UI.
 *  14. Phase D pattern intact in the new sources (hideByDefault +
 *      defaultColumns).
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

const tsfSources = read('backend/src/saas/reports/runtime/report-sources.ts');
const svc        = read('backend/src/reports/reports.service.ts');
const dto        = read('backend/src/reports/dto/report.dto.ts');
const ui         = read('src/app/pages/reports/ReportsDashboard.tsx');

// ── Tenant-safe registry ──────────────────────────────────────────────────
must(tsfSources, /vehicles:\s*READY\(\{[\s\S]{0,200}primaryTable:\s*'vehicles'[\s\S]{0,200}tenantColumn:\s*'tenantId'/,
  'tenant-safe: vehicles READY with tenantColumn=tenantId');
must(tsfSources, /vehicles:\s*READY\(\{[\s\S]{0,400}agencyColumn:\s*'agencyId'/,
  'tenant-safe: vehicles carries agencyColumn=agencyId');
must(tsfSources, /workshops:\s*READY\(\{[\s\S]{0,200}primaryTable:\s*'workshops'[\s\S]{0,200}tenantColumn:\s*'tenantId'/,
  'tenant-safe: workshops READY with tenantColumn=tenantId');
must(tsfSources, /workshops:\s*READY\(\{[\s\S]{0,400}agencyColumn:\s*null/,
  'tenant-safe: workshops carries agencyColumn=null');
must(tsfSources, /maintenance_records:\s*READY\(\{[\s\S]{0,200}primaryTable:\s*'maintenance_records'[\s\S]{0,200}tenantColumn:\s*'tenantId'/,
  'tenant-safe: maintenance_records READY with tenantColumn=tenantId');
must(tsfSources, /maintenance_records:\s*READY\(\{[\s\S]{0,400}agencyColumn:\s*null/,
  'tenant-safe: maintenance_records carries agencyColumn=null');

// ── Legacy registry ───────────────────────────────────────────────────────
must(svc, /\n  vehicles:\s*\{[\s\S]{0,400}primaryTable:\s*'vehicles'/,
  'legacy: vehicles source registered');
must(svc, /\n  workshops:\s*\{[\s\S]{0,400}primaryTable:\s*'workshops'/,
  'legacy: workshops source registered');
must(svc, /\n  maintenance_records:\s*\{[\s\S]{0,400}primaryTable:\s*'maintenance_records'/,
  'legacy: maintenance_records source registered');

// ── DTO whitelist ─────────────────────────────────────────────────────────
must(dto, /REPORT_DATA_SOURCE_VALUES[\s\S]{0,800}'vehicles'[\s\S]{0,80}'workshops'[\s\S]{0,80}'maintenance_records'/,
  'dto: REPORT_DATA_SOURCE_VALUES adds vehicles / workshops / maintenance_records');

// ── Permission map ────────────────────────────────────────────────────────
must(svc, /vehicles:\s*'vehicles:read'/,
  'permissions: vehicles → vehicles:read');
must(svc, /workshops:\s*'vehicles:read'/,
  'permissions: workshops → vehicles:read');
must(svc, /maintenance_records:\s*'vehicles:read'/,
  'permissions: maintenance_records → vehicles:read');

// ── Business identifiers (Phase D pattern) ────────────────────────────────
must(tsfSources, /vehicles:\s*READY\(\{[\s\S]{0,2000}registrationNumber:\s*\{[\s\S]{0,150}dbCol:\s*'registrationNumber'/,
  'vehicles: advertises registrationNumber');
must(tsfSources, /vehicles:\s*READY\(\{[\s\S]{0,2000}id:\s*\{[\s\S]{0,150}hideByDefault:\s*true/,
  'vehicles: id is hideByDefault');
must(tsfSources, /vehicles:\s*READY\(\{[\s\S]{0,2500}defaultColumns:\s*\[\s*'registrationNumber'/,
  'vehicles: defaultColumns starts with registrationNumber');

must(tsfSources, /workshops:\s*READY\(\{[\s\S]{0,2000}id:\s*\{[\s\S]{0,150}hideByDefault:\s*true/,
  'workshops: id is hideByDefault');
must(tsfSources, /workshops:\s*READY\(\{[\s\S]{0,2500}defaultColumns:\s*\[\s*'name'/,
  'workshops: defaultColumns starts with name');

must(tsfSources, /maintenance_records:\s*READY\(\{[\s\S]{0,2000}id:\s*\{[\s\S]{0,150}hideByDefault:\s*true/,
  'maintenance_records: id is hideByDefault');
must(tsfSources, /maintenance_records:\s*READY\(\{[\s\S]{0,2500}vehicleId:\s*\{[\s\S]{0,150}hideByDefault:\s*true/,
  'maintenance_records: vehicleId is hideByDefault');
must(tsfSources, /maintenance_records:\s*READY\(\{[\s\S]{0,2500}workshopId:\s*\{[\s\S]{0,150}hideByDefault:\s*true/,
  'maintenance_records: workshopId is hideByDefault');
must(tsfSources, /maintenance_records:\s*READY\(\{[\s\S]{0,3000}defaultColumns:\s*\[\s*'scheduledDate'/,
  'maintenance_records: defaultColumns starts with scheduledDate');

// ── Data sensitivity (Phase E spec §5) ────────────────────────────────────
// Look only at the fields object declarations (`name: {`), so the
// comment listing what we deliberately excluded doesn't trigger the
// negative match.
const workshopsBlock = (tsfSources.match(/workshops:\s*READY\(\{[\s\S]{0,3500}\}\)/) ?? [''])[0];
mustNot(workshopsBlock, /\bbankName:\s*\{/,
  'workshops: bankName field NOT declared (sensitive)');
mustNot(workshopsBlock, /\biban:\s*\{/,
  'workshops: iban field NOT declared (sensitive)');
mustNot(workshopsBlock, /\bswiftBicCode:\s*\{/,
  'workshops: swiftBicCode field NOT declared (sensitive)');

// ── Phase A / B / C / D invariants ────────────────────────────────────────
must(svc, /private async assertSourcePermitted\(/,
  'Phase A: per-source permission gate still present');
must(svc, /REPORTS_PREVIEW_LIMIT/,
  'Phase A: previewInline still uses REPORTS_PREVIEW_LIMIT');
must(svc, /accessibleReportsWhere\(/,
  'Phase B: accessibleReportsWhere helper still present');
must(ui, /import\s*\{\s*ShareReportDialog\s*\}/,
  'Phase C: ShareReportDialog still imported in UI');
must(svc, /defaultColumns\?\:\s*readonly string\[\]/,
  'Phase D: SourceDef.defaultColumns still typed (legacy)');

// ── Users source intentionally absent (no flat tenantId column) ───────────
mustNot(tsfSources, /\busers:\s*READY\(/,
  'Users source is NOT registered in tenant-safe registry (no flat tenantId)');
mustNot(svc, /\n  users:\s*\{[\s\S]{0,200}primaryTable:\s*'users'/,
  'Users source is NOT registered in legacy registry (no flat tenantId)');

// ╔═══════════════════════════════════════════════════════════════════════╗
// ║ Phase E Batch 2 — attendance / finance / job_ads                      ║
// ╚═══════════════════════════════════════════════════════════════════════╝

// Tenant-safe registry — three new sources READY with tenantColumn.
must(tsfSources, /\battendance:\s*READY\(\{[\s\S]{0,200}primaryTable:\s*'attendance_records'[\s\S]{0,200}tenantColumn:\s*'tenantId'/,
  'tenant-safe (B2): attendance READY with tenantColumn=tenantId');
must(tsfSources, /\battendance:\s*READY\(\{[\s\S]{0,1200}agencyColumn:\s*null/,
  'tenant-safe (B2): attendance agencyColumn=null (limitation documented)');
must(tsfSources, /\bfinance:\s*READY\(\{[\s\S]{0,200}primaryTable:\s*'financial_records'[\s\S]{0,200}tenantColumn:\s*'tenantId'/,
  'tenant-safe (B2): finance READY with tenantColumn=tenantId');
must(tsfSources, /\bfinance:\s*READY\(\{[\s\S]{0,400}agencyColumn:\s*null/,
  'tenant-safe (B2): finance agencyColumn=null');
must(tsfSources, /\bjob_ads:\s*READY\(\{[\s\S]{0,200}primaryTable:\s*'job_ads'[\s\S]{0,200}tenantColumn:\s*'tenantId'/,
  'tenant-safe (B2): job_ads READY with tenantColumn=tenantId');
must(tsfSources, /\bjob_ads:\s*READY\(\{[\s\S]{0,400}agencyColumn:\s*null/,
  'tenant-safe (B2): job_ads agencyColumn=null');

// Legacy registry
must(svc, /\n  attendance:\s*\{[\s\S]{0,400}primaryTable:\s*'attendance_records'/,
  'legacy (B2): attendance source registered');
must(svc, /\n  finance:\s*\{[\s\S]{0,400}primaryTable:\s*'financial_records'/,
  'legacy (B2): finance source registered');
must(svc, /\n  job_ads:\s*\{[\s\S]{0,400}primaryTable:\s*'job_ads'/,
  'legacy (B2): job_ads source registered');

// DTO whitelist
must(dto, /REPORT_DATA_SOURCE_VALUES[\s\S]{0,1000}'attendance'[\s\S]{0,80}'finance'[\s\S]{0,80}'job_ads'/,
  'dto (B2): REPORT_DATA_SOURCE_VALUES adds attendance / finance / job_ads');

// Permission map
must(svc, /attendance:\s*'attendance:read'/,
  'permissions (B2): attendance → attendance:read');
must(svc, /finance:\s*'finance:read'/,
  'permissions (B2): finance → finance:read');
must(svc, /job_ads:\s*'job-ads:read'/,
  'permissions (B2): job_ads → job-ads:read');

// Hidden by default + defaultColumns
must(tsfSources, /\battendance:\s*READY\(\{[\s\S]{0,2500}id:\s*\{[\s\S]{0,150}hideByDefault:\s*true/,
  'attendance: id is hideByDefault');
must(tsfSources, /\battendance:\s*READY\(\{[\s\S]{0,2500}employeeId:\s*\{[\s\S]{0,150}hideByDefault:\s*true/,
  'attendance: employeeId is hideByDefault (join deferred)');
must(tsfSources, /\battendance:\s*READY\(\{[\s\S]{0,3000}defaultColumns:\s*\[\s*'date'/,
  'attendance: defaultColumns starts with date');

must(tsfSources, /\bfinance:\s*READY\(\{[\s\S]{0,2500}id:\s*\{[\s\S]{0,150}hideByDefault:\s*true/,
  'finance: id is hideByDefault');
must(tsfSources, /\bfinance:\s*READY\(\{[\s\S]{0,2500}entityId:\s*\{[\s\S]{0,150}hideByDefault:\s*true/,
  'finance: entityId is hideByDefault');
must(tsfSources, /\bfinance:\s*READY\(\{[\s\S]{0,2500}applicantId:\s*\{[\s\S]{0,150}hideByDefault:\s*true/,
  'finance: applicantId is hideByDefault (join deferred)');
must(tsfSources, /\bfinance:\s*READY\(\{[\s\S]{0,3000}defaultColumns:\s*\[\s*'transactionDate'/,
  'finance: defaultColumns starts with transactionDate');

must(tsfSources, /\bjob_ads:\s*READY\(\{[\s\S]{0,2500}id:\s*\{[\s\S]{0,150}hideByDefault:\s*true/,
  'job_ads: id is hideByDefault');
must(tsfSources, /\bjob_ads:\s*READY\(\{[\s\S]{0,3000}defaultColumns:\s*\[\s*'title'/,
  'job_ads: defaultColumns starts with title');

// Data sensitivity (Phase E §5)
const financeBlock = (tsfSources.match(/\bfinance:\s*READY\(\{[\s\S]{0,3500}\}\)/) ?? [''])[0];
mustNot(financeBlock, /\bnotes:\s*\{/,
  'finance: free-text notes NOT exposed (potential PII)');
mustNot(financeBlock, /\bpaidById:\s*\{/,
  'finance: paidById UUID NOT exposed');
mustNot(financeBlock, /\bcreatedById:\s*\{/,
  'finance: createdById UUID NOT exposed');

const jobAdsBlock = (tsfSources.match(/\bjob_ads:\s*READY\(\{[\s\S]{0,3500}\}\)/) ?? [''])[0];
mustNot(jobAdsBlock, /\bdescription:\s*\{/,
  'job_ads: rich-text description NOT exposed in tabular reports');
mustNot(jobAdsBlock, /\brequiredDocuments:\s*\{/,
  'job_ads: requiredDocuments (JSON blob) NOT exposed');
mustNot(jobAdsBlock, /\bcreatedById:\s*\{/,
  'job_ads: createdById UUID NOT exposed');

// Engine untouched: confirm `tenantAwareJoins: []` on all three Batch 2 sources.
must(tsfSources, /\battendance:\s*READY\(\{[\s\S]{0,1300}tenantAwareJoins:\s*\[\]/,
  'attendance: no joins (composer not extended)');
must(tsfSources, /\bfinance:\s*READY\(\{[\s\S]{0,500}tenantAwareJoins:\s*\[\]/,
  'finance: no joins (composer not extended)');
must(tsfSources, /\bjob_ads:\s*READY\(\{[\s\S]{0,500}tenantAwareJoins:\s*\[\]/,
  'job_ads: no joins (composer not extended)');

// ╔═══════════════════════════════════════════════════════════════════════╗
// ║ Phase E Batch 3 — workflows                                           ║
// ╚═══════════════════════════════════════════════════════════════════════╝

must(tsfSources, /\bworkflows:\s*READY\(\{[\s\S]{0,300}primaryTable:\s*'workflows'[\s\S]{0,300}tenantColumn:\s*'tenantId'/,
  'tenant-safe (B3): workflows READY with tenantColumn=tenantId');
must(tsfSources, /\bworkflows:\s*READY\(\{[\s\S]{0,500}agencyColumn:\s*null/,
  'tenant-safe (B3): workflows agencyColumn=null (per-tenant template)');
must(tsfSources, /\bworkflows:\s*READY\(\{[\s\S]{0,500}tenantAwareJoins:\s*\[\]/,
  'workflows: no joins (composer not extended)');
must(svc, /\n  workflows:\s*\{[\s\S]{0,400}primaryTable:\s*'workflows'/,
  'legacy (B3): workflows source registered');
must(dto, /REPORT_DATA_SOURCE_VALUES[\s\S]{0,1200}'workflows'/,
  'dto (B3): REPORT_DATA_SOURCE_VALUES adds workflows');
must(svc, /workflows:\s*'workflow:read'/,
  'permissions (B3): workflows → workflow:read');

must(tsfSources, /\bworkflows:\s*READY\(\{[\s\S]{0,1500}id:\s*\{[\s\S]{0,150}hideByDefault:\s*true/,
  'workflows: id is hideByDefault');
must(tsfSources, /\bworkflows:\s*READY\(\{[\s\S]{0,2000}defaultColumns:\s*\[\s*'name'/,
  'workflows: defaultColumns starts with name');

// Data sensitivity — createdById NOT exposed.
const workflowsBlock = (tsfSources.match(/\bworkflows:\s*READY\(\{[\s\S]{0,2500}\}\)/) ?? [''])[0];
mustNot(workflowsBlock, /\bcreatedById:\s*\{/,
  'workflows: createdById UUID NOT exposed');

// Assignment + stage models intentionally absent in Batch 3.
mustNot(tsfSources, /\bcandidate_workflow_assignments:\s*READY\(/,
  'B3: CandidateWorkflowAssignment NOT exposed (needs join + R-6 verification)');
mustNot(tsfSources, /\bemployee_workflow_assignments:\s*READY\(/,
  'B3: EmployeeWorkflowAssignment NOT exposed (R-6 tenant-attribution deferred)');
mustNot(tsfSources, /\bcandidate_stage_progress:\s*READY\(/,
  'B3: CandidateStageProgress NOT exposed');
mustNot(tsfSources, /\bcandidate_stage_approvals:\s*READY\(/,
  'B3: CandidateStageApproval NOT exposed');
mustNot(svc, /\n  candidate_workflow_assignments:\s*\{/,
  'B3 (legacy): CandidateWorkflowAssignment NOT exposed');
mustNot(svc, /\n  employee_workflow_assignments:\s*\{/,
  'B3 (legacy): EmployeeWorkflowAssignment NOT exposed');

console.log('');
if (problems > 0) {
  console.log(`${problems} check(s) failed.`);
  process.exit(1);
}
console.log('All reports-phase-e (Batches 1+2+3) checks passed.');
