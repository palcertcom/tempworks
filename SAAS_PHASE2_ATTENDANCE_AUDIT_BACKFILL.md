# Phase 2.50 — Historic Attendance Audit Tenant Backfill

> One-shot, dry-run-first backfill that assigns `tenantId` to
> historic NULL-tenant `audit_logs` rows for `entity =
> 'AttendanceRecord'` by joining through `attendance_records.tenantId`.
> Default-OFF; refuses apply outside SAFE_CLONE/SAFE_STAGING.

---

## 1. Why

Phase 2.48 made `AttendanceService.auditLog` route through
`TenantAuditLogService.write`, so new audit rows carry `tenantId`
when the audit-log pilot is enabled. Existing rows produced by
the legacy code path are still NULL-tenant. This phase provides a
script to clean them up safely.

## 2. Dry-run-first behaviour

```sh
# default: dry-run — counts only, no writes.
npm run saas:phase250-attendance-audit-backfill

# apply — only when ATTENDANCE_AUDIT_BACKFILL_APPLY=true AND the
# runtime classifies as SAFE_CLONE/SAFE_STAGING. Otherwise the
# script falls back to dry-run with `refusalReason` populated.
ATTENDANCE_AUDIT_BACKFILL_APPLY=true \
  npm run saas:phase250-attendance-audit-backfill
```

The script always emits a JSON + Markdown report with mode,
classification, candidate / updated / skipped counts, and a
before/after count of NULL-tenant attendance audit rows.

## 3. Apply flag

| Variable | Default | Effect |
|---|---|---|
| `ATTENDANCE_AUDIT_BACKFILL_APPLY` | `false` | Stay in dry-run regardless of classification. |
| (also) | runtime classification | Apply also requires `SAFE_CLONE` or `SAFE_STAGING`. UNSAFE_PRODUCTION / UNKNOWN ⇒ dry-run with `refusalReason`. |

## 4. Eligible rows (apply UPDATE target)

```sql
UPDATE audit_logs al
SET "tenantId" = ar."tenantId"
FROM attendance_records ar
WHERE al.entity        = 'AttendanceRecord'
  AND al."entityId"    = ar.id
  AND al."tenantId"    IS NULL
  AND ar."tenantId"    IS NOT NULL;
```

A row is updated **only** when:
- `audit_logs.entity = 'AttendanceRecord'`, AND
- `audit_logs.tenantId IS NULL`, AND
- `audit_logs.entityId` joins to a real `attendance_records.id`, AND
- That `attendance_records.tenantId IS NOT NULL`.

## 5. Skipped rows (never updated)

| Bucket | Reason |
|---|---|
| `skippedAlreadyTenantStamped` | `audit_logs.tenantId IS NOT NULL`. Never overwritten. |
| `skippedMissingAttendanceRecord` | `audit_logs.entityId` does not match any `attendance_records.id`. |
| `skippedAttendanceWithoutTenant` | Joined `attendance_records.tenantId IS NULL`. Ambiguous; safer to leave alone. |
| `skippedWrongEntity` | `audit_logs.entity <> 'AttendanceRecord'`. Out of scope. |

The script also produces classification counts in the report so
operators can see the full population before deciding.

## 6. Idempotency

- Dry-run never writes.
- Apply UPDATE is idempotent: the WHERE clause excludes rows that
  already have non-NULL `tenantId`. A second run finds zero
  candidates and writes zero rows.

## 7. Production safety notes

- **No schema migration.** Phase 2.50 is data-only.
- **No runtime change.** The `AttendanceService` code path is
  unchanged. New audit rows continue to flow through Phase 2.48's
  `TenantAuditLogService.write`.
- **No cross-module impact.** The UPDATE filters on
  `entity = 'AttendanceRecord'`. Audit rows for other modules are
  untouched.
- **Scoped raw SQL.** The single UPDATE statement is parameter-free
  and visible in source for review. It lives in
  `scripts/saas/phase2/attendance-audit-backfill.ts` (gated by tag
  `phase250-attendance-audit-backfill`).
- **Apply gate is double-locked.** Both
  `ATTENDANCE_AUDIT_BACKFILL_APPLY=true` AND
  `SAFE_CLONE/SAFE_STAGING` classification must hold; otherwise the
  script silently downgrades to dry-run and records the refusal
  reason in the report.

## 8. Harness — `attendance-audit-backfill-harness` 13/13 PASS

```
[attendance-audit-backfill-harness] 13/13 PASS
```

1. dry-run updates zero rows
2. dry-run reports correct candidate count
3. apply refused when `ATTENDANCE_AUDIT_BACKFILL_APPLY=false`
4. apply refused outside SAFE_CLONE/SAFE_STAGING (source gate)
5. apply updates only AttendanceRecord rows with matching `ar.tenantId`
6. apply does not overwrite already tenant-stamped rows
7. apply skips missing AttendanceRecord entityId
8. apply skips attendance rows with NULL tenantId
9. apply does not touch non-AttendanceRecord audit rows
10. seeded candidate becomes tenant-stamped after apply
11. rerun apply is idempotent (zero updates)
12. backfill module exports `runBackfill` and uses env+SAFE guards
13. scanner registers `phase250-attendance-audit-backfill`

## 9. Validation results

- `nest build` clean
- `npx prisma validate` clean
- `npm run saas:validate` 6/6 suites
- `npm run saas:schema-lint` 0 issues
- `npm run saas:scan:annotations` 0 findings
- `npm run saas:scan:raw-sql` 26 findings (baseline unchanged — the
  attendance backfill SQL lives in `scripts/`, not `src/`)
- All Phase 2.47–2.49 attendance harnesses green
- Full sentinel chain green

## 10. Rollback

**Configuration rollback alone is not sufficient for an applied
backfill.** Set the apply flag back to default to disable future
runs, but the data change remains:

```sh
ATTENDANCE_AUDIT_BACKFILL_APPLY=false   # disables future apply
```

To reverse the data change, you need a **pre-apply snapshot** of
the affected rows. The recommended capture, executed BEFORE running
apply in production:

```sh
psql ... -c "\copy (
  SELECT id, \"tenantId\" FROM audit_logs
  WHERE entity = 'AttendanceRecord' AND \"tenantId\" IS NULL
) TO 'phase250_pre_apply_snapshot.csv' CSV"
```

Then to roll back:

```sql
-- Restore NULL-tenant for ids in the snapshot
UPDATE audit_logs SET "tenantId" = NULL
WHERE id IN (SELECT id FROM phase250_pre_apply_snapshot);
```

In the staging fixture `saas_phase1_fixture` this phase's harness
exercises apply mode against a controlled seeded subset; restore by
re-running the fixture extension.

## 11. Recommended next phase

**2.51 — Cross-module audit row tenant backfill.** Generalise the
Phase 2.50 single-entity pattern to other entities whose tenant
denormalisation has rolled out
(`Document`, `FinancialRecord`, `WorkPermit`, `Visa`,
`ComplianceAlert`, `Notification`). Each entity gets its own
gated, dry-run-first script following this template.
