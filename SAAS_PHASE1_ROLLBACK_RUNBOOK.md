# Phase 1 — Rollback Runbook

> Phase 1 backfill is **destructive at step 5.4** (it deletes the original `agencies` rows whose IDs are reused as `tenants.id`). Once `--apply` commits, the only way back is **restore from snapshot**.

## Decision tree

```
Did the backfill commit (--apply succeeded)?
│
├── No  →  rollback is automatic (--dry-run ROLLBACK), or partial
│          state can be cleared with ROLLBACK at the failed point.
│          Skip to §A.
│
└── Yes →  the original agencies rows are gone.
            Skip to §B.
```

## §A — Rollback before commit

| Failure point | Recovery |
|---|---|
| Preflight returned BLOCKER | No writes performed. Reconcile, re-run preflight. |
| Reconciliation `--apply` failed mid-run | Each script writes to `saas_reconciliation_queue` with `INSERT … ON CONFLICT DO NOTHING`; safe to re-run. |
| Dry-run backfill threw inside the per-agency tx | `agency_split_progress` records `FAILED:<sqlstate>`. Re-run with `--resume` to skip `DONE` agencies. The failed agency must be triaged manually. |
| Seq-snapshot threw | `DELETE FROM saas_phase1_seq_snapshot;` and re-run. |
| Verify-backfill returned FAIL | The data was committed but verifications failed. Treat as §B (snapshot restore) UNLESS the failure is purely metadata (e.g. quarantine queue size). |

### Cleaning a partial state

If `agency_split_progress` has rows but you want a clean restart:

```sql
BEGIN;
TRUNCATE agency_split_progress;
TRUNCATE saas_reconciliation_queue;
TRUNCATE saas_phase1_seq_snapshot;
COMMIT;
```

This does **not** undo a committed backfill — see §B for that.

## §B — Rollback after commit

The only path is **restore the pre-migration snapshot**.

### Steps

1. **Pause writes** (HTTP traffic drained at the load balancer).
2. **Identify the snapshot id** from the change record.
3. **Restore** to a new database name (`saas_phase1_rollback_target`):
   ```sh
   pg_restore -h ... -d saas_phase1_rollback_target snapshot.dump
   ```
4. **Switch DATABASE_URL** in the running app via deploy config (no code change).
5. **Re-run smoke tests** (recruitment, attendance, payroll-lock).
6. **Resume traffic**.

The original DB (with the partial Phase 1 state) is preserved for forensics; do **not** delete for at least 30 days.

### Why no in-place rollback exists

- The split deletes the original `agencies` row at step 5.4.
- All FKs that pointed at that row have been re-pointed at the new `Default Agency` UUID.
- Re-creating the original row would not restore the FKs without a separate UPDATE pass — equivalent in cost/risk to a snapshot restore.
- Snapshot restore preserves auxiliary state (audit logs, sessions) that an in-place rollback would diverge.

## Phase 1 prep migration rollback

The `saas_phase1_tenant_backfill_prepare/migration.sql` is reversible via `migration.down.sql` **only if no data has been written** to the new columns/tables.

```sh
# Safe before backfill runs:
psql "$DATABASE_URL" -f backend/prisma/migrations/saas_phase1_tenant_backfill_prepare/migration.down.sql
```

If `tenant_memberships`, `platform_admins`, etc. have rows, the script will fail (FK references). In that case:

```sql
-- WARNING: destroys all backfilled tenancy state. Use only in conjunction
-- with a snapshot restore.
BEGIN;
TRUNCATE tenant_memberships, agency_memberships, membership_roles,
         membership_permission_overrides, tenant_domains, tenants,
         platform_admins, platform_audit_logs,
         agency_split_progress, saas_reconciliation_queue,
         saas_phase1_seq_snapshot CASCADE;
COMMIT;
-- Then run migration.down.sql.
```

## Phase 0 foundation rollback

The Phase 0 migration (`saas_phase0_foundations`) creates the initial 8 tables. Roll back via its own `migration.down.sql`:

```sh
psql "$DATABASE_URL" -f backend/prisma/migrations/saas_phase0_foundations/migration.down.sql
```

Same constraint: no rows in those tables, otherwise truncate first.

## Validation after any rollback

```sh
npm run saas:validate         # 28 tests must pass
npm run saas:schema-lint      # 0 issues
npm run saas:phase1-preflight # status reflects current DB state
```

The application must boot clean (`npm run start`); Phase 0 invariants apply (flags off; no behaviour change).

## Communications

- **Engineering leads** notified within 5 min of rollback decision.
- **Customer-facing tenants** notified within 30 min if user-visible behaviour was affected (Phase 1 alone should not be visible).
- **Post-mortem** within 5 working days; archived alongside the run reports.
