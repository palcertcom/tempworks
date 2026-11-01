# Phase 2.16 + 2.17 — Finance Scope Split

> What ships in Phase 2.16 vs. what waits for Phase 2.17+.
> A guard-rail document so no one accidentally engages tenant
> rewrites on the write paths in this PR.

---

## 1. Scope summary

| Area | Phase | This PR? |
|------|------|----------|
| Read-path tenant scoping (`findAll`, `findOne`, `getTotals`, `getPersonRecords`, `getHistory parent check`) | **2.16** | **YES** |
| `listTransactionTypes` (global catalog) | 2.16 | yes (annotated `phase216-global`) |
| Audit log read in `getHistory` | 2.16 | yes (annotated `phase216-audit-log`, parent tenant-checked) |
| Mutation paths (`create` writes tenantId; `update`/`remove`/`updateStatus`/`addDeduction`/`addAttachment`/`removeAttachment` rely on tenant-scoped `findOne` pre-check; `removeDeduction` adds a parent tenant pre-check) | **2.17** | **YES** |
| Entity-name enrichment helpers | 2.17+ | NO |
| `checkAndNotifyHighBalance` write path | 2.17+ | NO |
| Audit log tenancy (cross-module) | 3.x | NO |
| Excel export tenant attribution | 2.17+ | NO |

## 2. Phase 2.16 — Read path refactor (THIS PR)

What lands:

- `FinanceService` constructor injects `PilotPrismaAccessor`.
- `private get prisma()` returns `pilot.client()`.
- `private scope()` returns `getPilotScope(this.pilot, 'finance')`.
- 9 read sites spread `scope.tenantWhere()` into the `where` clause.
- `findOne` and `getHistory` migrate from `findUnique` to
  `findFirst` to admit the tenant predicate without altering
  legacy semantics.
- 23 mutation/helper sites are routed through `this.legacyPrisma`
  with `phase216-excluded-mutation` / `phase216-helper-read` /
  `phase216-global` / `phase216-audit-log` annotations so the
  scanner shows them as intentionally excluded.

What does NOT land:

- No mutation behaviour change.
- No new flag.
- No schema change (`FinancialRecord.tenantId` already added in 2.3).
- No tenant reassignment guard on `update({ entityType, entityId })`.

## 2.1 Phase 2.17 update — mutation pilot shipped

Phase 2.17 narrowed the mutation surface. See
`SAAS_PHASE2_FINANCE_MUTATION_AUDIT.md` and
`SAAS_PHASE2_FINANCE_MUTATION_SCOPE_DECISION.md` for the
per-method classification. Summary:

- `create` spreads `scope.tenantData()` into create data. Pilot
  mode persists `tenantId`. Tag: `phase217-pilot-scope`.
- `update`, `remove`, `updateStatus`, `addDeduction`,
  `addAttachment`, `removeAttachment` rely on the tenant-scoped
  `findOne(id)` pre-check from Phase 2.16. The by-id update never
  reaches a foreign tenant's row. Tag:
  `phase217-pilot-scope-precheck`.
- `removeDeduction` adds a NEW parent tenant pre-check via
  `findFirst({ where: { id, tenantWhere() } })` before deleting
  the child deduction. Tag: `phase217-pilot-scope`.
- `auditLog.create` and `checkAndNotifyHighBalance` remain
  `LEGACY_ONLY` / `DEFERRED_HIGH_RISK` respectively. The Phase 2.15
  fanout writers handle notification tenancy when their flags are
  on; legacy production behaviour unchanged.

## 3. Phase 2.18+ — Remaining helpers (FUTURE)

The eight mutation methods all share a common shape today: take an
id, look it up, mutate. To safely tenant-scope them, Phase 2.17 needs:

1. A tenant pre-check on every `id`-keyed mutation: load via
   `findFirst({ where: { id, ...scope.tenantWhere() } })` first; raise
   404 if not found.
2. `scope.tenantData()` spread into `data` for `create` so the
   denormalised `tenantId` is set on insert.
3. Cross-entity reassignment guard on `update`: if a caller changes
   `entityType` / `entityId` / `applicantId`, ensure the new entity
   belongs to the same tenant as the record.

None of these exist today. The reads-first split lets us prove the
pilot's read access pattern on this module before changing any
mutation behaviour.

## 4. Phase 2.17+ — Helper enrichment (FUTURE)

`attachEntityNames`, `resolvePersonIdentity`, and
`resolveEntityNameForNotif` look up entity names by id. Today they
operate via `legacyPrisma` and rely on the fact that the ids handed
to them come from already tenant-filtered records. A future phase
should narrow them too so the helpers themselves cannot leak names
across tenants when reused in new code paths.

## 5. Guard-rails enforced by this PR

- The isolation harness's case 7 reads the service source and
  asserts that all eight mutation methods (`create`, `update`,
  `remove`, `updateStatus`, `addDeduction`, `removeDeduction`,
  `addAttachment`, `removeAttachment`) source `this.legacyPrisma`,
  not `this.prisma`. If a future PR moves them to `this.prisma`
  prematurely, the harness fails and blocks the merge.
- Every `legacyPrisma.*` site in mutation paths carries the
  `phase216-excluded-mutation` annotation. Helpers carry
  `phase216-helper-read`.
- The Phase 2.16 fixture extension seeds finance rows for two
  tenants exercising the read paths only — no mutation triggers.

## 6. Operator checklist for Phase 2.17

When Phase 2.17 starts, the operator should:

- [ ] Read this scope-split document.
- [ ] Re-run `saas:phase2-finance-equivalence` and
      `saas:phase2-finance-isolation` against the same staging DB
      to prove the read paths still pass after the mutation
      change.
- [ ] Add a new harness `saas:phase2-finance-mutation-equivalence`
      that asserts cross-tenant `update` / `remove` raise
      NotFoundException and that `create` persists `tenantId`.
- [ ] Update the `phase216-excluded-mutation` annotations to
      `phase217-pilot-scope` once the mutation paths engage the
      pilot.
