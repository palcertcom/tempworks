# Phase 2.26 — Workflow Scope Split

> What ships in Phase 2.26 vs. what waits for Phase 2.27+.

---

## 1. Scope summary

| Area | Phase | This PR? |
|------|------|----------|
| `StageTemplate` reads (global catalog) | **2.26** | yes (`phase226-global`) |
| Per-stage tenant-scoped counts (`getOverview`, `getAnalytics`) | **2.26** | **YES** |
| `getTimeline` employee gate | **2.26** | **YES** |
| `getStageDetails` applicant/employee/document tenant filters | **2.26** | **YES** |
| `findWorkPermits` / `findVisas` direct tenant filter | **2.26** | **YES** |
| Stage state mutations (`updateEmployeeWorkflowStage`, `setEmployeeCurrentStage`) | 2.27+ | NO |
| WorkPermit / Visa CRUD | 2.27+ | NO |
| Template clone / copy / per-tenant override | 3.x | NO |
| Approval mutations | n/a (not in this service) | NO |
| Cross-module documents `checkAndAutoCompleteStage` integration | 2.27+ | NO |

## 2. Phase 2.26 — Read path refactor (THIS PR)

What lands:

- `WorkflowService` constructor injects `PilotPrismaAccessor`.
- `private get prisma()` returns `pilot.client()`.
- `private scope()` returns `getPilotScope(this.pilot, 'workflow')`.
- `StageTemplate.*` reads tagged `phase226-global`.
- `EmployeeStage` aggregate counts narrowed via relation filter
  (`employee: { tenantId }`).
- `applicant.count` / `applicant.findMany` narrowed via
  direct `tenantId` filter.
- `employee.count` / `employee.findUnique` narrowed via direct
  `tenantId` filter.
- `getTimeline` migrates `findUnique` → `findFirst` + tenant
  predicate.
- `WorkPermit` / `Visa` reads narrowed.
- All mutation sites (`updateEmployeeWorkflowStage`,
  `setEmployeeCurrentStage`, `createWorkPermit`, etc.)
  routed through `legacyPrisma` with
  `phase226-excluded-mutation` annotations.
- All `auditLog.create` sites tagged `phase226-audit-log`.

What does NOT land:

- No mutation behaviour change.
- No new feature flag.
- No schema change.
- No `StageTemplate.tenantId` column (deferred to Phase 3).
- No template clone / copy logic.

## 2.1 Phase 2.27 update — mutation pilot shipped

Phase 2.27 closes the workflow module pilot. See
`SAAS_PHASE2_WORKFLOW_MUTATION_AUDIT.md` and
`SAAS_PHASE2_WORKFLOW_MUTATION_SCOPE_DECISION.md`.

- New `findEmployeeOrFail` / `findApplicantOrFail` helpers
  (tenant-scoped via pilot client) gate every mutation.
- `updateEmployeeWorkflowStage`, `setEmployeeCurrentStage`:
  parent employee gate; by-key/by-employeeId mutations stay on
  legacyPrisma with `phase227-pilot-scope-precheck`.
- `createWorkPermit`: parent gate + `scope.tenantData()` on the
  new row. Tag `phase227-pilot-scope`.
- `updateWorkPermit`, `updateVisa`: NEW tenant-scoped pre-check
  (`this.prisma.X.findFirst({ id, ...t })`).
- `createVisa`: parent-entity gate (EMPLOYEE/APPLICANT) +
  `scope.tenantData()`.

`StageTemplate` decision unchanged: global catalog. Per-tenant
override remains a Phase 3 product question.

## 3. Phase 3+ — Template per-tenant override (FUTURE)

The mutation pilot needs:

- `findEmployeeOrFail` / `findApplicantOrFail` private helpers
  that tenant-scope via `this.prisma.<entity>.findFirst({ id, ...t })`.
- `updateEmployeeWorkflowStage` and `setEmployeeCurrentStage`
  both already validate the parent employee — switch to the
  helper. The `EmployeeStage` mutation by composite key is
  then gated by parent tenant.
- `createWorkPermit` / `createVisa` need
  `scope.tenantData()` spread + employee/entity tenant probe
  before insert.
- `updateWorkPermit` / `updateVisa` need a tenant-scoped
  pre-check via `this.prisma.workPermit.findFirst({ id, ...t })`.

## 4. Phase 2.27+ — Documents auto-complete integration (FUTURE)

`documents.checkAndAutoCompleteStage` (in `src/documents`) writes
to `EmployeeStage.upsert` + `applicant.update`. It runs from
`verify` after a tenant-scoped `findOne` (Phase 2.20). Currently
tagged `phase220-excluded-mutation`. When Phase 2.27 ships the
workflow mutation pilot, the cross-module write inherits the
parent gate from documents and only needs a tenant probe on the
target entity.

## 5. Phase 3+ — Template clone / per-tenant override

See `SAAS_PHASE2_WORKFLOW_SYSTEM_TEMPLATE_DECISION.md`. Out of
scope for Phase 2.

## 6. Guard-rails enforced by this PR

- Source-level meta-assertion in the isolation harness: every
  mutation method (`updateEmployeeWorkflowStage`,
  `setEmployeeCurrentStage`, `createWorkPermit`,
  `updateWorkPermit`, `createVisa`, `updateVisa`) sources
  `this.legacyPrisma` for its mutation site.
- All `legacyPrisma.*` mutation sites carry the
  `phase226-excluded-mutation` annotation.
- All `auditLog.create` sites carry `phase226-audit-log`.
- The fixture seeds two tenants with employees + employeeStages
  + workPermits + visas so the read paths can be exercised
  with cross-tenant collision shapes.

## 7. Operator checklist for Phase 2.27

- [ ] Read this scope-split document.
- [ ] Re-run `saas:phase2-workflow-equivalence` and
      `saas:phase2-workflow-isolation` against the same staging
      DB.
- [ ] Add a new harness `saas:phase2-workflow-mutation-equivalence`
      that asserts cross-tenant `updateEmployeeWorkflowStage` /
      `createWorkPermit` raise NotFoundException and that
      `createWorkPermit` / `createVisa` persist `tenantId`.
- [ ] Update the `phase226-excluded-mutation` annotations to
      `phase227-pilot-scope` once the mutation paths engage the
      pilot.
