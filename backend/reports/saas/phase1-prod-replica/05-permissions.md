# Audit E — Permissions / RBAC

- **Status:** INFO
- **Started:** 2026-05-09T14:52:58.789Z
- **Duration:** 31 ms

## Metrics

| Key | Value | Note |
|-----|-------|------|
| `roles.total` | 5 |  |
| `permissions.total` | 5 |  |
| `role-permission.total` | 0 |  |
| `agency-user-permissions.total` | 0 |  |
| `agency-permission-overrides.total` | 0 |  |
| `employee-agency-access.total` | 2 |  |
| `users.system-level` | 2 |  |

## Findings

- **[INFO]** `roles.snapshot` — Found 5 roles.
  ```json
  [{"id":"00000000-0000-0000-0000-000000000004","name":"Compliance Officer","isSystem":false},{"id":"00000000-0000-0000-0000-000000000002","name":"HR Manager","isSystem":false},{"id":"00000000-0000-0000-0000-000000000005","name":"Read Only","isSystem":false},{"id":"00000000-0000-0000-0000-000000000003","name":"Recruiter","isSystem":false},{"id":"00000000-0000-0000-0000-000000000001","name":"System Admin","isSystem":true}]
  ```
- **[INFO]** `rbac.employee-cross-agency` — 2 cross-agency employee grants — these become AgencyMembership rows in Phase 1.
- **[INFO]** `rbac.platform-admin-projection` — 2 users have system-level access today; PlatformAdmin backfill input.
  ```json
  [{"id":"4634432d-de83-4376-8539-951ad54ba186","email":"admin1@tempworks.test","via":"system-agency"},{"id":"2306089e-3968-4ba0-877f-ab46593696c6","email":"admin2@tempworks.test","via":"system-agency"}]
  ```

## Notes
- Each existing User.roleId is cloned into one MembershipRole at backfill (one membership per existing User × Agency pair).
- agency_user_permission rows are migrated 1:1 into MembershipPermissionOverride keyed by membershipId.
