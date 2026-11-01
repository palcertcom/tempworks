# Phase 2.5 — Reports Staging Rollout Runbook

> Practice the switch before touching the switch.

This runbook describes one full rehearsal cycle for turning on the
tenant-safe reports path on a staging-classified host. Production is
explicitly out of scope.

---

## 1. Preconditions

Before starting:

- [ ] Branch `claude/design-multitenant-recruitment-8H42T` deployed.
- [ ] `npm run saas:env-safety` returns `SAFE_CLONE` or `SAFE_STAGING`.
- [ ] `npm run saas:apply-migrations` ran on this database (Phase 0 + Phase 1 + Phase 2.3).
- [ ] `npm run saas:phase1-verify-backfill` returns 0 mismatches.
- [ ] Phase 2.3 entity-tenantId backfill applied:
      `npm run saas:phase2-backfill-entity-tenantids -- --apply`
- [ ] Phase 2.3 entity-tenantId verifier returns
      `verify-entity-tenantids: N/15 PASS, 0 mismatch(es), 0 unexplained NULLs.`
- [ ] Operator has the rollback command memorised.

Do NOT proceed if any precondition fails.

## 2. Required DB state

The rehearsal assumes:

- `tenants`: at least 2 rows (so isolation harness has cross-tenant data).
- `employees`, `applicants`, `agencies`: populated with `tenantId` set.
- Phase 2.3 entity-keyed tables (`documents`, `work_permits`, …)
  populated with `tenantId` set or NULL-with-known-reason.
- Optional for the staging fixture only:
  `psql -f backend/scripts/saas/phase2/__fixture__/phase24-extension.sql`
  to materialise `document_types`, `work_permits`, `visas`,
  `compliance_alerts` and the `documents.deletedAt` /
  `documents.documentTypeId` / `agencies.deletedAt` columns the
  joined-source harnesses need. **Do NOT run on production** —
  production has these tables already.

## 3. Required Phase 1 backfill state

```sh
DATABASE_URL=... npm run saas:env-safety        # → SAFE_CLONE / SAFE_STAGING
DATABASE_URL=... npm run saas:phase1-verify-backfill
# expected:
#   verify-tenant-backfill: 0 mismatches, 0 orphans
```

If verification reports anything else, stop. Phase 1 is not done on
this DB.

## 4. Required Phase 2.3 entity-tenantId state

```sh
DATABASE_URL=... npm run saas:phase2-verify-entity-tenantids
# expected:
#   verify-entity-tenantids: N/15 PASS, 0 mismatch(es), 0 unexplained NULLs.
```

Mismatches or unexplained NULLs are a **block**.

## 5. Exact env variables for rehearsal

```sh
# Required — turn the safe path on, gated to staging.
export MULTI_TENANT_ENABLED=true
export TENANT_SAFE_REPORTS_ENABLED=true
export TENANT_CONTEXT_REQUIRED_FOR_SAFE_REPORTS=true
export TENANT_CONTEXT_STAGING_ONLY=true

# Must stay false (rehearsal does NOT exercise these).
export TENANT_PRISMA_ENFORCEMENT=false
export RLS_ENFORCEMENT=false

# Database.
export DATABASE_URL=postgres://user:pass@<staging-host>/<db>?sslmode=...

# Mutation gate (only the backfill scripts honour it; rehearsal does
# not mutate, but harnesses inside it confirm classification).
export ALLOW_SAAS_STAGING_MUTATION=true
```

## 6. Command order

```sh
# 1. Confirm we're not pointing at production.
npm run saas:env-safety
# → must say SAFE_CLONE or SAFE_STAGING. Abort if not.

# 2. Build (catches type drift in the runtime).
npm run build

# 3. Static validation (registry + scaffolding tests).
npm run saas:validate
npm run saas:schema-lint
npm run saas:phase2-reports-validate

# 4. Per-component smoke (each one shippable on its own).
npm run saas:phase2-context-smoke
npm run saas:phase2-reports-equivalence
npm run saas:phase2-reports-isolation

# 5. The full rehearsal — runs the four above in sequence plus the
#    integration smoke and rollback rehearsal.
npm run saas:phase2-reports-rollout-rehearsal
```

## 7. Expected outputs

```
saas:env-safety                                   → SAFE_CLONE | SAFE_STAGING
saas:validate                                      → All 6 suites passed.
saas:schema-lint                                   → schema-lint: 0 issues.
saas:phase2-reports-validate                      → reports-source-validation: <N> sources [READY=… NEEDS_DECISION=… BLOCKED=…]
saas:phase2-context-smoke                         → context-smoke: 7/7 cases PASS
saas:phase2-reports-equivalence                   → reports-read-equivalence: PASS=N WARN=0 FAIL=0 SKIPPED=… (of N READY)
saas:phase2-reports-isolation                     → reports-isolation-test: N/N sources isolated.
saas:phase2-reports-rollout-rehearsal             → [rollout-rehearsal] N/N steps PASS
```

The rehearsal harness produces:

- `backend/reports/saas/phase2/reports-staging-rollout-rehearsal.json`
- `backend/reports/saas/phase2/reports-staging-rollout-rehearsal.md`

Sample (post-Phase 2.5 dry-run on the local fixture):

```
[rollout-rehearsal] 20/20 steps PASS
```

## 8. Rollback

The single switch is `TENANT_SAFE_REPORTS_ENABLED`. Set it to `false`
and redeploy / restart:

```sh
export TENANT_SAFE_REPORTS_ENABLED=false
# kill -HUP $(pidof node) or your platform's restart command
```

`ReportsService.isTenantSafeRoute()` immediately returns `false` after
the next process boot, and `executeReport()` resumes the legacy path.
No data needs to be touched. RTO < 1 minute on most platforms.

If you also want to disable the middleware and revert to the
pre-Phase-2 surface entirely:

```sh
export MULTI_TENANT_ENABLED=false
export TENANT_CONTEXT_REQUIRED_FOR_SAFE_REPORTS=false
export TENANT_CONTEXT_STAGING_ONLY=false
```

The rehearsal harness's step 7 confirms a fresh boot under those flags
yields `tenantSafeReportsEnabled() === false` and
`multiTenantEnabled() === false`, and that no DB rows changed during
the rehearsal.

## 9. Post-rehearsal sign-off

The rehearsal is GREEN when ALL of the following hold:

- [ ] `saas:env-safety` reports SAFE_CLONE / SAFE_STAGING.
- [ ] `saas:phase2-reports-rollout-rehearsal` returns N/N steps PASS.
- [ ] `reports-staging-rollout-rehearsal.md` shows no FAIL rows.
- [ ] Equivalence and isolation harnesses both green on the same DB
      within the last 24 hours.
- [ ] Rollback rehearsal verified row counts unchanged.
- [ ] On-call confirms they have the rollback command.
- [ ] Engineering manager / SRE has signed this runbook.

Sign-off table — fill in for each rehearsal cycle:

| Date (UTC) | Environment | Operator | Result | Notes |
|------------|-------------|----------|--------|-------|
| 2026-05-09 | SAFE_CLONE (saas_phase1_fixture) | Claude / dry-run | 20/20 PASS | initial Phase 2.5 rehearsal on fixture |
|            |             |          |        |       |

Once a real staging DB has been rehearsed, replace the dry-run line
with the real run.
