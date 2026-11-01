# Recon C — Unique Constraint Reconciliation

- **Mode:** `dry-run`
- **Status:** **BLOCKER**
- **Database:** `postgres://postgres@127.0.0.1/saas_phase1_fixture?sslmode=disable`
- **Started:** 2026-05-09T14:53:10.262Z
- **Duration:** 39 ms

## Metrics

| Key | Value | Note |
|-----|-------|------|
| `employees.email.cross-tenant-pairs` | 0 |  |
| `employees.employeeCode.cross-tenant-pairs` | 1 |  |
| `job_ads.reserved-slug-count` | 0 |  |
| `reports.global-name-dupes` | 0 |  |
| `identifier_sequences.global-rows` | 2 |  |
| `attendance_locked_periods.global-rows` | 2 |  |

## Actions

| Kind | Applied | Proposed | Subject |
|------|---------|----------|---------|
| `collision.employee-code` | no | accept-as-tenant-scoped (no rename) | rename-one | merge | {"value":"common-001","ownerAgencies":["11111111-1111-1111-1111-111111111111","22222222-2222-2222-2222-222222222222"],"exampleIds":["51117ddf-170d-43fb-b98e-6e5170cbeee0","24edee8b-f235-413d-bbd2-87a3 |
| `collision.identifier-sequences` | no | run TKT-P1-05 (seq-snapshot) before cutover | {"rowsToSnapshot":2,"sample":[{"prefix":"A","year":2025,"month":1,"value":250},{"prefix":"E","year":2025,"month":1,"value":87}]} |
| `collision.attendance-locked-period` | no | replicate-to-every-tenant (default) | per-tenant-policy | {"year":2025,"month":1} |
| `collision.attendance-locked-period` | no | replicate-to-every-tenant (default) | per-tenant-policy | {"year":2025,"month":2} |

## Notes
- Identifier-sequences are the one HARD blocker: per-tenant rows must exist before any application writer cuts over.
- Cross-tenant employee email/code pairs are typically benign once the constraint is scoped — treat as WARN unless Product disagrees.
- Attendance locked periods default to replicate-to-every-tenant; do not change without finance sign-off.
