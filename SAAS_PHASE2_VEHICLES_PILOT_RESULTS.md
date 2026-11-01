# Phase 2.23 — Vehicles Pilot Results

> Reads-first vehicles pilot results.
> Companion to `SAAS_PHASE2_VEHICLES_AUDIT.md` and
> `SAAS_PHASE2_VEHICLES_SCOPE_SPLIT.md`.

---

## 1. What changed

| Surface | Change |
|---------|--------|
| `src/vehicles/vehicles.service.ts` | constructor injects `PilotPrismaAccessor`; legacy `prisma` renamed `legacyPrisma`; pilot-aware `prisma` getter + `scope()` helper |
| 24 read sites | spread `scope.tenantWhere()` into where clauses; annotated `phase223-pilot-scope` |
| 7 catalog sites | annotated `phase223-global` (MaintenanceType, Workshop) |
| 22 mutation sites | rerouted to `legacyPrisma`; annotated `phase223-excluded-mutation` |
| 5 storage/document sites | rerouted to `legacyPrisma`; annotated `phase223-excluded-storage` |
| `src/vehicles/vehicles.module.ts` | adds `FeatureFlagsModule`, `TenantPrismaService`, `PilotPrismaAccessor` |
| `scripts/scan-annotations.ts` | 4 new tags scoped to `src/vehicles/` |
| `scripts/saas/phase2/__fixture__/phase223-vehicles-seed.sql` | 4 vehicles (2 per tenant) + 2 maintenance records + 2 vehicle documents + 1 maintenance type catalog row |
| `scripts/saas/phase2/vehicles-equivalence.ts` | new equivalence harness (11 cases) |
| `scripts/saas/phase2/vehicles-isolation.ts` | new isolation harness (10 cases incl. source-level meta-assertion) |
| `package.json` | new scripts `saas:phase2-vehicles-equivalence` / `…-isolation` |

## 2. What did not change

- No production behaviour change while flags are off.
- No mutation/assignment/maintenance/storage narrowing (deferred to Phase 2.24+).
- No vehicle numbering / plate uniqueness change (`registrationNumber` remains globally `@unique`; per-tenant uniqueness is a Phase 3 schema change).
- No catalog (`MaintenanceType`, `Workshop`) tenancy.
- No new feature flag.

## 3. Pattern reusability

Documents and vehicles share the same shape:

| Pattern | Documents 2.20 | Vehicles 2.23 |
|---------|:---:|:---:|
| Constructor injects `PilotPrismaAccessor` | ✓ | ✓ |
| `private get prisma()` returns `pilot.client()` | ✓ | ✓ |
| `private scope()` returns `getPilotScope(this.pilot, '<module>')` | ✓ | ✓ |
| Read sites spread `scope.tenantWhere()` | ✓ | ✓ |
| Mutation sites tagged `*-excluded-mutation` | ✓ | ✓ |
| Catalog sites tagged `*-global` | ✓ | ✓ |
| Storage sites tagged `*-excluded-storage` | – | ✓ |
| `findUnique` → `findFirst` for tenant predicate composition | ✓ (findOne, readDocumentBytes) | ✓ (getMaintenanceRecord) |
| Source-level meta-assertion in isolation harness | ✓ | ✓ |
| Private pre-check helper used by mutations | ✓ (findOne) | ✓ (findVehicleOrFail) |

The pattern landed without surprises. The vehicles module added one new wrinkle — the `findVehicleOrFail` private helper used by every mutation method — which lets the future Phase 2.24 mutation pilot adopt the "INCLUDED_WITH_GUARD via tenant-scoped pre-check" pattern from finance 2.17 / documents 2.21 without further service-side changes.

## 4. Equivalence harness — 11/11 PASS

`saas:phase2-vehicles-equivalence` covers:

1. legacy: pilot OFF reports `pilotActive=false`
2. pilot: pilot ON + vehicles allow-list ⇒ `pilotActive=true`
3. `listVehicles`: pilot total <= legacy total
4. `getVehicle`: legacy + pilot resolve same id
5. `getMaintenanceRecord`: legacy + pilot resolve same id
6. error path: NotFoundException for missing vehicle id
7. `listMaintenanceRecords`: pilot total <= legacy total
8. `getDashboardStats.totalVehicles`: pilot <= legacy
9. `listMaintenanceTypes` global catalog identical
10. `listWorkshops` global catalog identical
11. response shape preserved

## 5. Isolation harness — 10/10 PASS

`saas:phase2-vehicles-isolation` covers:

1. pilot ON, tenant A: `listVehicles` returns ONLY A vehicles
2. pilot ON, tenant A: `getVehicle(tenantB-id)` raises `NotFoundException`
3. pilot ON, tenant A: `listMaintenanceRecords` excludes tenant B
4. pilot ON, tenant A: `getMaintenanceRecord(tenantB-id)` raises `NotFoundException`
5. pilot ON, tenant A: **`getDriverHistory(tenantB-vehicle-id)` raises `NotFoundException` (parent vehicle pre-check is tenant-scoped)**
6. pilot ON, tenant A: dashboard `totalVehicles` excludes tenant B
7. pilot ON, tenant A: `exportVehicles({mixed-tenant ids})` returns a Buffer (filter applies; B silently dropped)
8. concurrent ALS frames isolated
9. pilot OFF: legacy returns the union
10. **source-level meta-assertion**: every mutation/storage method (`createVehicle`, `updateVehicle`, `deleteVehicle`, `assignDriver`, `unassignDriver`, `addDocument`, `createMaintenanceRecord`, `updateMaintenanceRecord`) sources `legacyPrisma`; `findVehicleOrFail` is tenant-scoped via `this.prisma` + `...t`

## 6. Lessons learned

- **Private mutation pre-check (`findVehicleOrFail`) is the single most valuable narrowing.** It turns every mutation method that uses it into an INCLUDED_WITH_GUARD candidate for Phase 2.24 without further service-side rework — the by-id mutation just needs an annotation.
- **`registrationNumber` is globally unique today.** Phase 2.24 mutation pilot must NOT change this; per-tenant uniqueness needs a schema change with explicit migration. For now, two tenants cannot share a registration number — this is a real product constraint.
- **`VehicleDriverAssignment` has no `tenantId` column.** The parent vehicle gate is sufficient for `getDriverHistory`. A future schema phase could denorm `tenantId` onto assignments if cross-tenant assignment lookups are ever needed.
- **`Workshop` and `MaintenanceType` are global catalogs today.** Per-tenant overrides are a Phase 3 product question.
- **`exportVehicles` and `fetchMaintenanceForExport` already shared the read path.** Narrowing the underlying `findMany` automatically narrows the export. No separate export pilot needed.
- **Dashboard stats with parallel counts compose cleanly.** Each of the 7 parallel counts/groups gets a single `...t` spread; same shape as the documents `findAll` + count pattern.

## 7. Read/write split warning

The reads-first split deliberately leaves these mutation paths unchanged:

- `createVehicle` / `updateVehicle` / `deleteVehicle`
- `assignDriver` / `unassignDriver`
- `addDocument` / `updateDocument` / `deleteDocument`
- `createMaintenanceRecord` / `updateMaintenanceRecord` / `deleteMaintenanceRecord`
- `createMaintenanceType` / `updateMaintenanceType` / `deleteMaintenanceType`
- `createWorkshop` / `updateWorkshop` / `deleteWorkshop`
- `addMaintenanceAttachment` / storage paths

Phase 2.24 will land the reads-then-writes pattern from finance 2.17 / documents 2.21 once the operator confirms the pilot is stable on staging.

## 8. Assignment / maintenance / storage warnings

- **Assignment mutation** (`assignDriver`, `unassignDriver`) writes to `VehicleDriverAssignment` which has no `tenantId` column. Phase 2.24 narrowing should rely on the parent `findVehicleOrFail` gate and tag by-id mutation sites as `phase224-pilot-scope-precheck`.
- **Maintenance mutation** (`createMaintenanceRecord` etc.) needs `scope.tenantData()` spread on insert and tenant pre-check on the `vehicleId`. The `vehicle.update` mileage side-effect must run inside the same tenant gate.
- **Storage paths** (`addDocument`, `addMaintenanceAttachment`) need the documents-2.21-style storage guard: validate parent vehicle owns the active tenant BEFORE `storage.uploadFile`. No change to storage architecture, no signed URLs.

## 9. Rollback runbook

```sh
# To halt the vehicles pilot:
export TENANT_PRISMA_PILOT_MODULES=  # remove 'vehicles'

# To halt the framework entirely:
export TENANT_PRISMA_PILOT_ENABLED=false
```

No DB state introduced; rollback is configuration only.

## 10. Real-DB execution evidence

Same SAFE_CLONE used by Phase 2.16-2.22. Total cumulative harness cases:

| Module | Phases | Harness cases |
|---|---|---:|
| Finance | 2.16/2.17/2.17.1/2.18/2.19 | 41 |
| Documents | 2.20/2.21/2.22 | 52 |
| Vehicles | 2.23 | 21 |

**Total: 114/114 cases PASS** on real Postgres 16.

## 10.1 Phase 2.24 — Mutation pilot delta

Phase 2.24 extended the vehicles pilot to selected mutation
paths. New annotations:

- `createVehicle`: spreads `scope.tenantData()` into create
  data. Tag `phase224-pilot-scope`.
- `updateVehicle` / `deleteVehicle`: rely on the Phase 2.23
  tenant-scoped `findVehicleOrFail` pre-check. By-id mutation
  retagged `phase224-pilot-scope-precheck`.
- `assignDriver`: parent vehicle pre-check + NEW cross-tenant
  employee probe via `this.prisma.employee.findFirst({ id, ...t })`.
  Both the deactivate-existing `updateMany` and the new
  assignment `create` retagged `phase224-pilot-scope-precheck`.
- `unassignDriver`: NEW explicit `findVehicleOrFail` first;
  existing assignment lookup + update retagged
  `phase224-pilot-scope-precheck`.
- `createMaintenanceRecord`: parent vehicle gate + spreads
  `scope.tenantData()` on the new record. Tag
  `phase224-pilot-scope`. Spare parts are nested children
  (tenant-by-parent). Mileage `vehicle.update` side-effect
  retagged `phase224-pilot-scope-precheck`.
- `updateMaintenanceRecord` / `deleteMaintenanceRecord`: NEW
  pre-check via `this.prisma.maintenanceRecord.findFirst({ id, ...t })`
  to close a real cross-tenant mutation gap (the prior
  `findUnique` was by id alone). By-id update / soft-delete
  retagged `phase224-pilot-scope-precheck`.

`addDocument` / `updateDocument` / `deleteDocument` remain
`phase223-excluded-storage` (Phase 2.25+ storage guard).
Catalog mutations (`MaintenanceType`, `Workshop`) remain
`phase223-excluded-mutation` (Phase 3 product question).

Real bug closed:

- `updateMaintenanceRecord` and `deleteMaintenanceRecord` were
  doing a by-id `findUnique` pre-check. In pilot mode, a
  tenant-A caller passing a tenant-B record id could mutate
  the foreign row. The Phase 2.24 pre-check switch closes this.

`registrationNumber` uniqueness unchanged. Today globally
`@unique`. Tenant A using tenant B's plate raises `P2002`. See
`SAAS_PHASE2_VEHICLES_REGISTRATION_NUMBER_SAFETY.md` for the
Phase 3 transition plan.

New harnesses (real-DB SAFE_CLONE):
- `vehicles-mutation-equivalence` (12 cases): create shape,
  tenantId NULL/set, update mutation parity, maintenance
  create tenantId, maintenance update parity, soft-delete
  vehicle + maintenance, validation parity.
- `vehicles-mutation-isolation` (14 cases): pilot create
  persists tenantId=A; cross-tenant `update`/`delete`/`assign`/
  `unassign`/maintenance `create`/`update`/`delete` all
  rejected with target unchanged; cross-tenant employee probe
  blocks `assignDriver`; dashboard counts excluding tenant B
  after mutations; legacy mode still mutates without gate;
  registration-number P2002 collision; source-level
  meta-assertion of all phase224 patterns.

Real-DB results: **47/47 vehicles harness cases PASS** across
all 4 harnesses (11 + 10 + 12 + 14). Combined cumulative:
**finance 41 + documents 52 + vehicles 47 = 140/140** on real
Postgres 16.

The vehicles module pilot is now complete (reads + writes).
Storage paths (`addDocument`, `addMaintenanceAttachment`)
remain deferred to Phase 2.25.

## 10.2 Phase 2.25 — Storage pilot delta

Phase 2.25 closes the last vehicles-module deferred path: vehicle
document upload/update/delete.

- `addDocument`: parent `findVehicleOrFail` gate already in place
  (Phase 2.23) raises 404 BEFORE `storage.uploadFile` for
  cross-tenant `vehicleId`. Phase 2.25 adds `scope.tenantData()`
  spread on the new `VehicleDocument` row. Tag
  `phase225-pilot-scope`.
- `updateDocument` / `deleteDocument`: NEW explicit
  `findVehicleOrFail(vehicleId)` first. Pre-2.25 the lookup was
  by `{ id, vehicleId }` alone — both predicates could be foreign
  in pilot mode, allowing cross-tenant mutation. The new gate
  raises 404 before any DB write. By-id mutation sites tagged
  `phase225-pilot-scope-precheck`.
- `addMaintenanceAttachment` / `deleteMaintenanceAttachment`
  remain stubs that throw `BadRequestException` — DEFERRED
  until the attachments migration ships.

Real bugs closed:

- `updateDocument` and `deleteDocument` allowed cross-tenant
  mutation in pilot mode. The new `findVehicleOrFail` gate
  closes both gaps.

New harnesses (real-DB SAFE_CLONE):
- `vehicles-storage-equivalence` (10 cases): addDocument shape,
  tenantId NULL/set, upload count, no-file path, update mutation,
  soft-delete, validation parity, read-after-write.
- `vehicles-storage-isolation` (8 cases): STORAGE GUARD blocks
  cross-tenant addDocument with 0 uploads + 0 rows; same-tenant
  succeeds with 1 upload + tenantId=A; cross-tenant
  update/deleteDocument rejected; legacy mode unchanged;
  concurrent ALS frames isolated; addMaintenanceAttachment stub
  still throws (DEFERRED documented); source-level
  meta-assertion.

Real-DB results: **65/65 vehicles harness cases PASS** across
all 6 harnesses (11 + 10 + 12 + 14 + 10 + 8). Combined cumulative:
finance 41 + documents 52 + vehicles 65 = **158/158** on real
Postgres 16.

The vehicles module pilot is now complete (reads + writes +
storage). Zero `phase223-excluded-storage` annotations remain
on the active document paths.

## 11. Next recommended module

The pattern is now proven on three production-grade modules end-to-end (finance, documents) and one module reads-first (vehicles). Natural follow-ups:

1. **Phase 2.24 — Vehicles mutation pilot** (recommended — finish what we started, mirroring finance/documents precedent of completing one module before starting another).
2. `workflow` (35 Prisma sites; system-template + clone is the hard part; reads-first should land first).
3. `applicants` (large lifecycle module touching many existing modules).
4. Cross-module **audit-log tenancy** phase (would let every existing pilot retire its `*-audit-log` tag).

## 12. Blockers before vehicle write-path refactor

- `registrationNumber` is globally `@unique`. Phase 2.24 mutation pilot must NOT introduce per-tenant uniqueness without a schema change + migration. Document this in the Phase 2.24 audit.
- `VehicleDriverAssignment` has no `tenantId` column today. Mutation pilot can rely on parent gate; a follow-up schema phase could add the column for direct queries.
- `MaintenanceType` and `Workshop` mutations remain catalog mutations. Per-tenant catalog is a Phase 3 product question; keep them on `legacyPrisma` for now.
- Storage paths (`addDocument`, `addMaintenanceAttachment`) need their own Phase 2.25-style storage-guard pilot.
