# Phase 2.28 — Applicants Isolation

Generated: 2026-05-10T12:20:59.233Z
Environment: SAFE_CLONE (localhost + fixture pattern (db=saas_phase1_fixture))
Tenants: A=`11111111-1111-1111-1111-111111111111` B=`22222222-2222-2222-2222-222222222222`

- Cases passed: **10** / 10
- Cases failed: 0

| # | Case | Result | Detail |
|--:|------|:------:|--------|
| 1 | pilot ON, tenant A: findAll returns ONLY tenant A applicants | PASS | count=2 noB=true |
| 2 | pilot ON, tenant A: findOne(tenantB-id) raises NotFoundException | PASS | NotFoundException |
| 3 | pilot ON, tenant A: agencyId=tenantB filter returns 0 | PASS | total=0 |
| 4 | pilot ON, tenant A: search "B-" does not leak tenant B applicants | PASS | count=0 noB=true |
| 5 | pilot ON, tenant A: getFinancialProfile(tenantB-applicant) raises 404 (parent gate) | PASS | NotFoundException |
| 6 | pilot ON, tenant A: getAgencyHistory(tenantB-applicant) raises 404 (parent gate) | PASS | NotFoundException |
| 7 | pilot ON, tenant A: getDeleteRequests excludes tenant B (relation filter) | PASS | total=0 |
| 8 | concurrent ALS frames isolated (T_A no B-rows; T_B no A-rows) | PASS | aCount=2 bCount=2 |
| 9 | pilot OFF: legacy findAll includes tenants A AND B | PASS | count=4 |
| 10 | source: every Phase 2.28 mutation uses legacyPrisma; reads use tenantWhere/findFirst | PASS | all patterns matched |