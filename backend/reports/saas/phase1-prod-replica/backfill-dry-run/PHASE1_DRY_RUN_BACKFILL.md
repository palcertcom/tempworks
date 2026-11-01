# Phase 1 — Dry-Run Tenant Backfill Result

- **Mode:** `dry-run`
- **Status:** **ROLLED_BACK**
- **Database:** `postgres://postgres@127.0.0.1/saas_phase1_fixture?sslmode=disable`
- **Started:** 2026-05-09T14:53:16.290Z
- **Duration:** 63 ms

## Pre-flight summary

| Check | Count |
|-------|-------|
| duplicate emails | 0 |
| NULL-agency users | 1 |
| employee email collisions | 0 |
| employee code collisions | 1 |

## Projection

| Agency | Tenant Slug | Conflicts |
|--------|-------------|-----------|
| Acme HR | `acme-hr` | — |
| Globex Co. | `globex-co` | — |
| Initech | `initech` | — |
| Empty Co | `empty-co` | — |

## Writes (rolled back unless --apply)

- tenants: **4**
- defaultAgencies: **4**
- memberships: **11**
- agencyMemberships: **11**
- membershipRoles: **11**
- membershipPermissionOverrides: **0**
- platformAdmins: **2**
- quarantineRows: **1**
- tenantIdAssignments: {"applicants":72,"employees":29,"vehicles":2}

## Verification

| Check | OK | Detail |
|-------|----|--------|
| tenants.count | PASS | {"actual":4,"expected":4} |
| users.with-agency-have-membership | PASS | {"count":0} |
| users.no-agency.handled | PASS | {"count":0} |
| applicants.tenantId-populated | PASS | {"stillNull":0} |
| employees.tenantId-populated | PASS | {"stillNull":0} |
| tenants.no-duplicate-slug | PASS | {"duplicates":0} |
| tenant_memberships.no-duplicate-pair | PASS | {"duplicates":0} |
| checkpoint.no-partial | PASS | {"partial":0} |

## Diff Summary (pre-run vs in-tx counts)

| Table | Before | After | Δ |
|-------|--------|-------|---|
| `agencies` | 5 | 4 | -1 |
| `users` | 14 | 14 | 0 |
| `employees` | 29 | 29 | 0 |
| `applicants` | 72 | 72 | 0 |
| `vehicles` | 3 | 3 | 0 |
| `tenants` | 0 | 4 | +4 |
| `tenant_memberships` | 0 | 11 | +11 |
| `agency_memberships` | 0 | 11 | +11 |
| `membership_roles` | 0 | 11 | +11 |
| `membership_permission_overrides` | 0 | 0 | 0 |
| `platform_admins` | 0 | 2 | +2 |
| `agency_split_progress` | 0 | 4 | +4 |
| `saas_reconciliation_queue` | 0 | 1 | +1 |

> In `--dry-run`, the "After" column reflects what would have been written before ROLLBACK. The persisted database state is unchanged.

## Rollback notes

- `--dry-run`: ROLLBACK is automatic; no recovery needed.
- `--apply` on staging: re-running `dry-run-tenant-backfill --resume` is idempotent. To revert the entire backfill, restore the pre-run snapshot.
- The original `agencies` rows are deleted at backfill step 5.4. Database restore is the only revert path once `--apply` commits.
- Detected partial state from a prior run? Pass `--resume` to continue, or DELETE FROM agency_split_progress and start over.

## Notes

- This script does NOT touch identifier_sequences (TKT-P1-05).
- This script does NOT migrate Document/FinancialRecord tenantId (Phase 2).
- Re-running this script in --apply mode is idempotent due to the agency_split_progress checkpoint.
- Roll back any --apply by restoring from the pre-migration snapshot — the original `agencies` rows are deleted.
