# Phase 1 — Execution Runbook

> **Audience:** the engineer (or pair) running the Phase 1 cutover.
> **Output of every command:** `backend/reports/saas/phase1/*` (committed to a security-tracked location, not the public repo).

This runbook ASSUMES `SAAS_PHASE1_PROD_REPLICA_CHECKLIST.md` and `SAAS_PHASE1_STAGING_APPLY_CHECKLIST.md` are signed off.

---

## 0. Preconditions

```sh
# Branch is up to date with main; Phase 0 + Phase 1-prep merged
git pull
cd backend && npm ci

# `prisma generate` must succeed
DATABASE_URL=... npx prisma generate
```

Five sign-offs from `SAAS_PHASE1_DATA_RECONCILIATION_PLAN.md` §6 must be present in `saas_reconciliation_queue.decided_by`.

## 1. Prepare environment

```sh
# Choose target (staging or prod).
# DO NOT set NODE_ENV=production for the apply script unless you have
# the necessary security review.
export DATABASE_URL='postgres://...'
```

For `--apply` against staging, also:

```sh
export ALLOW_SAAS_STAGING_MUTATION=true
```

## 2. Stage 1 — preflight (read-only)

```sh
npm run saas:phase1-preflight
```

Inspect `backend/reports/saas/phase1/PHASE1_PREFLIGHT_SUMMARY.md`. Status must be `OK` or `WARN` (with sign-offs); never proceed past `BLOCKER`.

## 3. Stage 2 — reconciliation queue (write proposals)

Run all five in `--apply` mode (writes only to `saas_reconciliation_queue` and Phase 1 prep additive columns):

```sh
npm run saas:phase1-recon-A -- --apply
npm run saas:phase1-recon-B -- --apply
npm run saas:phase1-recon-C -- --apply
npm run saas:phase1-recon-D -- --apply
npm run saas:phase1-recon-E -- --apply
```

## 4. Stage 3 — drain the reconciliation queue

Operations triages each `saas_reconciliation_queue` row, setting `decision` and `decided_by`. The queue CLI (TKT-P1-07; not in this repo yet) is the canonical tool; until then use raw SQL:

```sql
UPDATE saas_reconciliation_queue
   SET decision = 'platform-admin:SUPER',
       decided_by = 'security-team',
       decided_at = now()
 WHERE kind = 'user.platform-admin-candidate' AND id = ?;
```

After draining, re-run preflight; expect status ≤ `WARN`.

## 5. Stage 4 — dry-run tenant backfill

```sh
npm run saas:phase1-backfill-dry-run -- --max-quarantine 50
```

Inspect `backend/reports/saas/phase1/PHASE1_DRY_RUN_BACKFILL.md`. Verification table must show all PASS. Status `ROLLED_BACK`.

If the script reports partial state (e.g. `agency_split_progress` non-empty), pass `--resume`:

```sh
npm run saas:phase1-backfill-dry-run -- --resume --max-quarantine 50
```

## 6. Stage 5 — identifier-sequence snapshot

```sh
npm run saas:phase1-seq-snapshot
```

Status `OK`. Inspect `recon-seq-snapshot.md`. Phase 2's cutover migration consumes this.

## 7. Stage 6 — verify

```sh
npm run saas:phase1-verify-backfill
```

In the pre-backfill state this returns `OK` with `SKIPPED` projection checks. After `--apply`, expect 12+ PASS, 0 FAIL.

## 8. Stage 7 — apply (staging only)

If everything above is green, run the orchestrator in `--apply`:

```sh
ALLOW_SAAS_STAGING_MUTATION=true \
DATABASE_URL=... \
  npm run saas:phase1-backfill-apply-staging -- --apply
```

The orchestrator runs:
1. preflight
2. all 5 recons (in apply)
3. dry-run-tenant-backfill (in `--apply --resume --max-quarantine 50`)
4. seq-snapshot (in apply)
5. verify

Status must be `OK`. Inspect `backend/reports/saas/phase1/PHASE1_APPLY_STAGING.md`.

## 9. Stage 8 — rehearsal handover

Two clean staging runs are required (first → reset → second). Compare verification reports; differences must be explainable (e.g. clock-skew, slug suffix on a renamed agency).

## 10. Stage 9 — production cutover

**This script does NOT run against production.** The production cutover is a separate ticket (TKT-P1-09) executed during a planned maintenance window with the same scripts but the safety guards consciously disabled by the SRE on call (and audit-logged).

The production runbook is the same shape as this one with the addition of:

- pre-snapshot (PITR + logical dump)
- HTTP write-pause via the load balancer
- post-cutover smoke test of recruitment + attendance flows
- 30-minute observation window before declaring success

## 11. Outputs to archive

- `backend/reports/saas/phase1/PHASE1_PREFLIGHT_SUMMARY.{json,md}`
- `backend/reports/saas/phase1/recon-A..E.{json,md}`
- `backend/reports/saas/phase1/PHASE1_DRY_RUN_BACKFILL.{json,md}`
- `backend/reports/saas/phase1/recon-seq-snapshot.{json,md}`
- `backend/reports/saas/phase1/recon-verify-backfill.{json,md}`
- `backend/reports/saas/phase1/PHASE1_APPLY_STAGING.{json,md}`
- DB snapshot of `saas_reconciliation_queue` post-drain.

---

## Stage 0 — Environment-safety probe (added 2026-05-09)

Run BEFORE Stage 1:

```sh
npm run saas:env-safety
```

The classifier output (printed and saved to `backend/reports/saas/phase1-prod-replica/env-safety.json`) is the gate to proceed. Operators MUST stop on `UNSAFE_PRODUCTION` or `UNKNOWN`. The same classifier is invoked transitively by every `--apply` script in this runbook; running it here surfaces the verdict early so you don't waste time on a misconfigured host.
