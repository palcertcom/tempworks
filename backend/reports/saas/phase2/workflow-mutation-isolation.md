# Phase 2.27 — Workflow Mutation Isolation

Generated: 2026-05-10T21:35:48.563Z
Environment: SAFE_CLONE (localhost + fixture pattern (db=saas_phase1_fixture))
Tenants: A=`11111111-1111-1111-1111-111111111111` B=`22222222-2222-2222-2222-222222222222`

- Cases passed: **11** / 11
- Cases failed: 0

| # | Case | Result | Detail |
|--:|------|:------:|--------|
| 1 | pilot ON, tenant A: updateEmployeeWorkflowStage(tenantB-employee) raises NotFoundException | PASS | NotFoundException |
| 2 | pilot ON, tenant A: setEmployeeCurrentStage(tenantB-employee) raises NotFoundException | PASS | NotFoundException |
| 3 | pilot ON, tenant A: createWorkPermit(tenantB-employee) raises 404; no row inserted | PASS | delta=0 |
| 4 | pilot ON, tenant A: updateWorkPermit(tenantB-id) rejected; permitType unchanged | PASS | before=WORK_VISA_B after=WORK_VISA_B |
| 5 | pilot ON, tenant A: createVisa({EMPLOYEE, tenantB}) raises 404 | PASS | NotFoundException |
| 6 | pilot ON, tenant A: updateVisa(tenantB-id) rejected; visaType unchanged | PASS | before=TOURIST after=TOURIST |
| 7 | pilot ON, tenant A: createWorkPermit succeeds; tenantId=A | PASS | tenantId=11111111-1111-1111-1111-111111111111 |
| 8 | pilot ON, tenant A: createVisa succeeds; tenantId=A | PASS | tenantId=11111111-1111-1111-1111-111111111111 |
| 9 | pilot ON, tenant A: getOverview after mutations still excludes B (sum IN_PROGRESS = 1) | PASS | aTotalInProgress=1 |
| 10 | pilot OFF: legacy update on tenant B permit still succeeds (gate disengages) | PASS | mutated |
| 11 | source: every Phase 2.27 mutation site has the right tag and parent gate | PASS | all patterns matched |