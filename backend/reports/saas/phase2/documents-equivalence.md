# Phase 2.20 — Documents Equivalence

Generated: 2026-05-10T11:43:31.605Z
Environment: SAFE_CLONE (localhost + fixture pattern (db=saas_phase1_fixture))
Tenant A: `11111111-1111-1111-1111-111111111111`

- Cases passed: **10** / 10
- Cases failed: 0

| # | Case | Result | Detail |
|--:|------|:------:|--------|
| 1 | legacy: pilot OFF reports pilotActive=false | PASS | TENANT_PRISMA_PILOT_ENABLED=false |
| 2 | pilot: pilot ON + documents allow-list ⇒ pilotActive=true | PASS | pilot ON, env=SAFE_CLONE |
| 3 | findAll: pilot total <= legacy total (tenant filter applies) | PASS | legacy=7 pilot=2 |
| 4 | findOne: legacy + pilot resolve the tenant A document id | PASS | legacy=00000000-0000-0000-0000-0000000dc001 pilot=00000000-0000-0000-0000-0000000dc001 |
| 5 | error path: NotFoundException for missing id in both modes | PASS | legacy=NotFoundException pilot=NotFoundException |
| 6 | findByEntity: pilot count <= legacy count (entity is tenant A; counts equal here) | PASS | legacy=5 pilot=2 |
| 7 | getExpiringDocuments: pilot count <= legacy count (tenant filter applies) | PASS | legacy=4 pilot=2 |
| 8 | readDocumentBytes: metadata lookup succeeds in BOTH modes for tenant A doc | PASS | legacy=true pilot=true |
| 9 | checkDocTypePermission: global catalog returns same value in both modes | PASS | legacy=true pilot=true |
| 10 | response shape preserved (PaginatedResponse<Document>) | PASS | legacy=true pilot=true |