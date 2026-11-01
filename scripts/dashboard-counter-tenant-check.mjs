#!/usr/bin/env node
/**
 * Phase 3 (#1 R-1 b/c) — Dashboard counter tenant-predicate regression.
 *
 * Two aggregate queries in `backend/src/reports/reports.service.ts`
 * previously summed across all tenants for SUPER + pilot-off because
 * the underlying models (EmployeeStage, CandidateStageApproval) carry
 * no flat `tenantId`. They MUST scope through a relation:
 *
 *   • EmployeeStage          →  employee.tenantId
 *   • CandidateStageApproval →  progress.assignment.candidate.tenantId
 *
 * This check fails if either query reverts to the bare pattern.
 *
 * Exit 1 on any failure.
 */
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SVC = resolve(ROOT, 'backend/src/reports/reports.service.ts');
const src = readFileSync(SVC, 'utf8');

let problems = 0;
const fail = (m) => { problems++; console.log(`✗ ${m}`); };
const ok = (m) => console.log(`✓ ${m}`);
const must = (re, label) => (re.test(src) ? ok(label) : fail(label));

// ── R-1(b) Pipeline IN_PROGRESS counter ───────────────────────────────────
// The nested employeeStages select must filter through the Employee
// relation when an actor tenant is present.
must(
  /employeeStages:\s*\{\s*where:\s*\{[\s\S]{0,400}status:\s*['"]IN_PROGRESS['"][\s\S]{0,400}employee:\s*\{\s*tenantId:\s*actor\.tenantId/,
  'R-1(b): pipeline IN_PROGRESS count scopes via employee.tenantId',
);

// Negative: the legacy bare form (no employee predicate) is gone.
const pipelineBlock = (src.match(/StageTemplates with active EmployeeStage counts[\s\S]{0,1200}/) ?? [''])[0];
if (/employeeStages:\s*\{\s*where:\s*\{\s*status:\s*['"]IN_PROGRESS['"]\s*\}\s*\}/.test(pipelineBlock)) {
  fail('R-1(b): bare `employeeStages: { where: { status: "IN_PROGRESS" } }` (no tenant predicate) is back');
} else {
  ok('R-1(b): bare unscoped employeeStages count is gone');
}

// ── R-1(c) Approval-rate counters ─────────────────────────────────────────
// Both the numerator (APPROVED) and the denominator (APPROVED|REJECTED)
// must scope through progress.assignment.candidate.tenantId.
must(
  /candidateStageApproval\.count\(\{\s*where:\s*\{[\s\S]{0,300}decision:\s*['"]APPROVED['"][\s\S]{0,400}progress:\s*\{\s*assignment:\s*\{\s*candidate:\s*\{\s*tenantId:\s*actor\.tenantId/,
  'R-1(c): APPROVED count scopes via progress.assignment.candidate.tenantId',
);
must(
  /candidateStageApproval\.count\(\{\s*where:\s*\{[\s\S]{0,300}decision:\s*\{\s*in:\s*\[\s*['"]APPROVED['"]\s*,\s*['"]REJECTED['"]\s*\][\s\S]{0,400}progress:\s*\{\s*assignment:\s*\{\s*candidate:\s*\{\s*tenantId:\s*actor\.tenantId/,
  'R-1(c): APPROVED+REJECTED denominator count scopes via progress.assignment.candidate.tenantId',
);

// Negative: no bare `candidateStageApproval.count({ where: { decision: ... } })`
// without the relation predicate.
const bareApproval = /candidateStageApproval\.count\(\{\s*where:\s*\{\s*decision:[^}]+\}\s*\}\)/g;
const matches = src.match(bareApproval) ?? [];
if (matches.length > 0) {
  fail(`R-1(c): ${matches.length} bare candidateStageApproval.count(...) call(s) without a tenant predicate`);
} else {
  ok('R-1(c): no bare candidateStageApproval.count calls remain');
}

console.log('');
if (problems > 0) {
  console.log(`${problems} check(s) failed.`);
  process.exit(1);
}
console.log('All dashboard-counter-tenant checks passed.');
