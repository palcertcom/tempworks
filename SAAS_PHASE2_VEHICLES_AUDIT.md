# Phase 2.23 — Vehicles Module Audit

> Inventory of every Prisma touchpoint in `src/vehicles` plus the
> read/write split that drives the Phase 2.23 reads-first pilot.

---

## 1. Module surface

| File | Role | Lines |
|------|------|------:|
| `src/vehicles/vehicles.service.ts` | business logic, every Prisma site | 1022 |
| `src/vehicles/vehicles.controller.ts` | HTTP surface (no DB) | 354 |
| `src/vehicles/vehicles.module.ts` | Nest module wiring | 11 |

Total Prisma sites: **51**.

## 2. Models touched

| Model | Has `tenantId`? | Notes |
|-------|:---:|-------|
| `Vehicle` | ✓ | Phase 2.3 denorm; primary entity. |
| `VehicleDocument` | ✓ | Phase 2.3 denorm. |
| `MaintenanceRecord` | ✓ | Phase 2.3 denorm. |
| `MaintenanceRecordSparePart` | – | child of MaintenanceRecord (gated by parent). |
| `VehicleDriverAssignment` | – | child of Vehicle (gated by parent vehicle's tenant). |
| `Workshop` | – | tenant-less catalog. |
| `MaintenanceType` | – | tenant-less catalog. |

## 3. Read paths — INCLUDED in Phase 2.23

| # | Method | Operation | Tenant filter |
|--:|--------|-----------|---------------|
| 1 | `listVehicles`            | `vehicle.findMany`         | `where.tenantId` |
| 2 | `listVehicles`            | `vehicle.count`            | same |
| 3 | `getVehicle`              | `vehicle.findFirst` (id)   | id + tenantId |
| 4 | `findVehicleOrFail`       | `vehicle.findFirst` (id)   | id + tenantId (private helper used by mutations; safe to narrow) |
| 5 | `getDriverHistory`        | `vehicleDriverAssignment.findMany` | scoped via parent vehicle (filter by `vehicleId` only; pre-check ensures tenant) |
| 6 | `listMaintenanceRecords`  | `maintenanceRecord.findMany` | `where.tenantId` |
| 7 | `listMaintenanceRecords`  | `maintenanceRecord.count`  | same |
| 8 | `getMaintenanceRecord`    | `maintenanceRecord.findUnique`→`findFirst` | id + tenantId |
| 9 | `getDashboardStats`       | 4 × `vehicle.count` + `maintenanceRecord.count` + `vehicleDocument.count` + `vehicle.groupBy` | each with `tenantId` filter |
| 10 | `exportVehicles`         | `vehicle.findMany`         | `where.tenantId` |
| 11 | `fetchMaintenanceForExport` | `maintenanceRecord.findMany` | `where.tenantId` |

`getDriverHistory` returns rows from `VehicleDriverAssignment` which has no `tenantId` column. The parent `vehicle.findFirst` pre-check (Phase 2.20-style) makes it safe.

## 4. Catalog/global reads — `phase223-global`

| # | Method | Operation |
|--:|--------|-----------|
| 12 | `listMaintenanceTypes` | `maintenanceType.findMany` |
| 13 | `getMaintenanceType` lookups | `maintenanceType.findUnique` (×2) |
| 14 | `listWorkshops` | `workshop.findMany` |
| 15 | `getWorkshop`   | `workshop.findUnique` |

`Workshop` and `MaintenanceType` have no `tenantId` column today. Treat as global. Per-tenant catalog is a Phase 3 product question.

## 5. Write/mutation paths — EXCLUDED from Phase 2.23

| # | Method | Reason |
|--:|--------|--------|
| 16 | `createVehicle` | upload-shaped flow; Phase 2.24+. |
| 17 | `updateVehicle` | Phase 2.24+ via findOne pre-check pattern. |
| 18 | `deleteVehicle` | soft delete. |
| 19 | `assignDriver` | mutates assignment. |
| 20 | `unassignDriver` | same. |
| 21 | `addDocument` / `updateDocument` / `deleteDocument` | vehicle document upload/download. |
| 22 | `createMaintenanceType` / `updateMaintenanceType` / `deleteMaintenanceType` | catalog mutations. |
| 23 | `createWorkshop` / `updateWorkshop` / `deleteWorkshop` | catalog mutations. |
| 24 | `createMaintenanceRecord` / `updateMaintenanceRecord` / `deleteMaintenanceRecord` | maintenance mutations + `vehicle.update` side effect (mileage). |
| 25 | `addMaintenanceAttachment` / `deleteMaintenanceAttachment` / `getMaintenanceAttachments` | storage-side; Phase 2.25+. |
| 26 | `exportMaintenanceRecordsExcel` / `exportMaintenanceRecordsPdf` | export builders use the read path; gain tenant safety automatically once `fetchMaintenanceForExport` is narrowed. |

## 6. Storage / file-system side effects — EXCLUDED

- `addDocument` / `updateDocument` / `deleteDocument` → `storage.uploadFile` / `storage.deleteFileByUrlOrKey`
- `addMaintenanceAttachment` → `storage.uploadFile`
- Phase 2.25+ will mirror the documents Phase 2.21 storage-guard pattern.

## 7. Notification side effects — none in vehicles module

`vehicles.service.ts` does not invoke `notifications.notifyXxx` directly. Maintenance/document expiry alerts are computed by the notifications module itself via cross-module queries; out of scope here.

## 8. Tenant ownership path

`Vehicle.tenantId`, `VehicleDocument.tenantId`, `MaintenanceRecord.tenantId` denormed in Phase 2.3 with `@@index([tenantId])`. The pilot reads filter by it when active and ignore it when inactive — preserving legacy behaviour.

## 9. Risks / out-of-scope concerns

- `VehicleDriverAssignment` has NO `tenantId` column. Phase 2.23 keeps reads gated by the parent `Vehicle.findFirst` pre-check (safe). A future schema phase could denorm `tenantId` onto assignments if cross-tenant assignment lookups are ever needed.
- Workshops + MaintenanceTypes are global catalog. Per-tenant catalog overrides are a Phase 3 product question.
- `getDashboardStats` issues 7 parallel counts/groups; all narrowed in pilot mode. Production (flag off) sees identical legacy aggregates.
- `findVehicleOrFail` is a private helper used by every mutation method. Narrowing it in pilot mode means cross-tenant ids raise `NotFoundException` even on legacy mutation paths — matching the documents Phase 2.21 "INCLUDED_WITH_GUARD via pre-check" pattern. The mutation Prisma calls themselves stay on `legacyPrisma`.

## 10. Scope summary

| Class | Methods |
|-------|---------|
| **INCLUDED — pilot scope** | `listVehicles`, `getVehicle`, `findVehicleOrFail`, `getDriverHistory` (parent-gated), `listMaintenanceRecords`, `getMaintenanceRecord`, `getDashboardStats`, `exportVehicles`, `fetchMaintenanceForExport` |
| **GLOBAL/CATALOG** | `listMaintenanceTypes`, `getMaintenanceType` lookups, `listWorkshops`, `getWorkshop` |
| **EXCLUDED — Phase 2.24+ writes** | every `createX` / `updateX` / `deleteX` for vehicle / driver-assignment / vehicle-document / maintenance-record / maintenance-type / workshop |
| **EXCLUDED — Phase 2.25+ storage** | every storage upload/download path (`addDocument`, `addMaintenanceAttachment`) |
