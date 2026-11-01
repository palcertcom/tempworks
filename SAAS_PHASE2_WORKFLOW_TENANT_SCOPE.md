# SaaS Phase 2.63 — Workflow Tenant Scoping Schema Migration

## Scope

Adds `Workflow.tenantId` (nullable text) plus a lookup index. Promotes
workflow configuration from a single-tenant global table to a per-tenant
construct while preserving legacy / NULL-tenant rows as **read-only global
templates** (Strategy A).

`WorkflowStage` does NOT carry a direct tenantId — it derives its tenant
through the parent `Workflow.tenantId`. The same is true for `WorkflowStageUser`,
`WorkflowStageRequiredDoc`, and `WorkflowAccessUser`.

## Strategy A — global templates

| Row state                | Visibility (pilot ON, tenant A)  | Mutation (pilot ON, tenant A) |
| ------------------------ | --------------------------------- | ----------------------------- |
| `tenantId = A`           | visible                           | allowed                       |
| `tenantId = B`           | hidden (NotFound)                 | refused (NotFound)            |
| `tenantId IS NULL`       | visible as **global template**    | refused (NotFound)            |

Rationale: pre-2.63 workflows were created without a tenant binding. Wiping
or backfilling those rows would require an operational migration window;
treating them as immutable global templates lets the pilot turn on without
data-plane changes. Tenant-specific workflows are created going forward
under pilot mode.

## Migration

- `prisma/migrations/saas_phase263_workflow_tenant_scope/migration.sql`
  - Additive: `ALTER TABLE workflows ADD COLUMN IF NOT EXISTS tenantId text`
  - Index: `workflows_tenantId_idx ON workflows(tenantId)`
  - **No backfill** — existing rows retain `tenantId = NULL`
- `migration.down.sql` drops the column + index. Safe ONLY when no
  `workflows.tenantId IS NOT NULL` rows exist.

## Service plumbing

Three new helpers on `WorkflowService`:

- `workflowReadWhere()` → `{ OR: [{tenantId: active}, {tenantId: null}] }`
  for read scope (own + NULL-global templates visible)
- `workflowMutateWhere()` → `{ tenantId: active }` (refuses templates +
  cross-tenant)
- `findMutableWorkflowOrFail(workflowId)` — parent gate for stage and
  access-user routes

Wired into:

- Reads: `listWorkflows`, `getWorkflow`, `copyWorkflow.source` lookup
- Stamping: `createWorkflow.create.data` + `copyWorkflow.tx.workflow.create`
  spread `scope().tenantData()`
- Mutation gates: `updateWorkflow`, `archiveWorkflow`, `deleteWorkflow`,
  `addStage`, `updateStage` (via parent), `deleteStage` (via parent),
  `reorderStages`, `addAccessUser`, `removeAccessUser`
- The `isDefault` flip in `createWorkflow` / `updateWorkflow` is scoped to
  the active tenant so a tenant's promotion does not dethrone another
  tenant's default.

Assignments / transitions (Phase 2.61/2.62) are untouched — they remain
tenant-bound via `assignment.tenantId`.

## Flags / Rollback

Configuration-only:

- `TENANT_PRISMA_PILOT_ENABLED=false` → all helpers return `{}` and
  `tenantData()` is a no-op. Byte-identical legacy behaviour.
- `TENANT_PRISMA_PILOT_MODULES` allow-list controls pipeline module
  opt-in.

Schema rollback via `migration.down.sql` only after operators have
cleaned tenant-tagged rows.

## Coverage

`backend/scripts/saas/phase2/workflow-config-isolation.ts` — 19 cases,
real DB harness against `saas_phase1_fixture`:

1. pilot off: createWorkflow returns tenantId=null (legacy)
2. pilot A: createWorkflow stamps tenantId=A
3. pilot A: createWorkflow(isDefault) flips ONLY own-tenant defaults
4. listWorkflows pilot A: own + NULL-global only
5. listWorkflows pilot B: own + NULL-global only
6. getWorkflow pilot A: own workflow visible
7. getWorkflow pilot A: NULL-global template visible
8. getWorkflow pilot A: tenant B → NotFound
9. updateWorkflow pilot A: NULL-global → NotFound
10. updateWorkflow pilot A: tenant B → NotFound
11. updateWorkflow pilot A: own → success
12. deleteWorkflow pilot A: NULL-global → NotFound
13. archiveWorkflow pilot A: tenant B → NotFound
14. addStage pilot A: tenant B parent → NotFound + no row inserted
15. updateStage pilot A: stage in NULL-global → NotFound
16. deleteStage pilot A: stage in NULL-global → NotFound
17. addAccessUser pilot A: tenant B parent → NotFound
18. concurrent ALS frames remain isolated for updateWorkflow
19. source-level: helpers defined + wired into update/archive/delete/stage
    routes + createWorkflow spreads tenantData()

Result: **19/19 PASS**.

Existing sentinels re-run green:
- Phase 2.61 pipeline-isolation 12/12, pipeline-equivalence 12/12
- Phase 2.62 pipeline-mutation-isolation 17/17

Cumulative regression count: **824/824 PASS** (805 from prior phases + 19).

## Scanner tags

Added to `scripts/scan-annotations.ts`:

- `phase263-workflow-tenant-scope` (allowed in `src/pipeline/`)
- `phase263-workflow-schema-migration` (allowed in `src/pipeline/`, `prisma/`)
- `phase263-workflow-global-template` (allowed in `src/pipeline/`)
- `phase263-workflow-stage-scope` (allowed in `src/pipeline/`)
- `phase263-workflow-audit-log` (allowed in `src/pipeline/`)

`scan-annotations` reports 0 findings; raw-SQL baseline unchanged.
