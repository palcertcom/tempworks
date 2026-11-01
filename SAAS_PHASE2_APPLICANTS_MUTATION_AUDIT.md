# Phase 2.29 — Applicants Mutation Audit

> Every applicants mutation method, mapped to Prisma writes,
> ownership path, side effects, and Phase 2.29 disposition.

---

## 1. Method-by-method inventory

### 1.1 `create(dto, actorId, actor)`
- Prisma: `applicant.create`.
- Models: `Applicant`.
- Action: CREATE. Default tenant pin: caller-supplied `dto.agencyId` (external actor pinned to its own agency).
- Tenant: write `tenantId` via `scope.tenantData()`; agency tenancy not validated cross-actor.
- Phase 2.29: **INCLUDED_NOW** — `tenantData()` spread on create.

### 1.2 `update(id, dto, actorId, actor)`
- Prisma: `applicant.findFirst` (email dup-check, global), `applicant.update` (by id).
- Tenant: NEW parent gate via `findApplicantOrFail(id)` (already added in 2.28; reused here). Email dup-check stays global (`phase228-global`).
- Phase 2.29: **INCLUDED_WITH_GUARD**.

### 1.3 `uploadPhoto(id, file)`
- Prisma: `applicant.findUnique` (pre-check, no tenant filter), `applicant.update` (by id). Storage: `storage.uploadFile` BEFORE the DB update.
- Phase 2.29: **DEFERRED_HIGH_RISK** — storage upload precedes tenant gate; needs documents-2.21-style storage guard. Phase 2.30+.

### 1.4 `updateStatus(id, status, actorId, actor)`
- Prisma: `applicant.update` (by id) + audit.
- Phase 2.29: **INCLUDED_WITH_GUARD** — add `findApplicantOrFail(id)` first.

### 1.5 `remove(id, actorId, actor)`
- Prisma: `applicant.update` (soft-delete) + audit.
- Phase 2.29: **INCLUDED_WITH_GUARD**.

### 1.6 `publicSubmit(dto)`
- Prisma: `applicant.create`. Side effects: email send + audit.
- Tenant context: NONE — public form runs without an ALS tenant frame.
- Phase 2.29: **DEFERRED_PUBLIC_ENTRY** — needs explicit tenant attribution rules (default tenant pin or product decision). Stays `phase228-excluded-mutation`.

### 1.7 `setCurrentStage(id, stageId, actorId)`
- Prisma: `applicant.update` + `stageTemplate.findUnique` (global catalog) + audit.
- Phase 2.29: **INCLUDED_WITH_GUARD** — applicant gate; StageTemplate stays `phase228-global`.

### 1.8 `approveApplicant(id, actorId)`
- Prisma: `applicant.update`.
- Phase 2.29: **INCLUDED_WITH_GUARD**.

### 1.9 `rejectApplicant(id, reason, actorId)`
- Prisma: `applicant.update`.
- Phase 2.29: **INCLUDED_WITH_GUARD**.

### 1.10 `convertLeadToCandidate(id, dto, actorId)`
- Prisma: `systemSetting.findUnique` (global), `applicant.update` (transactional with related history), `agency.findUnique`, `applicantAgencyHistory.updateMany` + `applicantAgencyHistory.create` + audit.
- Tenant: parent applicant gate via `findApplicantOrFail`. Target agency must belong to active tenant — add `findAgencyOrFail` helper. The agency-history writes are gated by parent applicant.
- Phase 2.29: **INCLUDED_WITH_GUARD** — applicant gate + agency tenant probe.

### 1.11 `reassignAgency(id, dto, actorId, actor)`
- Prisma: `agency.findUnique` (target), `applicantAgencyHistory.updateMany` + `applicantAgencyHistory.create`, `applicant.update`, audit.
- Tenant: parent applicant gate + target agency gate.
- Phase 2.29: **INCLUDED_WITH_GUARD**.

### 1.12 `upsertFinancialProfile(id, dto, actorId)`
- Prisma: `applicantFinancialProfile.upsert` + audit.
- Already calls `findOne` (Phase 2.28 tenant-scoped).
- Phase 2.29: **INCLUDED_WITH_GUARD** — already gated, just retag.

### 1.13 `bulkAction(dto, actorId, actor)`
- Prisma: per-id branching: status / tier / agency-assign / convert-to-candidate / soft-delete loops.
- Cross-tenant risk: HIGH today. The `dto.applicantIds[]` list is iterated without per-id tenant filtering. A mixed-id list could mutate tenant B rows if the caller is a System Admin operating with ALS=A.
- Required fix: **bulk filter** — pre-filter the id list via `applicant.findMany({ id: { in: ids }, ...t })` and only iterate over the survivors.
- Phase 2.29: **INCLUDED_WITH_BULK_FILTER**.

### 1.14 `convertToEmployee(id, dto, actorId, actor)`
- Prisma: huge transactional flow:
  - `employee.findFirst` (existing check)
  - `stageTemplate.findMany` (global catalog)
  - `employee.create` (new tenant employee)
  - `document.updateMany` (re-points entityType/entityId from APPLICANT to EMPLOYEE)
  - `financialRecord.updateMany` (same)
  - `applicant.update` (sets `convertedToEmployeeId`, `deletedAt`)
  - audit
- Cross-module risk: VERY HIGH. The conversion writes Documents and FinancialRecords, both of which already carry tenantId from earlier phases. The cross-module write is structurally safe IF the parent applicant gate runs first.
- Phase 2.29: **INCLUDED_WITH_GUARD** + spread `scope.tenantData()` into the `employee.create` so the new Employee carries `tenantId=A`. Document.updateMany / FinancialRecord.updateMany filter by `entityType+entityId` (which the gated applicant guarantees is tenant A).
- Conversion semantics UNCHANGED.

### 1.15 `requestDelete(candidateId, reason, requestedById)`
- Prisma: `applicant.findFirst` (parent), `candidateDeleteRequest.findFirst` (existing check), `candidateDeleteRequest.create`.
- Phase 2.29: **INCLUDED_WITH_GUARD** — switch parent lookup to `findApplicantOrFail`.

### 1.16 `reviewDeleteRequest(requestId, status, ...)`
- Prisma: `candidateDeleteRequest.findUnique`, `candidateDeleteRequest.update`, optional `applicant.update` soft-delete.
- Tenant: NEW pre-check via `this.prisma.candidateDeleteRequest.findFirst({ id, applicant: { ...t } })` relation filter.
- Phase 2.29: **INCLUDED_WITH_GUARD**.

## 2. Cross-module dependencies (CROSS_MODULE_DEPENDENCY)

- `convertToEmployee` writes to: `Employee` (new), `Document.updateMany`, `FinancialRecord.updateMany`. Documents 2.21 and finance 2.17 are both in pilot mode for tenant-scoped reads/writes; the cross-module updates here are by `entityType + entityId` which is tenant-pinned by the parent applicant gate.
- `setCurrentStage` writes to `applicant.currentWorkflowStageId` only (no cross-module side effect today).

## 3. Audit log

`auditLog.create` stays on `legacyPrisma` — global by design; cross-module audit-log tenancy is a separate phase.

## 4. Notification side effects

`publicSubmit` may dispatch email via `EmailService`. Out of scope for Phase 2.29 (deferred with the public submit path).

## 5. Rollback risk summary

| Method | Rollback flag | Action |
|--------|---------------|--------|
| All `INCLUDED_*` paths | `TENANT_PRISMA_PILOT_ENABLED=false` | parent gate disengages; `tenantData` spread collapses to `{}`; bulk filter passes through unchanged |
| `publicSubmit` (DEFERRED) | n/a | unchanged from pre-2.29 |
| `uploadPhoto` (DEFERRED) | n/a | unchanged from pre-2.29 |

No DB state introduced. No migration. Pure configuration rollback.

## 6. Production safety

With `TENANT_PRISMA_PILOT_ENABLED=false`:

- `tenantData()` returns `{}` → no tenantId written.
- `findApplicantOrFail` / `findAgencyOrFail` reduce to plain by-id lookups (matching the prior `findUnique`).
- `bulkAction` ID pre-filter passes the entire input list through (`tenantWhere()` returns `{}`).
- All audit-log writes unchanged.
- Email notifications unchanged.

Production behaviour byte-identical to pre-2.29.
