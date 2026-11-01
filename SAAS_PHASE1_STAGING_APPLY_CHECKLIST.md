# Phase 1 — Staging Apply Checklist

Use this checklist for the **first staging dry-run** and the **second staging dry-run on a fresh clone** (TKT-P1-08). Two clean runs are mandatory before production.

---

## Environment

- [ ] Database is staging (host on staging allow-list).
- [ ] `NODE_ENV != 'production'`.
- [ ] `DATABASE_URL` points to the staging clone.
- [ ] `ALLOW_SAAS_STAGING_MUTATION=true`.
- [ ] Pre-run snapshot taken (`pg_dump` or PITR marker).
- [ ] Smoke-test plan documented.
- [ ] Rollback plan reviewed (`SAAS_PHASE1_ROLLBACK_RUNBOOK.md`).

## Codebase

- [ ] On `claude/design-multitenant-recruitment-8H42T` (or merge-target).
- [ ] `npm ci` completed.
- [ ] `npx prisma generate` succeeded.
- [ ] `npx prisma validate` reports valid.
- [ ] `npm run saas:validate` 28/28 PASS.
- [ ] `npm run saas:schema-lint` 0 issues.
- [ ] `npm run saas:scan` advisory output reviewed (no NEW direct-Prisma usages introduced).

## Migrations applied to staging

- [ ] `saas_phase0_foundations/migration.sql` applied.
- [ ] `saas_phase1_tenant_backfill_prepare/migration.sql` applied.
- [ ] `\d agencies` shows `tenantId`, `isDefault`, `parentId` columns.
- [ ] `\d employees`, `\d applicants`, `\d vehicles` show `tenantId`.
- [ ] `\dt` lists `tenants`, `tenant_memberships`, `agency_memberships`, `membership_roles`, `membership_permission_overrides`, `platform_admins`, `platform_audit_logs`, `tenant_domains`, `agency_split_progress`, `saas_reconciliation_queue`, `saas_phase1_seq_snapshot`.

## Stage 1 — preflight (read-only)

- [ ] `npm run saas:phase1-preflight` runs to completion.
- [ ] `PHASE1_PREFLIGHT_SUMMARY.md` written.
- [ ] Status overall is `OK`, `INFO`, or `WARN` with sign-off.
- [ ] No BLOCKER findings unaddressed.

## Stage 2 — reconciliation `--apply`

- [ ] `saas:phase1-recon-A -- --apply` runs.
- [ ] `saas:phase1-recon-B -- --apply` runs.
- [ ] `saas:phase1-recon-C -- --apply` runs.
- [ ] `saas:phase1-recon-D -- --apply` runs.
- [ ] `saas:phase1-recon-E -- --apply` runs.
- [ ] `SELECT count(*) FROM saas_reconciliation_queue` matches expected proposal count.

## Stage 3 — queue drain

- [ ] Every queue row has a non-`pending` decision.
- [ ] Every decision has `decided_by` set.
- [ ] Sign-offs from Product / Security / Data steward captured.

## Stage 4 — dry-run backfill

- [ ] `npm run saas:phase1-backfill-dry-run -- --max-quarantine 50` runs.
- [ ] Status `ROLLED_BACK`.
- [ ] All verification rows PASS.
- [ ] Diff summary inspected; deltas match projection counts.
- [ ] Database row counts before/after dry-run: byte-identical (table-level `count(*)`).

## Stage 5 — apply backfill (staging only)

- [ ] `ALLOW_SAAS_STAGING_MUTATION=true` set.
- [ ] `npm run saas:phase1-backfill-apply-staging -- --apply` runs.
- [ ] Orchestrator overall: `OK`.
- [ ] `tenants.count` = expected.
- [ ] `tenant_memberships` count > 0.
- [ ] `platform_admins.count` = system-agency-user count.

## Stage 6 — sequence snapshot

- [ ] `saas_phase1_seq_snapshot` populated (or `0` rows acceptable if no identifier columns exist).
- [ ] No errors in `recon-seq-snapshot.md`.

## Stage 7 — verify

- [ ] `npm run saas:phase1-verify-backfill` runs.
- [ ] Verification PASSED (12+ pass, 0 fail; SKIPPED acceptable for absent tables).

## Stage 8 — application smoke

- [ ] `npm run start` boots cleanly.
- [ ] `GET /healthz` 200.
- [ ] Login flow succeeds for at least one user from each customer tenant.
- [ ] List candidates / employees / vehicles for one tenant returns the same row counts as before backfill.
- [ ] No 500s in last 100 application log lines.

## Stage 9 — second dry-run on fresh clone

- [ ] Restore staging from snapshot (resets DB).
- [ ] Re-apply Phase 0 + Phase 1 migrations.
- [ ] Repeat all stages above.
- [ ] Compare verification reports between run 1 and run 2; every delta explainable.
- [ ] Both runs archive to `backend/reports/saas/phase1/run-{1,2}/`.

## Sign-offs

- [ ] **Engineering lead** (name + date)
- [ ] **Product owner** (name + date)
- [ ] **Security** (name + date)
- [ ] **DevOps / SRE** (name + date)
- [ ] **Data steward** (name + date)

---

## Pre-stage probe (added 2026-05-09)

Before any stage:

```sh
npm run saas:env-safety
```

- [ ] Classification is `SAFE_CLONE` or `SAFE_STAGING`.
- [ ] If `SAFE_STAGING`, `ALLOW_SAAS_STAGING_MUTATION=true` is set explicitly.
- [ ] `env-safety.json` archived to the change record.

Any classification of `UNSAFE_PRODUCTION` or `UNKNOWN` aborts the staging apply; investigate the host/DB-name allow-list before retrying.
