# Phase 2.3 — Entity-Keyed `tenantId` Denormalisation Plan

> Goal: every entity-keyed model that today derives ownership through joins
> carries an own `tenantId` column, populated, indexed, and verified — so the
> tenant-safe reports engine can include them as single-table READY sources.

This is **additive only**. No existing column, index, FK, or constraint is
modified or dropped. RLS remains off. Production behaviour is unchanged
because every new column is nullable and no read or write path consults it
yet (the engine consults it only for sources flipped to READY in the same
phase, behind `TENANT_SAFE_REPORTS_ENABLED`).

---

## 1. Models in scope

The 15 models below carry `entityType + entityId` or descend from one that
does. Each receives a nullable `tenantId String?` and an `@@index([tenantId])`.

| # | Model (Prisma) | DB table | Parent path used by backfill |
|--:|----------------|----------|------------------------------|
| 1 | `Document` | `documents` | `entityId → employees|applicants|agencies → tenantId` |
| 2 | `WorkPermit` | `work_permits` | `employeeId → employees.tenantId` |
| 3 | `Visa` | `visas` | `entityId → employees|applicants → tenantId` |
| 4 | `ComplianceAlert` | `compliance_alerts` | `entityId → employees|applicants → tenantId` |
| 5 | `FinancialRecord` | `financial_records` | `entityId → employees|applicants → tenantId` |
| 6 | `FinancialRecordAttachment` | `financial_record_attachments` | `financialRecordId → financial_records.tenantId` |
| 7 | `FinancialRecordDeduction` | `financial_record_deductions` | `financialRecordId → financial_records.tenantId` |
| 8 | `AttendanceRecord` | `attendance_records` | `employeeId → employees.tenantId` |
| 9 | `Notification` | `notifications` | `userId → users.agencyId → agencies.tenantId` |
| 10 | `VehicleDocument` | `vehicle_documents` | `vehicleId → vehicles.tenantId` |
| 11 | `MaintenanceRecord` | `maintenance_records` | `vehicleId → vehicles.tenantId` |
| 12 | `CandidateWorkflowAssignment` | `candidate_workflow_assignments` | `candidateId → applicants.tenantId` |
| 13 | `EmployeeWorkflowAssignment` | `employee_workflow_assignments` | `employeeId → employees.tenantId` |
| 14 | `EmployeeWorkHistory` | `employee_work_history` | `employeeId → employees.tenantId` |
| 15 | `EmployeeWorkHistoryAttachment` | `employee_work_history_attachments` | `workHistoryId → employee_work_history.tenantId` |

Secondary composite indexes are added where reports filter most often:

- `documents (tenantId, status)`
- `compliance_alerts (tenantId, status)`
- `financial_records (tenantId, transactionDate)`
- `attendance_records (tenantId, date)`
- `notifications (tenantId, userId)`

## 2. Migration shape

`backend/prisma/migrations/saas_phase2_tenantid_denorm/migration.sql`:

- Single transaction.
- Top-level `DO $$ … $$;` block iterates the 15 table names.
- For each: `IF EXISTS (SELECT 1 FROM pg_tables …)` then
  - `ALTER TABLE %I ADD COLUMN IF NOT EXISTS "tenantId" TEXT`
  - `CREATE INDEX IF NOT EXISTS …_tenantId_idx ON %I("tenantId")`
- A second `DO $$ … $$;` block adds the secondary composite indexes,
  guarded by both table-exists AND column-exists (so partial fixtures
  do not roll back the whole transaction).

Reverse migration: `migration.down.sql` drops the indexes and columns
idempotently. No data loss occurs because the column is always nullable
and never read by production paths.

## 3. Backfill

Script: `backend/scripts/saas/phase2/backfill-entity-tenantids.ts`.

Behaviour:

- **Dry-run by default** — emits per-model `willBackfill` and `quarantined`
  counts, no `UPDATE`, no insert into the reconciliation queue.
- `--apply` requires both:
  - `ALLOW_SAAS_STAGING_MUTATION=true`
  - host classified as `SAFE_CLONE` or `SAFE_STAGING` by
    `backend/scripts/saas/phase1/env-safety.ts`.
- Per model: pre-flight `pg_tables` + `information_schema.columns` check;
  on miss, the model is recorded with `error: 'table not present (skipped)'`
  and skipped (the harness still completes).
- Where a child cannot be resolved to exactly one tenant (orphan parent,
  ambiguous polymorphic FK), the row is **quarantined**: a row is inserted
  into `saas_reconciliation_queue` with kind
  `tenantid-denorm.<model>.unresolved-parent` carrying the original PK and
  the reason. The original row is left untouched (`tenantId` stays NULL).
- `--limit N`, `--model <name>`, and `--fail-on-quarantine` are supported.
- Emits `backend/reports/saas/phase2/entity-tenantid-backfill.{json,md}`.

## 4. Verification

Script: `backend/scripts/saas/phase2/verify-entity-tenantids.ts`.

Per model, computes:

- `mismatch` — rows where `tenantId` is set AND differs from the parent's
  `tenantId`. Must be `0`.
- `withTid`, `withoutTid` — counts.
- `withoutParentTid` — children whose parent's tenantId is itself NULL
  (legitimate reason for child to be NULL).
- `unexplainedNulls = withoutTid - withoutParentTid` — children whose
  parent has a tenantId but the child does not. Must be `0` after backfill.

A model passes when `mismatch=0 AND unexplainedNulls=0`. Missing tables
are reported as `ERROR` with a clear `relation … does not exist` reason
and ignored by the staging gate (because the operator already knows
those tables aren't materialised in the fixture).

Emits `backend/reports/saas/phase2/entity-tenantid-verification.{json,md}`.

## 5. Engine impact

`backend/src/saas/reports/runtime/report-sources.ts` flips four sources
from DISABLED to READY:

- `documents`
- `compliance_alerts`
- `work_permits`
- `visas`

`document_types` stays DISABLED ("Phase 2.4 — catalog model with tenantId
NULL semantics not finalised"). All multi-table joined sources stay
DISABLED until Wave B (joined-source rewrite).

## 6. Rollout & rollback

| Step | Action | Effect |
|------|--------|--------|
| 1 | Apply migration on SAFE_CLONE | columns + indexes added; nullable; engine still off |
| 2 | `npm run saas:phase2-backfill-entity-tenantids -- --apply` | rows updated; orphans quarantined |
| 3 | `npm run saas:phase2-verify-entity-tenantids` | confirm 0 mismatches, 0 unexplained nulls |
| 4 | `npm run saas:phase2-reports-equivalence` | confirm new READY sources match legacy on tenant A |
| 5 | `npm run saas:phase2-reports-isolation` | confirm tenant A query returns no tenant B rows |
| 6 | Flip `TENANT_SAFE_REPORTS_ENABLED=true` (staging only) | engine starts serving the new sources |

Rollback: deploy `TENANT_SAFE_REPORTS_ENABLED=false`. Engine returns to
legacy path. Data is unchanged. To remove the columns, run
`migration.down.sql` (reversible at any point).

## 7. Closing principle

> Give every record its tenant passport before asking the guards to enforce borders.
