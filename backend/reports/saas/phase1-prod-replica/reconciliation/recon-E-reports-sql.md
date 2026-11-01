# Recon E — Reports SQL

- **Mode:** `dry-run`
- **Status:** **BLOCKER**
- **Database:** `postgres://postgres@127.0.0.1/saas_phase1_fixture?sslmode=disable`
- **Started:** 2026-05-09T14:53:14.357Z
- **Duration:** 25 ms

## Metrics

| Key | Value | Note |
|-----|-------|------|
| `reports.raw-sql-hits` | 13 |  |
| `reports.source-def-files` | 1 |  |
| `reports.source-defs.with-tenantColumn` | 0 |  |

## Actions

| Kind | Applied | Proposed | Subject |
|------|---------|----------|---------|
| `reports.missing-tenant-column` | no | add tenantColumn:<col>; reject at boot if missing | {"file":"src/reports/reports.service.ts","declarationCount":0} |
| `reports.raw-sql` | no | wrap-with-Prisma.sql + parameterize; declare tenantColumn on parent source | {"file":"src/reports/reports.service.ts","line":33,"snippet":"*  hardcoded here — never interpolated from user input — so Prisma.raw is safe. */","pattern":"Prisma.raw"} |
| `reports.raw-sql` | no | wrap-with-Prisma.sql + parameterize; declare tenantColumn on parent source | {"file":"src/reports/reports.service.ts","line":653,"snippet":"? [Prisma.sql`${Prisma.raw(`${primaryAlias}.\"deletedAt\"`)} IS NULL`]","pattern":"Prisma.raw"} |
| `reports.raw-sql` | no | wrap-with-Prisma.sql + parameterize; declare tenantColumn on parent source | {"file":"src/reports/reports.service.ts","line":660,"snippet":"const col    = Prisma.raw(`${f.alias}.\"${f.dbCol}\"`);","pattern":"Prisma.raw"} |
| `reports.raw-sql` | no | wrap-with-Prisma.sql + parameterize; declare tenantColumn on parent source | {"file":"src/reports/reports.service.ts","line":692,"snippet":"groupedCols.map((c: any) => Prisma.raw(`${fields[c.columnName].alias}.\"${fields[c.columnName].dbCol}\"`)),","pattern":"Prisma.raw"} |
| `reports.raw-sql` | no | wrap-with-Prisma.sql + parameterize; declare tenantColumn on parent source | {"file":"src/reports/reports.service.ts","line":700,"snippet":".map((s: any) => Prisma.raw(","pattern":"Prisma.raw"} |
| `reports.raw-sql` | no | wrap-with-Prisma.sql + parameterize; declare tenantColumn on parent source | {"file":"src/reports/reports.service.ts","line":706,"snippet":": Prisma.sql`ORDER BY ${Prisma.raw(fallbackOrder)}`;","pattern":"Prisma.raw"} |
| `reports.raw-sql` | no | wrap-with-Prisma.sql + parameterize; declare tenantColumn on parent source | {"file":"src/reports/reports.service.ts","line":715,"snippet":"SELECT ${Prisma.raw(countExpr)} AS total","pattern":"Prisma.raw"} |
| `reports.raw-sql` | no | wrap-with-Prisma.sql + parameterize; declare tenantColumn on parent source | {"file":"src/reports/reports.service.ts","line":716,"snippet":"FROM ${Prisma.raw(fromFragment)}","pattern":"Prisma.raw"} |
| `reports.raw-sql` | no | wrap-with-Prisma.sql + parameterize; declare tenantColumn on parent source | {"file":"src/reports/reports.service.ts","line":719,"snippet":"const countResult: any[] = await this.prisma.$queryRaw(countSql);","pattern":"$queryRaw"} |
| `reports.raw-sql` | no | wrap-with-Prisma.sql + parameterize; declare tenantColumn on parent source | {"file":"src/reports/reports.service.ts","line":724,"snippet":"SELECT ${Prisma.raw(selectParts.join(', '))}","pattern":"Prisma.raw"} |
| `reports.raw-sql` | no | wrap-with-Prisma.sql + parameterize; declare tenantColumn on parent source | {"file":"src/reports/reports.service.ts","line":725,"snippet":"FROM ${Prisma.raw(fromFragment)}","pattern":"Prisma.raw"} |
| `reports.raw-sql` | no | wrap-with-Prisma.sql + parameterize; declare tenantColumn on parent source | {"file":"src/reports/reports.service.ts","line":731,"snippet":"const rows: any[] = await this.prisma.$queryRaw(dataSql);","pattern":"$queryRaw"} |
| `reports.raw-sql` | no | wrap-with-Prisma.sql + parameterize; declare tenantColumn on parent source | {"file":"src/reports/reports.service.ts","line":835,"snippet":"this.prisma.$queryRaw`","pattern":"$queryRaw"} |
| `reports.export-isolation` | no | route exports through `runReport` with the same tenantColumn enforcement | {"requirement":"Excel/PDF/DOCX exports MUST reuse the same query builder; export entry-points cannot accept raw SQL."} |

## Notes
- Static analysis only — no DB queries.
- BLOCKER status here is informational for Phase 2 planning; Phase 1 backfill itself is unaffected.
- apply-mode is a no-op for this recon (no DB writes); current mode = dry-run.
