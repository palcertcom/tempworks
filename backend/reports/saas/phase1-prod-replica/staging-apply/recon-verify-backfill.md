# Phase 1 — Tenant Backfill Verifier

- **Mode:** `dry-run`
- **Status:** **OK**
- **Database:** `postgres://postgres@127.0.0.1/saas_phase1_fixture?sslmode=disable`
- **Started:** 2026-05-09T14:54:27.930Z
- **Duration:** 55 ms

## Metrics

| Key | Value | Note |
|-----|-------|------|
| `tenants.count` | 4 |  |
| `platform_admins.count` | 2 |  |
| `reconciliation_queue.pending` | 16 |  |

## Actions

| Kind | Applied | Proposed | Subject |
|------|---------|----------|---------|
| `tenants.count-matches-progress` | no | PASS | {"tenants":4,"progressDone":4} |
| `tenants.have-default-agency` | no | PASS | {"withoutDefault":0} |
| `users.with-agency-have-membership` | no | PASS | {"count":0} |
| `users.no-agency.handled` | no | PASS | {"count":0} |
| `memberships.have-agency-membership` | no | PASS | {"without":0} |
| `applicants.tenantId-populated` | no | PASS | {"stillNull":0} |
| `employees.tenantId-populated` | no | PASS | {"stillNull":0} |
| `vehicles.tenantId-populated` | no | PASS | {"stillNull":0} |
| `platform_admins.exists` | no | PASS | {"count":2} |
| `tenants.no-duplicate-slug` | no | PASS | {"dupes":0} |
| `memberships.no-duplicate-pair` | no | PASS | {"dupes":0} |
| `checkpoint.no-partial` | no | PASS | {"n":0,"samples":null} |
| `reconciliation.queue-pending` | no | SKIPPED | {"pending":16} |

## Notes
- Verification PASSED: 12 pass, 0 fail, 1 skipped
