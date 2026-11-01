# Phase 2.25 — Vehicles Storage Isolation

Generated: 2026-05-10T09:03:37.037Z
Environment: SAFE_CLONE (localhost + fixture pattern (db=saas_phase1_fixture))
Tenants: A=`11111111-1111-1111-1111-111111111111` B=`22222222-2222-2222-2222-222222222222`

- Cases passed: **8** / 8
- Cases failed: 0

| # | Case | Result | Detail |
|--:|------|:------:|--------|
| 1 | STORAGE GUARD: cross-tenant addDocument raises NotFoundException; 0 uploads; 0 rows inserted | PASS | err=NotFoundException uploads=0 dbDelta=0 |
| 2 | pilot ON, tenant A: addDocument(tenantA-vehicle) succeeds; tenantId=A; 1 storage upload | PASS | tenantId=11111111-1111-1111-1111-111111111111 uploads=1 |
| 3 | pilot ON, tenant A: updateDocument(tenantB-vehicle, tenantB-doc) rejected; name unchanged | PASS | before="MOT cert B" after="MOT cert B" |
| 4 | pilot ON, tenant A: deleteDocument(tenantB-vehicle, tenantB-doc) rejected; deletedAt unchanged | PASS | deletedAt=null |
| 5 | pilot OFF: legacy update on tenant B doc still succeeds | PASS | mutated |
| 6 | concurrent ALS frames isolated: T_A doc gets tenantId=A; T_B trying to add to A vehicle is rejected | PASS | aTenant=11111111-1111-1111-1111-111111111111 bResult=NotFoundException |
| 7 | addMaintenanceAttachment (stub) still throws BadRequestException — DEFERRED until migration | PASS | err=BadRequestException |
| 8 | source: every Phase 2.25 storage site has the right tag and parent gate | PASS | all patterns matched |