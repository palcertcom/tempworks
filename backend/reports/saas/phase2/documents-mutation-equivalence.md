# Phase 2.21 — Documents Mutation Equivalence

Generated: 2026-05-10T07:21:34.889Z
Environment: SAFE_CLONE (localhost + fixture pattern (db=saas_phase1_fixture))
Tenant A: `11111111-1111-1111-1111-111111111111`

- Cases passed: **10** / 10
- Cases failed: 0

| # | Case | Result | Detail |
|--:|------|:------:|--------|
| 1 | create response shape preserved (id + docId string) | PASS | legacy.shape=true pilot.shape=true |
| 2 | create legacy: tenantId is NULL | PASS | legacy.tenantId=null |
| 3 | create pilot: tenantId is set to active tenant | PASS | pilot.tenantId=11111111-1111-1111-1111-111111111111 tenantA=11111111-1111-1111-1111-111111111111 |
| 4 | create: storage.uploadFile invoked once per create in both modes | PASS | legacy.uploads=1 pilot.uploads=1 |
| 5 | update both modes mutate the notes | PASS | legacy="desc-legacy-updated" pilot="desc-pilot-updated" |
| 6 | validation error: NotFoundException for unknown documentTypeId in both modes | PASS | legacy=NotFoundException pilot=NotFoundException |
| 7 | audit log: one UPLOAD row written per create in both modes | PASS | legacy=1 pilot=1 |
| 8 | pilot remove: deletedAt is set on the row | PASS | deletedAt=set |
| 9 | pilot renew: creates new row with renewedFromId AND tenantId=A | PASS | renewedFromId=86d61a32-9c23-4908-91f0-725a0df114ec tenantId=11111111-1111-1111-1111-111111111111 |
| 10 | pilot read-after-write: findOne returns tenant A seed doc | PASS | id=00000000-0000-0000-0000-0000000dc001 |