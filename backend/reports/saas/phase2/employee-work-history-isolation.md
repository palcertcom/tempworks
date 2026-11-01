# Phase 2.7 — Employee Work History Isolation

Generated: 2026-05-10T02:08:45.444Z
Environment: SAFE_CLONE (localhost + fixture pattern (db=saas_phase1_fixture))
Tenants: A=`11111111-1111-1111-1111-111111111111` B=`22222222-2222-2222-2222-222222222222`
Employees: A=`f2cae0af-4df6-46ea-8689-3c0576681de2` B=`2e00a128-26e3-4fb0-a25d-fd9c06c4d281`

- Cases passed: **8** / 8
- Cases failed: 0

| # | Case | Result | Detail |
|--:|------|:------:|--------|
| 1 | pilot ON, tenant A: list(empA) returns ONLY tenant A rows | PASS | ids=00000000-0000-0000-0000-0000000ea002,00000000-0000-0000-0000-0000000ea001 |
| 2 | pilot ON, tenant A: NULL-tenant legacy row not surfaced | PASS | legacy NULL-tenant row excluded |
| 3 | pilot ON, tenant A: list(empB) raises NotFoundException (cross-tenant employee id hidden) | PASS | NotFoundException raised |
| 4 | pilot ON, tenant A: create persists tenantId=A | PASS | tenantId=11111111-1111-1111-1111-111111111111 |
| 5 | pilot ON, tenant A: update on tenant B entry rejected, row unchanged | PASS | before=tenant B new contract after=tenant B new contract |
| 6 | pilot ON, tenant A: remove of tenant B entry rejected, deletedAt still NULL | PASS | deletedAt=null |
| 7 | concurrent ALS frames isolated (T_A sees only A, T_B sees only B) | PASS | seenA=00000000-0000-0000-0000-0000000ea002,00000000-0000-0000-0000-0000000ea001 seenB=00000000-0000-0000-0000-0000000eb002,00000000-0000-0000-0000-0000000eb001 |
| 8 | pilot OFF: legacy returns rows including NULL-tenant legacy row | PASS | ids=00000000-0000-0000-0000-0000000ea002,00000000-0000-0000-0000-0000000ea001,00000000-0000-0000-0000-0000000ea999 |