# Audit D — Uniqueness Collisions

- **Status:** BLOCKER
- **Started:** 2026-05-09T14:52:56.747Z
- **Duration:** 49 ms

## Metrics

| Key | Value | Note |
|-----|-------|------|
| `employees.email.cross-tenant-collisions` | 0 |  |
| `employees.employeeCode.cross-tenant-collisions` | 1 |  |
| `job_ads.total` | 3 |  |
| `reports.total` | 2 |  |
| `attendance_locked_periods.total` | 2 |  |
| `identifier_sequences.total` | 2 |  |

## Findings

- **[BLOCKER]** `unique.employee-code` — 1 employee codes appear in 2+ agencies; will collide on (tenantId,employeeCode).
  ```json
  [{"value":"common-001","owners":["11111111-1111-1111-1111-111111111111","22222222-2222-2222-2222-222222222222"]}]
  ```
- **[INFO]** `unique.report-name` — All 2 report names are globally unique today; (tenantId,name) backfill will be conflict-free.
- **[WARN]** `unique.attendance-locked` — attendance_locked_periods has 2 GLOBAL rows — must be replicated per tenant on backfill.
- **[BLOCKER]** `unique.identifier-sequences` — identifier_sequences has 2 GLOBAL rows — backfill MUST initialise per-tenant counters from existing identifiers before any insert lands on the new key.

## Notes
- Cross-tenant collisions on (tenantId, X) are pre-flight blockers; reconcile by either renaming or merging in coordination with Product.
- Identifier-sequence backfill is the single most important pre-cutover step (see SAAS_PHASE1_TENANT_BACKFILL_ALGORITHM.md).
