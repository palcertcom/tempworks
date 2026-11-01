# Phase 2.26 — Workflow Isolation

Generated: 2026-05-10T10:27:20.101Z
Environment: SAFE_CLONE (localhost + fixture pattern (db=saas_phase1_fixture))
Tenants: A=`11111111-1111-1111-1111-111111111111` B=`22222222-2222-2222-2222-222222222222`

- Cases passed: **11** / 11
- Cases failed: 0

| # | Case | Result | Detail |
|--:|------|:------:|--------|
| 1 | getStages: BOTH tenants see the same global catalog (StageTemplate is global) | PASS | aCount=3 bCount=3 |
| 2 | getOverview tenant A: stage 1 inProgress count = 1 (excludes B) | PASS | inProgress=1 |
| 3 | getOverview tenant B: stage 1 inProgress count = 1 (excludes A) | PASS | inProgress=1 |
| 4 | getAnalytics tenant A: totalEmployees = 1 (excludes B) | PASS | totalEmployees=1 |
| 5 | pilot ON, tenant A: getTimeline(tenantB-employee-id) raises NotFoundException | PASS | NotFoundException |
| 6 | pilot ON, tenant A: getStageDetails employees exclude tenant B | PASS | count=1 hasB=false |
| 7 | pilot ON, tenant A: findWorkPermits returns ONLY tenant A | PASS | count=1 ids=00000000-0000-0000-0000-0000000wp001 |
| 8 | pilot ON, tenant A: findVisas returns ONLY tenant A | PASS | count=1 ids=00000000-0000-0000-0000-0000000vs001 |
| 9 | concurrent ALS frames isolated (each sees their own totalEmployees=1) | PASS | aTotal=1 bTotal=1 |
| 10 | pilot OFF: legacy aggregates include both tenants (totalEmployees=2, workPermits=2) | PASS | totalEmployees=2 workPermits=2 |
| 11 | source: every Phase 2.26 mutation uses legacyPrisma; reads use relation filter / tenantWhere | PASS | all patterns matched |