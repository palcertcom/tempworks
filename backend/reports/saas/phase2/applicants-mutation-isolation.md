# Phase 2.29 — Applicants Mutation Isolation

Generated: 2026-05-10T21:34:48.507Z
Environment: SAFE_CLONE (localhost + fixture pattern (db=saas_phase1_fixture))
Tenants: A=`11111111-1111-1111-1111-111111111111` B=`22222222-2222-2222-2222-222222222222`

- Cases passed: **11** / 11
- Cases failed: 0

| # | Case | Result | Detail |
|--:|------|:------:|--------|
| 1 | pilot ON, tenant A: update(tenantB-id) rejected; phone unchanged | PASS | before="+49B" after="+49B" |
| 2 | pilot ON, tenant A: updateStatus(tenantB-id) rejected; status unchanged | PASS | before=NEW after=NEW |
| 3 | pilot ON, tenant A: remove(tenantB-id) rejected; deletedAt unchanged | PASS | deletedAt=null |
| 4 | pilot ON, tenant A: setCurrentStage(tenantB-id) raises 404 | PASS | NotFoundException |
| 5 | pilot ON, tenant A: approveApplicant(tenantB-id) raises 404 | PASS | NotFoundException |
| 6 | pilot ON, tenant A: reassignAgency(tenantB-id) raises 404 (parent gate) | PASS | NotFoundException |
| 7 | pilot ON, tenant A: reassignAgency(tenantA-id, tenantB-agency) raises 404 (agency gate) | PASS | NotFoundException |
| 8 | pilot ON, tenant A: requestDelete(tenantB-id) raises 404 | PASS | NotFoundException |
| 9 | BULK FILTER: pilot ON, tenant A bulk(STATUS_CHANGE on [A,B]) → only A processed; B unchanged | PASS | processedCount=1 bIncluded=false bStatusBefore=NEW bStatusAfter=NEW |
| 10 | pilot OFF: legacy update on tenant B applicant still succeeds | PASS | mutated |
| 11 | source: every Phase 2.29 mutation pattern present | PASS | all patterns matched |