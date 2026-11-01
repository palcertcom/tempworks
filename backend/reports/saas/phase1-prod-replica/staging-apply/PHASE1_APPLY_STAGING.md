# Phase 1 — Staging Apply Orchestrator

- **Mode:** apply
- **Database:** `postgres://postgres@127.0.0.1/saas_phase1_fixture?sslmode=disable`
- **NODE_ENV:** unset
- **Allowed:** true
- **Overall:** OK

| Stage | Result | Exit | Duration |
|-------|--------|------|----------|
| preflight | OK | 3 | 19120 ms |
| recon-A-user-identity | OK | 0 | 1761 ms |
| recon-B-agency-tenant-projection | OK | 0 | 1877 ms |
| recon-C-unique-constraints | OK | 0 | 1722 ms |
| recon-D-data-ownership | OK | 0 | 1717 ms |
| recon-E-reports-sql | OK | 0 | 1666 ms |
| tenant-backfill | OK | 0 | 1883 ms |
| seq-snapshot | OK | 0 | 1918 ms |
| verify | OK | 0 | 1880 ms |

## Rollback

- `--dry-run`: nothing to roll back; the tenant backfill ROLLs BACK its own transaction.
- `--apply` on staging: restore the pre-run database snapshot. The tenant backfill is destructive at step 5.4 (DELETE FROM agencies WHERE id = old).
- Re-running `--apply` is idempotent for stages 1, 2, 4, 5; stage 3 supports `--resume` via `agency_split_progress`.
