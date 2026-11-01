# Audit B — User Identity

- **Status:** BLOCKER
- **Started:** 2026-05-09T14:52:52.522Z
- **Duration:** 31 ms

## Metrics

| Key | Value | Note |
|-----|-------|------|
| `users.total` | 14 |  |
| `users.soft-deleted` | 1 |  |
| `users.null-email` | 0 |  |
| `users.duplicate-emails` | 0 |  |
| `users.no-agency` | 1 |  |
| `users.system-agency` | 2 |  |
| `tenant_memberships.preexisting` | 0 |  |
| `users.status-counts` | [{"status":"ACTIVE","n":13},{"status":"INACTIVE","n":1}] |  |

## Findings

- **[BLOCKER]** `user.no-agency` — 1 users have NULL agencyId. Each must be reconciled (delete, assign, or platform-admin).
- **[INFO]** `user.platform-admin-candidates` — 2 users belong to the system agency. They become PlatformAdmin rows.
  ```json
  [{"id":"4634432d-de83-4376-8539-951ad54ba186","email":"admin1@tempworks.test"},{"id":"2306089e-3968-4ba0-877f-ab46593696c6","email":"admin2@tempworks.test"}]
  ```

## Notes
- Pre-flight contract: users.duplicate-email and users.null-email MUST be 0 before backfill.
- NULL agencyId users require manual disposition (assign, deactivate, or platform-admin).
