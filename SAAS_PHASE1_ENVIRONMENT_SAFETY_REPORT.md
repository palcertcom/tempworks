# Phase 1 — Environment Safety Report

**Generated:** 2026-05-09
**Tool:** `npm run saas:env-safety` (commit `cd65acd`)
**Branch:** `claude/design-multitenant-recruitment-8H42T`
**Commit at run time:** `cd65acd9d7b7c1a584d0c252b333f82731bf9ce7`

---

## 1. Disclosure

A real sanitized production replica was **not provisioned for this engagement**. The validation in this branch was executed against the staging fixture `saas_phase1_fixture` on `127.0.0.1`, which the Phase 1 environment-safety classifier correctly identified as `SAFE_CLONE`.

The findings, scripts, and reports are nonetheless directly applicable to a real prod-replica run because:

- The classifier is automatic and independent of the human operator.
- Every script in the suite respects the classifier output.
- The classification rules (host pattern + DB-name pattern + read-only flag + `NODE_ENV`) are the same on any host.

A real prod-replica run is the next operational gate (TKT-P1-02 in `SAAS_PHASE1_IMPLEMENTATION_PLAN.md`); it does not require any further code from this branch.

## 2. Active environment signals

```
DATABASE_URL          postgres://postgres@127.0.0.1/saas_phase1_fixture?sslmode=disable
host                  127.0.0.1
dbName                saas_phase1_fixture
NODE_ENV              unset
ALLOW_SAAS_STAGING_MUTATION  false (was set to true only for the optional staging-apply step)
ALLOW_NON_STAGING_APPLY      false
git branch            claude/design-multitenant-recruitment-8H42T
git commit            cd65acd9d7b7c1a584d0c252b333f82731bf9ce7
PostgreSQL server     PostgreSQL 16
default_transaction_read_only  off
PgBouncer             not detected
```

Pre-validation row counts on the live DB:

| Table | Rows |
|---|---|
| agencies | 5 |
| users | 14 |
| employees | 29 |
| applicants | 72 |
| documents | 52 |
| tenants | (post-apply: 4; pre-apply: 0) |
| tenant_memberships | (post-apply: 11; pre-apply: 0) |

## 3. Classification

> **Classification: `SAFE_CLONE`**
>
> Reason: DB name `saas_phase1_fixture` matches a fixture/test pattern AND host is `127.0.0.1`.

### Permitted actions

| Action | Permitted |
|---|---|
| Read-only audits (preflight, recon dry-run) | YES |
| Reconciliation `--apply` (writes only to `saas_reconciliation_queue`) | YES |
| Tenant backfill `--apply` (writes to tenancy tables, modifies `agencies`) | YES (on this fixture only) |
| Migration rollback (`down.sql`) | YES |

### Refused actions (would be refused on real production)

If the same script ran with `host` matching `^prod[-.]/^postgres-prod-/...` or `dbName` matching `^prod$/^production$/_prod$/^tempworks_prod`, the classifier would return `UNSAFE_PRODUCTION` and every mutating script would refuse to run.

## 4. Pre-mutation gates verified

- [x] `nest build` clean — backend compiles unchanged
- [x] `npx prisma validate` — schema valid
- [x] `npm run saas:validate` — 28/28 PASS
- [x] `npm run saas:schema-lint` — 0 issues
- [x] `git diff src/app.module.ts src/main.ts src/auth/ src/prisma/prisma.service.ts` — empty
- [x] `NODE_ENV != 'production'` (unset on this engagement)
- [x] Classifier returned `SAFE_CLONE` before any mutation ran

## 5. Production safety confirmation

> **No mutation reached, was attempted on, or could have reached a production database during this engagement.**

The branch `claude/design-multitenant-recruitment-8H42T` does not change `AppModule`, `main.ts`, the auth guard, the Prisma service, or any feature-flag default. The Phase 1 scripts respect the classifier; the orchestrator additionally requires `ALLOW_SAAS_STAGING_MUTATION=true` for `--apply`.

## 6. Required next operational step

Run the same `npm run saas:env-safety` against the actual sanitized production replica when one is provisioned. Expected classification:

- If hostname matches `^staging[-.]/.staging./^stg[-.]/.stg./^postgres-staging-` → `SAFE_STAGING`.
- If the DB role used by the script has `default_transaction_read_only=on` → `READONLY_REPLICA` (read-only audits permitted; mutation refused).
- Otherwise `UNKNOWN` and the operator must update the allow-list with the actual staging hostname before any `--apply`.
