# Audit-log Retention Runbook (top-level pointer)

The operator-facing runbook lives at:

[`docs/runbooks/audit-retention-rollout.md`](./docs/runbooks/audit-retention-rollout.md)

It stitches Phases 2.50–2.54 into one production rollout sequence:

1. Phase 2.50 — Attendance audit-log tenant backfill (data-only, gated).
2. Phase 2.51 — Cross-module audit-log tenant backfill (data-only, gated).
3. Phase 2.52 — Tenant-scoped audit read API + retention preview (read-only).
4. Phase 2.53 — Soft-delete retention enforcement (`deletedAt = now()`, triple-gated).
5. Grace-period wait (`AUDIT_LOG_HARD_DELETE_GRACE_DAYS`, default 90).
6. Phase 2.54 — Hard-delete of rows already soft-deleted past grace (irreversible without full-row snapshot or `pg_dump`).

**Hard-delete cannot be configuration-rolled back.** Production
apply requires `pg_dump audit_logs`, a full-row snapshot, AND
operator approval.

See the runbook for command sequences, snapshot SQL, go/no-go
gates, and the sign-off table.
