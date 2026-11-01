# Phase 2.8 — Compliance Isolation

Generated: 2026-05-10T21:33:20.151Z
Environment: SAFE_CLONE (localhost + fixture pattern (db=saas_phase1_fixture))
Tenants: A=`11111111-1111-1111-1111-111111111111` B=`22222222-2222-2222-2222-222222222222`

- Cases passed: **7** / 7
- Cases failed: 0

| # | Case | Result | Detail |
|--:|------|:------:|--------|
| 1 | pilot ON, tenant A: getAlerts returns ONLY tenant A rows | PASS | ids=00000000-0000-0000-0000-00000000c001,00000000-0000-0000-0000-00000000c002,00000000-0000-0000-0000-00000000c003 |
| 2 | pilot ON, tenant A: getDashboard.summary.totalAlerts excludes other tenants | PASS | totalAlerts=3 (expected 3) |
| 3 | pilot ON, tenant A: dashboard recentAlerts contain no tenant B ids | PASS | recentIds=00000000-0000-0000-0000-00000000c001,00000000-0000-0000-0000-00000000c002 |
| 4 | pilot ON, tenant A: updateAlert on tenant B row rejected, row unchanged | PASS | before=OPEN after=OPEN |
| 5 | concurrent ALS frames isolated (T_A no B-rows; T_B no A-rows) | PASS | seenA=3 ids; seenB=3 ids; bNoA=true |
| 6 | pilot OFF: legacy reads include tenant B + NULL-tenant legacy row | PASS | total=7 includesB=true includesNull=true |
| 7 | allow-list: TENANT_PRISMA_PILOT_MODULES=nothing ⇒ legacy union (compliance opt-out) | PASS | total=7 includesB=true |