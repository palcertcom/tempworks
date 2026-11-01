# Phase 2.3 — Entity-Keyed `tenantId` Backfill Results

> Source of truth: `backend/reports/saas/phase2/entity-tenantid-backfill.{json,md}`,
> regenerated whenever the backfill is run.

---

## 1. Run summary (staging fixture, apply mode)

| Field | Value |
|------|------|
| Mode | `apply` |
| Database | `postgres://postgres@127.0.0.1/saas_phase1_fixture?sslmode=disable` |
| Models processed | 15 |
| Rows backfilled | **56** |
| Rows quarantined | 2 |
| Reconciliation queue rows inserted | 2 |
| Models skipped (table not present in fixture) | 11 |
| Generated | 2026-05-09 |

## 2. Per-model breakdown

| Model | Applied | Pending | Quarantined | Notes |
|-------|--------:|--------:|------------:|-------|
| `documents` | 52 | 0 | 0 | All 52 rows resolved via `entityId → employees|applicants|agencies` |
| `financial_records` | 1 | 0 | 0 | Single record resolved via `entityId → employees` |
| `attendance_records` | 0 | 0 | 0 | No rows in fixture |
| `notifications` | 3 | 0 | 2 | 2 rows have a `userId` whose user has `agencyId=NULL` (platform-admin notifications). Quarantined as orphans. |
| `work_permits` | — | — | — | table not present (skipped) |
| `visas` | — | — | — | table not present (skipped) |
| `compliance_alerts` | — | — | — | table not present (skipped) |
| `financial_record_attachments` | — | — | — | table not present (skipped) |
| `financial_record_deductions` | — | — | — | table not present (skipped) |
| `vehicle_documents` | — | — | — | table not present (skipped) |
| `maintenance_records` | — | — | — | table not present (skipped) |
| `candidate_workflow_assignments` | — | — | — | table not present (skipped) |
| `employee_workflow_assignments` | — | — | — | table not present (skipped) |
| `employee_work_history` | — | — | — | table not present (skipped) |
| `employee_work_history_attachments` | — | — | — | table not present (skipped) |

The 11 "skipped" rows reflect the staging fixture, not the production
schema. Production runs are expected to fully exercise all 15 models.

## 3. Quarantine analysis

The two quarantined rows are platform-admin notifications: their `userId`
points to a user whose `agencyId` is NULL (intentional, those users are
not scoped to any agency). The script wrote them to
`saas_reconciliation_queue` with kind
`tenantid-denorm.notifications.unresolved-parent` and a reason of
`user has no agencyId`. Operator action: assign these notifications to a
tenant explicitly via the reconciliation tooling (Phase 2.4 work item)
or accept that platform-admin notifications stay tenantless.

No quarantine entry indicates corruption — every entry is a row whose
parent chain genuinely does not lead to a single tenant. The original
`tenantId` column on each quarantined row remains NULL.

## 4. Safety posture during this run

- `ALLOW_SAAS_STAGING_MUTATION=true` was set explicitly.
- `npm run saas:env-safety` returned `SAFE_CLONE` (localhost +
  `saas_phase1_fixture` pattern) — `--apply` accepted.
- No production hosts touched; production `tenantId` columns remain
  identical to before this branch.
- No existing column, index, or FK was modified. Schema diff is
  additive-only.

## 5. Reproducing

```sh
cd backend
DATABASE_URL=... ALLOW_SAAS_STAGING_MUTATION=true \
  npm run saas:phase2-backfill-entity-tenantids -- --apply
```

To audit the queue afterwards:

```sql
SELECT kind, payload->>'reason' AS reason, count(*)
  FROM saas_reconciliation_queue
 WHERE kind LIKE 'tenantid-denorm.%'
 GROUP BY 1, 2 ORDER BY 1, 2;
```
