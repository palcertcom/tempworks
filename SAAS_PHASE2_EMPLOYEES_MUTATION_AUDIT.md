# Phase 2.34 — Employees Mutation / Storage / Agency-Access Audit

> Per-call audit of every employee write site after Phase 2.33
> reads-first refactor.

---

## 1. Per-method audit

### 1.1 `create(dto, actorId?)` — `employees.service.ts:239`

| Aspect | State |
|---|---|
| Prisma calls | `legacyPrisma.employee.findFirst({ email })` (duplicate-check), `legacyPrisma.stageTemplate.findMany`, `legacyPrisma.$queryRaw` (employee-number sequence), `legacyPrisma.employee.create({ data, employeeStages })` |
| Storage calls | none |
| Tenant ownership | `Employee.tenantId` exists; not yet written by this method |
| Required guard | Spread `scope.tenantData()` on the `Employee.create` `data` (mirror applicants 2.29) |
| Side effects | nested `employeeStages.create` (no tenantId column on EmployeeStage) |
| Rollback risk | NONE — additive `tenantId` write; legacy mode skips |
| Decision | **INCLUDED_NOW** as `phase234-pilot-scope` |

### 1.2 `update(id, dto, actorId?, actor?)` — L293

| Aspect | State |
|---|---|
| Prisma calls | `findOne(id, actor, {require:'edit'})` (already tenant-scoped from Phase 2.33), `legacyPrisma.employee.update({ where: { id } })` |
| Storage calls | none |
| Required guard | `findOne` already gates by tenant in pilot mode. The `legacyPrisma.update` then runs by-id over the gated row. |
| Side effects | none |
| Rollback risk | NONE |
| Decision | **INCLUDED_WITH_GUARD** — retag from `phase233-excluded-mutation` to `phase234-pilot-scope-precheck` |

### 1.3 `remove(id, actorId?, actor?)` — L348

| Aspect | State |
|---|---|
| Prisma calls | `findOne(id, actor, {require:'edit'})`, `legacyPrisma.employee.update({ data: { deletedAt } })` |
| Storage calls | none |
| Required guard | parent-gated by `findOne` (tenant-scoped) |
| Side effects | soft delete only |
| Rollback risk | NONE |
| Decision | **INCLUDED_WITH_GUARD** as `phase234-pilot-scope-precheck` |

### 1.4 `updateStatus(id, status, actorId?, actor?)` — L354

| Aspect | State |
|---|---|
| Prisma calls | `findOne(id, actor, {require:'edit'})`, `legacyPrisma.employee.update({ data: { status } })` |
| Required guard | parent-gated by `findOne` |
| Decision | **INCLUDED_WITH_GUARD** as `phase234-pilot-scope-precheck` |

### 1.5 `uploadPhoto(id, file)` — L306

| Aspect | State |
|---|---|
| Prisma calls | `legacyPrisma.employee.findUnique({ where: { id } })` (ungated!), `legacyPrisma.employee.update` |
| Storage calls | `storage.uploadFile(file.buffer, …)` runs **BEFORE** any tenant gate |
| Required guard | Replace the `findUnique` with `findFirst({ id, deletedAt: null, ...scope.tenantWhere() })` BEFORE `storage.uploadFile`, mirror of applicants Phase 2.31 |
| Side effects | optional orphan cleanup via `deleteFileByUrlOrKey` (preserved) |
| Rollback risk | NONE — legacy mode collapses to today's `findFirst({ id, deletedAt: null })` |
| Decision | **INCLUDED_WITH_STORAGE_GUARD** as `phase234-storage-guard` |

### 1.6 `grantAgencyAccess(employeeId, agencyId, dto, actorId)` — L171

| Aspect | State |
|---|---|
| Prisma calls | `legacyPrisma.employee.findFirst({ id: employeeId, deletedAt: null })`, `legacyPrisma.agency.findFirst({ id: agencyId, deletedAt: null })`, then `legacyPrisma.employeeAgencyAccess.upsert / deleteMany` |
| Required guard | both lookups must be tenant-scoped in pilot mode (employee tenant gate + agency tenant gate). The upsert/delete runs by `(employeeId, agencyId)` after gates. |
| Side effects | toggling canView/canEdit; soft-delete-symmetric remove when both flags false |
| Decision | **INCLUDED_WITH_AGENCY_GATE** as `phase234-agency-gate` |

### 1.7 `updateAgencyAccess(employeeId, agencyId, dto, actorId)` — L200

| Aspect | State |
|---|---|
| Prisma calls | `legacyPrisma.employeeAgencyAccess.findUnique({ where: { employeeId_agencyId } })`, then update / delete |
| Required guard | parent gates (target employee + target agency tenants) before the lookup |
| Decision | **INCLUDED_WITH_AGENCY_GATE** |

### 1.8 `revokeAgencyAccess(employeeId, agencyId)` — L228

| Aspect | State |
|---|---|
| Prisma calls | `legacyPrisma.employeeAgencyAccess.delete({ where: { employeeId_agencyId } })` |
| Required guard | parent gates (target employee + target agency) before delete |
| Decision | **INCLUDED_WITH_AGENCY_GATE** |

### 1.9 `generateEmployeeNumber()` — L267

| Aspect | State |
|---|---|
| Prisma calls | `legacyPrisma.$queryRaw` (`MAX(SUBSTRING)` over global `employees`) |
| Required guard | none — this remains global, same shape as applicants A/C/E identifier sequence and `Employee.employeeNumber @unique` |
| Decision | **LEGACY_ONLY** — keep `phase233-global` |

### 1.10 Email duplicate-check (inside `create`)

`legacyPrisma.employee.findFirst({ email })` is global by design
(matches `Employee.email @unique`). **LEGACY_ONLY** — keep
`phase233-global`.

### 1.11 Audit-log writes

The employees service **does not emit audit rows** today on any
mutation path. Phase 2.34 does **not** start emitting them — consistent
with the applicants 2.31 deferral of the same. (Audit emission for
employees is a follow-up phase if/when the product asks for it.)

## 2. Models touched

| Model | Tenancy column | Notes |
|---|---|---|
| `Employee` | `tenantId String?` | Phase 2.34 writes it on `create` |
| `EmployeeStage` | none | Rides on `employeeId` (parent gated) |
| `EmployeeAgencyAccess` | none | Rides on parent `employeeId` + `agencyId` (both gated by Phase 2.34 in pilot mode) |
| `Agency` | `tenantId String?` | New target gate via `findAgencyOrFail` |
| `StageTemplate` | none | Global catalog, unchanged |

## 3. Tenant ownership path (post-2.34, pilot mode)

```
Active ALS tenantId
  → findEmployeeOrFail(id) → Employee row in active tenant (or 404)
  → findAgencyOrFail(id)   → Agency row in active tenant (or 404)
  → Employee.create        → row stamped with active tenantId
  → Employee.update        → only the gated row mutates
  → uploadPhoto            → storage.uploadFile runs only after gate succeeds
  → EmployeeAgencyAccess.upsert/update/delete
                           → composite key (employeeId, agencyId) where both
                             have been tenant-gated ⇒ tenant-safe
```

## 4. Production safety with flags OFF

`scope.active === false` ⇒ `tenantWhere()` returns `{}` ⇒ all new
predicates collapse to today's where-clauses. `scope.tenantData()`
returns `{}` ⇒ `Employee.create` writes no `tenantId`. `findUnique`
in `uploadPhoto` is replaced with `findFirst({ id, deletedAt: null })`
which is **byte-equivalent for the legitimate happy path** (the
applicant id resolves the same row), but the storage write now
happens only after a confirmed lookup. The legacy `findUnique` had
no `deletedAt` filter; in legacy mode the new `findFirst` with
`deletedAt: null` IS a stricter match — soft-deleted rows can no
longer have their photos overwritten. This is consistent with
`update` / `remove` / `updateStatus` which all already require
`deletedAt: null` via `findOne`. **Acceptable change.**

## 5. Rollback risk

All changes are gated by `scope.active`. Toggling
`TENANT_PRISMA_PILOT_ENABLED=false` (or removing `employees` from
`TENANT_PRISMA_PILOT_MODULES`) returns to byte-identical legacy
behaviour. No data, no schema migration. The single behaviour change
in legacy mode is `uploadPhoto` adding `deletedAt: null` (see §4) —
which mirrors every other write site in the service today.

## 6. Included vs. deferred summary

**Included (Phase 2.34):** `create`, `update`, `remove`,
`updateStatus`, `uploadPhoto`, `grantAgencyAccess`,
`updateAgencyAccess`, `revokeAgencyAccess`.

**Legacy-only (intentionally global):** `generateEmployeeNumber`,
email duplicate-check, `StageTemplate.findMany` (global catalog).

**Deferred:** `Employee.email` / `Employee.employeeNumber` per-tenant
uniqueness — Phase 3 product question with schema migration.
