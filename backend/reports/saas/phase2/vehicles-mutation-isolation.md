# Phase 2.24 — Vehicles Mutation Isolation

Generated: 2026-05-10T09:03:05.123Z
Environment: SAFE_CLONE (localhost + fixture pattern (db=saas_phase1_fixture))
Tenants: A=`11111111-1111-1111-1111-111111111111` B=`22222222-2222-2222-2222-222222222222`

- Cases passed: **14** / 14
- Cases failed: 0

| # | Case | Result | Detail |
|--:|------|:------:|--------|
| 1 | pilot ON, tenant A: createVehicle persists tenantId=A | PASS | tenantId=11111111-1111-1111-1111-111111111111 |
| 2 | pilot ON, tenant A: updateVehicle on tenant B rejected, make unchanged | PASS | before="Volvo" after="Volvo" |
| 3 | pilot ON, tenant A: deleteVehicle on tenant B rejected, deletedAt unchanged | PASS | deletedAt=null |
| 4 | pilot ON, tenant A: assignDriver(tenantB-vehicle) raises NotFoundException | PASS | NotFoundException |
| 5 | pilot ON, tenant A: assignDriver(tenantA-vehicle, tenantB-employee) raises NotFoundException | PASS | NotFoundException |
| 6 | pilot ON, tenant A: unassignDriver(tenantB-vehicle) raises NotFoundException | PASS | NotFoundException |
| 7 | pilot ON, tenant A: createMaintenanceRecord(tenantB-vehicle) raises NotFoundException; no row inserted | PASS | before=1 after=1 |
| 8 | pilot ON, tenant A: createMaintenanceRecord(tenantA-vehicle) succeeds, tenantId=A | PASS | tenantId=11111111-1111-1111-1111-111111111111 |
| 9 | pilot ON, tenant A: updateMaintenanceRecord on tenant B rejected, notes unchanged | PASS | before="null" after="null" |
| 10 | pilot ON, tenant A: deleteMaintenanceRecord on tenant B rejected, deletedAt unchanged | PASS | deletedAt=null |
| 11 | pilot ON, tenant A: dashboard totalVehicles excludes tenant B after mutations | PASS | totalVehicles=3 (expected 3: 2 seeded + 1 iso-create) |
| 12 | pilot OFF: legacy update on tenant B vehicle still succeeds | PASS | mutated |
| 13 | reg-num uniqueness: pilot tenant A using tenant B plate raises P2002 (global @unique unchanged) | PASS | P2002 / Unique constraint |
| 14 | source: every Phase 2.24 mutation site carries the right tag and shape | PASS | all patterns matched |