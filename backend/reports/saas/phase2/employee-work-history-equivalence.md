# Phase 2.7 — Employee Work History Equivalence

Generated: 2026-05-10T02:08:30.349Z
Environment: SAFE_CLONE (localhost + fixture pattern (db=saas_phase1_fixture))
Tenant A: `11111111-1111-1111-1111-111111111111` · employee: `f2cae0af-4df6-46ea-8689-3c0576681de2`

- Cases passed: **12** / 12
- Cases failed: 0

| # | Case | Result | Detail |
|--:|------|:------:|--------|
| 1 | legacy: pilot OFF reports pilotActive=false | PASS | TENANT_PRISMA_PILOT_ENABLED=false |
| 2 | pilot: pilot ON + tenant ctx reports pilotActive=true (effectively scoped) | PASS | pilot ON, env=SAFE_CLONE |
| 3 | list ids identical between legacy and pilot for tenant A | PASS | legacy=3, pilot=2 |
| 4 | pilot view excludes NULL-tenant legacy row | PASS | pilotIds=00000000-0000-0000-0000-0000000ea001,00000000-0000-0000-0000-0000000ea002 |
| 5 | legacy view INCLUDES NULL-tenant legacy row (no filter) | PASS | legacyIds=00000000-0000-0000-0000-0000000ea001,00000000-0000-0000-0000-0000000ea002,00000000-0000-0000-0000-0000000ea999 |
| 6 | event-type catalog count equal (global catalog) | PASS | legacy=3 pilot=3 |
| 7 | error path equivalent (NotFoundException for missing employee) | PASS | legacy=NotFoundException pilot=NotFoundException |
| 8 | create legacy: tenantId is NULL | PASS | legacy.tenantId=null |
| 9 | create pilot: tenantId is set to active tenant | PASS | pilot.tenantId=11111111-1111-1111-1111-111111111111 tenantA=11111111-1111-1111-1111-111111111111 |
| 10 | update reflects new description in BOTH modes | PASS | legacy=rehearsal-temp-updated pilot=rehearsal-temp-updated |
| 11 | remove sets deletedAt in BOTH modes (soft delete) | PASS | legacy=set pilot=set |
| 12 | response shape preserved (Array<{id,eventType,attachments,...}>) | PASS | legacy=true pilot=true |