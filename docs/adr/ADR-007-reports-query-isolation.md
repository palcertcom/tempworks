# ADR-007 — Reports Query Isolation

- **Status:** Accepted
- **Date:** 2026-05-09
- **Related:** ADR-001 (RLS), ADR-004 (TenantPrismaService)

## Context

`backend/src/reports/reports.service.ts` is a metadata-driven reporting engine. It defines a `SOURCE_DEFS` registry mapping logical data sources (employees, applicants, documents, compliance_alerts, agencies, work_permits, visas, document_types, and several multi-table combinations) to SQL templates composed via `Prisma.raw(...)`. User-supplied filters are appended to the base query at run time, then results are streamed to Excel/PDF/DOCX export pipelines.

Two facts make this the **single highest-risk surface** for cross-tenant leakage:

1. The base queries have **no tenant filter**. Tenant scoping today depends on the user-supplied filter UI (which assumes a single-tenant deployment).
2. Raw SQL composition bypasses any application-layer tenant injection (`TenantPrismaService` cannot help if the query is constructed via `Prisma.raw`).

Even with RLS `FORCE` enabled, an unfiltered SQL query under the platform-admin role would happily return cross-tenant rows.

## Decision

The reports engine is refactored so that **every base query template includes an unconditional `WHERE tenant_id = $tenantId AND …`**, injected by the engine itself, and **never controllable by the user**.

### Concrete rules

1. **Every entry in `SOURCE_DEFS` declares a `tenantFilterColumn`.** A source whose root table lacks a `tenant_id` column (or whose tenancy is derived through a join) declares the join path explicitly. The engine validates declarations at startup; missing/invalid declarations crash on boot.

2. **Tenant filter is added as a parameterized clause**, not a string concatenation. The engine uses Prisma's `Prisma.sql` tagged template / parameter binding so the value cannot be user-injected.

3. **User filters are `AND`-only, applied to a fresh subquery.** The query builder constructs:

   ```sql
   SELECT ...
   FROM ( <base query with WHERE tenant_id = $1 AND <fixed joins>> ) AS q
   WHERE <user filter clauses>
   ```

   User clauses cannot reference `tenant_id`, cannot use `OR` against the tenant filter, and cannot use raw SQL.

4. **Whitelisted column references.** User filters reference fields by their `SOURCE_DEFS` key; the engine maps the key to a safe column name. Arbitrary identifiers are rejected.

5. **No raw SQL outside the engine.** ESLint rule forbids `Prisma.raw`, `$queryRaw`, `$executeRaw` outside `backend/src/reports/engine/*` and `backend/src/infra/prisma/*`. Even inside `reports/`, use is constrained to the query builder.

6. **Defense in depth.** Reports run under the same `TenantPrismaService` connection so RLS catches anything the builder misses.

7. **Unique constraint on `Report.name`** changes from global to `(tenantId, name)`.

8. **Export pipelines reuse the builder.** Excel/PDF/DOCX exports invoke the same `runQuery()` path; they do not have a separate execution surface.

### Test obligations

- For every entry in `SOURCE_DEFS`, an integration test creates two tenants, populates fixtures in each, runs the report **without filters**, and asserts no cross-tenant rows.
- For each entry, a fuzz test attempts to bypass the tenant filter via crafted user filters (`OR 1=1`, `tenant_id IN (...)`, SQL injection in field names, comment terminators, UNION-based attempts). All must reject.
- An `EXPLAIN` test asserts that partition pruning (where applicable) selects only the active tenant's partition.

### Migration sequence

1. Refactor the engine to add the mandatory tenant filter; existing single-tenant deployments are unaffected because their tenant filter resolves to the only tenant.
2. Backfill `tenantId` on every reportable model (Phase 2).
3. Enable RLS in audit mode on those models; ensure no policy violations occur in reports.
4. Promote RLS to `FORCE`.

## Consequences

**Positive**
- Reports cannot leak across tenants by construction.
- A single, audited code path for SQL composition.
- Raw SQL outside the engine is forbidden — easier to review.
- Future analytics engines (data warehouse, ETL) inherit the same contract.

**Negative**
- Every report definition must declare its tenant filter column or join path. New report sources require deliberate setup.
- Some advanced cross-source aggregations are constrained to safe joins; complex bespoke SQL is no longer possible from the UI.

## Alternatives Considered

- **Rely on RLS alone.** Rejected: under the platform-admin role, RLS is bypassed; one accidental use of that role in reports leaks everything. Application-layer enforcement is non-negotiable.
- **Ban user-supplied filters and switch to a fully-typed query builder (e.g. Kysely).** Stronger long-term option; prohibitively large refactor for Phase 3. Considered for Phase 5+.
- **Run reports in a separate "reporting" replica with read-only credentials.** Compatible and recommended for performance; doesn't change the leakage surface. Adopt in Phase 5.

## Implementation Notes

- The mandatory tenant clause is the **first** WHERE term, so partition pruning works.
- The query builder uses `Prisma.sql` for SQL composition; identifiers are quoted via a typed helper (`ident('candidates')`); literals via `Prisma.sql\`${value}\``.
- Each `SOURCE_DEFS` entry has the shape:
  ```ts
  {
    key: 'employees_documents',
    rootTable: 'employees',
    tenantColumn: 'tenant_id',     // on rootTable
    joins: [{ table: 'documents', on: 'documents.entity_id = employees.id AND documents.entity_type = $EMPLOYEE AND documents.tenant_id = employees.tenant_id' }],
    fields: { ... },
  }
  ```
- The engine refuses any entry that doesn't declare `tenantColumn` (or, for joined sources, a `tenant_id`-equality condition on every join).
- Per-tenant query budgets enforced via `statement_timeout` set per role.
- Long-running exports run on a worker (BullMQ) with the same engine; the job carries `tenantId`, the engine reads it from ALS via `TenantAwareJobProcessor`.

## Risks

- **A new `SOURCE_DEFS` entry shipped without `tenantColumn`.** Mitigation: startup validation crashes on boot; PR template requires the field; reviewer checklist enforces it.
- **Field-mapping injection.** Mitigation: fields are looked up in a whitelist; unknown keys are rejected with a typed error.
- **User attempts to bypass filter via JSON paths or array operators.** Mitigation: filter operators are an enum, not a string; only listed operators are emitted.
- **RLS bypass on platform-admin role used during a report.** Mitigation: reports always use `TenantPrismaService` (never `PlatformPrismaService`); ESLint forbids the import inside `reports/`.

## Rollback Considerations

- The engine refactor lands behind a flag (`REPORTS_TENANT_FILTER_ENFORCED`); off → legacy behavior. Default `true` after Phase 3 hardening.
- Per-tenant rollouts possible: the engine can early-return `[]` for any tenant whose `SOURCE_DEFS` declarations fail validation, avoiding broken reports without crashing.
- During Phase 3, both legacy and new paths exist for ≤ 2 weeks; then legacy is removed.
