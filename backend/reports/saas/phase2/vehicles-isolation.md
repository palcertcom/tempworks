# Phase 2.23 — Vehicles Isolation

Generated: 2026-05-10T21:35:34.331Z
Environment: SAFE_CLONE (localhost + fixture pattern (db=saas_phase1_fixture))
Tenants: A=`11111111-1111-1111-1111-111111111111` B=`22222222-2222-2222-2222-222222222222`

- Cases passed: **10** / 10
- Cases failed: 0

| # | Case | Result | Detail |
|--:|------|:------:|--------|
| 1 | pilot ON, tenant A: listVehicles returns ONLY tenant A vehicles | PASS | count=2 noB=true |
| 2 | pilot ON, tenant A: getVehicle(tenantB-id) raises NotFoundException | PASS | NotFoundException |
| 3 | pilot ON, tenant A: listMaintenanceRecords excludes tenant B | PASS | count=1 |
| 4 | pilot ON, tenant A: getMaintenanceRecord(tenantB-id) raises NotFoundException | PASS | NotFoundException |
| 5 | pilot ON, tenant A: getDriverHistory(tenantB-vehicle-id) raises NotFoundException (parent gate) | PASS | NotFoundException |
| 6 | pilot ON, tenant A: dashboard totalVehicles excludes tenant B | PASS | totalVehicles=2 |
| 7 | pilot ON, tenant A: exportVehicles({mixed-tenant ids}) returns a Buffer (filter applies; B silently dropped) | PASS | bufferLen=7025 |
| 8 | concurrent ALS frames isolated (T_A no B-rows; T_B no A-rows) | PASS | aCount=2 bCount=2 |
| 9 | pilot OFF: legacy listVehicles includes tenants A AND B | PASS | count=4 |
| 10 | source: every mutation/storage method routes through legacyPrisma; findVehicleOrFail is tenant-scoped | PASS | all patterns matched |