# Phase 2.11 — Recycle Bin Isolation

Generated: 2026-05-10T02:10:43.808Z
Environment: SAFE_CLONE (localhost + fixture pattern (db=saas_phase1_fixture))
Tenants: A=`11111111-1111-1111-1111-111111111111` B=`22222222-2222-2222-2222-222222222222`

- Cases passed: **7** / 7
- Cases failed: 0

| # | Case | Result | Detail |
|--:|------|:------:|--------|
| 1 | pilot ON tenant A: getEntityCounts.JOB_AD < combined-tenant total | PASS | tenantA.JOB_AD=1; tenantB.JOB_AD=1 |
| 2 | pilot ON tenant A: findAll(JOB_AD) excludes tenant B id | PASS | ids=00000000-0000-0000-0000-0000000a0001 |
| 3 | pilot ON tenant A: RestoreService.restore(JOB_AD, tenantB-id) rejected; deletedAt unchanged | PASS | leaked=false after.deletedAt=Sun May 10 2026 02:10:43 GMT+0000 (Coordinated Universal Time) |
| 4 | pilot ON tenant A: HardDeleteService.execute(JOB_AD, tenantB-id) rejected; row preserved | PASS | leaked=false stillExists=true |
| 5 | global entity counts (USER/ROLE/DOCUMENT_TYPE/MAINTENANCE_TYPE/WORKSHOP/REPORT) equal | PASS | equal=true; pilot.USER=1 legacy.USER=1 |
| 6 | concurrent ALS frames isolated (T_A no B-rows; T_B no A-rows) | PASS | seenA=1; seenB=1; aNoB=true bNoA=true |
| 7 | pilot OFF: legacy includes BOTH tenants soft-deleted job-ads | PASS | ids=00000000-0000-0000-0000-0000000a0001,00000000-0000-0000-0000-0000000a0002 |