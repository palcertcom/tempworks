# Phase 2.61 — Pipeline Pilot Results

> Reads-first TenantPrisma pilot for `src/pipeline`. Default-off;
> configuration-only rollback.

## Module status

| Aspect | Status |
|---|---|
| Read paths under pilot | 3 assignment-keyed (`getWorkflowCandidates`, `getWorkflowBoardView`, `getWorkflowStats`) |
| Workflow CONFIG (Workflow/Stage CRUD reads) | unchanged (global by design — no `tenantId` column) |
| Mutation parent gates | deferred (`phase261-pipeline-mutation-deferred`) |
| Stage transition flow | deferred (`phase261-pipeline-transition-deferred`) |
| Audit emission | unchanged — still `legacyPrisma.auditLog.create` (`phase261-pipeline-audit-log`) |
| Export | none today (`phase261-pipeline-export-deferred` reserved) |
| Schema migration | none |
| Production behaviour change with flags off | none |

## Harness results

```
[pipeline-equivalence] 12/12 PASS
[pipeline-isolation]   12/12 PASS
```

Cumulative regression chain:

Phase 2.61 adds 24 cases on top of Phase 2.60:
**788/788 PASS** (was 764/764 after 2.60).

## Rollback

```sh
TENANT_PRISMA_PILOT_ENABLED=false
# OR
TENANT_PRISMA_PILOT_MODULES=nothing
```

No data rollback required.

## Recommended next phase

**2.62 — Pipeline mutation + transition pilot.** Stamp `tenantId`
on `CandidateWorkflowAssignment.create` and
`EmployeeWorkflowAssignment.create`; add parent gates for
`advanceToStage`, `approveStage`, `flagStage`, `assignCandidate`,
`assignEmployee`; route the 14 `auditLog.create` sites through
`TenantAuditLogService.write`. Workflow / Stage CRUD remains
global until product approves a schema migration to add
`Workflow.tenantId`.

---

# Phase 2.62 results — Pipeline mutation + transition pilot

```
[pipeline-mutation-isolation] 17/17 PASS
[pipeline-equivalence]        12/12 PASS  (regression)
[pipeline-isolation]          12/12 PASS  (regression — case 12 updated to assert audit routing)
```

Cumulative regression chain: **805/805 PASS** (was 788/788 after 2.61).

## Recommended next phase

**2.63 — Workflow tenant scoping (schema migration).** Add
`Workflow.tenantId` (and propagate to `WorkflowStage` via the
workflow FK), backfill existing global workflows to a default
tenant or "platform" sentinel, then tenant-scope listWorkflows /
getWorkflow / createWorkflow / updateWorkflow / archiveWorkflow /
deleteWorkflow / addStage / updateStage / deleteStage /
reorderStages / addAccessUser / removeAccessUser. Requires
explicit product decision on backfill strategy because workflows
are shared today.

---

## Phase 2.63 — Workflow Tenant Scoping Schema Migration (addendum)

Strategy A landed: `Workflow.tenantId` added (nullable); legacy NULL-tenant
rows treated as read-only global templates; per-tenant workflows created
going forward. CRUD wired (list / get / create / update / archive / delete
plus stage and access-user routes). Harness `workflow-config-isolation`
19/19 PASS; Phase 2.61/2.62 pipeline harnesses re-run green. See
`SAAS_PHASE2_WORKFLOW_TENANT_SCOPE.md` for full details.
