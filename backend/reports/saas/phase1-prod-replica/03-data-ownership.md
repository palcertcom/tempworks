# Audit C — Data Ownership

- **Status:** WARN
- **Started:** 2026-05-09T14:52:54.660Z
- **Duration:** 65 ms

## Metrics

| Key | Value | Note |
|-----|-------|------|
| `applicants.total` | 72 |  |
| `applicants.distinct-owners` | 2 |  |
| `applicants.null-owner` | 0 |  |
| `employees.total` | 29 |  |
| `employees.distinct-owners` | 2 |  |
| `employees.null-owner` | 0 |  |
| `job_ads.total` | 3 |  |
| `documents.total` | 52 |  |
| `attendance_records.total` | 0 |  |
| `attendance_locked_periods.total` | 2 |  |
| `financial_records.total` | 1 |  |
| `workflows.total` | 3 |  |
| `reports.total` | 2 |  |
| `reports.distinct-owners` | 1 |  |
| `reports.null-owner` | 0 |  |
| `notifications.total` | 5 |  |
| `notifications.distinct-owners` | 5 |  |
| `notifications.null-owner` | 0 |  |
| `vehicles.total` | 3 |  |
| `vehicles.distinct-owners` | 3 |  |
| `vehicles.null-owner` | 1 |  |
| `identifier_sequences.total` | 2 |  |
| `audit_logs.total` | 1 |  |
| `audit_logs.distinct-owners` | 1 |  |
| `audit_logs.null-owner` | 0 |  |
| `workshops.total` | 1 |  |

## Findings

- **[INFO]** `model.job_ads.no-direct-ownership` — NO ownership column today (global slug)
- **[INFO]** `model.documents.no-direct-ownership` — entity-keyed; tenancy via parent
- **[INFO]** `model.attendance_records.no-direct-ownership` — via Employee
- **[INFO]** `model.attendance_locked_periods.no-direct-ownership` — GLOBAL today; must become per-tenant
- **[INFO]** `model.financial_records.no-direct-ownership` — entity-keyed
- **[INFO]** `model.workflows.no-direct-ownership` — no ownership; system-template + clone-on-use planned
- **[WARN]** `model.vehicles.null-owner` — 1 rows with NULL agencyId — must be reconciled before backfill.
- **[INFO]** `model.identifier_sequences.no-direct-ownership` — GLOBAL today; must become per-tenant
- **[INFO]** `model.workshops.no-direct-ownership` — GLOBAL today; review per-tenant ownership

## Notes
- Models with `entity-keyed` ownership (Document, FinancialRecord) need a tenantId denorm in Phase 2 derived from the parent entity at backfill time.
- Global models (workshops, identifier_sequences, attendance_locked_periods) require a per-tenant split decision before any backfill writes.
