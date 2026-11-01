# Phase 2.9 — Job Ads Isolation

Generated: 2026-05-10T02:09:43.691Z
Environment: SAFE_CLONE (localhost + fixture pattern (db=saas_phase1_fixture))
Tenants: A=`11111111-1111-1111-1111-111111111111` B=`22222222-2222-2222-2222-222222222222`

- Cases passed: **9** / 9
- Cases failed: 0

| # | Case | Result | Detail |
|--:|------|:------:|--------|
| 1 | pilot ON, tenant A: findAll returns ONLY tenant A rows | PASS | ids=00000000-0000-0000-0000-0000000a0001,00000000-0000-0000-0000-0000000a0003 |
| 2 | pilot ON, tenant A: findOne(tenantB-id) raises NotFoundException | PASS | NotFoundException |
| 3 | pilot ON, tenant A: update on tenant B ad rejected, title unchanged | PASS | before=Engineer (Globex) after=Engineer (Globex) |
| 4 | pilot ON, tenant A: remove of tenant B ad rejected, deletedAt still NULL | PASS | deletedAt=null |
| 5 | pilot ON, tenant A: create persists tenantId=A | PASS | tenantId=11111111-1111-1111-1111-111111111111 |
| 6 | same-slug request in two tenants: service auto-suffixes; both inserts succeed (legacy unique honoured) | PASS | aSlug=iso-collision-cgch bSlug=iso-collision-cgch-1 |
| 7 | public listing (no ALS tenant): includes ads from all tenants (preserves public URLs) | PASS | total=7 hasA=true hasB=true |
| 8 | concurrent ALS frames isolated (T_A no B-rows; T_B no A-rows) | PASS | seenA=2 ids; seenB=2 ids; aNoB=true bNoA=true |
| 9 | pilot OFF: legacy reads include tenant B + NULL-tenant legacy row | PASS | ids=8 includesB=true includesNull=true |