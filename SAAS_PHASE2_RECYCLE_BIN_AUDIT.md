# Phase 2.11 — Recycle Bin Module Audit

> Even the trash room needs tenant locks before the castle opens.
> Pre-refactor audit of `src/recycle-bin`. Fifth tenant-scoped pilot.

---

## 1. Files in module

| File | Lines | Role |
|------|------|------|
| `recycle-bin.module.ts` | 16 | Nest module |
| `recycle-bin.controller.ts` | 108 | HTTP routes (list, counts, related, restore, hard-delete, cleanup) |
| `recycle-bin.service.ts` | 1282 | reads + filters + entity mapping |
| `restore.service.ts` | 409 | restore handlers per entity type |
| `hard-delete.service.ts` | 390 | permanent-delete handlers per entity type |
| `database-cleanup.service.ts` | 259 | System Admin "wipe everything" platform op |
| `dto/*.ts` | (small) | input shapes |

Total: ~2464 lines across 4 services.

## 2. Services / controllers

- `RecycleBinService` — list / counts / related / preview-hard-delete.
- `RestoreService` — per-entity-type restore branches (16 types).
- `HardDeleteService` — per-entity-type hard-delete branches (16 types).
- `DatabaseCleanupService` — System Admin global wipe; out of scope.
- `RecycleBinController` — JWT + role-gated routes (System Admin /
  HR Manager / Compliance Officer for reads/restore; System Admin only
  for hard-delete + database cleanup).

## 3. Prisma call sites (pre-refactor)

| Service | Sites |
|---|---:|
| `recycle-bin.service.ts` | 107 |
| `restore.service.ts` | 45 |
| `hard-delete.service.ts` | 37 |
| `database-cleanup.service.ts` | 52 |
| **Total** | **241** |

After Phase 2.11 every site is annotated with one of three tags:

- `phase211-pilot-scope` — tenant-scoped entities (where the call now
  spreads `tenantWhereFor(entityType)`).
- `phase211-global` — global / catalog entities (USER, ROLE,
  DOCUMENT_TYPE, MAINTENANCE_TYPE, WORKSHOP, REPORT) which keep their
  pre-pilot semantics.
- `phase211-excluded-platform` — `DatabaseCleanupService` operations,
  intentionally cross-tenant (System Admin only).

## 4. Models touched

16 entity types listed in `ENTITY_POLICIES`:

```
APPLICANT, EMPLOYEE, USER, AGENCY,
DOCUMENT, DOCUMENT_TYPE, JOB_AD, FINANCIAL_RECORD,
ROLE, NOTIFICATION, REPORT,
VEHICLE, VEHICLE_DOCUMENT, MAINTENANCE_RECORD, MAINTENANCE_TYPE, WORKSHOP
```

Plus side-effect models touched during restore/hard-delete:
`FinancialRecordAttachment`, `Visa`, `WorkPermit`,
`ComplianceAlert`, `ApplicantFinancialProfile`, `ApplicantAgencyHistory`,
`AuditLog`, `RolePermission`.

## 5. Soft-delete assumptions

- Every restorable entity has a nullable `deletedAt` column.
- Restore = `update({ where: { id }, data: { deletedAt: null, deletedBy: null, deletionReason: null } })`.
- Listing = `findMany({ where: { deletedAt: { not: null } } })`.

## 6. Restore assumptions

- Restore operates by `id` only. The pre-refactor service makes no
  ownership check beyond the role guard.
- `restoreWithRelated` cascades to documents / financial records /
  maintenance records that have their own `deletedAt` and were
  soft-deleted alongside the parent.
- Email/slug/name uniqueness conflicts are checked before restore;
  they raise `ConflictException`.

## 7. Ownership path per entity

| Entity | Ownership in production | Tenant filter applied? |
|---|---|---|
| APPLICANT | `tenantId` (Phase 1) | YES |
| EMPLOYEE | `tenantId` (Phase 1) | YES |
| AGENCY | `tenantId` (Phase 1) | YES |
| DOCUMENT | `tenantId` (Phase 2.3 denorm) | YES |
| FINANCIAL_RECORD | `tenantId` (Phase 2.3) | YES |
| JOB_AD | `tenantId` (Phase 2.9) | YES |
| NOTIFICATION | `tenantId` (Phase 2.3) | YES |
| VEHICLE | `tenantId` (Phase 2.3) | YES |
| VEHICLE_DOCUMENT | `tenantId` (Phase 2.3) | YES |
| MAINTENANCE_RECORD | `tenantId` (Phase 2.3) | YES |
| USER | global (no `tenantId`) | NO |
| ROLE | global (no `tenantId`) | NO |
| DOCUMENT_TYPE | global catalog | NO |
| MAINTENANCE_TYPE | global catalog | NO |
| WORKSHOP | shared service-provider | NO |
| REPORT | no `tenantId` column | NO |

## 8. Use of `tenantId`

- Pre-refactor: never consulted by recycle-bin code paths.
- Post-refactor: spread into every read/count/restore/hard-delete
  pre-check for tenant-scoped entities, via `tenantWhereFor()`.

## 9. Cross-entity behavior

- `getRelatedDeletedData(APPLICANT|EMPLOYEE)` reads `Document` and
  `FinancialRecord` rows — both tenant-filtered in pilot mode.
- `getRelatedDeletedData(VEHICLE)` reads `VehicleDocument` and
  `MaintenanceRecord` — both tenant-filtered.
- `getRelatedDeletedData(FINANCIAL_RECORD)` reads
  `FinancialRecordAttachment` — global because the parent FR is
  already tenant-checked.

## 10. Current risks (pre-refactor)

- **Cross-tenant restore:** any caller with the role guard could
  restore a record from another tenant by guessing its id. Pilot
  closes via `assertTenantOwnership`.
- **Cross-tenant hard-delete:** same risk; pilot closes the same way.
- **Cross-tenant counts on dashboards:** `getEntityCounts` returns
  totals across tenants. Pilot scopes them per tenant.
- **`getRelatedDeletedData`** could surface another tenant's
  documents/financials when called by id from a foreign tenant. Pilot
  scopes the inner queries.

## 11. What can be safely scoped in this phase

- All read paths (`findAll`, `getEntityCounts`, `findByEntityType`,
  `getRelatedDeletedData`, `previewHardDelete`).
- Restore and hard-delete entry-point pre-checks for the 10
  tenant-scoped entities.

## 12. What must remain legacy/global

- `DatabaseCleanupService`: System Admin platform operation that
  intentionally wipes business data across tenants. Annotated
  `phase211-excluded-platform`. A future Phase 3 may add per-tenant
  reset endpoints; not today.
- 6 global / catalog entities (USER, ROLE, DOCUMENT_TYPE,
  MAINTENANCE_TYPE, WORKSHOP, REPORT). Their counts/lists/restores
  stay unfiltered — this is the deliberate semantics for shared
  reference data and platform-admin tables.
