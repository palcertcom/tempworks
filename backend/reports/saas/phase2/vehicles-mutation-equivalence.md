# Phase 2.24 — Vehicles Mutation Equivalence

Generated: 2026-05-10T09:02:49.138Z
Environment: SAFE_CLONE (localhost + fixture pattern (db=saas_phase1_fixture))
Tenant A: `11111111-1111-1111-1111-111111111111`

- Cases passed: **12** / 12
- Cases failed: 0

| # | Case | Result | Detail |
|--:|------|:------:|--------|
| 1 | createVehicle response shape preserved (id present) | PASS | legacy.id=946e9692-8e5f-43ff-af2d-25b98213a609 pilot.id=c037d67f-a337-48b2-8c60-ab352977eb4b |
| 2 | createVehicle legacy: tenantId is NULL | PASS | legacy.tenantId=null |
| 3 | createVehicle pilot: tenantId is set to active tenant | PASS | pilot.tenantId=11111111-1111-1111-1111-111111111111 tenantA=11111111-1111-1111-1111-111111111111 |
| 4 | updateVehicle (legacy) mutates make | PASS | make=LegacyUpdated |
| 5 | updateVehicle (pilot) mutates make | PASS | make=PilotUpdated |
| 6 | createMaintenanceRecord legacy: tenantId is NULL | PASS | legacy.tenantId=null |
| 7 | createMaintenanceRecord pilot: tenantId is set to active tenant | PASS | pilot.tenantId=11111111-1111-1111-1111-111111111111 |
| 8 | updateMaintenanceRecord (legacy) mutates notes | PASS | notes=legacy-notes |
| 9 | updateMaintenanceRecord (pilot) mutates notes | PASS | notes=pilot-notes |
| 10 | pilot deleteVehicle: deletedAt is set | PASS | deletedAt=set |
| 11 | pilot deleteMaintenanceRecord: deletedAt is set | PASS | deletedAt=set |
| 12 | validation: NotFoundException for missing maintenance record id in both modes | PASS | legacy=NotFoundException pilot=NotFoundException |