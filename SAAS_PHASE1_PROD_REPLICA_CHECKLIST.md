# Phase 1 — Production Replica Pre-Flight Checklist

For `TKT-P1-02` and the second staging dry-run (`TKT-P1-08`). The point is: **read real production data, write nothing**.

## Provisioning

- [ ] Create a new logical replica from production. Name it `tempworks_phase1_replica_<date>`.
- [ ] Make it READ-ONLY at the database level (`ALTER DATABASE … SET default_transaction_read_only = on;`) **OR** revoke `INSERT/UPDATE/DELETE` from the script's role.
- [ ] PII handling: confirm replica is in the same security zone as prod. If exporting reports, scrub before sharing.
- [ ] Connection string never logged.

## Environment

- [ ] `DATABASE_URL` exported.
- [ ] `NODE_ENV` is **not** `production`.
- [ ] `ALLOW_SAAS_STAGING_MUTATION` is **not** set.
- [ ] No `--apply` flags used.

## Migrations on the replica

- [ ] Apply `saas_phase0_foundations/migration.sql`. Idempotent; safe.
- [ ] Apply `saas_phase1_tenant_backfill_prepare/migration.sql`. Idempotent; safe.
- [ ] Confirm new tables exist; existing tables unchanged.

## Run preflight

- [ ] `npm run saas:phase1-preflight` runs to completion.
- [ ] `PHASE1_PREFLIGHT_SUMMARY.md` archived.
- [ ] Tally: BLOCKER count, WARN count, INFO count.

## Run reconciliations (read-only / dry-run)

- [ ] All five recon scripts in default (no `--apply`) mode.
- [ ] Each `recon-*.json` archived.
- [ ] Confirm no rows written to the replica (compare `pg_stat_user_tables.n_tup_ins` before/after on `saas_reconciliation_queue`).

## Run dry-run backfill (no `--apply`)

- [ ] `saas:phase1-backfill-dry-run --max-quarantine 0` (extra strict for the first read-only pass).
- [ ] Status `ROLLED_BACK`.
- [ ] Diff summary archived.

## Manual triage

- [ ] Open the JSON outputs; route each finding to its owner per `SAAS_PHASE1_BLOCKER_RESOLUTION_REPORT.md`:
  - User identity → Data steward + Product
  - Tenant projection / slugs → Product
  - Unique-constraint collisions → Product (sign-off only) + Backend
  - Data ownership → Data steward
  - Reports SQL → Backend (Phase 2 input)
- [ ] Each owner produces a written disposition (email or ticket comment) within 5 working days.

## Outputs

- [ ] All reports committed to a security-tracked repository (NOT public).
- [ ] Decision log started; will become input to Stage 3 (queue drain) of `SAAS_PHASE1_EXECUTION_RUNBOOK.md`.

## Acceptance

The replica preflight is complete when:
- The reconciliation worklist is **fully assigned** (every finding has an owner).
- The aggregate count of unresolved BLOCKER findings is `0`.
- No `--apply` was performed.

## Cleanup

- [ ] Mark replica for retention through cutover + 30 days.
- [ ] Schedule destruction of the replica + any extracted reports per data-retention policy.

---

## Step 0 — Mandatory environment safety probe (added 2026-05-09)

Before doing anything else on the replica:

```sh
DATABASE_URL=... npm run saas:env-safety
```

Expected classifications and actions:

- `SAFE_CLONE` / `SAFE_STAGING` → proceed with the rest of this checklist.
- `READONLY_REPLICA` → only the read-only audits in steps 4–5 are valid; skip steps 6–10.
- `UNSAFE_PRODUCTION` / `UNKNOWN` → **stop**. Update the classifier allow-list with the actual replica hostname or fix DATABASE_URL.

The classifier output is archived as `backend/reports/saas/phase1-prod-replica/env-safety.json` and must be attached to the change record.
