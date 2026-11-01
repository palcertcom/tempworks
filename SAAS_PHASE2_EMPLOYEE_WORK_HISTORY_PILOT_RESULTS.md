# Phase 2.7 — Employee Work History Pilot Results

> First TENANT-SCOPED pilot. Phase 2.6 proved the accessor pattern on a
> GLOBAL module; Phase 2.7 proves it filters and writes `tenantId`
> correctly on a real tenant-scoped module.

---

## 1. Headline

```
build:                                          ✅
prisma validate:                                ✅
saas:validate (6 suites):                       ✅
saas:schema-lint:                                ✅
saas:phase2-ewh-equivalence:                    12/12 cases PASS
saas:phase2-ewh-isolation:                       8/8  cases PASS
saas:phase2-tenantprisma-pilot-equivalence:     13/13 cases PASS  (Phase 2.6 still green)
saas:phase2-tenantprisma-pilot-isolation:        9/9  cases PASS
saas:scan:                                      817 unreviewed (down from 818)
saas:scan:raw-sql:                              baseline unchanged
production defaults:                            all OFF
```

## 2. What was tested

### Equivalence (12/12 PASS)

- `pilotActive` is `false` with the flag OFF, and reports `"pilot ON, env=SAFE_CLONE"` when ON.
- `list(empA)` returns the same intersection of ids in both modes;
  pilot mode additionally **excludes** the seeded NULL-tenant legacy
  row (`...ea999`), legacy mode includes it. This is the documented
  Phase 2.3 contract.
- `listEventTypes()` returns identical row count in both modes
  (catalog is global).
- `findOne(missing-employee)` raises `NotFoundException` in both modes.
- `create()` legacy persists `tenantId=NULL`; pilot persists
  `tenantId=tenantA`.
- `update()` round-trip reflects new description in both modes.
- `remove()` sets `deletedAt` in both modes (soft delete preserved).
- Response shape preserved (`Array<{id, eventType, attachments, ...}>`).

### Isolation (8/8 PASS)

- Pilot ON + tenant A: `list(empA)` returns ONLY tenant A rows; the
  cross-tenant collision row (`...eb001`) does not appear.
- Pilot ON + tenant A: `list(empB)` raises `NotFoundException` —
  cross-tenant employee id is hidden.
- Pilot ON + tenant A: NULL-tenant legacy row (`...ea999`) excluded.
- Pilot ON + tenant A: `create()` persists `tenantId=tenantA`.
- Pilot ON + tenant A: `update()` on tenant B's entry raises
  `NotFoundException`; the row's `description` is unchanged.
- Pilot ON + tenant A: `remove()` on tenant B's entry raises
  `NotFoundException`; the row's `deletedAt` remains `null`.
- Concurrent ALS frames (T_A and T_B) each see only their own rows —
  no context bleed.
- Pilot OFF: legacy path returns rows including the NULL-tenant legacy
  row (no filter).

## 3. Lessons learned

1. **Two helpers, not one.** GLOBAL pilots (`roles`) only needed the
   accessor; tenant-scoped pilots need a per-call scope object that
   carries the active tenant id and exposes spreadable `tenantWhere()` /
   `tenantData()` helpers. Putting both in one place
   (`tenant-pilot-scope.ts`) keeps call sites compact.
2. **Pre-check + mutate-by-id is the safe pattern.** Doing
   `findFirst({ where: { id, employeeId, ...tenantWhere } })` before
   `update({ where: { id } })` is faster than constraining the update
   itself and produces the same security property. The pre-check is
   the audit gate.
3. **Legacy fallback when ALS lacks a tenant.** The pilot scope
   intentionally reports `active=false` with reason "pilot ON but no
   TenantContext in scope" when ALS is empty. This keeps the pilot
   path safe to enable on a partially-deployed staging host: requests
   without context simply use the legacy SQL.
4. **Cross-tenant errors should be 404, not 403.** A foreign tenant's
   resource is *invisible*, not *forbidden*. The pilot does NOT change
   HTTP status codes — `NotFoundException` is what the legacy 404 path
   already throws.
5. **Audit log stays on the legacy `PrismaService`.** Audit writes are
   global, must never block, and would be confusing to attribute to a
   tenant. The service injects `legacyPrisma` separately for that
   single call.
6. **Fixture extension is per-pilot.** Phase 2.6 needed
   `phase26-pilot-extension.sql` (lowercase Roles tables);
   Phase 2.7 needs `phase27-ewh-extension.sql`. Both are idempotent
   and additive. Production has these tables already.

## 4. Pattern reusability

The Phase 2.7 pattern is reusable for any tenant-scoped module that:

- has its own `tenantId` column populated by a Phase 2.3-style backfill
- queries by a parent FK + soft-delete filter today
- accepts that cross-tenant resources present as 404

A future module copy-pastes this skeleton into its service:

```ts
constructor(
  private legacyPrisma: PrismaService,
  private pilot: PilotPrismaAccessor,
  /* ...other deps... */
) {}
private get prisma() { return this.pilot.client(); }
private scope() { return getPilotScope(this.pilot); }

async findX(parentId: string) {
  const scope = this.scope();
  return this.prisma.x.findMany({
    where: { parentId, ...scope.tenantWhere() },
  });
}
```

## 5. Risks before next module

- **Soft-fallback semantics.** When the pilot is ON but ALS lacks a
  tenant, we silently fall back to legacy. That is correct for
  reads; it is dangerous for **creates** because a row would be
  written with `tenantId=NULL` even with the pilot on. Today no caller
  hits this path (the middleware always attaches a tenant when the
  flag profile is on), but a future module's harness should explicitly
  test the "pilot ON, no ALS" create path and confirm it lands a NULL-
  tenant row that the next backfill can reconcile.
- **Composite `where` clauses with `OR`.** The `tenantWhere()` spread
  works when the existing where is AND-only. A query that uses Prisma's
  `OR` would need explicit handling to avoid a tenant filter that's
  OR'd with a wider clause. None of the pilot modules use OR, so this
  is fine for now; document and revisit when we hit a module that does.
- **Bulk operations.** `deleteMany` / `updateMany` should accept the
  `tenantWhere()` spread the same way. The fixture-cleanup path in the
  isolation harness uses this pattern, but no service code does yet.

## 6. Whether the pattern is reusable: yes

The combination of `PilotPrismaAccessor` + `getPilotScope` is reusable
across modules without per-module flags or per-module accessors. Each
new module:

1. Adds `PilotPrismaAccessor` to its module providers.
2. Refactors its service to inject `pilot` and use the
   `private get prisma()` + `private scope()` pattern.
3. Adds a per-module equivalence + isolation harness.
4. Annotates each `this.prisma.*` site with a `@tenant-reviewed: phase27-pilot-scope` (or phase-specific) comment so the scanner shows the module as fully reviewed.

No new flags. No new accessors. The single `TENANT_PRISMA_PILOT_ENABLED`
flag remains the global pilot toggle.

## 7. Next recommended module

`src/compliance` — primarily a read view of `compliance_alerts`. After
Phase 2.3 the table has `tenantId` populated. The service is small
(estimated < 200 lines, ~10 prisma calls), no file/storage interactions,
no broad downstream dependencies. Will be the third pilot.

Backup options if compliance turns out to have unexpected coupling:
`src/job-ads` (single-table with low mutation rate), or splitting
`src/vehicles` reads vs. mutations.

## 8. Production behaviour change status

**Unchanged.** With `TENANT_PRISMA_PILOT_ENABLED=false` (default),
`getPilotScope()` returns `active=false` and both `tenantWhere()` /
`tenantData()` return `{}`. Every legacy SQL is byte-for-byte the same
as before this PR. The legacy `PrismaService` is the only client in
production today.
