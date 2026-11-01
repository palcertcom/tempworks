# Phase 2.23 — Vehicles Equivalence

Generated: 2026-05-10T11:43:47.529Z
Environment: SAFE_CLONE (localhost + fixture pattern (db=saas_phase1_fixture))
Tenant A: `11111111-1111-1111-1111-111111111111`

- Cases passed: **11** / 11
- Cases failed: 0

| # | Case | Result | Detail |
|--:|------|:------:|--------|
| 1 | legacy: pilot OFF reports pilotActive=false | PASS | TENANT_PRISMA_PILOT_ENABLED=false |
| 2 | pilot: pilot ON + vehicles allow-list ⇒ pilotActive=true | PASS | pilot ON, env=SAFE_CLONE |
| 3 | listVehicles: pilot total <= legacy total (tenant filter applies) | PASS | legacy=4 pilot=2 |
| 4 | getVehicle: legacy + pilot resolve the tenant A vehicle id | PASS | legacy=00000000-0000-0000-0000-0000000vh001 pilot=00000000-0000-0000-0000-0000000vh001 |
| 5 | getMaintenanceRecord: legacy + pilot resolve the tenant A record id | PASS | legacy=00000000-0000-0000-0000-0000000mr001 pilot=00000000-0000-0000-0000-0000000mr001 |
| 6 | error path: NotFoundException for missing vehicle id in both modes | PASS | legacy=NotFoundException pilot=NotFoundException |
| 7 | listMaintenanceRecords: pilot total <= legacy total | PASS | legacy=2 pilot=1 |
| 8 | getDashboardStats.totalVehicles: pilot <= legacy | PASS | legacy=4 pilot=2 |
| 9 | listMaintenanceTypes: global catalog identical in both modes | PASS | legacy=1 pilot=1 |
| 10 | listWorkshops: global catalog identical in both modes | PASS | legacy=0 pilot=0 |
| 11 | response shape preserved | PASS | legacy=true pilot=true |