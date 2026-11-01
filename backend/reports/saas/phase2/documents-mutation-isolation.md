# Phase 2.21 — Documents Mutation Isolation

Generated: 2026-05-10T21:35:19.304Z
Environment: SAFE_CLONE (localhost + fixture pattern (db=saas_phase1_fixture))
Tenants: A=`11111111-1111-1111-1111-111111111111` B=`22222222-2222-2222-2222-222222222222`

- Cases passed: **9** / 9
- Cases failed: 0

| # | Case | Result | Detail |
|--:|------|:------:|--------|
| 1 | STORAGE GUARD: cross-tenant create raises NotFoundException; 0 uploads; 0 rows inserted | PASS | err=NotFoundException uploads=0 dbDelta=0 |
| 2 | pilot ON, tenant A: same-tenant create succeeds, tenantId=A, 1 storage upload | PASS | tenantId=11111111-1111-1111-1111-111111111111 uploads=1 |
| 3 | pilot ON, tenant A: update on tenant B doc rejected, notes unchanged | PASS | before="null" after="null" |
| 4 | pilot ON, tenant A: verify on tenant B doc rejected, status unchanged | PASS | before=VERIFIED after=VERIFIED |
| 5 | pilot ON, tenant A: renew on tenant B doc rejected, 0 storage uploads | PASS | leaked=false uploadDelta=0 |
| 6 | pilot ON, tenant A: remove on tenant B doc rejected, deletedAt unchanged | PASS | deletedAt=null |
| 7 | pilot ON, tenant A: getExpiringDocuments after mutation excludes tenant B | PASS | count=2 |
| 8 | pilot OFF: legacy update on tenant B doc still succeeds (gate disengages) | PASS | mutated as expected |
| 9 | source: every Phase 2.21 mutation site carries the right tag and shape | PASS | all patterns matched |