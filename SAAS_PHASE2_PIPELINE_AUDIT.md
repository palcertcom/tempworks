# Phase 2.61 — Pipeline Module Audit + Reads-First Pilot

> Audit + reads-first TenantPrisma pilot split for `src/pipeline`
> (Workflows / WorkflowStages / Candidate+Employee assignments).
> Default-off; configuration-only rollback; no schema migration.

---

## 1. Module surface

```
backend/src/pipeline/
├── pipeline.controller.ts   (291 LoC — Workflow + stage + assignment routes)
├── pipeline.service.ts      (1431 LoC pre-2.61 / now ~1470)
├── pipeline.module.ts
└── dto/create-pipeline.dto.ts
```

The module is named `WorkflowPipelineModule` and exposes a
`WorkflowController` mounted at `/workflows`.

## 2. Tenant landscape

| Model | tenantId column | Notes |
|---|---|---|
| `Workflow` | ❌ | GLOBAL by design (cross-tenant config like `DocumentType`). |
| `WorkflowStage` | ❌ | Owned by global `Workflow`. |
| `WorkflowStageUser`, `WorkflowStageRequiredDoc`, `WorkflowAccessUser` | ❌ | linked to global stage/workflow |
| `CandidateWorkflowAssignment` | ✅ | denormed via Phase 2.3 |
| `EmployeeWorkflowAssignment` | ✅ | denormed via Phase 2.3 |
| `CandidateStageProgress`, `CandidateStageApproval`, `EmployeeStageApproval` | ❌ | scoped through parent assignment |

This shape **fundamentally limits** what tenant isolation can
achieve here: workflow CONFIGURATION (definition, stages, RBAC
assignments) is a global cross-tenant primitive today. The
tenant-bound surface is the *assignment* layer.

## 3. Scope map

### A. Read paths — IN PILOT
| Endpoint | Service method | Tag |
|---|---|---|
| `GET /workflows/:id/candidates` | `getWorkflowCandidates` | `phase261-pipeline-pilot-scope` |
| `GET /workflows/:id/board` | `getWorkflowBoardView` | `phase261-pipeline-pilot-scope` |
| `GET /workflows/:id/stats` | `getWorkflowStats` | `phase261-pipeline-pilot-scope` |

All three apply `scope().tenantWhere()` to assignment-keyed
queries:

- `candidateWorkflowAssignment.findMany/count` — direct
  `tenantId` filter.
- `candidateStageProgress.count` / `findMany` — `assignment.tenantId`
  nested filter.
- `employeeWorkflowAssignment.findMany` — direct `tenantId` filter.

### B. Workflow CONFIG reads — GLOBAL by design
| Endpoint | Service method | Status |
|---|---|---|
| `GET /workflows` | `listWorkflows` | unchanged (no `tenantId` on `Workflow`) |
| `GET /workflows/:id` | `getWorkflow` | unchanged (no `tenantId` on `Workflow`) |
| stage/access list reads | `listStages` etc. | unchanged |

Workflows are intended to be cross-tenant config. Documenting this
explicitly as the contract is the point of this phase.

### C. Mutations — deferred
All workflow / stage / assignment **writes** (create/update/delete,
stage CRUD, assignment-create, advance-stage, approvals) stay on
the same `this.prisma` getter (= `pilot.client()`), which falls
back to legacy with the flag off. They do **not** apply mutation
parent gates yet. Tag: `phase261-pipeline-mutation-deferred` and
`phase261-pipeline-transition-deferred`.

### D. Audit emission — deferred
The module emits `auditLog.create` directly (14 call sites). Tag:
`phase261-pipeline-audit-log`. Routing through
`TenantAuditLogService.write` is deferred to a follow-up phase
that does mutation pilot for pipeline.

### E. Export / report — deferred
There is no export endpoint on the module today. The board / stats
endpoints are pilot-scoped. Tag reserved:
`phase261-pipeline-export-deferred`.

## 4. Tenant join strategy

```text
ALS tenant id ──► scope.tenantWhere() ──► { tenantId: <active> }

reads:
  - CandidateWorkflowAssignment.findMany(where: { workflowId, ...tenantWhere })
  - CandidateStageProgress.findMany(where: { ..., assignment: { workflowId, ...tenantWhere } })
  - EmployeeWorkflowAssignment.findMany(where: { workflowId, ...tenantWhere })

writes (deferred):
  - workflow/stage CRUD ⇒ remain global (no tenantId available)
  - assignment CRUD ⇒ next phase will add tenantData() stamping + parent gate
```

NULL-tenant assignment rows are EXCLUDED in pilot mode (the
predicate `tenantId = <active>` is exclusive of NULL). With the
flag off they remain visible (legacy union).

## 5. Production behaviour change

**None.** With `TENANT_PRISMA_PILOT_ENABLED=false` (default):
- `pilot.client()` returns `legacyPrisma`.
- `scope().tenantWhere()` returns `{}`.
- All three assignment-keyed reads reduce to the original where
  clauses — byte-identical to pre-2.61.

## 6. Equivalence — 12/12 PASS

```
[pipeline-equivalence] 12/12 PASS
```

1. pilot disabled returns legacy list shape
2. pilot disabled `getWorkflow` matches legacy
3. pilot enabled response shape preserved (array)
4. pilot enabled candidates ⊂ legacy union
5. `getWorkflow` under pilot returns same workflow id (workflows are global)
6. stages list shape preserved (id/name/order)
7. `getWorkflowStats` keys preserved
8. `getWorkflowBoardView` shape preserved (workflow + columns)
9. allow-list unset ⇒ all modules allowed
10. allow-list `pipeline` allows pipeline, denies others
11. allow-list comma-separated allows both
12. allow-list `nothing` ⇒ scope inactive (legacy reading restored)

## 7. Isolation — 12/12 PASS

```
[pipeline-isolation] 12/12 PASS
```

1. tenant A `getWorkflowCandidates` returns only tenant A
2. tenant A excludes tenant B candidates
3. tenant A excludes NULL-tenant assignments
4. tenant B `getWorkflowCandidates` returns only tenant B
5. tenant A `getWorkflowStats` counts only tenant A (1 ACTIVE + 1 COMPLETED candidate + 1 employee → 2 active, 1 completed)
6. tenant B `getWorkflowStats` counts only tenant B (1 ACTIVE candidate + 1 employee → 2 active, 0 completed)
7. tenant A board view counts only tenant A subjects in columns
8. concurrent ALS frames stay isolated for `getWorkflowCandidates`
9. allow-list `nothing` ⇒ legacy union (B + NULL visible)
10. workflow CONFIG (`getWorkflow`) remains global — tenant A sees the global workflow id
11. mutation paths deferred (source-level: `createWorkflow` still uses `pilot.prisma`)
12. audit emission deferred (source-level: `auditLog.create` stays on `pilot.prisma`)

## 8. Rollback runbook

```sh
TENANT_PRISMA_PILOT_ENABLED=false           # disables pilot probe
# OR
TENANT_PRISMA_PILOT_MODULES=nothing         # opts pipeline out only
```

No data, no schema migration introduced. Configuration-only
rollback. The fixture extension (`phase261-pipeline-extension.sql`)
seeds harness data only — production deployments are not affected.

## 9. Remaining blockers / next phase

- **Pipeline mutation pilot**: stamp `tenantId` on
  `CandidateWorkflowAssignment.create` / `EmployeeWorkflowAssignment.create`
  via `scope.tenantData()` and add parent gates for
  `advanceToStage`, `approveStage`, etc. so a tenant-A actor
  cannot move tenant-B assignments through the global workflow.
- **Pipeline audit pilot**: route the 14 `legacyPrisma.auditLog.create`
  sites through `TenantAuditLogService.write` so audit rows for
  assignment mutations carry `tenantId` when the audit pilot is on.
- **Workflow tenant scoping**: a future product phase may
  introduce per-tenant workflows (requires schema migration on
  `Workflow.tenantId`).

---

# Phase 2.62 addendum — Pipeline mutation + transition pilot

Extends the Phase 2.61 reads-first pilot to mutation + transition
parent gates plus audit routing through `TenantAuditLogService`.

## A. Tenant stamping on assignment creation
`assignCandidate` spreads `scope().tenantData()` into the
`CandidateWorkflowAssignment.create` data block. With pilot OFF
`tenantData()` returns `{}` so the create is byte-identical to
pre-2.62. `assignEmployee` remains a documented `BadRequest`
(`WORKFLOW.EMPLOYEE_ASSIGN_FORBIDDEN`) by product spec — no
mutation surface to gate. Tag: `phase262-pipeline-mutation-pilot`.

## B. Parent gates
New private helpers:
- `findCandidateForPipelineMutationOrFail(candidateId)` — applicant
  table with `tenantWhere()`. Wired into `assignCandidate`.
- `findCandidateAssignmentForMutationOrFail(assignmentId)` —
  `CandidateWorkflowAssignment.tenantId` filter. Wired into
  `advanceToStage`.
- `findProgressForMutationOrFail(progressId)` — `CandidateStageProgress`
  scoped via `assignment.tenantId`. Wired into `updateProgress`,
  `toggleProgressFlag`, `submitApproval`.

Tag: `phase262-pipeline-transition-pilot`.

Stage object remains GLOBAL: stage existence + workflow membership
checks are unchanged. Cross-tenant access fails BEFORE any write
because the gate runs first.

## C. Audit routing
All 14 active `legacyPrisma.auditLog.create` sites now flow
through a private `auditLog(userId, action, entity, entityId,
changes?)` helper that delegates to `TenantAuditLogService.write`.

- `TENANT_AUDIT_LOG_PILOT_ENABLED=false` (default) ⇒ row carries
  no `tenantId` — byte-identical to legacy.
- `TENANT_AUDIT_LOG_PILOT_ENABLED=true` + ALS tenant attached ⇒
  row carries `tenantId = <active>`.
- Rejected mutations short-circuit BEFORE `auditLog(...)` is
  called, so no audit row is emitted for a denied cross-tenant
  attempt.

Tag: `phase262-pipeline-audit-log-pilot`.

The only remaining `prisma.auditLog.create` reference in the file
is inside `assignEmployee`'s commented-out body, which never
executes.

## D. Workflow / Stage config
Unchanged. Workflow and WorkflowStage have no `tenantId` column;
a future schema migration is required to tenant-scope workflow
configuration. Tags:
`phase262-pipeline-workflow-config-global`,
`phase262-pipeline-stage-config-global`.

## E. Harness — `pipeline-mutation-isolation` 17/17 PASS

```
[pipeline-mutation-isolation] 17/17 PASS
```

1. pilot off assignment reads succeed (legacy-compatible)
2. pilot A reads: every returned assignment has tenantId=A
3. assignEmployee remains a documented BadRequest (no mutation surface)
4. tenant A cannot assign tenant B candidate (NotFound)
5. employee assign mutation surface forbidden by product
6. rejected tenant B assign creates no row in tenant A scope
7. tenant A can advance tenant A assignment (passes tenant gate)
8. tenant A cannot advance tenant B assignment (NotFound)
9. rejected tenant B advance leaves progress unchanged
10. tenant A can toggle flag on tenant A progress
11. tenant A cannot toggle flag on tenant B progress (NotFound)
12. tenant A cannot mutate NULL-tenant legacy assignment (NotFound)
13. audit row tenant A carries tenantId=A (audit pilot ON)
14. rejected tenant B mutation emits no audit row
15. workflow CONFIG remains global (same id visible to A and B)
16. concurrent ALS frames remain isolated for advanceToStage
17. source-level: every candidateWorkflowAssignment.create site spreads tenantData()

## F. Rollback runbook

```sh
TENANT_PRISMA_PILOT_ENABLED=false           # disables pilot path
# OR
TENANT_PRISMA_PILOT_MODULES=nothing         # opts pipeline out only
# OR
TENANT_AUDIT_LOG_PILOT_ENABLED=false        # disables tenantId on audit rows
```

No data, no schema migration introduced. Configuration-only.

---

## Phase 2.63 addendum — workflow config tenant scope

Workflows now carry `tenantId text NULL`. NULL is reserved for legacy
"global templates" (Strategy A): visible to every tenant under pilot,
but mutation is refused. Tenant-specific workflows are created going
forward and refuse cross-tenant access via `workflowMutateWhere()` and
`findMutableWorkflowOrFail`. `WorkflowStage` derives its tenant through
the parent workflow (no direct column). See
`SAAS_PHASE2_WORKFLOW_TENANT_SCOPE.md`.
