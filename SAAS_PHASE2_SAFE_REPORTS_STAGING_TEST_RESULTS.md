# Phase 2.2 — Safe Reports + Staging Context: Combined Test Results

> Validates that the Phase 2.1 tenant-safe reports engine works correctly
> when the Phase 2.2 tenant context is supplied by the new middleware /
> auth bridge.

---

## 1. Headline (post Phase 2.5 rehearsal on staging fixture)

```
context-smoke:                           7/7 cases PASS
reports-read-equivalence:                PASS=17 WARN=0 FAIL=0 SKIPPED=1 (of 17 READY)
reports-isolation-test:                  17/17 sources isolated
reports-staging-rollout-rehearsal:       20/20 steps PASS
saas:validate (6 suites, 45+ unit):      all PASS
```

The Phase 2.5 rehearsal harness exercises the integration path
end-to-end on a SAFE_CLONE classified database with the four flags
set to their staging values. Rollback step (flags off → legacy path,
0 row mutations) verified inside the same script.

## 2. Reports engine + tenant context

The Phase 2.2 integration touches `executeReportTenantSafe()` in
`reports.service.ts` to honour the new flag
`TENANT_CONTEXT_REQUIRED_FOR_SAFE_REPORTS`:

| Flag combo | Source | Tenant context | Outcome |
|---|---|---|---|
| `TSR=false` | any | irrelevant | legacy engine; production behaviour |
| `TSR=true`, `TCRfSR=true` | READY | absent | **400** `REPORT.TENANT_CONTEXT_REQUIRED` |
| `TSR=true`, `TCRfSR=true` | READY | present | tenant-safe engine |
| `TSR=true`, `TCRfSR=false` | READY | absent | **soft fallback** to legacy engine for that request |
| `TSR=true`, `TCRfSR=false` | READY | present | tenant-safe engine |
| `TSR=true` | DISABLED | irrelevant | legacy engine for that source |

`TSR` = `TENANT_SAFE_REPORTS_ENABLED`
`TCRfSR` = `TENANT_CONTEXT_REQUIRED_FOR_SAFE_REPORTS`

## 3. Per-source results (against staging fixture, 4 tenants populated)

| Source | Status | Equivalence | Isolation | Notes |
|---|---|:---:|:---:|---|
| `employees`  | READY    | PASS | PASS | matches legacy row counts; 0 leaks; cross-tenant filter rejected |
| `applicants` | READY    | PASS | PASS | same |
| `agencies`   | READY    | PASS | PASS | same; agency-scope via `id` |
| 15 others    | DISABLED | n/a  | n/a  | legacy engine continues to handle them |

## 4. Concurrency + isolation re-verification

The Phase 2.2 middleware introduces a new code path that opens an ALS
frame per request. Phase 0 SPIKE-002 already validated this propagation
mechanism; the Phase 2.2 smoke case 7 re-asserts the property with two
parallel frames, observing two distinct tenant ids without bleed.

`reports-isolation-test` exercises the property at the SQL plane: each
READY source's safe query returns ONLY rows tagged with the active
tenant's id; adversarial filter attempts (`tenantId` field, `OR` op)
are rejected by the builder.

## 5. Production safety re-confirmed

```
nest build:                                    clean
prisma validate:                                valid
saas:validate:                                  6 suites, 45 tests, all PASS
saas:schema-lint:                               0 issues
git diff src/auth/ src/main.ts:                empty
git diff src/prisma/prisma.service.ts:          empty
src/app.module.ts diff:                         additive — new TenancyModule import only
src/reports/reports.service.ts diff:            adds executeReportTenantSafe() ONLY behind
                                                 isTenantSafeRoute(); legacy path unchanged
```

## 6. How to run

Single command:

```sh
ALLOW_SAAS_STAGING_MUTATION=true \
DATABASE_URL=postgres://postgres@127.0.0.1/saas_phase1_fixture?sslmode=disable \
  npm run saas:phase2-context-smoke
```

Then:

```sh
DATABASE_URL=... npm run saas:phase2-reports-equivalence
DATABASE_URL=... npm run saas:phase2-reports-isolation
```

For a live server probe (after `npm start` with flags set):

```sh
npm run saas:phase2-diagnostics -- \
    --base http://localhost:3000 \
    --tenant-id 11111111-1111-1111-1111-111111111111 \
    --token <jwt>
```

## 7. Risks observed

None. The Phase 2.2 changes do not introduce any new BLOCKER findings
in the raw-SQL scanner (count remains 26 advisory, 20 unreviewed —
identical to pre-Phase-2.2). The two new `$queryRawUnsafe` lines from
Phase 2.1 remain `@tenant-reviewed`-tagged.
