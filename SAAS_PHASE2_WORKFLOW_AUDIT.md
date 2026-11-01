# Phase 2.26 — Workflow Module Audit

> Inventory of every Prisma touchpoint in `src/workflow` plus the
> read/write split for Phase 2.26.

---

## 1. Module surface

| File | Role | Lines |
|------|------|------:|
| `src/workflow/workflow.service.ts` | business logic | 317 |
| `src/workflow/workflow.controller.ts` | HTTP surface | 137 |
| `src/workflow/workflow.module.ts` | Nest wiring | 10 |

Total Prisma sites: **35**.

## 2. Models touched — tenancy map

| Model | Has `tenantId`? | Treatment |
|-------|:---:|-----------|
| `StageTemplate` | – | **GLOBAL CATALOG** (system templates; `name @unique`) |
| `EmployeeStage` | – | child of `Employee`; gated by parent's `tenantId` |
| `Employee` | ✓ | Phase 2.3 denorm |
| `Applicant` | ✓ | Phase 2.3 denorm; `currentWorkflowStageId` is a FK to global `StageTemplate` |
| `Document` | ✓ | Phase 2.3; reads only (doc-checklist build) |
| `WorkPermit` | ✓ | Phase 2.3 denorm |
| `Visa` | ✓ | Phase 2.3 denorm |
| `AuditLog` | – | global by design |

`StageTemplate` is intentionally global today (catalog of stages
available to all tenants). `EmployeeStage` rows live per-employee
and inherit tenancy via the parent. `Applicant.currentWorkflowStageId`
is a column on the per-tenant `Applicant`, so per-stage applicant
counts naturally tenant-scope when we filter by `Applicant.tenantId`.

## 3. Read paths — INCLUDED in Phase 2.26

| # | Method | Operation | Tenant filter |
|--:|--------|-----------|---------------|
| 1 | `getStages` | `stageTemplate.findMany` | **GLOBAL** (`phase226-global` — catalog) |
| 2 | `getOverview` | `stageTemplate.findMany` | global catalog |
| 3 | `getOverview` per-stage counts | 3× `employeeStage.count` + 1× `applicant.count` | **tenant-scoped** via `employee/applicant.tenantId` (employeeStage gated through join filter on `employee.tenantId`) |
| 4 | `getAnalytics` | `employee.count`, `employeeStage.groupBy`, `employeeStage.findMany` recent-activity | tenant-scoped via parent employee |
| 5 | `getTimeline(employeeId)` | `employee.findUnique` (was findUnique → switch to findFirst+t) | id + tenantId |
| 6 | `getStageDetails(stageId)` global stage lookup | `stageTemplate.findUnique` | global |
| 7 | `getStageDetails` per-stage applicants/employeeStages | `applicant.findMany` (tenantId filter), `employeeStage.findMany` (employee.tenantId filter via relation) | tenant-scoped |
| 8 | `getStageDetails` doc-checklist | `document.findMany` | tenant-scoped |
| 9 | `findWorkPermits` | `workPermit.findMany` + count | tenant-scoped |
| 10 | `findVisas` | `visa.findMany` + count | tenant-scoped |

`employeeStage` does not have `tenantId`. Two safe ways to scope it:

(a) **filter via relation**: `employeeStage.count({ where: { stageId, employee: { tenantId } } })` — Prisma generates a join.
(b) **gate via parent**: `findVehicleOrFail`-style — load the parent first.

Phase 2.26 picks (a) for `getOverview`/`getAnalytics` aggregate counts (no parent id available), and (b) for `getTimeline` (parent employee id is the input).

## 4. Mutation paths — EXCLUDED from Phase 2.26

| Method | Reason |
|--------|--------|
| `updateEmployeeWorkflowStage` | mutates `EmployeeStage`; uses `findUnique({ employeeId_stageId })`; needs parent gate via `findEmployeeOrFail` (not present today) |
| `setEmployeeCurrentStage` | mutates EmployeeStage + employee state |
| `createWorkPermit` / `updateWorkPermit` | Phase 2.27+ |
| `createVisa` / `updateVisa` | Phase 2.27+ |
| Stage/template CRUD | not present in this service today; lives elsewhere |
| Template clone/copy | not present today; reserved for future product feature |
| Approval mutations | not present in this service today |

## 5. Cross-module side effects

- `documents.checkAndAutoCompleteStage` (in `src/documents/documents.service.ts`) writes to `EmployeeStage.upsert` + `applicant.update` from inside `verify`. That side effect is currently `phase220-excluded-mutation` and runs after a tenant-scoped `findOne` in documents — same gate logic. Phase 2.26 does NOT touch it.

## 6. System-template decision

`StageTemplate` is a global catalog today. Phase 2.26 treats it
as global with explicit `phase226-global` tags. See
`SAAS_PHASE2_WORKFLOW_SYSTEM_TEMPLATE_DECISION.md` for the
analysis and the Phase 3 product question.

## 7. Risks / out-of-scope concerns

- `StageTemplate.name` is `@unique`. If Phase 3 adds per-tenant
  templates, the schema must move to composite uniqueness — same
  shape as `Vehicle.registrationNumber` (Phase 2.24 deferred).
- `EmployeeStage` has no `tenantId` column. Phase 2.26 narrows
  reads via the parent `employee.tenantId` relation filter; a
  follow-up schema phase could denorm if direct queries ever
  need tenant indexing.
- `getAnalytics.recentActivity` returns the most recent 20
  activity rows globally today. Phase 2.26 narrows by joining
  on `employee.tenantId`.
- `Applicant.currentWorkflowStageId` is a FK to global
  `StageTemplate`. Cross-tenant applicant ids cannot be
  introduced via this FK; the predicate uses the per-tenant
  `Applicant` row.
- `WorkPermit` and `Visa` have direct `tenantId`. Their reads
  narrow in the same shape as finance/documents.

## 8. Scope summary

| Class | Methods |
|-------|---------|
| **INCLUDED — pilot scope** | `getStages` (catalog reads), `getOverview` (catalog + per-stage tenant-scoped counts), `getAnalytics` (employee + EmployeeStage tenant-scoped via relation), `getTimeline` (employee.findFirst tenant-scoped), `getStageDetails` (catalog + applicant/employeeStage tenant-scoped), `findWorkPermits` (direct tenant), `findVisas` (direct tenant) |
| **GLOBAL/CATALOG** | `StageTemplate` reads everywhere |
| **EXCLUDED — Phase 2.27+ writes** | `updateEmployeeWorkflowStage`, `setEmployeeCurrentStage`, `createWorkPermit`, `updateWorkPermit`, `createVisa`, `updateVisa` |
| **EXCLUDED — audit-log** | every `auditLog.create` site |
