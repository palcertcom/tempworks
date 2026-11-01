# Phase 2.49 — AttendanceLockedPeriod Tenant Scoping

> Adds per-tenant payroll locks to `AttendanceLockedPeriod`.
> Default-off for runtime (pilot flag); the schema migration is
> additive and reversible.

---

## 1. Schema changes

### Old shape (pre-2.49)
```prisma
model AttendanceLockedPeriod {
  id          String  @id @default(uuid())
  year        Int
  month       Int
  ...
  @@unique([year, month])
  @@index([year, month])
  @@map("attendance_locked_periods")
}
```
A global `(year, month)` unique. One lock per month, shared by every
tenant.

### New shape (Phase 2.49)
```prisma
model AttendanceLockedPeriod {
  id          String  @id @default(uuid())
  year        Int
  month       Int
  ...
  tenantId    String?
  @@unique([tenantId, year, month], map: "attendance_locked_periods_tenant_year_month_key")
  @@index([tenantId])
  @@index([year, month])
  @@map("attendance_locked_periods")
}
```

In raw SQL, the migration also creates a partial unique index that
preserves the pre-2.49 invariant for legacy NULL-tenant rows:
```sql
CREATE UNIQUE INDEX "attendance_locked_periods_global_year_month_uq"
  ON "attendance_locked_periods" ("year", "month")
  WHERE "tenantId" IS NULL;
```
This index keeps "one global lock per (year, month)" intact for
NULL-tenant legacy rows even though the composite `@@unique` uses
Postgres NULLS DISTINCT semantics.

## 2. Old vs new uniqueness

| Row shape | Pre-2.49 | Post-2.49 |
|---|---|---|
| `(NULL, year, month)` | unique on `(year, month)` | unique on `(year, month) WHERE tenantId IS NULL` (partial) |
| `(tA, year, month)` vs `(tB, year, month)` | impossible — old unique would conflict | both allowed (composite unique) |
| `(tA, year, month)` duplicate | impossible — both rows would collide on `(year, month)` | rejected by composite unique |

## 3. Backfill strategy

**This phase performs NO data backfill.** Existing global rows are
preserved as-is with `tenantId = NULL`. Production deployments
choose at rollout time:

- **Strategy A — Keep global legacy rows** (default). NULL-tenant
  rows continue to enforce the legacy global lock for tenants that
  have not opted into the pilot. New per-tenant rows are written
  only when `TENANT_PRISMA_PILOT_ENABLED=true` AND ALS tenant attached.
  Recommended for staged rollouts.
- **Strategy B — Backfill per active tenant**. For a deployment that
  flips the pilot ON globally, run a one-shot script that copies
  every NULL-tenant row to every active tenant
  (`(NULL, Y, M) → ∀tA. (tA, Y, M)`) then deletes the NULL row. Tag:
  `phase249-attendance-lock-period-backfill`.
- **Strategy C — Backfill to a default tenant**. For
  single-tenant-per-deployment installs, change every NULL row to
  carry the deployment's tenantId.

Strategy A is the migration default; B and C are additive scripts
the operator opts in to.

## 4. Runtime behaviour

### Pilot OFF (default)
- `lockPeriod` writes a row with `tenantId = NULL` (global, legacy).
- `unlockPeriod` only deletes NULL-tenant rows (cannot accidentally
  remove a per-tenant lock created by a pilot-enabled tenant).
- `listLockedPeriods` returns only NULL-tenant rows.
- `isPeriodLocked(y, m)` checks `(tenantId IS NULL, y, m)`.
- Mutation paths (`upsertRecord`, `updateRecord`, `deleteRecord`,
  `bulkApply`) use `assertPeriodUnlocked` which calls
  `isPeriodLocked` — every legacy mutation continues to honour the
  global lock as before.

### Pilot ON + ALS tenant attached
- `lockPeriod` writes `tenantId = <active>` and refuses if a row
  already exists for `(active, y, m)`.
- `unlockPeriod` only removes a row whose `tenantId = <active>` —
  attempts at cross-tenant or NULL-tenant rows raise `NotFound`.
- `listLockedPeriods` returns rows with `tenantId = <active>` only.
- `isPeriodLocked(y, m)` checks `(tenantId = <active>, y, m)`.
- Mutation paths inherit the tenant-aware lock check, so:
  - tenant A lock blocks tenant A mutation in `(y, m)`,
  - tenant B lock does not block tenant A,
  - NULL-tenant legacy rows do not block tenant A in pilot mode.

## 5. Lock-period mutation effects

| Site | Pilot OFF | Pilot ON |
|---|---|---|
| `lockPeriod` | NULL-tenant row | tenantId = active |
| `unlockPeriod` | match NULL-tenant id only | match `id + tenantId = active` |
| `listLockedPeriods` | NULL-tenant rows | active-tenant rows |
| `isPeriodLocked` | NULL-tenant lookup | active-tenant lookup |

## 6. Harness — `attendance-lock-period-isolation` 13/13 PASS

```
[attendance-lock-period-isolation] 13/13 PASS
```

1. pilot off lockPeriod produces NULL-tenant row
2. pilot A lockPeriod stamps tenantId = A
3. pilot B lockPeriod for SAME (year, month) succeeds independently
4. tenant A `listLockedPeriods` returns only A rows
5. tenant B `listLockedPeriods` returns only B rows
6. tenant A unlock on tenant B row rejected; B row intact
7. tenant B lock (Y, 9) does NOT block tenant A mutation in (Y, 9)
8. tenant A lock blocks tenant A mutation
9. tenant A lock (Y, M) does NOT block tenant B mutation in (Y, 10)
10. NULL-tenant global lock does NOT block tenant A pilot mutation
11. concurrent ALS frames: lock checks isolated
12. unique constraint permits SAME (year, month) across tenants
13. duplicate `(tenantId, year, month)` on same tenant rejected

## 7. Regression — 544 + 13 = 557

All previous attendance harnesses + sentinels remain green:
- `attendance-equivalence` 12/12
- `attendance-isolation` 12/12
- `attendance-mutation-isolation` 17/17
- compliance × 6, notifications × 4, audit-log × 1, applicants/
  conversion × 1, agencies/employees/applicants/finance/documents/
  vehicles/workflow mutation-isolation × 7

**Cumulative: 557/557 PASS.**

## 8. Production behaviour status

With `TENANT_PRISMA_PILOT_ENABLED=false` (default):
- All lock-period reads/writes look up only NULL-tenant rows.
- The schema migration is additive (column added, partial unique
  preserves old invariant). Pre-2.49 callers see byte-identical
  data and behaviour.

## 9. Rollback

### Configuration-only (preferred, instant)
```sh
TENANT_PRISMA_PILOT_ENABLED=false           # disables tenant-aware lock paths
# OR
TENANT_PRISMA_PILOT_MODULES=nothing         # opt attendance out only
```
This restores the pre-2.49 runtime behaviour: lock APIs read/write
NULL-tenant rows. Per-tenant rows already in the table become
invisible to legacy callers but stay in place.

### Schema rollback (only if no per-tenant rows exist)
The down migration drops the `tenantId` column and partial unique
index, and restores the original `(year, month)` unique constraint.
This is **destructive** if any `tenantId IS NOT NULL` rows exist —
those rows would be merged on `(year, month)` and cause unique
violations.

```sh
TENANT_PRISMA_PILOT_ENABLED=false
DELETE FROM attendance_locked_periods WHERE "tenantId" IS NOT NULL;
psql ... -f prisma/migrations/saas_phase249_attendance_locked_period_tenant/migration.down.sql
```

## 10. Remaining blockers

None for the lock-period scope. The denormalised `tenantId` mirrors
the rest of the attendance schema; mutation parent gates already
prevent cross-tenant ids; the partial unique index protects
NULL-tenant legacy invariants.

## 11. Recommended next phase

**2.50 — Cross-module audit row Tenant Resolution.** Now that
attendance audits emit `tenantId` (Phase 2.48) and lock periods are
tenant-scoped (Phase 2.49), we can run a follow-up audit-log
backfill / cleanup pass over historic NULL-tenant rows for the
attendance entity (and the equivalent for other modules) without
breaking the pilot's "with flag off, behaviour byte-identical"
invariant.
