# Phase 2.16 — Finance Pilot Results

> Reads-first finance pilot results.
> Companion to `SAAS_PHASE2_FINANCE_AUDIT.md` and
> `SAAS_PHASE2_FINANCE_SCOPE_SPLIT.md`.

---

## 1. What changed

| Surface | Change |
|---------|--------|
| `src/finance/finance.service.ts` | constructor injects `PilotPrismaAccessor`; legacy `prisma` renamed `legacyPrisma`; pilot-aware `prisma` getter + `scope()` helper |
| 9 read sites | spread `scope.tenantWhere()` into where clause; annotated `phase216-pilot-scope` |
| 2 read sites | annotated `phase216-global` (catalog) / `phase216-audit-log` |
| 23 mutation / helper sites | rerouted to `legacyPrisma`; annotated `phase216-excluded-mutation` / `phase216-helper-read` / `phase216-global` / `phase216-audit-log` |
| `src/finance/finance.module.ts` | adds `FeatureFlagsModule`, `TenantPrismaService`, `PilotPrismaAccessor` |
| `scripts/scan-annotations.ts` | five new tags scoped to `src/finance/` |
| `scripts/saas/phase2/__fixture__/phase216-finance-extension.sql` | additive fixture: two tenants × two finance records each |
| `scripts/saas/phase2/finance-equivalence.ts` | new equivalence harness |
| `scripts/saas/phase2/finance-isolation.ts` | new isolation harness with source-level meta-assertion |
| `package.json` | new scripts `saas:phase2-finance-equivalence` and `saas:phase2-finance-isolation` |

## 2. What did not change

- No production behaviour change while flags are off.
- No mutation path narrowing (deferred to Phase 2.17).
- No schema change.
- No new feature flag.

## 3. Production default

| Flag | Default | This PR |
|------|---------|---------|
| `TENANT_PRISMA_PILOT_ENABLED` | `false` | unchanged |
| `TENANT_PRISMA_PILOT_MODULES` | unset | unchanged |
| `MULTI_TENANT_ENABLED` | `false` | unchanged |

With defaults, `getPilotScope(this.pilot, 'finance').tenantWhere()`
returns `{}` — every read query is byte-identical to pre-2.16.

## 4. Pilot activation

The pilot scope activates on:

```
TENANT_PRISMA_PILOT_ENABLED=true
TENANT_PRISMA_PILOT_MODULES=finance       # or empty (allow-all)
NODE_ENV=staging                          # SAFE_CLONE / SAFE_STAGING classifier
TenantContext.attach({ id: ... })         # ALS frame holds a tenant
```

When all four are true, `tenantWhere()` returns `{ tenantId }` and
the read queries narrow.

## 5. Equivalence harness

`saas:phase2-finance-equivalence` covers:

1. legacy: pilot OFF reports `pilotActive=false`
2. pilot: pilot ON + finance allow-list ⇒ `pilotActive=true`
3. `findAll`: pilot total <= legacy total (tenant filter applies)
4. `findOne`: legacy + pilot resolve the same tenant A record id
5. error path: NotFoundException for missing id in both modes
6. `getTotals`: legacy + pilot return same per-entity sum
7. `listTransactionTypes`: global catalog identical
8. `getHistory`: pilot resolves the same record id (tenant pre-check)
9. response shape preserved (PaginatedResponse<FinancialRecord>)

## 6. Isolation harness

`saas:phase2-finance-isolation` covers:

1. pilot ON, tenant A: `findAll` returns only tenant A rows
2. pilot ON, tenant A: `findOne(tenantB-id)` raises NotFoundException
3. pilot ON, tenant A: `getHistory(tenantB-id)` raises NotFoundException
4. pilot ON, tenant A: `getTotals` on tenant B's entity returns 0
5. concurrent ALS frames isolated (T_A no B-rows; T_B no A-rows)
6. pilot OFF: legacy returns the union of A+B records
7. **source-level meta-assertion**: every mutation method
   (`create`, `update`, `remove`, `updateStatus`,
   `addDeduction`, `removeDeduction`, `addAttachment`,
   `removeAttachment`) sources `legacyPrisma` and must keep doing
   so until the Phase 2.17 mutation pilot lands

## 7. Rollback runbook

```sh
# To halt the finance pilot specifically:
export TENANT_PRISMA_PILOT_MODULES=  # remove 'finance' from the list

# To halt the pilot framework entirely:
export TENANT_PRISMA_PILOT_ENABLED=false
```

No DB state introduced; rollback is configuration only. The Phase
2.16 read narrowing is a same-process spread that collapses to
`{}` when the scope is inactive.

## 7.1 Phase 2.17 — Mutation pilot delta

Phase 2.17 extended the pilot to mutations. New annotations in
`src/finance/finance.service.ts`:

- `create`: `phase217-pilot-scope` — spreads `scope.tenantData()`
  into create data; routes through `this.prisma`.
- `update` / `remove` / `updateStatus` / `addDeduction` /
  `addAttachment` / `removeAttachment`: `phase217-pilot-scope-precheck`
  on the by-id `legacyPrisma.update`. The tenant gate is the prior
  `findOne(id)` (Phase 2.16, tenant-scoped).
- `removeDeduction`: `phase217-pilot-scope` on a NEW parent
  `findFirst({ where: { id, tenantWhere() } })` pre-check; the
  subsequent legacy aggregate update is annotated
  `phase217-pilot-scope-precheck`.
- `attachAttachment` find/update of the attachment row stays on
  `legacyPrisma` and is gated by the parent `findOne` plus the
  `financialRecordId` predicate.

New harnesses:

- `finance-mutation-equivalence` — 8 cases: create shape, create
  tenantId NULL legacy / set pilot, update shape, validation error
  parity, audit-log delta, removeDeduction parent pre-check
  (bogus-id 404), pilot soft-delete, totals after mutation.
- `finance-mutation-isolation` — 8 cases: pilot create persists
  tenantId=A; cross-tenant update / remove / updateStatus /
  addAttachment / removeDeduction all rejected with
  NotFoundException and target row unchanged; getTotals on tenant
  B's entity from tenant A returns 0; legacy mode (flags off)
  still mutates without tenant gate.

The existing `finance-isolation` harness's source-level
meta-assertion now checks for the Phase 2.17
`phase217-pilot-scope-precheck` annotations on each mutation
method and the `...tdata` spread inside `create`.

## 7.2 Phase 2.17.1 — Real DB harness execution

The Phase 2.17 harnesses were executed against a SAFE_CLONE
(`postgresql://…@127.0.0.1:5432/saas_phase1_fixture`) on
2026-05-10. Results:

| Harness | Cases | Status |
|---------|------:|:------:|
| `saas:phase2-finance-equivalence` | 9/9 | **PASS** |
| `saas:phase2-finance-isolation` | 7/7 | **PASS** |
| `saas:phase2-finance-mutation-equivalence` | 9/9 | **PASS** |
| `saas:phase2-finance-mutation-isolation` | 10/10 | **PASS** |

Total **35/35 cases PASS** on real Postgres 16. See
`SAAS_PHASE2171_FINANCE_MUTATION_ENV_REPORT.md` for the
environment classification, seed steps, and refusal-gate
behaviour.

Two real bugs/regressions identified by the review and closed in
2.17.1:

- `resolvePersonIdentity` was looking up entities by id without a
  tenant predicate. In pilot mode that allowed a tenant-A caller
  to seed a financial record pointing at a tenant-B entity. Fixed
  by routing through the pilot client and spreading
  `scope.tenantWhere()`. New annotation tag:
  `phase2171-helper-narrowed`. Covered by
  `finance-mutation-isolation` case 9.
- `update`'s spread `data: { ...dto }` would propagate any stray
  identity-reassignment fields if a future DTO refactor
  re-introduced `entityType` / `entityId` / `applicantId` /
  `stageAtCreation`. Closed by a defensive scrub in `update`.
  Covered by `finance-mutation-isolation` case 10.

The two other helpers (`attachEntityNames`,
`resolveEntityNameForNotif`) were structurally safe in pilot mode
because their callers already tenant-filter, but were narrowed
defensively in the same pass.

See:
- `SAAS_PHASE2171_FINANCE_MUTATION_ENV_REPORT.md`
- `SAAS_PHASE2171_FINANCE_CROSS_ENTITY_GUARD_REVIEW.md`
- `SAAS_PHASE2171_FINANCE_HELPER_ENRICHMENT_REVIEW.md`

## 7.3 Phase 2.18 — APPLICANT helper coverage completion

The Phase 2.17.1 EMPLOYEE-only coverage gap is closed. New
fixture extension `phase218-finance-applicant-seed.sql` seeds one
applicant per tenant. Three new isolation cases:

- **case 11**: pilot ON, tenant A, `create({ entityType: 'APPLICANT',
  entityId: tenantB-applicant })` ⇒ `NotFoundException`, no row
  inserted.
- **case 12**: pilot ON, tenant A, `create({ entityType: 'APPLICANT',
  entityId: tenantA-applicant })` ⇒ success, persists `tenantId=A`,
  `applicantId=appA`, `stageAtCreation` derived from tier.
- **case 13**: pilot ON, tenant A, `update` on the tenant A
  APPLICANT-typed record keeps `applicantId` tenant-scoped — proves
  the `resolveEntityNameForNotif` helper does not corrupt the row
  when called inside an update flow.

Real-DB results on the same SAFE_CLONE: **38/38 cases PASS**
(9 + 7 + 9 + 13). No service code change required — the Phase
2.17.1 narrowing already covered all three entityType branches
symmetrically; Phase 2.18 is pure test coverage completion.

See `SAAS_PHASE218_FINANCE_APPLICANT_HELPER_COVERAGE.md`.

## 7.4 Phase 2.19 — AGENCY helper coverage completion

The per-entity coverage matrix is now complete. Three new
isolation cases (14, 15, 16) cover the AGENCY branch the same way
APPLICANT was covered in 2.18.

| Entity | Real-DB harness coverage |
|--------|--------------------------|
| EMPLOYEE | case 9 (Phase 2.17.1) |
| APPLICANT | cases 11+12+13 (Phase 2.18) |
| AGENCY | **cases 14+15+16 (Phase 2.19)** |

Real-DB results on the same SAFE_CLONE: **41/41 cases PASS**
(9 + 7 + 9 + 16). No service code change. Pure coverage
completion. See `SAAS_PHASE219_FINANCE_AGENCY_HELPER_COVERAGE.md`.

The Phase 2.17.1 helper-narrowing fix is now end-to-end proven on
real DB across every supported `entityType`.

## 8. Next steps — Phase 2.20

Remaining finance work:

- Cross-tenant entity reassignment guard on `update` (when caller
  changes `entityType` / `entityId` / `applicantId`, validate the
  new entity's tenant matches).
- Helper enrichment narrowing (`attachEntityNames`,
  `resolvePersonIdentity`, `resolveEntityNameForNotif`) so the
  helpers cannot leak names cross-tenant when reused.
- `checkAndNotifyHighBalance` background path engagement via the
  Phase 2.13 `runForTenant` framework.
- Audit-log tenancy (cross-module audit phase).
