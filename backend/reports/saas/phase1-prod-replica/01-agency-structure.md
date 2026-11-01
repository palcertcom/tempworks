# Audit A — Agency Structure

- **Status:** INFO
- **Started:** 2026-05-09T14:52:50.324Z
- **Duration:** 83 ms

## Metrics

| Key | Value | Note |
|-----|-------|------|
| `agencies.total` | 5 |  |
| `agencies.isSystem` | 1 |  |
| `agencies.with-parent` | 0 |  |
| `users.distinct-agencies` | 4 |  |
| `agencies.empty-customer` | 2 |  |
| `phase1.candidate-tenants` | 4 |  |

## Findings

- **[INFO]** `agency.empty` — 2 customer agencies have no users/employees/applicants — verify they should still become tenants.
  ```json
  [{"id":"44444444-4444-4444-4444-444444444444","name":"Empty Co"},{"id":"33333333-3333-3333-3333-333333333333","name":"Initech"}]
  ```
- **[INFO]** `phase1.tenant-projection` — Phase 1 backfill projects 4 new Tenant rows (one per non-system Agency).

## Notes
- Per ADR-003: each non-system Agency becomes a Tenant (id reused) plus a Default sub-Agency.
- isSystem agencies are not created as Tenants; their users become PlatformAdmin rows.
