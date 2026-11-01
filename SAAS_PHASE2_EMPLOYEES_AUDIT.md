# Phase 2.33 — Employees Module Audit

> Inventory and decision matrix for the `src/employees` reads-first pilot.

---

## 1. Files in module

| File | Lines | Role |
|---|--:|---|
| `src/employees/employees.controller.ts` | 212 | HTTP routes |
| `src/employees/employees.service.ts`    | 493 | All Prisma calls live here |
| `src/employees/employees.module.ts`     | 10  | Nest module wiring |
| `src/employees/dto/*.ts`                | (4) | Request DTOs |

`EmployeesService` constructs with `PrismaService` + `StorageService`. No
pilot accessor today.

## 2. Models touched

| Model | Where | Has `tenantId`? |
|---|---|---|
| `Employee` | `findAll`, `findOne`, `create`, `update`, `remove`, `updateStatus`, `uploadPhoto`, `exportExcel` | **YES** (`tenantId String?`, indexed) |
| `EmployeeAgencyAccess` | `findAll`, `findOne` (gate), `listAgencyAccess`, `grantAgencyAccess`, `updateAgencyAccess`, `revokeAgencyAccess` | NO column today; rides on parent `employeeId` |
| `Agency` | `grantAgencyAccess` | YES |
| `StageTemplate` | `create` (init stages) | NO (global catalog, Phase 2.26) |
| `EmployeeStage` | `getWorkflow`, `getTraining`, `getPerformance` | NO (rides on `employeeId`) |
| `Document` | `getDocuments`, `getCompliance`, `getCertifications`, `getPerformance` | YES (Phase 2.20) |
| `ComplianceAlert` | `getCompliance` | YES (Phase 2.8) |
| `ApplicantFinancialProfile` | `getFinancialProfile` | NO (rides on unique `employeeId`) |

## 3. Per-method read/write classification

| # | Method | Type | This phase |
|---|---|---|---|
| 1 | `findAll(query, actor)` | READ | **INCLUDED** — `where.tenantId` spread; preserves external-actor agency-grant filter additively |
| 2 | `findOne(id, actor, opts)` | READ + per-actor permission check | **INCLUDED** — `findFirst({ id, deletedAt: null, ...tenantWhere() })`; permission grant lookup unchanged (relation by `employeeId` after parent gate) |
| 3 | `listAgencyAccess(employeeId)` | READ | **INCLUDED** — parent gate via tenant-scoped employee read, then by `employeeId` |
| 4 | `grantAgencyAccess(...)` | WRITE | **EXCLUDED** — `phase233-excluded-mutation` |
| 5 | `updateAgencyAccess(...)` | WRITE | **EXCLUDED** — `phase233-excluded-mutation` |
| 6 | `revokeAgencyAccess(...)` | WRITE | **EXCLUDED** — `phase233-excluded-mutation` |
| 7 | `create(dto, actorId)` | WRITE | **EXCLUDED** — Phase 2.34+ |
| 8 | `generateEmployeeNumber()` | global serial helper | **EXCLUDED** — `phase233-global` (raw SQL, identifier sequence) |
| 9 | `update(id, dto, actor)` | WRITE | **EXCLUDED** — gated by `findOne` (which becomes tenant-scoped this phase) |
| 10 | `uploadPhoto(id, file)` | WRITE + storage | **EXCLUDED** — `phase233-excluded-storage` (mirrors applicants Phase 2.31 pattern, deferred to Phase 2.34) |
| 11 | `getFinancialProfile(id)` | READ | **INCLUDED** — parent gate via `findOne`; inner read uses unique `employeeId` |
| 12 | `remove(id, actor)` | WRITE | **EXCLUDED** |
| 13 | `updateStatus(id, status, actor)` | WRITE | **EXCLUDED** |
| 14 | `getDocuments(id)` | READ | **INCLUDED** — parent gate via `findOne` |
| 15 | `getWorkflow(id)` | READ | **INCLUDED** — parent gate via `findOne` |
| 16 | `getCompliance(id)` | READ | **INCLUDED** — parent gate via `findOne` |
| 17 | `getCertifications(id)` | READ | **INCLUDED** — parent gate via `findOne` |
| 18 | `getTraining(id)` | READ | **INCLUDED** — parent gate via `findOne` |
| 19 | `getPerformance(id)` | READ | **INCLUDED** — parent gate via `findOne` |
| 20 | `exportExcel(query, actor, ids?, locale)` | READ | **INCLUDED** — by-id branch spreads `tenantWhere()`; default branch delegates to `findAll` (already narrowed) |

## 4. Tenant ownership path

The `Employee.tenantId` column is denormalized from Phase 1 / Phase 2
work and now carries the active tenant for every row created via the
piloted Applicants conversion (Phase 2.29 + 2.32) and any future
piloted `create` call. Phase 2.33 reads narrow on this column when
the pilot is active.

`EmployeeAgencyAccess` has no `tenantId` column. Phase 2.33 keeps
this. Access grants ride on the gated parent `Employee` row — once
the parent is tenant-scoped, the grant lookup by `employeeId +
agencyId` is automatically tenant-safe (foreign-tenant `employeeId`
fails the parent gate first).

`EmployeeStage` has no `tenantId` column — same story (rides on
parent `employeeId`).

## 5. Uniqueness constraints (current)

- `Employee.employeeNumber @unique` — global today.
- `Employee.email @unique` — global today.

Both stay global in Phase 2.33. See
`SAAS_PHASE2_EMPLOYEES_UNIQUENESS_REVIEW.md` for the Phase 3
migration plan.

## 6. Permissions / agency visibility

External-tenant actors (`isExternalActor`) see only employees
explicitly granted via `EmployeeAgencyAccess.canView=true`. Phase 2.33
keeps this exactly. The pilot tenant predicate is **additive** —
`where: { tenantId: <active>, AND: { id: { in: grantedIds } } }`.

## 7. Global scans (no tenant predicate by design)

- `Employee.email` duplicate check inside `create` — global by design
  (matches `Applicant.email`). Tag `phase233-global`.
- `generateEmployeeNumber` raw SQL — sequence over the unique global
  column. Tag `phase233-global`.
- `StageTemplate.findMany({ isActive: true })` inside `create` —
  global catalog (Phase 2.26). Tag `phase233-global`.

## 8. Current cross-tenant risk (pre-2.33)

- `findAll` returns the union across tenants for any non-external
  actor. **HIGH** — every system admin / Tempworks staff request
  sees both tenants today.
- `findOne` resolves any tenant's employee id without restriction.
  **HIGH** — same vector.
- `getDocuments`, `getCompliance`, etc. inherit the gap because
  they call the un-narrowed `findOne` first.

Phase 2.33 closes all of these in pilot mode.

## 9. Scope summary

**Included (read-only):** `findAll`, `findOne`, `listAgencyAccess`,
`getFinancialProfile`, `getDocuments`, `getWorkflow`, `getCompliance`,
`getCertifications`, `getTraining`, `getPerformance`, `exportExcel`.

**Excluded (mutation / lifecycle / payroll / storage / sequence):**
`create`, `update`, `remove`, `updateStatus`, `uploadPhoto`,
`grantAgencyAccess`, `updateAgencyAccess`, `revokeAgencyAccess`,
`generateEmployeeNumber` (raw SQL identifier helper).

## 10. Notes for the next phase

- Mutation pilot needs a parent gate helper (`findEmployeeOrFail`
  pattern, mirror of applicants `findApplicantOrFail`).
- `uploadPhoto` mirrors applicants Phase 2.31 storage-guard.
- Agency-access write paths need their own audit because
  `EmployeeAgencyAccess` has no `tenantId` column today —
  Phase 2.34 will decide whether to add the column or keep relying
  on the gated parent.
