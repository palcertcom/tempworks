# Phase 1 Pre-Flight Summary

- **Generated:** 2026-05-09T14:53:03.567Z
- **Overall status:** **BLOCKER**
- **Risk:** HIGH — backfill must NOT proceed.

## Per-suite

| Suite | Status | Findings |
|------|--------|----------|
| `01-agency-structure` | **INFO** | 2 |
| `02-user-identity` | **BLOCKER** | 2 |
| `03-data-ownership` | **WARN** | 9 |
| `04-uniqueness-collisions` | **BLOCKER** | 4 |
| `05-permissions` | **INFO** | 3 |
| `06-storage` | **WARN** | 3 |
| `07-reports-sql` | **BLOCKER** | 2 |

## Blocking issues (must resolve before backfill)

- **`02-user-identity` / `user.no-agency`** — 1 users have NULL agencyId. Each must be reconciled (delete, assign, or platform-admin).
- **`04-uniqueness-collisions` / `unique.employee-code`** — 1 employee codes appear in 2+ agencies; will collide on (tenantId,employeeCode).
- **`04-uniqueness-collisions` / `unique.identifier-sequences`** — identifier_sequences has 2 GLOBAL rows — backfill MUST initialise per-tenant counters from existing identifiers before any insert lands on the new key.
- **`07-reports-sql` / `reports.raw-sql-without-tenant-column`** — Found 13 raw-SQL occurrences but no source declares `tenantColumn`. Phase 3 reports refactor (ADR-007) MUST land before Phase 2 enforcement.

## Warnings (recommended to resolve)

- **`03-data-ownership` / `model.vehicles.null-owner`** — 1 rows with NULL agencyId — must be reconciled before backfill.
- **`04-uniqueness-collisions` / `unique.attendance-locked`** — attendance_locked_periods has 2 GLOBAL rows — must be replicated per tenant on backfill.
- **`06-storage` / `storage.missing-pointer`** — 1 documents have neither storageKey nor storageUrl. Investigate; rekey-skip on Phase 3.
- **`06-storage` / `storage.local-path`** — 1 documents reference a legacy local /uploads path (sample: /uploads/documents/legacy.pdf).
- **`06-storage` / `storage.public-spaces`** — 50 documents stored as public-readable Spaces URLs (no signature). Will be rekeyed to tenants/<tenantId>/... in Phase 3.

## Recommended manual decisions

- Confirm slug for each backfilled tenant (default: kebab-case of agency name; collision-suffixed).
- Confirm PlatformAdmin level for each system-agency user (default: SUPPORT; promote on request).
- Confirm disposition for `users.no-agency` rows (assign / deactivate / promote-to-platform-admin).
- Confirm `attendance_locked_periods` per-tenant policy (replicate existing locks across all tenants by default).
- Confirm `Workshop` / `MaintenanceType` / `DocumentType` catalog vs override resolution policy.
