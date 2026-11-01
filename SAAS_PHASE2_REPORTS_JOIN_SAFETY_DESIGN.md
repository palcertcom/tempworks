# Phase 2.4 — Reports Join Safety Design

> Joins are where tenant leaks hide. Make every join show its passport.

This document specifies the structural representation of joins in the
tenant-safe reports runtime, the validator rules that protect them at
boot, and the composer rules that render them at request time.

---

## 1. Goals

1. Every multi-table source carries enough structure that the boot
   validator can prove tenant equality WITHOUT regex on free-form SQL.
2. Composer renders joins deterministically; no operator-supplied SQL
   reaches the join clause.
3. Catalog (global reference) tables are the only joins exempt from
   tenant equality, and only via an explicit allow-list.
4. The new structure does NOT replace the legacy free-form `on: string`
   form — the dormant Phase 2.1/2.3 single-table sources keep that
   field, but the validator-enforced `joinHasTenantEquality` regex
   still fires there. Phase 2.4 sources MUST use the structural form.

## 2. Types

`backend/src/saas/reports/source-def.types.ts`:

```ts
export type JoinKind = 'tenant-equality' | 'catalog';

export interface StructuredJoinOn {
  fk:         { leftAlias: string; leftCol: string; rightAlias: string; rightCol: string };
  tenant?:    { leftAlias: string; leftCol: string; rightAlias: string; rightCol: string };
  literals?:  { alias: string; col: string; literal: string }[];
  nullChecks?:{ alias: string; col: string }[];
}

export interface JoinDef {
  joinType: 'LEFT' | 'INNER';
  table: string;
  alias: string;
  kind?: JoinKind;                 // default 'tenant-equality'
  structuredOn?: StructuredJoinOn; // preferred, Phase 2.4+
  on?: string;                     // legacy fallback
}
```

The composer renders structuredOn as:

```
<fk.leftAlias>.<fk.leftCol> = <fk.rightAlias>.<fk.rightCol>
[AND <tenant.leftAlias>.<tenant.leftCol> = <tenant.rightAlias>.<tenant.rightCol>]
[AND <literals[i].alias>.<literals[i].col> = '<literals[i].literal>']
[AND <nullChecks[i].alias>.<nullChecks[i].col> IS NULL]
```

## 3. Validator rules

`backend/src/saas/reports/source-registry.ts` and
`backend/src/saas/reports/join-builder.ts`:

| Rule | Mechanism |
|------|-----------|
| `joinType` ∈ {LEFT, INNER} | `ALLOWED_JOIN_TYPES` set |
| Alias collision forbidden | tracked across joins via `aliasesSoFar` |
| Each join's edge references one new alias and one known alias | `assertEdge()` in renderer |
| Every literal matches `^[A-Z][A-Z0-9_]*$` | `assertLiteral()` |
| Every identifier matches `^[a-zA-Z_][a-zA-Z0-9_]*$` | `colRef`, `ident` |
| `kind: 'catalog'` requires table ∈ `CATALOG_TABLES` | `sql-guards.ts` allow-list |
| `kind: 'tenant-equality'` (default) REQUIRES tenant edge in structuredOn | renderer throws if missing |
| Legacy `on: string` MUST contain `<a>.tenant_id = <b>.tenant_id` (camelCase or snake_case) | `joinHasTenantEquality()` |

Invariant: `validateAll()` returns 0 errors for every source the
runtime ships as READY. If a future change breaks this, the boot path
refuses to start.

## 4. Composer rules

`backend/src/saas/reports/runtime/compose-sql.ts`:

- Joins are rendered through `renderJoin()` with a running set of known
  aliases starting at `{primaryAlias}`. Each rendered alias is added so
  later joins can reference it.
- The `WHERE` clause comes from `buildTenantSafeWhere()` and ALWAYS
  starts with `<primaryAlias>.<tenantColumn> = $1`. Joined aliases get
  their tenant equality term inside the join's ON, never the WHERE.
- `ORDER BY` is rendered only when `req.sort` (or `def.defaultSort`) is
  provided; both must reference a known field, and the field must be
  in `def.sortFields` if that list is set.
- `LIMIT` and `OFFSET` are integers, clamped to `[1, 10_000]` and
  `[0, ∞)`. They are inlined as integers, never user-supplied SQL.
- `def.allowedFilterFields` (when set) gates user filters to a subset.
  `def.exportFields` (when set) gates the SELECT-list.

## 5. Forbidden join patterns

Refused at validation time (with the rule name from `SourceValidationError.rule`):

- `joinType` outside `LEFT|INNER` → `invalid-join-type`
- Two joins sharing an alias → `duplicate-join-alias`
- Edge referencing an alias not yet in scope → `unknown-join-alias-reference`
- `kind: 'catalog'` on a non-allow-listed table → `catalog-table-not-allowed`
- Literal containing characters outside `[A-Z][A-Z0-9_]*` → `invalid-literal`
- `kind: 'tenant-equality'` (default) without a tenant edge in structuredOn → `tenant-equality-missing-from-structured-join`
- Legacy `on: string` without a tenant equality regex hit → `join-missing-tenant-equality`

Refused at composer time:

- Sort field not in `def.sortFields` (when list is set)
- Filter on field not in `def.allowedFilterFields` (when list is set)
- Export column not in `def.exportFields` (when list is set)

## 6. Platform-admin bypass

The engine bypasses the tenant filter ONLY for sources marked
`platformAdminOnly: true`, AND ONLY when the request is coming from a
platform admin. There is currently NO source in the registry with
`platformAdminOnly: true`. The isolation harness logs the list at the
end of every run so the audit trail captures any future addition.

When such a source is added, the join-builder's contract still holds:
joins must declare tenant equality. The platform-admin path skips the
WHERE-side `<primaryAlias>.tenantColumn = $1` term but does NOT skip
the join-side tenant equality. A platform admin reading
`employees_documents` still sees only documents whose `tenantId` equals
the parent employee's `tenantId` — same row safety, just across all
tenants.

## 7. Strict parameter ordering

The composer is the single owner of parameter binding. Order:

1. `$1` = `tenantId` (always)
2. `$2…$k` = agency UUIDs (when `def.agencyColumn` and ctx has `agencyIds`)
3. `$k+1…$N` = user-filter values, in the order the filters were supplied

`buildTenantSafeWhere` is the only producer of the WHERE clause and
emits the parameters in this order. The composer never injects
parameters in the JOIN clause — joins are pure DDL fragments.

## 8. Boot validation

The dormant runtime's boot validator (Phase 3 cutover) registers every
READY source and calls `assertAllValid()`. If any rule is violated, the
process refuses to boot. Phase 2.4 confirms this for the 17 READY
sources via the `saas:validate` suite (boot validator equivalent runs
in tests).

## 9. Open questions / not-in-scope

- `ORDER BY` on a joined column (e.g. sort employees_documents by
  `docExpiryDate`) is supported, but it does NOT push parents that have
  no matching child to the front — the LEFT JOIN's NULL child rows sort
  by NULL semantics. Operators who care about parent-only ordering
  must use a primary-table sort field.
- Multi-direction sort (a, b DESC) is not yet exposed. Callers can
  pass a single `{field, direction}` per request. Future work.
- The catalog allow-list contains only `document_types`. Any addition
  requires `SAAS_PHASE2_CATALOG_SOURCES_DECISION.md` updates and a
  schema check that the new table genuinely has no `tenantId`.
