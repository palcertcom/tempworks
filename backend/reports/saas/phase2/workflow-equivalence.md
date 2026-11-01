# Phase 2.26 — Workflow Equivalence

Generated: 2026-05-10T11:44:18.308Z
Environment: SAFE_CLONE (localhost + fixture pattern (db=saas_phase1_fixture))
Tenant A: `11111111-1111-1111-1111-111111111111`

- Cases passed: **11** / 11
- Cases failed: 0

| # | Case | Result | Detail |
|--:|------|:------:|--------|
| 1 | legacy: pilot OFF reports pilotActive=false | PASS | TENANT_PRISMA_PILOT_ENABLED=false |
| 2 | pilot: pilot ON + workflow allow-list ⇒ pilotActive=true | PASS | pilot ON, env=SAFE_CLONE |
| 3 | getStages: catalog identical in both modes | PASS | legacy=3 pilot=3 |
| 4 | getOverview: pilot first-stage inProgress count <= legacy | PASS | legacy=2 pilot=1 |
| 5 | getAnalytics.totalEmployees: pilot <= legacy | PASS | legacy=2 pilot=1 |
| 6 | getTimeline: legacy + pilot resolve the tenant A employee id | PASS | legacy=eeeeeeea-aaaa-aaaa-aaaa-aaaaaaaaaaaa pilot=eeeeeeea-aaaa-aaaa-aaaa-aaaaaaaaaaaa |
| 7 | error path: NotFoundException for missing employee id in both modes | PASS | legacy=NotFoundException pilot=NotFoundException |
| 8 | getStageDetails: pilot employee count <= legacy (tenant filter) | PASS | legacy=2 pilot=1 |
| 9 | findWorkPermits: pilot total <= legacy total | PASS | legacy=2 pilot=1 |
| 10 | findVisas: pilot total <= legacy total | PASS | legacy=2 pilot=1 |
| 11 | response shape preserved | PASS | legacy=true pilot=true |