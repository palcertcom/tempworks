# Phase 2 — Runtime Refactor Inventory (machine output)

Generated: 2026-05-09T15:22:56.347Z

## Totals

| Metric | Value |
|--------|------:|
| modules | 28 |
| files | 201 |
| prismaCalls | 793 |
| rawSqlHits | 17 |
| P0 | 6 |
| P1 | 5 |
| P2 | 9 |
| P3 | 6 |
| global | 2 |

## Per-module (sorted by tier, then prismaCalls)

| Module | Tier | Files | LOC | Prisma calls | Raw SQL | Cron | setInterval | queue.add | Export libs | agencyId-filter usages |
|--------|------|------:|----:|-------------:|--------:|-----:|------------:|----------:|------------:|-----------------------:|
| `pipeline` | **P0** | 4 | 1802 | 91 | 1 | 0 | 0 | 0 | 0 | 0 |
| `applicants` | **P0** | 9 | 1761 | 50 | 3 | 0 | 0 | 0 | 1 | 0 |
| `employees` | **P0** | 6 | 778 | 35 | 1 | 0 | 0 | 0 | 1 | 8 |
| `notifications` | **P0** | 8 | 864 | 28 | 0 | 0 | 1 | 0 | 0 | 3 |
| `reports` | **P0** | 4 | 1434 | 27 | 10 | 0 | 0 | 0 | 2 | 1 |
| `backup` | **P0** | 4 | 1003 | 0 | 1 | 0 | 0 | 0 | 0 | 0 |
| `vehicles` | **P1** | 4 | 1805 | 47 | 0 | 0 | 0 | 0 | 1 | 0 |
| `documents` | **P1** | 8 | 1274 | 44 | 0 | 0 | 0 | 0 | 0 | 0 |
| `settings` | **P1** | 7 | 1017 | 41 | 0 | 0 | 0 | 0 | 0 | 0 |
| `workflow` | **P1** | 6 | 533 | 35 | 0 | 0 | 0 | 0 | 0 | 0 |
| `finance` | **P1** | 8 | 1570 | 32 | 0 | 0 | 0 | 0 | 1 | 0 |
| `recycle-bin` | **P2** | 10 | 2583 | 184 | 0 | 0 | 0 | 0 | 0 | 6 |
| `auth` | **P2** | 19 | 1496 | 47 | 0 | 0 | 0 | 0 | 0 | 1 |
| `users` | **P2** | 8 | 1430 | 35 | 0 | 0 | 0 | 0 | 0 | 1 |
| `agencies` | **P2** | 5 | 569 | 31 | 0 | 0 | 0 | 0 | 0 | 4 |
| `compliance` | **P2** | 4 | 282 | 23 | 0 | 0 | 0 | 0 | 0 | 0 |
| `logs` | **P2** | 4 | 291 | 13 | 0 | 0 | 0 | 0 | 0 | 1 |
| `roles` | **P2** | 5 | 230 | 11 | 0 | 0 | 0 | 0 | 0 | 0 |
| `job-ads` | **P2** | 7 | 496 | 10 | 0 | 0 | 0 | 0 | 0 | 0 |
| `attendance` | **P2** | 4 | 1535 | 7 | 0 | 0 | 0 | 0 | 1 | 0 |
| `employee-work-history` | **P3** | 4 | 352 | 2 | 0 | 0 | 0 | 0 | 0 | 0 |
| `app.module.ts` | **P3** | 1 | 66 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| `application-drafts` | **P3** | 5 | 535 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| `email` | **P3** | 3 | 1050 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| `main.ts` | **P3** | 1 | 717 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| `prisma` | **P3** | 2 | 128 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| `common` | **global** | 19 | 1322 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| `saas` | **global** | 32 | 1584 | 0 | 1 | 0 | 0 | 0 | 0 | 0 |