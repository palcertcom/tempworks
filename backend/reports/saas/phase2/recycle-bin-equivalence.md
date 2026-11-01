# Phase 2.11 — Recycle Bin Equivalence

Generated: 2026-05-10T02:10:28.069Z
Environment: SAFE_CLONE (localhost + fixture pattern (db=saas_phase1_fixture))

- Cases passed: **11** / 11
- Cases failed: 0

| # | Case | Result | Detail |
|--:|------|:------:|--------|
| 1 | legacy: pilot OFF reports pilotActive=false | PASS | TENANT_PRISMA_PILOT_ENABLED=false |
| 2 | pilot ON: pilotActive=true | PASS | pilot ON, env=SAFE_CLONE |
| 3 | getEntityCounts: pilot APPLICANT count <= legacy | PASS | legacy=0 pilot=0 |
| 4 | getEntityCounts: pilot EMPLOYEE count <= legacy | PASS | legacy=0 pilot=0 |
| 5 | getEntityCounts: USER count is GLOBAL — equal in both modes | PASS | legacy=1 pilot=1 |
| 6 | getEntityCounts: pilot total <= legacy total | PASS | legacy=1 pilot=1 |
| 7 | findAll(all types): pilot total <= legacy total | PASS | legacy=0 pilot=0 |
| 8 | findAll(entityType=JOB_AD): pilot subset of legacy (tenant-scoped) | PASS | legacy=0 pilot=0 |
| 9 | findAll(entityType=DOCUMENT_TYPE): GLOBAL — equal in both modes | PASS | legacy=0 pilot=0 |
| 10 | error path: unknown entityType raises same error class | PASS | legacy=no-error pilot=no-error |
| 11 | response shape preserved (PaginatedResponse + counts.total) | PASS | numeric totals + meta in both modes |