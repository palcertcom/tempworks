# Phase 2.17 — Finance Mutation Equivalence

Generated: 2026-05-10T06:34:46.758Z
Environment: SAFE_CLONE (localhost + fixture pattern (db=saas_phase1_fixture))
Tenant A: `11111111-1111-1111-1111-111111111111` · Employee A: `eeeeeeea-aaaa-aaaa-aaaa-aaaaaaaaaaaa`

- Cases passed: **9** / 9
- Cases failed: 0

| # | Case | Result | Detail |
|--:|------|:------:|--------|
| 1 | create response shape preserved (id + transactionType + attachments[]) | PASS | legacy.shape=true pilot.shape=true |
| 2 | create legacy: tenantId is NULL | PASS | legacy.tenantId=null |
| 3 | create pilot: tenantId is set to active tenant | PASS | pilot.tenantId=11111111-1111-1111-1111-111111111111 tenantA=11111111-1111-1111-1111-111111111111 |
| 4 | update both modes mutate the description | PASS | legacy="desc-legacy-updated" pilot="desc-pilot-updated" |
| 5 | validation error: BadRequestException for invalid entityType in both modes | PASS | legacy=BadRequestException pilot=BadRequestException |
| 6 | audit log: one CREATED row written per create in both modes | PASS | legacy=1 pilot=1 |
| 7 | removeDeduction with bogus id: NotFoundException in both modes | PASS | legacy=NotFoundException pilot=NotFoundException |
| 8 | pilot remove: deletedAt is set on the row | PASS | deletedAt=set |
| 9 | totals after mutation: legacy aggregate non-zero (sees both creates) | PASS | count=3 disbursed=350 |