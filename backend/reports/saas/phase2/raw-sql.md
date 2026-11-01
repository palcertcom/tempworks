# Phase 2 — Raw-SQL Scanner Report

Generated: 2026-05-11T12:06:16.530Z

- Total findings: **26**
- BLOCKER: 11 (blocks Phase 2 enforcement: 20)
- HIGH: 9
- MEDIUM: 6
- @tenant-reviewed without reason: 0

## Per-module

| Module | Findings |
|--------|---------:|
| `backup` | 2 |
| `common` | 1 |
| `email` | 1 |
| `recycle-bin` | 5 |
| `reports` | 11 |
| `saas` | 1 |
| `applicants` | 3 |
| `employees` | 1 |
| `pipeline` | 1 |

## Findings

| File | Line | Severity | Pattern | Module | Reviewed | Snippet |
|------|-----:|----------|---------|--------|---------|---------|
| `src/backup/backup.service.ts` | 325 | **BLOCKER** | `$executeRawUnsafe` | `backup` | — | `await this.prisma.$executeRawUnsafe(` |
| `src/backup/backup.service.ts` | 556 | **BLOCKER** | `string-concat-SQL` | `backup` | — | ``Backup database name "${meta.databaseName}" differs from current "${conn.database}".`,` |
| `src/common/storage/storage.service.ts` | 171 | **BLOCKER** | `string-concat-SQL` | `common` | — | `this.logger.warn(`Spaces delete failed for ${key}: ${err?.message ?? err}`);` |
| `src/email/email.service.ts` | 19 | **BLOCKER** | `string-concat-SQL` | `email` | — | `this.logger.log(`Email service ready (Resend API). Key: ${this.apiKey.substring(0, 8)}... FROM: ${this.from}`);` |
| `src/recycle-bin/hard-delete.service.ts` | 210 | **BLOCKER** | `string-concat-SQL` | `recycle-bin` | — | ``Cannot hard-delete agency: ${activeEmployees} active employee(s) and ${activeUsers} active user(s) still reference it. Reassign or delete them first.`,` |
| `src/recycle-bin/hard-delete.service.ts` | 249 | **BLOCKER** | `string-concat-SQL` | `recycle-bin` | — | ``Cannot hard-delete document type: ${activeDocs} active document(s) reference it. Soft-delete or reassign them first.`,` |
| `src/recycle-bin/hard-delete.service.ts` | 313 | **BLOCKER** | `string-concat-SQL` | `recycle-bin` | — | ``Cannot hard-delete role: ${assignedUsers} active user(s) are assigned this role. Reassign them first.`,` |
| `src/recycle-bin/hard-delete.service.ts` | 55 | **BLOCKER** | `string-concat-SQL` | `recycle-bin` | — | `throw new ForbiddenException(`Hard delete is not permitted for entity type: ${entityType}`);` |
| `src/recycle-bin/hard-delete.service.ts` | 79 | **BLOCKER** | `string-concat-SQL` | `recycle-bin` | — | `throw new BadRequestException(`No hard-delete handler for entity type: ${entityType}`);` |
| `src/reports/reports.service.ts` | 779 | **BLOCKER** | `string-concat-SQL` | `reports` | — | ``${j.joinType} JOIN "${j.table}" AS ${j.alias} ON ${j.on}`,` |
| `src/saas/prisma/tenant-prisma.service.ts` | 62 | **BLOCKER** | `$executeRawUnsafe` | `saas` | — | `await tx.$executeRawUnsafe(setLocalTenantSql(tenantId));` |
| `src/reports/reports.service.ts` | 785 | **HIGH** | `Prisma.raw` | `reports` | — | `? [Prisma.sql`${Prisma.raw(`${primaryAlias}."deletedAt"`)} IS NULL`]` |
| `src/reports/reports.service.ts` | 792 | **HIGH** | `Prisma.raw` | `reports` | — | `const col    = Prisma.raw(`${f.alias}."${f.dbCol}"`);` |
| `src/reports/reports.service.ts` | 824 | **HIGH** | `Prisma.raw` | `reports` | — | `groupedCols.map((c: any) => Prisma.raw(`${fields[c.columnName].alias}."${fields[c.columnName].dbCol}"`)),` |
| `src/reports/reports.service.ts` | 832 | **HIGH** | `Prisma.raw` | `reports` | — | `.map((s: any) => Prisma.raw(` |
| `src/reports/reports.service.ts` | 838 | **HIGH** | `Prisma.raw` | `reports` | — | `: Prisma.sql`ORDER BY ${Prisma.raw(fallbackOrder)}`;` |
| `src/reports/reports.service.ts` | 847 | **HIGH** | `Prisma.raw` | `reports` | — | `SELECT ${Prisma.raw(countExpr)} AS total` |
| `src/reports/reports.service.ts` | 848 | **HIGH** | `Prisma.raw` | `reports` | — | `FROM ${Prisma.raw(fromFragment)}` |
| `src/reports/reports.service.ts` | 856 | **HIGH** | `Prisma.raw` | `reports` | — | `SELECT ${Prisma.raw(selectParts.join(', '))}` |
| `src/reports/reports.service.ts` | 857 | **HIGH** | `Prisma.raw` | `reports` | — | `FROM ${Prisma.raw(fromFragment)}` |
| `src/applicants/applicants.service.ts` | 1336 | **MEDIUM** | `$queryRaw` | `applicants` | — | `const result: { current: number }[] = await this.legacyPrisma.$queryRaw`` |
| `src/applicants/applicants.service.ts` | 1363 | **MEDIUM** | `$queryRaw` | `applicants` | — | `const result: { current: number }[] = await this.legacyPrisma.$queryRaw`` |
| `src/applicants/applicants.service.ts` | 1390 | **MEDIUM** | `$queryRaw` | `applicants` | — | `const result: { current: number }[] = await this.legacyPrisma.$queryRaw`` |
| `src/employees/employees.service.ts` | 318 | **MEDIUM** | `$queryRaw` | `employees` | — | `const result: any[] = await this.legacyPrisma.$queryRaw`` |
| `src/pipeline/pipeline.service.ts` | 433 | **MEDIUM** | `$executeRaw` | `pipeline` | — | `await this.prisma.$executeRaw`` |
| `src/reports/reports.service.ts` | 967 | **MEDIUM** | `$queryRaw` | `reports` | — | `this.prisma.$queryRaw`` |

## Suggested fixes

- **`$executeRawUnsafe`** (BLOCKER): Convert to $executeRaw with tagged-template params; route through TenantPrismaService.withTenant.
- **`$queryRawUnsafe`** (BLOCKER): Convert to $queryRaw tagged template; declare a SOURCE_DEFS entry with tenantColumn.
- **`Prisma.raw`** (HIGH): Move into the SOURCE_DEFS registry under backend/src/saas/reports; the boot validator will require tenantColumn.
- **`$executeRaw`** (MEDIUM): Wrap the call site in TenantPrismaService.withTenant so RLS sees a tenant_id GUC.
- **`$queryRaw`** (MEDIUM): Wrap call site in TenantPrismaService.withTenant; verify the SQL has a tenant filter.