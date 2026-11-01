# Phase 2.24 — Vehicles Mutation Audit

> Every vehicles mutation method, mapped to Prisma writes, ownership
> path, side effects, and Phase 2.24 disposition.

---

## 1. Method-by-method inventory

### 1.1 `createVehicle(dto, userId)`

- Prisma: `legacyPrisma.vehicle.create`.
- Models: `Vehicle`.
- Action: CREATE.
- Tenant ownership: caller-supplied `dto.agencyId`. Today the new
  `Vehicle.tenantId` is left NULL.
- Required `tenantId`: write via `scope.tenantData()` in pilot mode.
- Cross-tenant risk: HIGH today. A tenant-A caller could create a
  vehicle visible only to A (because of tenantId denorm) but
  pointing at a tenant-B agency. Phase 2.24 binds tenantId to the
  ALS tenant, not to the dto agency — agency-tenant alignment is
  a Phase 3 product invariant.
- Side effects: none.
- `registrationNumber` is globally `@unique`. Two tenants cannot
  share the same plate today. **Phase 2.24 does NOT change this.**
- Phase 2.24: **INCLUDED_NOW** — spread `scope.tenantData()` into
  `data`.

### 1.2 `updateVehicle(id, dto, userId)`

- Prisma: `findVehicleOrFail(id)` (tenant-scoped Phase 2.23),
  `legacyPrisma.vehicle.update({ where: { id } })`.
- Tenant gate: `findVehicleOrFail` raises 404 in pilot mode for
  cross-tenant ids ⇒ by-id update never executes.
- Phase 2.24: **INCLUDED_WITH_GUARD**.

### 1.3 `deleteVehicle(id, userId)`

- Same shape: `findVehicleOrFail` gate → soft-delete `legacyPrisma.vehicle.update`.
- Phase 2.24: **INCLUDED_WITH_GUARD**.

### 1.4 `assignDriver(vehicleId, dto, userId)`

- Prisma: `findVehicleOrFail(vehicleId)`,
  `legacyPrisma.vehicleDriverAssignment.updateMany` (deactivate
  existing), `legacyPrisma.vehicleDriverAssignment.create`.
- Tenant gate: parent vehicle pre-check. The `updateMany` is
  scoped by `vehicleId` — same tenant-by-parent guarantee.
- Cross-tenant employee risk: `dto.employeeId` could in principle
  reference a tenant-B employee. `Employee.tenantId` exists from
  Phase 2.3, so we can validate it cheaply.
- Phase 2.24: **INCLUDED_WITH_GUARD** + add employee tenant
  pre-check (cheap `findFirst({ id, ...t })` via the pilot client).

### 1.5 `unassignDriver(vehicleId, assignmentId)`

- Prisma: `legacyPrisma.vehicleDriverAssignment.findFirst({ id, vehicleId, isActive: true })`,
  `legacyPrisma.vehicleDriverAssignment.update`.
- Tenant gate: `vehicleId` predicate ties the lookup to the same
  parent. Adding `findVehicleOrFail(vehicleId)` first makes the
  parent gate explicit (same as `assignDriver`).
- Phase 2.24: **INCLUDED_WITH_GUARD** + add explicit
  `findVehicleOrFail` first.

### 1.6 `addDocument` / `updateDocument` / `deleteDocument`

- Storage upload runs BEFORE DB on `addDocument`. Phase 2.21
  storage-guard pattern fits but is **out of Phase 2.24 scope per
  the strict rules**. Storage paths stay
  `phase223-excluded-storage` until Phase 2.25.

### 1.7 `createMaintenanceType` / `updateMaintenanceType` / `deleteMaintenanceType`

- Catalog mutations on `MaintenanceType` (no `tenantId` column).
- Phase 2.24: **LEGACY_ONLY** — global catalog (Phase 3 product
  question).

### 1.8 `createWorkshop` / `updateWorkshop` / `deleteWorkshop`

- Same shape — catalog mutations on `Workshop`.
- Phase 2.24: **LEGACY_ONLY**.

### 1.9 `createMaintenanceRecord(dto, userId)`

- Prisma: `findVehicleOrFail(dto.vehicleId)`,
  optional `legacyPrisma.vehicle.update` (mileage side-effect),
  `legacyPrisma.maintenanceRecord.create` (with optional spare
  parts via nested write),
  optional `legacyPrisma.maintenanceRecord.update` (recomputed
  partsCost).
- Tenant gate: parent vehicle pre-check.
- Required `tenantId`: write via `scope.tenantData()` so the
  denormed `MaintenanceRecord.tenantId` carries the active
  tenant.
- Cross-tenant via spare parts: child `MaintenanceRecordSparePart`
  rows have no `tenantId` and are nested-written under the parent
  record — same tenant-by-parent guarantee.
- Phase 2.24: **INCLUDED_NOW** — `tenantData()` spread on the
  parent create.

### 1.10 `updateMaintenanceRecord(id, dto, userId)`

- Prisma: `legacyPrisma.maintenanceRecord.findUnique({ id })`
  (NOT tenant-scoped today — gap),
  `legacyPrisma.maintenanceRecordSparePart.deleteMany`,
  optional `legacyPrisma.vehicle.update` (mileage),
  `legacyPrisma.maintenanceRecord.update`.
- Cross-tenant risk today: a tenant-A caller passing a tenant-B
  maintenance record id can mutate it (the `findUnique` is by id
  alone).
- Required fix: switch the pre-check to `this.prisma.maintenanceRecord.findFirst({ id, ...t })`
  so cross-tenant ids raise 404 BEFORE any subsequent write. The
  by-id update + sparePart deleteMany can stay on `legacyPrisma`
  with `phase224-pilot-scope-precheck` tags.
- Phase 2.24: **INCLUDED_NOW** — switch the pre-check + retag
  by-id mutation sites.

### 1.11 `deleteMaintenanceRecord(id, userId)`

- Same shape: `legacyPrisma.maintenanceRecord.findUnique({ id })`
  + `legacyPrisma.maintenanceRecord.update` soft-delete.
- Same gap. Same fix.
- Phase 2.24: **INCLUDED_NOW** — switch pre-check.

### 1.12 `addMaintenanceAttachment` / `deleteMaintenanceAttachment` / `getMaintenanceAttachments`

- Stubs today (`throw BadRequestException(...)`). No DB or
  storage calls.
- Phase 2.24: **LEGACY_ONLY** — nothing to refactor until the
  attachments migration ships.

## 2. Audit log

`vehicles.service.ts` does not emit audit-log writes today. No
`auditLog.create` calls in the module. Audit-log tenancy is a
cross-module phase that does not affect vehicles.

## 3. Notification side effects

None in the vehicles module. Maintenance/document expiry
notifications are computed by the notifications module via
cross-module queries; out of scope.

## 4. Storage side effects

- `addDocument` → `storage.uploadFile` (vehicle document upload).
  **DEFERRED_STORAGE_RISK** — Phase 2.25+ will add the
  documents-2.21-style storage guard.
- `addMaintenanceAttachment` → stub today.

## 5. Rollback risk summary

| Method | Rollback flag | Rollback action |
|--------|---------------|------------------|
| `createVehicle` | TENANT_PRISMA_PILOT_ENABLED=false | new rows stop carrying tenantId |
| `updateVehicle` / `deleteVehicle` | same | findVehicleOrFail pre-check disengages |
| `assignDriver` / `unassignDriver` | same | parent vehicle pre-check disengages; employee pre-check spreads `{}` |
| `createMaintenanceRecord` | same | new rows stop carrying tenantId |
| `updateMaintenanceRecord` / `deleteMaintenanceRecord` | same | tenant-scoped pre-check reduces to plain by-id lookup |

No DB state introduced. No migration. Pure configuration rollback.

## 6. Production safety

With production defaults (`TENANT_PRISMA_PILOT_ENABLED=false`):

- `tenantData()` spread returns `{}` ⇒ no `tenantId` column written.
- Pre-check `findFirst({ id, ...t })` reduces to legacy
  `findFirst({ id })` semantics.
- `registrationNumber` uniqueness unchanged.
- Audit log writes unchanged (none in vehicles).
- No notification fanout (none in vehicles).

Production behaviour byte-identical to pre-2.24.
