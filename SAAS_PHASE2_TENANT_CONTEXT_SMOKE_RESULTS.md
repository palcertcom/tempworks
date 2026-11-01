# Phase 2.2 — Tenant Context Smoke Results

**Run command:** `npm run saas:phase2-context-smoke`
**Run target:** in-process; no live server needed.

---

## Headline

```
context-smoke: 7/7 cases PASS
```

| # | Case | Result | Detail |
|---|---|:---:|---|
| 1 | flags off → resolver no-op | PASS | `method=none, tenant=null` |
| 2 | staging flags on + valid header → resolves from header | PASS | `method=header, tenant=11111111-1111-1111-1111-111111111111` |
| 3 | production flags on → middleware refuses with error | PASS | error message contains `refused outside staging` |
| 4 | tenant-safe builder requires a valid tenantId | PASS | builder rejects empty tenantId |
| 5 | disabled report source fails closed | PASS | `documents` source remains DISABLED with reason |
| 6 | ready source builder emits `tenantId = $1` first | PASS | sql starts with `"e"."tenantId" = $1`, params[0] = TID |
| 7 | two parallel ALS frames do not bleed | PASS | both tenant ids observed in correct frames |

## Methodology

The harness manipulates `process.env` per scenario, instantiates the
production services with stub Prisma stand-ins where useful, and asserts
the documented contract for each scenario without booting a NestJS HTTP
server. This keeps the smoke test fast (sub-second) and isolated.

## Production safety check (case 3)

The most important scenario:

```
Setup:
  MULTI_TENANT_ENABLED=true
  NODE_ENV=production
  DATABASE_URL=postgres://postgres@prod-db-1.prod.example.com/tempworks_prod

Action:
  TenantContextMiddleware.use(req, res, next)

Result:
  next() called with Error: "MULTI_TENANT_ENABLED=true is refused
  outside staging. Set the flag to false OR move the database to a
  staging-classified host."
```

The middleware constructor also logs the `[FAIL-FAST]` warning at boot
so an operator sees the problem in the startup log without needing to
make an HTTP request.

## Concurrency check (case 7)

`AsyncLocalStorage` is the propagation mechanism. Phase 0's SPIKE-002
already validated AsyncLocalStorage propagation through all the relevant
async paths. Case 7 re-asserts it specifically for two parallel
`withRequestContext` frames with different `TenantContext.attach` values.

```
Result: seen = [TID-A, TID-B] (or reversed by scheduler)
        — both tenant ids observed; neither saw the other's tenant.
```

## How to reproduce

```sh
DATABASE_URL=postgres://postgres@127.0.0.1/saas_phase1_fixture?sslmode=disable \
  npm run saas:phase2-context-smoke
```

Exit code:
- `0` — all PASS
- `2` — at least one FAIL
- `3` — runtime error
