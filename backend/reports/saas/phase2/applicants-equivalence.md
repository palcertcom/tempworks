# Phase 2.28 — Applicants Equivalence

Generated: 2026-05-10T12:20:42.586Z
Environment: SAFE_CLONE (localhost + fixture pattern (db=saas_phase1_fixture))
Tenant A: `11111111-1111-1111-1111-111111111111`

- Cases passed: **12** / 12
- Cases failed: 0

| # | Case | Result | Detail |
|--:|------|:------:|--------|
| 1 | legacy: pilot OFF reports pilotActive=false | PASS | TENANT_PRISMA_PILOT_ENABLED=false |
| 2 | pilot: pilot ON + applicants allow-list ⇒ pilotActive=true | PASS | pilot ON, env=SAFE_CLONE |
| 3 | findAll: pilot total <= legacy total | PASS | legacy=4 pilot=2 |
| 4 | findOne: legacy + pilot resolve the tenant A applicant id | PASS | legacy=00000000-0000-0000-0000-0000000aa001 pilot=00000000-0000-0000-0000-0000000aa001 |
| 5 | error path: NotFoundException for missing id in both modes | PASS | legacy=NotFoundException pilot=NotFoundException |
| 6 | tier filter: pilot CANDIDATE total <= legacy | PASS | legacy=4 pilot=2 |
| 7 | status filter: pilot ACCEPTED total <= legacy | PASS | legacy=2 pilot=1 |
| 8 | search filter: pilot search total <= legacy | PASS | legacy=2 pilot=2 |
| 9 | getFinancialProfile: both modes return profile for tenant A candidate | PASS | legacy=true pilot=true |
| 10 | getAgencyHistory: both modes return rows for tenant A candidate | PASS | legacy=1 pilot=1 |
| 11 | getDeleteRequests: pilot total <= legacy total (relation filter) | PASS | legacy=0 pilot=0 |
| 12 | response shape preserved (PaginatedResponse) | PASS | legacy=true pilot=true |