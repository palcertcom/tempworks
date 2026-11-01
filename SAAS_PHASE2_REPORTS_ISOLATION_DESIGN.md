# Phase 2 — Reports Engine Isolation Design

> Status: **dormant scaffolding shipped under `backend/src/saas/reports/`**;
> the live legacy engine in `backend/src/reports/reports.service.ts` is
> unchanged. ADR-007 governs the design.

---

## 1. Why this is the most important Phase 2 deliverable

`reports/reports.service.ts` (1,178 lines) builds SQL via
`Prisma.raw(...)` against a hand-rolled `SOURCE_DEFS` registry. Today
the queries have **no automatic tenant filter** — scoping depends on
whether the UI happens to apply one. Once `TENANT_PRISMA_ENFORCEMENT`
turns on (Phase 2.6+):

- the wrapped client cannot intercept `Prisma.raw`-built SQL;
- RLS will fire — and either return 0 rows (silently breaking reports)
  if the GUC is correct, or **leak** if a future code path uses the
  platform-admin role instead.

The reports refactor is therefore the **hard prerequisite** to
enabling Phase 2 enforcement. ADR-007 documented the contract; this
file documents the engineering plan.

## 2. Current architecture (legacy)

### 2.1 Layers

```
HTTP /reports/*
  └── ReportsController (DTOs, RBAC by role)
        └── ReportsService.runReport(reportId)
              ├── load Report row from `reports` table
              ├── pick a SOURCE_DEFS entry by `report.source`
              ├── compose SQL string with Prisma.raw fragments
              │     - SELECT clause from user-chosen columns
              │     - FROM clause from SourceDef.primaryTable + joins
              │     - WHERE clause = soft-delete + user filters
              │     - GROUP BY / ORDER BY from user choices
              ├── Prisma.$queryRaw → rows
              └── (optional) Excel/PDF/DOCX export (exceljs/pdfkit/docx)
```

### 2.2 Statistics (live; from `npm run saas:phase2-reports-validate`)

- **18 sources** registered in `SOURCE_DEFS`.
- **0 sources** declare a `tenantColumn` (it doesn't exist in the type yet).
- **10 sources** have joins WITHOUT `tenant_id = tenant_id` equality.
- **0 sources** are **READY** for the new contract; **8** need a decision; **10** are blocked on join refactors.

### 2.3 Raw-SQL surfaces (from `npm run saas:scan:raw-sql`)

Across `backend/src/`:

- **11 BLOCKER** findings (string-concatenated SQL, `*Unsafe` variants, `Prisma.raw`).
- **9 HIGH** findings (`Prisma.raw`).
- **6 MEDIUM** findings (`$queryRaw` / `$executeRaw` tagged templates).

The reports module owns the majority. The rest are smaller surfaces
in the migration / startup paths (acceptable, but each must get a
`@tenant-reviewed` comment with a reason during Phase 2).

## 3. Target architecture (Phase 3 cutover; Phase 2 scaffolds)

### 3.1 Source-of-truth registry: `TenantSafeReportSourceRegistry`

Lives at `backend/src/saas/reports/source-registry.ts`. Each entry is a
`SourceDef` (see `source-def.types.ts`) and **must declare**:

- `tenantColumn: string` on the primary table (boot validator
  refuses if missing).
- `agencyColumn: string | null` (optional sub-scope; nullable for
  catalogue-style sources).
- `tenantAwareJoins: JoinDef[]` — every join's `on` must contain
  `<aliasA>.tenant_id = <aliasB>.tenant_id` (regex-validated).
- `platformAdminOnly?: boolean` — for cross-tenant analytics.

`assertAllValid()` is invoked at module boot. Any mismatch throws an
aggregated error and the process exits with the offending source key.

### 3.2 Safe SQL builder

Composition steps:

1. Validate the active source via the registry.
2. **First WHERE term, always**: `<primaryAlias>.<tenantColumn> = $1` bound from `TenantContext.current().id`.
3. **Optional next term**: agency-scope `<primaryAlias>.<agencyColumn> IN ($2, ...)` when the caller has `AgencyMembership` rows.
4. **Optional next term**: soft-delete filter when `softDelete=true`.
5. **User filters**: AND-only, allow-listed operators (`=, !=, <, <=, >, >=, ILIKE, IN, BETWEEN, IS NULL, IS NOT NULL`), allow-listed fields (looked up by `key` in `SourceDef.fields`).
6. **Identifiers** quoted via `colRef(alias, col)` which validates both via `^[a-zA-Z_][a-zA-Z0-9_]*$`.
7. **Values** are positional parameters; strings additionally checked against `looksLikeUnsafeSql()` heuristic and rejected on match.

The implementation is in `backend/src/saas/reports/where-builder.ts`
and tested by `backend/src/saas/__validation__/reports.check.ts` (17 tests, all PASS).

### 3.3 Forbidden SQL patterns

Static-detected by `npm run saas:scan:raw-sql` and runtime-detected by
`looksLikeUnsafeSql`:

- `OR 1=1` and inline-comment obfuscation (`-- $`, `/* */`)
- `; DROP/TRUNCATE/DELETE/UPDATE/INSERT/ALTER/GRANT/REVOKE`
- `UNION SELECT`
- `xp_cmdshell` (defence in depth)
- string-concatenated SQL (template literal containing SQL keyword + `${...}` substitution)

Also forbidden by convention (lint + reviewer checklist):

- top-level `OR` in user filters
- user-controllable `ORDER BY` field that bypasses the field allow-list
- user-controllable `LIMIT` greater than the per-source cap (default 10,000)
- `Prisma.raw` outside `backend/src/saas/reports/` and `backend/src/infra/prisma/`
- `$queryRawUnsafe` / `$executeRawUnsafe` anywhere

### 3.4 Typed source registry shape

```ts
interface SourceDef {
  key: string;
  label: string;
  group: 'single' | 'combined';
  tables: string[];
  primaryTable: string;
  primaryAlias: string;
  softDelete: boolean;
  tenantColumn: string;          // MANDATORY
  agencyColumn: string | null;   // optional
  tenantAwareJoins: JoinDef[];
  fields: Record<string, FieldDef>;
  platformAdminOnly?: boolean;
}
```

The `key` doubles as the URL slug; the registry rejects slugs that
don't match the identifier regex.

### 3.5 Export isolation

Excel / PDF / DOCX exports must NOT have a separate query path. They
go through the same `runReport(...)` engine and stream rows through
the export library. The current code has separate codepaths for
HTML/JSON vs Excel/PDF/DOCX; Phase 3 unifies them.

Concrete rule: export pipelines accept a `RunReportResult` (rows +
columns), never raw SQL.

### 3.6 Aggregate isolation

Aggregations (`COUNT`, `SUM`, `AVG`, `MIN`, `MAX`) inherit the same
WHERE clause. The user can pick aggregate columns from the same
`fields` allow-list; the engine emits `<agg>(<colRef>) AS <alias>`.
No user-supplied SQL fragments in aggregates.

`GROUP BY` columns are also from the field allow-list.

`HAVING` is restricted to AND-only filters on aggregated columns; the
user can only use the same operator allow-list.

### 3.7 Agency-scope filtering

When the caller's JWT carries a non-empty `agy[]` claim, the engine
adds `<primaryAlias>.<agencyColumn> IN (...)` automatically. If the
source doesn't declare `agencyColumn`, the agency-scope filter is
silently skipped — the source is "tenant-only", which is correct for
catalogue tables.

For agency-scope to be enforced when relevant, the `agencyColumn` must
be on the **primary** table (not on a joined table). If a future
source needs agency scope on a joined table only, the convention is
to denormalise the agency id into the primary table during Phase 2
backfill.

### 3.8 Platform-admin reporting

Three categories:

| Category | Behaviour |
|---|---|
| Tenant-scoped source (default) | Tenant filter mandatory. Platform admin sees only one tenant per query (the `tid` claim in their access token, even when it's a `pa: true` token). |
| `platformAdminOnly: true` source | Source rejects non-platform-admin callers. The engine bypasses the tenant filter in this case AND writes an audit row to `platform_audit_logs` per call. |
| Cross-tenant reporting on demand | Implemented via `platformAdminOnly` sources whose primary table is a tenant-aware view, e.g. `tenant_kpi_summary`. NOT a generic "list across all tenants of this domain table". |

This avoids the "platform admin runs an ordinary report and accidentally sees all tenants" failure mode.

## 4. Test matrix

| Test | Tier | Run by |
|------|------|--------|
| Boot validator rejects source without `tenantColumn` | unit | `saas:validate` |
| Boot validator rejects join without `tenant_id =` | unit | `saas:validate` |
| Where-builder forces `tenantId` as `$1` | unit | `saas:validate` |
| Where-builder rejects unknown field | unit | `saas:validate` |
| Where-builder rejects forbidden op | unit | `saas:validate` |
| Where-builder rejects adversarial value (`OR 1=1`) | unit | `saas:validate` |
| Where-builder accepts apostrophes (no false-positives) | unit | `saas:validate` |
| Per-source isolation test (two tenants, same source, no overlap) | integration | per-source on cutover |
| `EXPLAIN` plan shows partition pruning | integration | per-source on cutover |
| Export reuses engine output (rows match) | integration | export pipeline |
| `platformAdminOnly` source rejects tenant member | unit | `saas:validate` |
| Static raw-SQL scanner sees zero unreviewed BLOCKERs in `reports/` | CI | `saas:scan:raw-sql --strict` |

The 17 unit tests in `backend/src/saas/__validation__/reports.check.ts` are the **boot gate**; the per-source isolation tests are the **cutover gate**.

## 5. Cutover sequence (Phase 3)

1. **Per-source migration ticket** for each of the 18 legacy `SOURCE_DEFS` entries:
    - copy into `backend/src/saas/reports/` registry,
    - add `tenantColumn` (decision per source — see `SAAS_PHASE2_REPORTS_SOURCE_MAPPING.md`),
    - rewrite joins to include `tenant_id = tenant_id`,
    - declare `agencyColumn` if applicable,
    - write a per-source isolation test (two tenants, identical fixture, run report under tenant A's context, assert no tenant-B rows).
2. **Cutover flag** `REPORTS_TENANT_FILTER_ENFORCED`. When OFF: legacy engine runs. When ON: `runReport` delegates to the new builder + new registry. Default OFF.
3. **Per-tenant rollout** in staging — flip the flag for one tenant, observe; flip for all in staging; promote to prod.
4. **Legacy engine retirement** — once `REPORTS_TENANT_FILTER_ENFORCED=true` in prod for ≥ 2 weeks with zero leakage incidents, delete the legacy `SOURCE_DEFS`.

## 6. Risk matrix

| Risk | Severity | Mitigation |
|---|---|---|
| Per-source migration introduces a regression in row counts | HIGH | Read-equivalence test per source before the cutover flag flips for that source |
| Some legacy reports rely on no-filter behaviour (cross-tenant) | MEDIUM | Audit + re-classify as `platformAdminOnly` if so |
| Engineer adds new `Prisma.raw` outside the registry | MEDIUM | Scanner runs in `--strict` mode in CI for `backend/src/reports/` |
| Performance regression from extra WHERE term | LOW | EXPLAIN test confirms partition pruning; tenant-leading index added in Phase 1 |
| User-controllable `ORDER BY` injection | LOW | Same allow-list; no surface for arbitrary `ORDER BY` |

## 7. Files

| Path | Status |
|------|--------|
| `backend/src/saas/reports/source-def.types.ts` | dormant (Phase 2) |
| `backend/src/saas/reports/source-registry.ts` | dormant (Phase 2) |
| `backend/src/saas/reports/where-builder.ts` | dormant (Phase 2) |
| `backend/src/saas/reports/sql-guards.ts` | dormant (Phase 2) |
| `backend/src/saas/reports/index.ts` | dormant (Phase 2) |
| `backend/src/saas/__validation__/reports.check.ts` | active (saas:validate) |
| `backend/scripts/scan-raw-sql.ts` | advisory (saas:scan:raw-sql) |
| `backend/scripts/saas/phase2/reports-validate.ts` | advisory (saas:phase2-reports-validate) |
| `backend/src/reports/reports.service.ts` | UNCHANGED — legacy engine, still live |
