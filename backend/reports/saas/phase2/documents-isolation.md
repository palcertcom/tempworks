# Phase 2.20 — Documents Isolation

Generated: 2026-05-10T07:21:19.178Z
Environment: SAFE_CLONE (localhost + fixture pattern (db=saas_phase1_fixture))
Tenants: A=`11111111-1111-1111-1111-111111111111` B=`22222222-2222-2222-2222-222222222222`

- Cases passed: **9** / 9
- Cases failed: 0

| # | Case | Result | Detail |
|--:|------|:------:|--------|
| 1 | pilot ON, tenant A: findAll returns ONLY tenant A documents | PASS | count=2 noB=true |
| 2 | pilot ON, tenant A: findOne(tenantB-id) raises NotFoundException | PASS | NotFoundException |
| 3 | pilot ON, tenant A: findByEntity on tenant B employee returns 0 documents | PASS | total=0 |
| 4 | pilot ON, tenant A: getExpiringDocuments excludes tenant B documents | PASS | count=2 ids=00000000-0000-0000-0000-0000000dc002,00000000-0000-0000-0000-0000000dc001… |
| 5 | pilot ON, tenant A: readDocumentBytes(tenantB-id) raises NotFoundException (no storage fetch) | PASS | err=NotFoundException msg=Document 00000000-0000-0000-0000-0000000dc101 not found |
| 6 | pilot ON: checkDocTypePermission (global catalog) returns boolean | PASS | value=true |
| 7 | concurrent ALS frames isolated (T_A no B-rows; T_B no A-rows) | PASS | aCount=2 bCount=2 aNoB=true bNoA=true |
| 8 | pilot OFF: legacy reads include both tenant A and tenant B documents | PASS | count=7 hasA=true hasB=true |
| 9 | source: every mutation/download method routes through legacyPrisma | PASS | all guard annotations present |