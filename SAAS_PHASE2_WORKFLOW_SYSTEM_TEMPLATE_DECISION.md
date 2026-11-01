# Phase 2.26 — Workflow System Template Decision

> Templates are the rulebook. Are there one rulebook for the
> world, one per tenant, or a global default with tenant
> overrides?

---

## 1. Current state

`prisma/schema.prisma`:

```prisma
model StageTemplate {
  id                    String           @id @default(uuid())
  name                  String           @unique           // ← global unique
  order                 Int
  description           String?
  color                 String           @default("#2563EB")
  category              WorkflowCategory @default(INITIAL)
  isActive              Boolean          @default(true)
  requirementsDocuments String[]         @default([])
  requirementsActions   String[]         @default([])
  requirementsApprovals String[]         @default([])
  ...
  // NO tenantId column
  @@map("stage_templates")
}
```

Three signals say **GLOBAL CATALOG**:
- `name @unique` (no tenant qualifier).
- No `tenantId` column.
- The seed data ships a single ordered list of stages
  (`Application`, `Background Check`, `Onboarding`, …) used by
  every tenant.

Same shape as `MaintenanceType` and `Workshop` (vehicles 2.23)
and `DocumentType` / `DocumentTypePermission` (documents 2.20):
all treated as global catalog.

## 2. Options analyzed

### Option A — Pure global (current)

All tenants share the same stage catalog. A System Admin can add
a new stage; it appears for every tenant.

- ✅ Simplest. No schema change. No migration.
- ✅ Reports + cross-tenant rollups work without remapping.
- ❌ Cannot offer tenant-specific stages (e.g. "Compliance
  audit (acme)").

### Option B — Pure per-tenant

Drop `name @unique`, add `tenantId String @unique([tenantId, name])`.
Every tenant gets their own copy.

- ✅ Maximum flexibility per tenant.
- ❌ Schema migration: drop global unique, add composite unique.
  Backfill: clone the existing catalog into every tenant.
- ❌ `EmployeeStage.stageId` FKs need to point at the new
  per-tenant copies.
- ❌ System Admin "edit one stage" UX no longer makes sense.

### Option C — Hybrid: global default + tenant overrides

Add `tenantId String?` on `StageTemplate` (NULL = global default;
non-NULL = tenant override). Resolver prefers tenant-specific row
over global. `EmployeeStage.stageId` may point at either.

- ✅ Allows custom tenant stages without breaking the global
  catalog.
- ✅ Existing rows stay tenant-less and remain visible to all.
- ❌ Resolver complexity: every read needs a "global OR my-tenant"
  predicate.
- ❌ Order/category collisions across global + tenant rows.
- ❌ Schema change + composite unique on `(tenantId, name)` with
  tenantId nullable → still unique-able via partial index.

## 3. Phase 2.26 decision

**Option A — pure global catalog.** Phase 2.26 treats
`StageTemplate` as a global catalog with explicit
`phase226-global` annotations on every read:

```ts
this.prisma.stageTemplate.findMany(...) // @tenant-reviewed: phase226-global
```

Rationale:
- Smallest change. No schema migration. No data backfill.
- Matches `MaintenanceType` / `Workshop` / `DocumentType`
  precedent across other modules.
- Phase 2.26 is reads-first; introducing per-tenant templates
  needs product input AND mutation pilot work AND clone
  semantics, none of which are in scope.

`StageTemplate.name @unique` stays globally unique. Two tenants
cannot create stages with the same name today — same as
vehicles' `registrationNumber`.

## 4. What Phase 3 must decide

If product wants per-tenant custom stages, Phase 3 must:

1. **Pick option B or C.**
2. **Schema migration**:
   - Add `tenantId String?` (Option C) or `String NOT NULL`
     (Option B).
   - Add composite `@@unique([tenantId, name])` (Option C with
     a partial index for NULL tenantId, OR Option B without
     NULL handling).
   - Drop `@unique` on `name` alone.
3. **Backfill**:
   - Option B: clone catalog per tenant; rewrite every
     `EmployeeStage.stageId` to point at the new per-tenant copy.
     This is invasive.
   - Option C: leave existing rows tenant-less; new tenant-
     specific rows added on demand.
4. **Resolver**:
   - Option B: trivial (FK already per-tenant).
   - Option C: every read needs `where: { OR: [{ tenantId: null }, { tenantId: ALS }] }`
     and a deduplication step (tenant override wins).
5. **Mutation API**:
   - Tenants can create their own stages.
   - System Admin can mark a tenant override as "promoted to
     global" (or the inverse).

Until product input arrives, **Phase 2 commits to Option A**.

## 5. Visibility rules in Phase 2.26

| Caller | StageTemplate visibility |
|--------|--------------------------|
| Tenant A reading `getStages` | sees the global catalog (same rows as tenant B) ✓ |
| Tenant B reading `getStages` | sees the global catalog (same rows as tenant A) ✓ |
| `getOverview` per-stage counts | each stage shows tenant A's counts only when ALS=A; tenant B's counts only when ALS=B |
| `getStageDetails` applicant/employee lists | scoped to active tenant ✓ |

The catalog is the same; the runtime data per stage is per-tenant.

## 6. Tests in Phase 2.26 isolation harness

- Both tenants see the same `getStages` rows (catalog identity).
- Both tenants see different per-stage counts (`getOverview`).
- `getStageDetails` applicants/employees are tenant-scoped.
- `getTimeline(tenantB-employee-id)` from tenant A raises 404.
