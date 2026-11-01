# Phase 2.4 — Catalog Sources Decision

> Catalog sources are global reference tables with no `tenantId` column.
> They are read-shared across tenants. Any source that joins them must
> use `kind: 'catalog'` so the validator skips the tenant-equality
> requirement for that one join — and ONLY for that one join.

---

## 1. Catalog allow-list

`backend/src/saas/reports/sql-guards.ts`:

```ts
export const CATALOG_TABLES: ReadonlySet<string> = new Set([
  'document_types',
]);
```

Adding a table here requires:

1. Schema audit: confirm the table genuinely has no `tenantId` column
   in the live Prisma schema.
2. Product confirmation: the table is reference data, not user-writable
   per-tenant data.
3. A new section in this document with the rationale.

## 2. Per-table decisions

### `document_types`

- **Classification:** GLOBAL CATALOG.
- **Schema evidence:** `model DocumentType` in `backend/prisma/schema.prisma`
  has no `tenantId` column. Rows are seeded centrally and shared.
- **Source exposure:**
  - DIRECT: `document_types` standalone source is **DISABLED** in
    `TENANT_SAFE_SOURCES`. Direct enumeration of catalog rows from the
    reports surface is not necessary for any tenant-facing report and
    is left disabled until a product use case appears.
  - INDIRECT: accessible via `documents_with_type` and
    `employees_documents_type` using `kind: 'catalog'` joins. Tenant
    isolation is enforced on the parent (`documents`) and propagated to
    the LEFT-joined `document_types` row only as the type metadata for
    a tenant-scoped document.
- **Risk profile:** zero — the catalog is read-only reference data and
  never carries per-tenant rows. A leak is impossible because there is
  no per-tenant content to leak.

### Future candidates (not yet added)

| Table | Decision needed | Owner |
|------|---|---|
| `permissions` | Looks global. Audit pending. | platform |
| `roles` | Mixed: some system, some agency-scoped. Decision pending. | platform + product |
| `countries` (if present) | Global. Audit pending. | platform |

These tables are NOT yet in `CATALOG_TABLES`. Any join attempting
`kind: 'catalog'` against them will be refused by the validator.

## 3. Hybrid catalogs (deferred)

A hybrid catalog has a base set of global rows AND per-tenant overrides.
Examples we considered:

- Localised translations of a global catalog row.
- Tenant-specific aliases over a global enum.

Decision: **deferred**. Hybrid catalogs require a `tenantId NULL =
global, tenantId = X = override` semantic that we have not yet
specified. Until then, hybrid sources stay DISABLED. When the product
team is ready, the structural ON form will gain a third `kind` value
(e.g. `'hybrid-catalog'`) with explicit semantics.

## 4. Operator checklist

When the engine starts, the registry validates that every join with
`kind: 'catalog'` targets a table in `CATALOG_TABLES`. To add a new
catalog table:

1. Edit `sql-guards.ts` — add the table name.
2. Edit this document — add a section with classification + risk.
3. Run `npm run saas:validate` and `npm run saas:phase2-reports-validate`.
4. Add an isolation-harness fixture row to confirm the catalog rows are
   visible to both tenants (positive test) and that joining the catalog
   does not leak per-tenant data (negative test).
