# Phase 2.23 — Vehicles Scope Split

> What ships in Phase 2.23 vs. what waits for Phase 2.24+.

---

## 1. Scope summary

| Area | Phase | This PR? |
|------|------|----------|
| Read-path tenant scoping (`listVehicles`, `getVehicle`, `findVehicleOrFail`, `listMaintenanceRecords`, `getMaintenanceRecord`, `getDashboardStats`, `exportVehicles`, `fetchMaintenanceForExport`, `getDriverHistory`) | **2.23** | **YES** |
| Catalog reads (`MaintenanceType`, `Workshop`) | 2.23 | yes — annotated `phase223-global` |
| Vehicle create/update/delete | 2.24+ | NO |
| Driver assignment mutations | 2.24+ | NO |
| Vehicle document upload/download | 2.25+ | NO |
| Maintenance record mutations | 2.24+ | NO |
| Maintenance attachment storage | 2.25+ | NO |
| Catalog mutations (workshop / maintenance-type CRUD) | 2.24+ (or Phase 3 per-tenant) | NO |
| `vehicle.update` side effect on mileage from maintenance | 2.24+ | NO |

## 2. Phase 2.23 — Read path refactor (THIS PR)

What lands:

- `VehiclesService` constructor injects `PilotPrismaAccessor`.
- `private get prisma()` returns `pilot.client()`.
- `private scope()` returns `getPilotScope(this.pilot, 'vehicles')`.
- Read sites spread `scope.tenantWhere()` into the `where` clause.
- `getVehicle` and `findVehicleOrFail` already use `findFirst`; just add the tenant predicate.
- `getMaintenanceRecord` migrates `findUnique` → `findFirst` to admit the tenant predicate.
- `getDriverHistory` filters by `vehicleId` only — safe because the parent `Vehicle` is loaded and tenant-checked.
- All mutation / catalog-write / storage sites routed through `this.legacyPrisma` with `phase223-excluded-mutation` / `phase223-excluded-storage` annotations.

What does NOT land:

- No mutation behaviour change.
- No new feature flag.
- No schema change (Phase 2.3 denorm already in place).
- No catalog tenancy.

## 2.1 Phase 2.24 update — mutation pilot shipped

Phase 2.24 narrowed the mutation surface. See
`SAAS_PHASE2_VEHICLES_MUTATION_AUDIT.md`,
`SAAS_PHASE2_VEHICLES_MUTATION_SCOPE_DECISION.md`, and
`SAAS_PHASE2_VEHICLES_REGISTRATION_NUMBER_SAFETY.md`.

- `createVehicle` + `createMaintenanceRecord`: spread
  `scope.tenantData()` into create data. Tag
  `phase224-pilot-scope`.
- `updateVehicle` / `deleteVehicle` / `assignDriver` (with
  cross-tenant employee probe) / `unassignDriver`: rely on the
  Phase 2.23 tenant-scoped `findVehicleOrFail` pre-check.
- `updateMaintenanceRecord` / `deleteMaintenanceRecord`: NEW
  tenant-scoped pre-check (`this.prisma.maintenanceRecord.findFirst({ id, ...t })`)
  closes a real cross-tenant mutation gap.
- `registrationNumber` remains globally `@unique` — Phase 3
  schema change required for per-tenant uniqueness.
- Storage paths (`addDocument`, `addMaintenanceAttachment`)
  still `phase223-excluded-storage` (Phase 2.25+).
- Catalog mutations (`MaintenanceType`, `Workshop`) still
  `phase223-excluded-mutation` (Phase 3 product question).

## 2.2 Phase 2.25 update — storage pilot shipped

Phase 2.25 closes the vehicles module pilot. See
`SAAS_PHASE2_VEHICLES_STORAGE_AUDIT.md` and
`SAAS_PHASE2_VEHICLES_STORAGE_SIDE_EFFECT_REVIEW.md`.

- `addDocument`: parent vehicle gate already in place;
  `scope.tenantData()` spread on the new VehicleDocument.
  Tag `phase225-pilot-scope`.
- `updateDocument` / `deleteDocument`: NEW explicit
  `findVehicleOrFail` first. By-id mutation sites tagged
  `phase225-pilot-scope-precheck`. Closes a real cross-tenant
  mutation gap.
- `addMaintenanceAttachment` / `deleteMaintenanceAttachment`
  remain stubs — DEFERRED until the attachments migration ships.

Zero `phase223-excluded-storage` annotations remain on the
active vehicle-document paths.

## 3. Phase 3+ — Catalog tenancy / signed URL refactor (FUTURE)

The `findVehicleOrFail` pre-check is already tenant-scoped after Phase 2.23, so mutation paths inherit a safety gate via the existing pattern from finance 2.17 / documents 2.21:

- `updateVehicle`, `deleteVehicle`, `addDocument`, `updateDocument`, `deleteDocument`, `assignDriver`, `unassignDriver` all call `findVehicleOrFail` → cross-tenant ids raise 404 BEFORE the by-id mutation. Phase 2.24 will re-tag those by-id mutation sites as `phase224-pilot-scope-precheck`.
- `createVehicle` will need a `scope.tenantData()` spread + duplicate-registration validation must remain global (since `registrationNumber` is `@unique` worldwide today; per-tenant uniqueness is a Phase 3 schema change).
- `createMaintenanceRecord` will need entity validation + `tenantData()`.
- `addMaintenanceAttachment` (storage) — Phase 2.25.

## 4. Phase 2.25+ — Storage refactor (FUTURE)

- `addDocument` upload: same storage-guard pattern as documents Phase 2.21 (validate tenant ownership of the parent vehicle BEFORE storage upload).
- `addMaintenanceAttachment` upload: same.
- Bulk download / download endpoints: same as documents Phase 2.22 download-guard.

## 5. Catalog tenancy (FUTURE — Phase 3 product)

`Workshop` and `MaintenanceType` are global today. Per-tenant catalog overrides require:
- `tenantId String?` columns added to both models (NULL = global default).
- A resolver that prefers tenant-specific row over global.
- Migration tooling for tenant-specific defaults.

Out of scope. Phase 2.23 treats both as global.

## 6. Guard-rails enforced by this PR

- The isolation harness includes a source-level meta-assertion: every mutation method (`createVehicle`, `updateVehicle`, `deleteVehicle`, `assignDriver`, `unassignDriver`, `addDocument`, `updateDocument`, `deleteDocument`, `createMaintenanceRecord`, `updateMaintenanceRecord`, `deleteMaintenanceRecord`, catalog CRUD) sources `this.legacyPrisma`.
- Every `legacyPrisma.*` site in mutation paths carries the `phase223-excluded-mutation` / `phase223-excluded-storage` annotation.
- The fixture seeds two tenants × two vehicles each so the read paths can be exercised with cross-tenant collision shapes.

## 7. Operator checklist for Phase 2.24

- [ ] Read this scope-split document.
- [ ] Re-run `saas:phase2-vehicles-equivalence` and `saas:phase2-vehicles-isolation` against the same staging DB.
- [ ] Add a new harness `saas:phase2-vehicles-mutation-equivalence` that asserts cross-tenant `update`/`delete`/`assign` raise NotFoundException and that `create` persists `tenantId`.
- [ ] Update the `phase223-excluded-mutation` annotations to `phase224-pilot-scope` once the mutation paths engage the pilot.
