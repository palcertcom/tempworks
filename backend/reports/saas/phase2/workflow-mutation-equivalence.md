# Phase 2.27 — Workflow Mutation Equivalence

Generated: 2026-05-10T10:27:35.104Z
Environment: SAFE_CLONE (localhost + fixture pattern (db=saas_phase1_fixture))
Tenant A: `11111111-1111-1111-1111-111111111111`

- Cases passed: **11** / 11
- Cases failed: 0

| # | Case | Result | Detail |
|--:|------|:------:|--------|
| 1 | updateEmployeeWorkflowStage (legacy) mutates notes | PASS | notes=legacy-mozmpq55 |
| 2 | updateEmployeeWorkflowStage (pilot) mutates notes | PASS | notes=pilot-mozmpq55 |
| 3 | setEmployeeCurrentStage (pilot) upserts an IN_PROGRESS row | PASS | status=IN_PROGRESS stageId=00000000-0000-0000-0000-00000000st02 |
| 4 | createWorkPermit response shape preserved | PASS | legacy.id=08570818-0953-4f5d-800c-10af987bd5b0 pilot.id=4dec5873-2832-4d37-bd9c-f9d39f452e52 |
| 5 | createWorkPermit legacy: tenantId NULL | PASS | tenantId=null |
| 6 | createWorkPermit pilot: tenantId=A | PASS | tenantId=11111111-1111-1111-1111-111111111111 |
| 7 | updateWorkPermit (pilot) mutates permitType | PASS | permitType=UPDATED-mozmpq55 |
| 8 | createVisa shape preserved + tenantId NULL legacy / set pilot | PASS | legacy.tid=null pilot.tid=11111111-1111-1111-1111-111111111111 |
| 9 | updateVisa (pilot) mutates visaType | PASS | visaType=UPDATED-mozmpq55 |
| 10 | validation: NotFoundException for missing permit id in both modes | PASS | legacy=NotFoundException pilot=NotFoundException |
| 11 | pilot read-after-write: findWorkPermits sees the new pilot-created row | PASS | count=2 |