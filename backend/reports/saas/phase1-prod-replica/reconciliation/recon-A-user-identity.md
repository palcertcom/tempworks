# Recon A — User Identity

- **Mode:** `dry-run`
- **Status:** **BLOCKER**
- **Database:** `postgres://postgres@127.0.0.1/saas_phase1_fixture?sslmode=disable`
- **Started:** 2026-05-09T14:53:05.810Z
- **Duration:** 33 ms

## Metrics

| Key | Value | Note |
|-----|-------|------|
| `users.duplicate-emails` | 0 |  |
| `users.null-email` | 0 |  |
| `users.invalid-email` | 0 |  |
| `users.no-agency` | 1 |  |
| `users.system-agency` | 2 |  |
| `users.soft-deleted` | 1 |  |

## Actions

| Kind | Applied | Proposed | Subject |
|------|---------|----------|---------|
| `user.no-agency` | no | assign-tenant | platform-admin | deactivate | {"id":"02b109f7-4710-4e82-8906-9ea8c47577ed","email":"orphan@nowhere.test","status":"ACTIVE"} |
| `user.platform-admin-candidate` | no | platform-admin:SUPER (downgrade post-cutover) | {"id":"4634432d-de83-4376-8539-951ad54ba186","email":"admin1@tempworks.test"} |
| `user.platform-admin-candidate` | no | platform-admin:SUPER (downgrade post-cutover) | {"id":"2306089e-3968-4ba0-877f-ab46593696c6","email":"admin2@tempworks.test"} |
| `user.soft-deleted-skipped` | no | skip-from-membership-backfill | {"count":1} |

## Notes
- No user rows are modified by this script. Apply mode only inserts proposals into saas_reconciliation_queue.
- Ops drains the queue with the queue-cli (TKT-P1-07) before backfill runs.
