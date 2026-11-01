# Phase 2.24 — Vehicles Registration Number Safety Review

> The plate is the vehicle's name. Two tenants cannot share a name
> until the schema agrees.

---

## 1. Current uniqueness

`prisma/schema.prisma`:

```prisma
model Vehicle {
  id                  String        @id @default(uuid())
  registrationNumber  String        @unique
  ...
}
```

`registrationNumber` is **globally `@unique`** today. The DB has a
single unique index covering all tenants' vehicles.

## 2. Why this is the right choice for Phase 2.24

The pilot reads-first split (Phase 2.23) and the mutation pilot
(this phase) both add `tenantId` filtering on read paths and
`tenantData()` spread on create paths. They do NOT change the
underlying uniqueness invariant.

If Phase 2.24 attempted to allow two tenants to register the same
plate number, it would require:

- dropping the global `@unique` index,
- adding a composite `@@unique([tenantId, registrationNumber])`
  index,
- a data migration (no two existing rows currently collide, but
  the migration tooling must verify),
- updating every callsite that today assumes globally-unique
  plates,
- coordinating with downstream report consumers.

That is a **schema change with a migration** — explicitly out of
scope per the Phase 2.24 strict rules ("Do not change
registration-number uniqueness behavior").

## 3. Collision risks during SaaS migration

Today's data: every plate is unique. No two tenants share a
plate by accident because the DB enforced uniqueness when the
rows were inserted.

Future risk: a tenant that genuinely owns a plate that another
tenant already has cannot enter their data without the schema
change. Operators encountering this will see a `P2002` Prisma
unique-constraint violation on `Vehicle.registrationNumber`.

For Phase 2.24, this is the desired behaviour — the tenant that
"already has" the plate keeps it; the second tenant's create
fails loudly. The mutation harness asserts this.

## 4. Why Phase 2.24 must not change uniqueness

- The strict rules forbid it.
- The schema change requires migration tooling, downstream report
  audits, and product input.
- Without per-tenant uniqueness, `createVehicle` for an existing
  plate will hit the unique constraint regardless of pilot mode.
  Both modes fail the same way — **byte-identical to pre-2.24**.
- Production behaviour MUST remain unchanged.

## 5. Phase 3 transition plan (PRODUCT)

When the product team decides per-tenant uniqueness is desired:

### 5.1 Schema migration

```sql
-- Step 1: add the composite index alongside the existing one
CREATE UNIQUE INDEX CONCURRENTLY "vehicles_tenantId_registrationNumber_key"
  ON vehicles ("tenantId", "registrationNumber");

-- Step 2: backfill any NULL tenantIds (Phase 2.3 already did this for
-- live tenants; double-check fixture / test data).

-- Step 3: drop the global unique
DROP INDEX CONCURRENTLY "vehicles_registrationNumber_key";

-- Step 4: schema.prisma:
-- - remove `@unique` from `registrationNumber`
-- - add `@@unique([tenantId, registrationNumber])`
```

### 5.2 Application changes

- `createVehicle` and `updateVehicle` already operate inside an
  ALS frame in pilot mode. The composite unique requires no code
  change.
- Any callsite that reads `Vehicle.registrationNumber` as a global
  identifier (e.g. exports, search) must be re-audited to ensure
  the per-tenant scope is sufficient.
- Cross-tenant duplicate-plate alerts for fleet managers (if a
  product feature) need a new platform-admin-scoped query.

### 5.3 Migration verification

The Phase 1 reconciliation harness (`saas:phase1-reconciliation`)
already audits `unique-fields-per-tenant` invariants. A new
reconciliation rule for `vehicles.registrationNumber` would gate
the schema change.

## 6. Implication for Phase 2.24 isolation testing

The mutation isolation harness tests that:

- `createVehicle` from tenant A with a plate already used by
  tenant B raises a `P2002` unique-constraint violation. **NO
  SILENT OVERWRITE.** This is the desired behaviour for Phase
  2.24.
- The legacy mode shows the same behaviour — no regression.

## 7. Summary

| Aspect | Phase 2.24 | Phase 3+ |
|--------|:----------:|:--------:|
| Global `@unique` on `registrationNumber` | **kept** | dropped |
| Composite `@@unique([tenantId, registrationNumber])` | not added | added |
| Schema migration required | none | yes |
| Cross-tenant plate collision behaviour | DB rejects with P2002 | DB allows distinct rows per tenant |
| Test fixture must avoid collisions | yes | no longer required |

The Phase 2.23/2.24 fixture (`phase223-vehicles-seed.sql`) uses
distinct plates per tenant (`AB-12-A` for A, `CD-34-A` for B) so
the global unique constraint never trips.
