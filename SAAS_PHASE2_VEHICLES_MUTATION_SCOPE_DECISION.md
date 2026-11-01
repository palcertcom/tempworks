# Phase 2.24 — Vehicles Mutation Scope Decision

> Per-method classification for the Phase 2.24 mutation pilot.

---

## Classification

| Method | Class | Reason |
|--------|-------|--------|
| `createVehicle` | **INCLUDED_NOW** | Spread `scope.tenantData()` into create data. |
| `updateVehicle` | **INCLUDED_WITH_GUARD** | `findVehicleOrFail` pre-check is tenant-scoped (Phase 2.23). |
| `deleteVehicle` | **INCLUDED_WITH_GUARD** | Same gate. |
| `assignDriver` | **INCLUDED_WITH_GUARD + employee tenant probe** | Parent vehicle pre-check + cheap `Employee.findFirst({ id, ...t })` to block cross-tenant `dto.employeeId`. |
| `unassignDriver` | **INCLUDED_WITH_GUARD** | Add explicit `findVehicleOrFail` first, then by-id `findFirst` + `update` on legacyPrisma. |
| `createMaintenanceRecord` | **INCLUDED_NOW** | Parent vehicle pre-check + spread `scope.tenantData()` on the new record. Spare parts are nested children — gated by parent. Mileage side-effect on `vehicle.update` is by-id (parent already gated). |
| `updateMaintenanceRecord` | **INCLUDED_NOW** | NEW pre-check via `this.prisma.maintenanceRecord.findFirst({ id, ...t })` to close a real cross-tenant mutation gap. By-id update + sparePart deleteMany stay legacy with `phase224-pilot-scope-precheck`. |
| `deleteMaintenanceRecord` | **INCLUDED_NOW** | Same NEW pre-check pattern. |
| `addDocument` / `updateDocument` / `deleteDocument` | **DEFERRED_STORAGE_RISK** | Storage upload precedes DB; needs Phase 2.25 storage-guard. |
| `addMaintenanceAttachment` / `deleteMaintenanceAttachment` | **DEFERRED_HIGH_RISK** | Stubs today; activate when attachments migration ships. |
| `createMaintenanceType` / `updateMaintenanceType` / `deleteMaintenanceType` | **LEGACY_ONLY** | Global catalog (Phase 3 product). |
| `createWorkshop` / `updateWorkshop` / `deleteWorkshop` | **LEGACY_ONLY** | Global catalog. |
| `auditLog.create` | n/a | Vehicles module does not emit audit logs. |

## Rationale — INCLUDED_NOW (`createVehicle`, `createMaintenanceRecord`, `updateMaintenanceRecord`, `deleteMaintenanceRecord`)

`createVehicle` and `createMaintenanceRecord` need `scope.tenantData()` spread so the denormed `tenantId` column is set on insert. Same shape as finance 2.17 / documents 2.21.

`updateMaintenanceRecord` and `deleteMaintenanceRecord` close a real bug: their existing `findUnique({ where: { id } })` pre-check is by id alone. In pilot mode, a tenant-A caller passing a tenant-B maintenance record id mutates the foreign row. Phase 2.24 switches the pre-check to `this.prisma.maintenanceRecord.findFirst({ where: { id, ...t } })` so cross-tenant ids raise `NotFoundException` BEFORE any subsequent write.

## Rationale — INCLUDED_WITH_GUARD (`updateVehicle`, `deleteVehicle`, `unassignDriver`)

These already call `findVehicleOrFail` (or for `unassignDriver`, will after this phase). The by-id mutation never reaches a foreign tenant's row in pilot mode. Re-tag the by-id mutation site as `phase224-pilot-scope-precheck`.

## Rationale — INCLUDED_WITH_GUARD + employee probe (`assignDriver`)

Parent vehicle gate is in place. The `dto.employeeId` could in principle belong to another tenant — `Employee.tenantId` exists from Phase 2.3 so the probe is cheap:

```ts
await this.findVehicleOrFail(vehicleId);
const t = this.scope().tenantWhere();
const emp = await this.prisma.employee.findFirst({ where: { id: dto.employeeId, ...t }, select: { id: true } });
if (!emp) throw new NotFoundException('Employee not found');
```

In legacy mode the employee lookup matches by id alone (same as today's behaviour where the employee is not validated at all — but no worse). In pilot mode, cross-tenant employees raise 404.

## Rationale — DEFERRED_STORAGE_RISK (`addDocument` etc.)

The vehicle-document upload path mirrors documents 2.20: storage upload BEFORE DB insert. Phase 2.24 strictly excludes storage paths per the brief; Phase 2.25+ will land the storage guard.

## Rationale — DEFERRED_HIGH_RISK (`addMaintenanceAttachment` etc.)

Stubs that throw `BadRequestException`. Nothing to narrow.

## Rationale — LEGACY_ONLY (catalog mutations)

`MaintenanceType` and `Workshop` have no `tenantId` column. Per-tenant catalog is a Phase 3 product question.

## Out-of-scope safeguards

- No `registrationNumber` uniqueness change. Today globally `@unique`. See `SAAS_PHASE2_VEHICLES_REGISTRATION_NUMBER_SAFETY.md`.
- No new feature flag.
- No schema change.
- No storage architecture change.
- No catalog tenancy.
- No driver-employee FK schema change.
