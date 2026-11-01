# Phase 2.17.1 — Finance Mutation Harness Environment Report

> A ledger may only be touched in a room where the doors are
> labelled. This is the room.

---

## 1. Pre-flight checks

| Check | Result |
|-------|--------|
| `DATABASE_URL` set | YES (`postgresql://tempworks:***@127.0.0.1:5432/saas_phase1_fixture?sslmode=disable`) |
| Postgres reachable | YES (`pg_isready` → accepting connections) |
| Postgres version | `PostgreSQL 16.13 (Ubuntu 16.13-0ubuntu0.24.04.1)` |
| `NODE_ENV` | `unset` (not `production`) |
| Database name matches FIXTURE_DB_PATTERNS | YES (`saas_phase1_fixture`) |
| Host matches STAGING_HOST_PATTERNS | YES (`127.0.0.1`) |

## 2. Classification result

```
{
  "classification": "SAFE_CLONE",
  "reason": "localhost + fixture pattern (db=saas_phase1_fixture)",
  "host": "127.0.0.1",
  "dbName": "saas_phase1_fixture",
  "nodeEnv": "unset"
}
```

`SAFE_CLONE` ⇒ mutation harnesses are permitted to write.
`UNSAFE_PRODUCTION` would have been refused with exit code 3 by
every harness's `if (!isStagingClassification(env.classification))
{ ... process.exit(3); }` guard.

## 3. Database setup steps

```sh
# 1. Start Postgres locally
sudo service postgresql start

# 2. Create role + database
sudo -u postgres psql -c "CREATE USER tempworks WITH PASSWORD 'tempworks' SUPERUSER CREATEDB;"
sudo -u postgres psql -c "CREATE DATABASE saas_phase1_fixture OWNER tempworks;"

# 3. Materialise the current Prisma schema (db push, NOT migrate)
export DATABASE_URL='postgresql://tempworks:tempworks@127.0.0.1:5432/saas_phase1_fixture?sslmode=disable'
npx prisma db push

# 4. Seed minimal two-tenant rows (tmp seed; replicated as
#    `phase2171-finance-seed.sql` under
#    `backend/scripts/saas/phase2/__fixture__/` for repeatability)
psql "$DATABASE_URL" -f scripts/saas/phase2/__fixture__/phase2171-finance-seed.sql
```

The seed creates:

- 2 tenants (`tenant-a` `11111111…`, `tenant-b` `22222222…`)
- 1 agency per tenant
- 1 employee per tenant
- 4 financial records (2 per tenant) with the IDs the existing
  finance harnesses expect (`…fa001`, `…fa002`, `…fb001`, `…fb002`)
- 2 finance transaction-type catalog rows

## 4. Production-vs-staging refusal

The Phase 2.17.1 harnesses share the existing Phase 2.16/2.17
gate in `classifyRuntimeEnv`:

| Classification | Action |
|----------------|--------|
| `SAFE_CLONE` / `SAFE_STAGING` | proceed |
| `UNSAFE_PRODUCTION` | **abort with exit code 3** |
| `UNKNOWN` | **abort with exit code 3** |

Production identifiers (`NODE_ENV=production`, host pattern
`prod-*`, DB pattern `*_prod`) all force `UNSAFE_PRODUCTION`.

## 5. Connection identity verification

```sql
SELECT current_database(), inet_server_addr(), inet_server_port(), version();
-- saas_phase1_fixture | 127.0.0.1 | 5432 | PostgreSQL 16.13
```

No production hostname is reachable from this environment. The
gate is enforced both at the harness level (refusal) and at the
infrastructure level (no prod connectivity).

## 6. Harness execution log

All four finance harnesses ran against this SAFE_CLONE on
`2026-05-10` and persisted JSON+MD reports under
`backend/reports/saas/phase2/`:

| Harness | Cases | Status |
|---------|------:|:------:|
| `saas:phase2-finance-equivalence` | 9/9 | **PASS** |
| `saas:phase2-finance-isolation` | 7/7 | **PASS** |
| `saas:phase2-finance-mutation-equivalence` | 9/9 | **PASS** |
| `saas:phase2-finance-mutation-isolation` | 10/10 | **PASS** |

Total: **35/35 cases PASS** on real DB.
