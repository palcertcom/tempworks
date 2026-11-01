# Phase 2.27 — Workflow Mutation Audit

> Every workflow mutation method, mapped to Prisma writes,
> ownership path, side effects, and Phase 2.27 disposition.

---

## 1. Method-by-method inventory

### 1.1 `updateEmployeeWorkflowStage(employeeId, stageId, dto, updatedById?)`

- Prisma: `legacyPrisma.employeeStage.findUnique({ employeeId_stageId })` (pre-check), `legacyPrisma.employeeStage.update`, `legacyPrisma.auditLog.create`.
- Models: `EmployeeStage`, `AuditLog`.
- Action: UPDATE stage status / notes / assignee.
- Tenant ownership path: `EmployeeStage` has no `tenantId` column — gated by parent `Employee.tenantId`.
- Cross-tenant risk today: HIGH. The pre-check is by composite key `{ employeeId, stageId }` alone. A tenant-A caller passing a tenant-B `employeeId` succeeds at the pre-check (no tenant filter) and the by-key update mutates the foreign tenant's row.
- Required fix: add a `findEmployeeOrFail(employeeId)` helper that loads the parent employee through the pilot client with tenant predicate. Cross-tenant `employeeId` raises 404 BEFORE the EmployeeStage lookup.
- Phase 2.27: **INCLUDED_NOW** — add helper + parent gate.

### 1.2 `setEmployeeCurrentStage(employeeId, stageId, updatedById?)`

- Prisma: `legacyPrisma.employee.findUnique({ id, deletedAt: null })` (no tenant filter today), `legacyPrisma.stageTemplate.findUnique` (global), `legacyPrisma.employeeStage.updateMany`, `legacyPrisma.employeeStage.upsert`, `legacyPrisma.auditLog.create`.
- Models: `Employee`, `StageTemplate` (read), `EmployeeStage`, `AuditLog`.
- Action: complete IN_PROGRESS stages + upsert chosen stage as IN_PROGRESS.
- Cross-tenant risk today: HIGH. Same shape as 1.1 — the employee pre-check is by id only.
- Required fix: switch the employee pre-check to the new `findEmployeeOrFail`.
- Phase 2.27: **INCLUDED_NOW**.

### 1.3 `createWorkPermit(dto, createdById?)`

- Prisma: `legacyPrisma.employee.findUnique({ id })` (no tenant filter), `legacyPrisma.workPermit.create`, `legacyPrisma.auditLog.create`.
- Models: `Employee`, `WorkPermit`, `AuditLog`.
- Action: CREATE WorkPermit.
- Cross-tenant risk today: HIGH on two axes:
  - Employee pre-check is by id only.
  - New `WorkPermit.tenantId` column is left NULL (Phase 2.3 denorm exists but Phase 2.26 only narrowed reads).
- Required fix: parent employee gate via `findEmployeeOrFail` + spread `scope.tenantData()` into create data.
- Phase 2.27: **INCLUDED_NOW**.

### 1.4 `updateWorkPermit(id, dto, updatedById?)`

- Prisma: `legacyPrisma.workPermit.findUnique({ id })`, `legacyPrisma.workPermit.update`.
- Cross-tenant risk today: HIGH. The pre-check is by id alone. A tenant-A caller passing a tenant-B `WorkPermit.id` mutates the foreign row.
- Required fix: switch the pre-check to `this.prisma.workPermit.findFirst({ id, ...t })` so cross-tenant ids raise 404 BEFORE the update.
- Phase 2.27: **INCLUDED_NOW** — switch pre-check.

### 1.5 `createVisa(dto, createdById?)`

- Prisma: `legacyPrisma.visa.create`, `legacyPrisma.auditLog.create`.
- Models: `Visa`, `AuditLog`.
- `Visa.entityType` is `APPLICANT` or `EMPLOYEE`; `entityId` references the parent.
- Cross-tenant risk today: HIGH on two axes:
  - No parent-entity gate (caller can pass any `entityId`).
  - New `Visa.tenantId` left NULL.
- Required fix: parent-entity gate (`findEmployeeOrFail` for EMPLOYEE; `findApplicantOrFail` for APPLICANT) BEFORE create + spread `scope.tenantData()`.
- Phase 2.27: **INCLUDED_NOW**.

### 1.6 `updateVisa(id, dto, updatedById?)`

- Prisma: `legacyPrisma.visa.findUnique({ id })`, `legacyPrisma.visa.update`.
- Same shape as `updateWorkPermit`.
- Phase 2.27: **INCLUDED_NOW** — switch pre-check via `this.prisma.visa.findFirst({ id, ...t })`.

## 2. Audit log

`auditLog.create` writes are global by design (cross-module phase). Tag stays `phase226-audit-log`.

## 3. Notification side effects

None in workflow module.

## 4. Cross-module side effects

`setEmployeeCurrentStage` writes to `EmployeeStage.upsert`. Same parent gate handles both writes.

`documents.checkAndAutoCompleteStage` (in `src/documents`) writes `EmployeeStage.upsert` + `applicant.update` from inside `verify`. Phase 2.27 does NOT change that — it remains `phase220-excluded-mutation` and runs after the documents tenant-scoped `findOne` (Phase 2.20). When workflow mutation pilot is complete the cross-module write inherits the parent gate from documents.

## 5. Rollback risk summary

| Method | Rollback flag | Rollback action |
|--------|---------------|------------------|
| `updateEmployeeWorkflowStage` | `TENANT_PRISMA_PILOT_ENABLED=false` | parent gate disengages; legacy by-key update behaviour returns |
| `setEmployeeCurrentStage` | same | parent gate disengages |
| `createWorkPermit` / `createVisa` | same | new rows stop carrying tenantId; parent gate disengages |
| `updateWorkPermit` / `updateVisa` | same | tenant-scoped pre-check reduces to plain by-id lookup |

No DB state introduced. No migration. Pure configuration rollback.

## 6. Production safety

With `TENANT_PRISMA_PILOT_ENABLED=false`:

- `tenantData()` returns `{}` ⇒ no `tenantId` written.
- `findEmployeeOrFail`'s `tenantWhere()` returns `{}` ⇒ plain by-id lookup.
- Audit log writes unchanged.

Production behaviour byte-identical to pre-2.27.

## 7. StageTemplate decision unchanged

Phase 2.26 decision stands: `StageTemplate` is a global catalog. Phase 2.27 does NOT add `tenantId` to `StageTemplate`, does NOT clone catalog per tenant, does NOT change `name @unique`. `StageTemplate` reads inside mutation methods (e.g. `setEmployeeCurrentStage`'s stage lookup) remain `phase226-global`.
