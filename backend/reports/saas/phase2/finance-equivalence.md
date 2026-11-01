# Phase 2.16 — Finance Equivalence

Generated: 2026-05-10T11:43:15.189Z
Environment: SAFE_CLONE (localhost + fixture pattern (db=saas_phase1_fixture))
Tenant A: `11111111-1111-1111-1111-111111111111`

- Cases passed: **9** / 9
- Cases failed: 0

| # | Case | Result | Detail |
|--:|------|:------:|--------|
| 1 | legacy: pilot OFF reports pilotActive=false | PASS | TENANT_PRISMA_PILOT_ENABLED=false |
| 2 | pilot: pilot ON + finance allow-list ⇒ pilotActive=true | PASS | pilot ON, env=SAFE_CLONE |
| 3 | findAll: pilot total <= legacy total (tenant filter applies) | PASS | legacy=6 pilot=4 |
| 4 | findOne: legacy + pilot resolve the tenant A record id | PASS | legacy=00000000-0000-0000-0000-0000000fa001 pilot=00000000-0000-0000-0000-0000000fa001 |
| 5 | error path: NotFoundException for missing id in both modes | PASS | legacy=NotFoundException pilot=NotFoundException |
| 6 | getTotals: legacy + pilot return same per-entity sum | PASS | legacy=300/2 pilot=300/2 |
| 7 | listTransactionTypes: global catalog identical in both modes | PASS | legacy=2 pilot=2 |
| 8 | getHistory: pilot resolves the same record id (tenant pre-check) | PASS | legacy=00000000-0000-0000-0000-0000000fa001 pilot=00000000-0000-0000-0000-0000000fa001 |
| 9 | response shape preserved (PaginatedResponse<FinancialRecord>) | PASS | legacy=true pilot=true |