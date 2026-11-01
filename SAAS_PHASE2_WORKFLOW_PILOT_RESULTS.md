# Phase 2.26 — Workflow Pilot Results

> Reads-first workflow pilot results.
> Companion to `SAAS_PHASE2_WORKFLOW_AUDIT.md`,
> `SAAS_PHASE2_WORKFLOW_SCOPE_SPLIT.md`, and
> `SAAS_PHASE2_WORKFLOW_SYSTEM_TEMPLATE_DECISION.md`.

---

## 1. What changed

| Surface | Change |
|---------|--------|
| `src/workflow/workflow.service.ts` | constructor injects `PilotPrismaAccessor`; `prisma`→`legacyPrisma` rename; pilot-aware `prisma` getter + `scope()` helper |
| Read sites | `phase226-pilot-scope` for tenant-scoped reads; `phase226-global` for `StageTemplate.*` catalog reads |
| `EmployeeStage` aggregates | narrowed via `employee: { tenantId }` relation filter (no `tenantId` column on `EmployeeStage`) |
| `getTimeline` | migrated `findUnique` → `findFirst` + tenant predicate |
| Mutation sites | rerouted to `legacyPrisma` with `phase226-excluded-mutation` |
| Audit log writes | `phase226-audit-log` |
| `src/workflow/workflow.module.ts` | adds `FeatureFlagsModule`, `TenantPrismaService`, `PilotPrismaAccessor` |
| `scripts/scan-annotations.ts` | 4 new tags scoped to `src/workflow/` |
| `scripts/saas/phase2/__fixture__/phase226-workflow-seed.sql` | 3 stage templates + 2 employeeStages + 2 work permits + 2 visas |
| `scripts/saas/phase2/workflow-equivalence.ts` | new equivalence harness (11 cases) |
| `scripts/saas/phase2/workflow-isolation.ts` | new isolation harness (11 cases incl. source-level meta-assertion) |
| `package.json` | new scripts `saas:phase2-workflow-equivalence` / `…-isolation` |

## 2. What did not change

- No production behaviour change while flags are off.
- No mutation/clone/template-write narrowing (deferred to Phase 2.27+).
- No `StageTemplate` schema change (catalog stays global; `name @unique` unchanged).
- No `EmployeeStage` schema change (no `tenantId` column added; gated via parent relation filter).
- No new feature flag.

## 3. System-template decision summary

`StageTemplate` remains a **global catalog** (`phase226-global`). Per-tenant overrides require a Phase 3 product decision + schema migration. See `SAAS_PHASE2_WORKFLOW_SYSTEM_TEMPLATE_DECISION.md`.

## 4. Pilot activation

```
TENANT_PRISMA_PILOT_ENABLED=true
TENANT_PRISMA_PILOT_MODULES=workflow       # or empty (allow-all)
NODE_ENV=staging                           # SAFE_CLONE / SAFE_STAGING classifier
TenantContext.attach({ id: ... })          # ALS frame
```

When all four are true, `tenantWhere()` returns `{ tenantId }` (for direct-tenancy models like Applicant/Employee/WorkPermit/Visa) and the relation filter `employee: { tenantId }` is added (for `EmployeeStage`).

## 5. Equivalence harness — 11/11 PASS

`saas:phase2-workflow-equivalence` covers:

1. legacy: pilot OFF reports `pilotActive=false`
2. pilot: pilot ON + workflow allow-list ⇒ `pilotActive=true`
3. `getStages` global catalog identical
4. `getOverview` first-stage inProgress count: pilot <= legacy
5. `getAnalytics.totalEmployees`: pilot <= legacy
6. `getTimeline`: legacy + pilot resolve same employee id
7. error path: NotFoundException for missing id
8. `getStageDetails`: pilot employee count <= legacy
9. `findWorkPermits`: pilot total <= legacy total
10. `findVisas`: pilot total <= legacy total
11. response shape preserved

## 6. Isolation harness — 11/11 PASS

`saas:phase2-workflow-isolation` covers:

1. `getStages`: BOTH tenants see the same global catalog rows (StageTemplate is global)
2. `getOverview` tenant A: stage 1 inProgress = 1 (excludes B)
3. `getOverview` tenant B: stage 1 inProgress = 1 (excludes A)
4. `getAnalytics` tenant A: totalEmployees = 1 (excludes B)
5. pilot ON, tenant A: `getTimeline(tenantB-employee-id)` raises `NotFoundException`
6. pilot ON, tenant A: `getStageDetails` employees exclude tenant B
7. pilot ON, tenant A: `findWorkPermits` returns ONLY tenant A
8. pilot ON, tenant A: `findVisas` returns ONLY tenant A
9. concurrent ALS frames isolated
10. pilot OFF: legacy aggregates include both tenants (totalEmployees=2, workPermits=2)
11. **source-level meta-assertion**: every mutation method (`updateEmployeeWorkflowStage`, `setEmployeeCurrentStage`, `createWorkPermit`, `updateWorkPermit`, `createVisa`, `updateVisa`) sources `legacyPrisma`; reads use `employee.tenantId` relation filter / `tenantWhere`; `getTimeline` migrated to `findFirst` + `...t`

## 7. Lessons learned

- **Relation filter pattern**: `EmployeeStage` has no `tenantId` column. Narrowing via `employee: { tenantId }` works cleanly with Prisma's nested-filter syntax. No schema change needed; can be denormed in a later phase if direct queries become hot.
- **Global catalog precedent**: matches `MaintenanceType` / `Workshop` (vehicles) and `DocumentType` (documents). Same `phase*-global` tag pattern.
- **`getTimeline` `findUnique` → `findFirst`**: same migration as documents 2.20 / vehicles 2.23. Composes the tenant predicate cleanly.
- **`getStageDetails` mixes catalog + tenant-scoped data**: catalog is the same across tenants; per-stage applicants/employees are scoped. The harness verifies both invariants in one call.

## 8. Read/write split warning

Mutation paths (`updateEmployeeWorkflowStage`, `setEmployeeCurrentStage`, `createWorkPermit`, `updateWorkPermit`, `createVisa`, `updateVisa`) remain on `legacyPrisma`. Phase 2.27+ will:

- Add `findEmployeeOrFail` / `findApplicantOrFail` / `findWorkPermitOrFail` private helpers (tenant-scoped).
- Switch mutation pre-checks via these helpers.
- Spread `scope.tenantData()` on `WorkPermit.create` and `Visa.create`.
- Audit-log writes stay on `legacyPrisma` (cross-module audit phase).

## 9. Cross-module integration with documents

`documents.checkAndAutoCompleteStage` writes to `EmployeeStage.upsert` + `applicant.update` from inside `verify`. Currently tagged `phase220-excluded-mutation` and runs after a tenant-scoped `findOne` in documents (Phase 2.20). When Phase 2.27 ships the workflow mutation pilot, the cross-module write inherits the parent gate; only the target entity needs a tenant probe.

## 10. Pattern reusability

The pattern is now proven on **four end-to-end modules**:
- `finance` (2.16/2.17/2.17.1/2.18/2.19) — reads + writes
- `documents` (2.20/2.21/2.22) — reads + writes + downloads
- `vehicles` (2.23/2.24/2.25) — reads + writes + storage
- `workflow` (2.26) — reads only (mutations Phase 2.27+)

Plus reads-only on `roles`, `employee-work-history`, `compliance`, `job-ads`, `notifications`, `recycle-bin` from earlier phases. The pattern is reusable without surprises.

## 11. Rollback runbook

```sh
# To halt the workflow pilot:
export TENANT_PRISMA_PILOT_MODULES=  # remove 'workflow'

# To halt the framework entirely:
export TENANT_PRISMA_PILOT_ENABLED=false
```

No DB state introduced; rollback is configuration only.

## 12. Real-DB execution evidence

Same SAFE_CLONE used by Phase 2.16-2.25. Cumulative harness cases:

| Module | Cases |
|---|---:|
| Finance | 41 |
| Documents | 52 |
| Vehicles | 65 |
| Workflow (NEW) | 22 |
| **Total** | **180/180** |

All PASS on real Postgres 16.

## 12.1 Phase 2.27 — Mutation pilot delta

Phase 2.27 extended the workflow pilot to mutations. New
annotations:

- `findEmployeeOrFail` / `findApplicantOrFail` private helpers
  (tenant-scoped via pilot client). Tag `phase227-pilot-scope`.
- `updateEmployeeWorkflowStage`: NEW parent gate. By-key
  EmployeeStage update + auditLog tagged
  `phase227-pilot-scope-precheck`.
- `setEmployeeCurrentStage`: same parent gate. The StageTemplate
  lookup remains `phase226-global`. The by-employeeId `updateMany`
  + `upsert` are tagged `phase227-pilot-scope-precheck`.
- `createWorkPermit`: parent gate + spreads `scope.tenantData()`
  on the new row. Tag `phase227-pilot-scope`.
- `updateWorkPermit`: NEW pre-check via `this.prisma.workPermit.findFirst({ id, ...t })`.
  Tag `phase227-pilot-scope`. By-id update tagged
  `phase227-pilot-scope-precheck`.
- `createVisa`: NEW parent-entity gate (`findEmployeeOrFail` for
  EMPLOYEE; `findApplicantOrFail` for APPLICANT) + spreads
  `tenantData()`. Tag `phase227-pilot-scope`.
- `updateVisa`: NEW pre-check via `this.prisma.visa.findFirst({ id, ...t })`.

Real bugs closed:
- `updateEmployeeWorkflowStage` / `setEmployeeCurrentStage` had
  by-id pre-checks with no tenant filter. A tenant-A caller
  could mutate a tenant-B employee's stage. Closed by parent
  gate.
- `createWorkPermit` / `createVisa` left `tenantId` NULL on new
  rows. Pilot mode now persists `tenantId`.
- `updateWorkPermit` / `updateVisa` had by-id pre-checks with no
  tenant filter. Closed by switching pre-check to the pilot
  client.

New harnesses (real-DB SAFE_CLONE):
- `workflow-mutation-equivalence` (11 cases): updateEmployeeWorkflowStage
  / setEmployeeCurrentStage / createWorkPermit shape + tenantId
  NULL/set / updateWorkPermit / createVisa / updateVisa parity,
  validation parity, read-after-write.
- `workflow-mutation-isolation` (11 cases): cross-tenant
  rejections for stage update, current-stage set, permit/visa
  CRUD; same-tenant create persists `tenantId=A`; legacy mode
  unchanged; source-level meta-assertion of all phase227
  patterns.

Real-DB results: **44/44 workflow harness cases PASS** across
all 4 harnesses (11 + 11 + 11 + 11). Cumulative finance +
documents + vehicles + workflow: **202/202** on real Postgres 16.

The workflow module pilot is now complete (reads + writes).
Zero `phase226-excluded-mutation` annotations remain on the
active mutation paths.

## 13. Next recommended module

- **Phase 2.27 — Workflow mutation pilot** (recommended; mirrors finance/documents/vehicles precedent of completing one module before starting another).
- `applicants` (large lifecycle module touching many existing modules).
- Cross-module audit-log tenancy phase.

## 14. Blockers before workflow mutation/template refactor

- `EmployeeStage` mutations need `findEmployeeOrFail` helper (not present today; trivial to add following the vehicles 2.23 pattern).
- `StageTemplate` per-tenant override / clone semantics need Phase 3 product decision + schema migration.
- `setEmployeeCurrentStage` cross-module side effect (it currently writes to `Employee.currentWorkflowStageId` via `EmployeeStage.upsert`; the parent gate handles the tenant safety).
- Approval mutations are not present in `WorkflowService` today; if added later, they'll need their own pilot.
