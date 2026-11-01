# SPIKE-004 — Reports Engine Tenant Isolation

- **Status:** PASS WITH CONSTRAINTS
- **Date:** 2026-05-09
- **Artifact:** `spikes/spike-004-reports/builder.mjs` (executable)
- **Validates:** ADR-007

## Hypothesis

A reports query builder can be made structurally tenant-safe — i.e. it is **impossible** to run a query that returns cross-tenant rows, even by an adversarial user — by:

1. Requiring every `SOURCE_DEFS` entry to declare a `tenantColumn`; rejecting at startup any entry without one.
2. Injecting a parameterized `WHERE tenant_id = $1` as a fixed first clause that user filters cannot reach.
3. Treating user filters as **AND-only**, applied over a **field allowlist**, with a closed enum of operators.
4. Quoting identifiers via a typed helper that rejects anything not matching `^[a-zA-Z_][a-zA-Z0-9_]*$`.
5. Parameterizing all user-supplied values.
6. Running every query inside a `TenantPrismaService` transaction so RLS catches anything the builder misses.

## Findings (measured)

The spike implements the minimal builder and runs adversarial inputs against it on the same Postgres+RLS stack from SPIKE-001.

| Probe | Result |
|---|---|
| Startup validation rejects source without `tenantColumn` | ✅ `source 'candidates_unsafe' missing tenantColumn` |
| Tenant A query → 50 rows, all tenant A | ✅ |
| Tenant B query → 50 rows, all tenant B | ✅ |
| `overlap(A ∩ B)` of returned IDs | ✅ 0 |
| Source not declaring `tenantColumn` rejected at run time | ✅ `source not tenant-safe` |
| User filter on `tenant_id` field (cross-tenant attempt) | ✅ `unknown field: tenant_id` (not in allowlist) |
| Operator injection (`OR 1=1 --`) | ✅ `forbidden op` |
| Identifier injection (`candidates; DROP TABLE x`) | ✅ `bad identifier` |
| Adversarial value via parameter (`%' OR 1=1 --`) | ✅ Safely parameterized; 0 rows returned |

All cross-tenant attack vectors are rejected at one of: startup, request build time, parameter binding, or RLS.

## Tenant-Safe Reporting Abstraction

```ts
// reports/engine/source-defs.ts
type FieldDef = { col: string; type: 'uuid'|'text'|'int'|'numeric'|'timestamptz'|'boolean'; };
type SourceDef = {
  rootTable: string;
  tenantColumn: string;                   // REQUIRED
  joins?: Array<{ table: string; on: string }>;  // each join's `on` MUST equate `tenant_id`
  fields: Record<string, FieldDef>;       // user-visible alias → typed column
};
const SOURCE_DEFS: Record<string, SourceDef> = { /* ... */ };

// reports/engine/validate.ts (runs at boot)
export function validateSourcesAtBoot(defs) {
  const errors = [];
  for (const [k, d] of Object.entries(defs)) {
    if (!d.tenantColumn) errors.push(`source '${k}' missing tenantColumn`);
    for (const j of d.joins ?? []) {
      if (!/\btenant_id\s*=\s*\w+\.tenant_id\b/.test(j.on))
        errors.push(`source '${k}' join on ${j.table} doesn't equate tenant_id`);
    }
  }
  if (errors.length) throw new Error('SOURCE_DEFS validation:\n' + errors.join('\n'));
}
```

## SQL Templating Rules

1. **One-and-only-one place** composes SQL: `reports/engine/build-query.ts`. Other modules import its `runReport(sourceKey, filters)` API.
2. The first WHERE term is **always** `WHERE <root>.<tenantColumn> = $1` and `$1` is bound from `TenantContext.current().id` server-side.
3. User filters are appended as `AND <ident> <op> <param>`; never concatenated into the SQL string.
4. Identifiers go through `ident(name)` (regex-allowlisted, double-quoted).
5. Values are positional parameters (`$2`, `$3`, …); strings are never interpolated into SQL.
6. Operator set is a closed enum: `=`, `!=`, `<`, `<=`, `>`, `>=`, `ILIKE`, `IN`, `BETWEEN`, `IS NULL`, `IS NOT NULL`. Anything else throws.
7. `IN` requires a non-empty array; bound as N positional parameters.
8. `LIMIT` is server-set (max 10,000 rows) and cannot be overridden by user.
9. Sub-queries / CTEs / `UNION` are forbidden in user-supplied input. Only registry-defined `joins`.
10. The query runs inside `TenantPrismaService.withTenant(...)` — RLS is the safety net.

## Forbidden Patterns

- `Prisma.raw(`..`${userInput}..`)` — banned by ESLint allowlist (anywhere).
- `prisma.$queryRaw\`...\`` outside `infra/prisma` and `reports/engine` — banned.
- Filter operator passed through as a string from the request body.
- Identifiers built by string concatenation.
- `WHERE tenant_id = ${value}` (must be `$1` parameter).
- `OR` in user filters at the top level (only `AND`-of-clauses; "OR" inside a clause's `IN` list is fine).
- User-controlled `ORDER BY` field that bypasses the field allowlist.

## Automated Detection Strategy

1. **ESLint rule** `no-prisma-raw-outside-allowlist`: forbids `Prisma.raw`, `$queryRaw`, `$executeRaw`, `$queryRawUnsafe`, `$executeRawUnsafe` outside `backend/src/infra/prisma/` and `backend/src/reports/engine/`.
2. **Boot validator** `validateSourcesAtBoot(SOURCE_DEFS)` — crashes the process on missing `tenantColumn` or join misconfiguration. CI runs the app boot in a smoke test.
3. **Two-tenant isolation test** per source: seeds rows in tenants A and B; runs the report under tenant A's context **without** filters; asserts no tenant-B rows in the output. Repeated for every source in the registry.
4. **Fuzz test** per source: passes a curated list of adversarial inputs (operator strings, field names, values) and asserts the builder rejects or safely runs.
5. **EXPLAIN regression test**: for tables with hash-partitioning by `tenant_id`, asserts only one partition is scanned per query (i.e. partition pruning works → tenant filter is the leading condition). Catches accidental late-binding of `tenant_id`.
6. **Code review checklist** when adding a new source: must include `tenantColumn` and `joins[].on` containing `tenant_id` equality; reviewer signs off on both.

## Migration Path for Today's `SOURCE_DEFS`

1. Audit existing entries (`backend/src/reports/reports.service.ts`). Each entry maps to one logical data source.
2. Add `tenantColumn` to each. For derived sources (e.g. `documents` joined to `employees`), add a `tenantColumn` on the root and also include `documents.tenant_id = employees.tenant_id` in the join `on` clause.
3. Strip any user-controllable raw SQL from filter inputs; convert to the typed operator/value model.
4. Run isolation tests for each source.
5. Cut over behind `REPORTS_TENANT_FILTER_ENFORCED=true`.

Estimated effort: 2 weeks one engineer (≈10 sources, integration tests included).

## Risks Surfaced

| # | Risk | Mitigation |
|---|---|---|
| R-1 | Engineer adds a new `SOURCE_DEFS` entry without `tenantColumn` | Boot validator crashes the app; CI smoke test catches it |
| R-2 | Engineer bypasses the engine and writes raw SQL elsewhere | ESLint allowlist; PR review |
| R-3 | User-controllable `ORDER BY` field name | Server applies the same `ident()` + field-allowlist check |
| R-4 | Export pipeline (Excel/PDF/DOCX) uses a different SQL path | Refactor exports to call the same `runReport` engine |
| R-5 | Join `on` clauses lacking `tenant_id` equality (subtle data leak when one side has many rows of another tenant) | Validator regex; `EXPLAIN` test |
| R-6 | Cross-source `UNION` reports | Build as a registry-defined source; never user-composable |

## Verdict: **PASS WITH CONSTRAINTS**

Constraints (must hold during Phase 3 reports refactor):

1. Single composition surface (`reports/engine/build-query.ts`).
2. `SOURCE_DEFS.tenantColumn` mandatory; validator at boot.
3. Field allowlist + closed operator enum; values parameterized.
4. ESLint allowlist for raw Prisma.
5. Per-source isolation + fuzz + EXPLAIN tests.
6. Exports reuse the same engine.

## Cleanup

```sh
rm -rf spikes/spike-004-reports/node_modules
```
