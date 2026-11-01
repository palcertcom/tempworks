# Phase 2.25 — Vehicles Storage Equivalence

Generated: 2026-05-10T09:03:21.047Z
Environment: SAFE_CLONE (localhost + fixture pattern (db=saas_phase1_fixture))
Tenant A: `11111111-1111-1111-1111-111111111111`

- Cases passed: **10** / 10
- Cases failed: 0

| # | Case | Result | Detail |
|--:|------|:------:|--------|
| 1 | addDocument shape preserved (id present) | PASS | legacy=true pilot=true |
| 2 | addDocument legacy: tenantId is NULL | PASS | legacy.tenantId=null |
| 3 | addDocument pilot: tenantId is set to active tenant | PASS | pilot.tenantId=11111111-1111-1111-1111-111111111111 |
| 4 | addDocument: 1 storage upload in both modes (with file) | PASS | legacy=1 pilot=1 |
| 5 | addDocument: 0 storage uploads when no file is supplied | PASS | uploads=0 |
| 6 | updateDocument (legacy) mutates name | PASS | name=legacy-renamed |
| 7 | updateDocument (pilot) mutates name | PASS | name=pilot-renamed |
| 8 | pilot deleteDocument: deletedAt is set | PASS | deletedAt=set |
| 9 | validation: NotFoundException for missing docId in both modes | PASS | legacy=NotFoundException pilot=NotFoundException |
| 10 | metadata read-after-write: getVehicle includes the legacy doc just created (tenant A scope) | PASS | docs=3 |