# Phase 2.47 — Attendance Module Audit + Reads-First Pilot

> Audit + reads-first TenantPrisma pilot split for `src/attendance`.
> Default-off; configuration-only rollback; no schema migration.

---

## 1. Module surface

```
backend/src/attendance/
├── attendance.controller.ts   (145 LoC, 11 endpoints)
├── attendance.service.ts      (1278 LoC pre-2.47 / now ~1300)
├── attendance.module.ts
└── dto/attendance.dto.ts
```

## 2. Scope map

### A. Read paths — IN PILOT (Phase 2.47)
| Endpoint | Service method | Tag |
|---|---|---|
| `GET /attendance/employees` | `listEmployeesWithStats` | `phase247-attendance-pilot-scope` |
| `GET /attendance/employees/:id` | `getEmployeeAttendance` | `phase247-attendance-pilot-scope` |

### B. Mutation paths — gated parent only (writes stay on `legacyPrisma`)
| Endpoint | Service method | Tag |
|---|---|---|
| `POST /attendance` | `upsertRecord` | `phase247-attendance-mutation-scope` |
| `POST /attendance/bulk` | `bulkUpsert` | `phase247-attendance-mutation-scope` |
| `POST /attendance/bulk-apply` | `bulkApply` | `phase247-attendance-mutation-scope` |
| `PATCH /attendance/:id` | `updateRecord` | `phase247-attendance-mutation-scope` |
| `DELETE /attendance/:id` | `deleteRecord` | `phase247-attendance-mutation-scope` |

The mutation parent gate (`findEmployeeForMutationOrFail`,
`findRecordForMutationOrFail`) loads the parent through
`pilot.client()` with `scope().tenantWhere()`. With the flag off
`tenantWhere()` returns `{}` so the lookup reduces to plain by-id —
byte-identical to pre-2.47. With the pilot active a cross-tenant id
raises `NotFoundException` BEFORE the legacy mutation runs.

### C. Excluded / deferred
| Path | Reason | Tag |
|---|---|---|
| `GET /attendance/locked-periods`, `POST /attendance/locked-periods`, `DELETE /attendance/locked-periods/:id` | `AttendanceLockedPeriod` is intentionally global — no `tenantId` per schema comment ("Intentionally global for MVP (not per-employee) so one payroll run seals the whole month at once"). | `phase247-attendance-mutation-scope` (annotation only) |
| `GET /attendance/export/excel` | Export bundles many tenants of data; deferring to a later phase that can also stream / paginate. | `phase247-attendance-deferred-export` |
| Audit log emission via `legacyPrisma.auditLog.create` | Routing through `TenantAuditLogService` deferred to the mutation-pilot phase (parity with the Phase 2.33/2.34 split). | `phase247-attendance-audit-log` |

## 3. Tenant join strategy

`AttendanceRecord.tenantId` is **already denormalised** as a nullable
column (Phase 2.3 entity-keyed denorm — see `prisma/schema.prisma:1564`):

```prisma
model AttendanceRecord {
  ...
  // Phase 2.3 entity-keyed denorm.
  tenantId   String?
  @@index([tenantId])
  @@index([tenantId, date])
}
```

Therefore the pilot does **not** need to join through `Employee` — it
applies `tenantWhere() === { tenantId }` directly to both the parent
`Employee` lookup and the child `AttendanceRecord` query. Both
gates are in place because:
- Filtering only the parent leaves the door open to child rows whose
  `tenantId` mismatches (defence-in-depth).
- Filtering only the child would still leak parent metadata.

NULL-tenant legacy `AttendanceRecord` rows are **excluded** in pilot
mode (the equality predicate `tenantId = <active>` is exclusive of
NULL). With the flag off they remain visible (legacy union).

## 4. Production behaviour change

**None.** With `TENANT_PRISMA_PILOT_ENABLED=false` (default):
- `pilot.client()` returns the legacy `PrismaService`.
- `scope()` is inactive ⇒ `tenantWhere()` returns `{}`.
- All read paths reduce to the original `where` clauses.
- All mutation parent gates reduce to the original by-id lookup.
- `legacyPrisma.notification.create`, `auditLog.create`, lock-period,
  export-excel paths are byte-identical to pre-2.47.

## 5. Equivalence — 12/12 PASS

```
[attendance-equivalence] 12/12 PASS
```

1. pilot disabled returns legacy list shape (`data` + `meta` keys)
2. pilot disabled count matches legacy union (≥ 2 employees)
3. pilot enabled response shape preserved
4. pilot enabled list ⊂ legacy union
5. date-range filter equivalent (legacy ≥ pilot, both > 0)
6. employee filter works for same-tenant employee under pilot
7. pagination shape preserved (`page=1, limit=1`)
8. mutation shape preserved (`upsert` returns `id + employee`)
9. allow-list unset ⇒ all modules allowed
10. allow-list `attendance` allows attendance, denies others
11. allow-list comma-separated allows both
12. allow-list `nothing` ⇒ scope inactive (legacy reading restored)

## 6. Isolation — 12/12 PASS

```
[attendance-isolation] 12/12 PASS
```

1. tenant A list returns only tenant A employees
2. tenant A `getEmployeeAttendance` for tenant B employee raises `NotFound`
3. tenant A reads do NOT see NULL-tenant legacy attendance row
4. tenant A summary counts only tenant A records
5. tenant A date-range list excludes tenant B
6. employee filter rejects tenant B employee (NotFound)
7. tenant A `updateRecord` on tenant B record id raises `NotFound` (no mutation)
8. tenant B row unchanged after rejected mutation
9. create under tenant A returns id + employee (tenant A linkage via existing denorm)
10. tenant A `bulkApply` for tenant B employee raises `NotFound`
11. concurrent ALS frames remain isolated
12. allow-list `nothing` ⇒ NULL-tenant row visible (legacy union)

## 7. Rollback runbook

```sh
TENANT_PRISMA_PILOT_ENABLED=false           # disables pilot probe
# OR
TENANT_PRISMA_PILOT_MODULES=nothing         # disables attendance pilot only
# OR remove "attendance" from the allow-list and keep other modules.
```

No data, no schema migration introduced. Configuration-only rollback.

## 8. Remaining blockers / next phase

- **Mutation phase**: stamp `tenantId` on `AttendanceRecord.create` /
  `upsert` from ALS frame instead of relying on the existing entity-
  keyed denorm trigger. Route audit emission through
  `TenantAuditLogService`.
- **Excel export phase**: stream + paginate; apply tenant predicate
  to `employee.findMany` and `attendanceRecord.findMany` inside the
  pilot client.
- **Locked period scoping**: today global; a future product phase may
  introduce per-tenant locks (requires schema change).

---

# Phase 2.48 addendum — Attendance mutation pilot

## A. Tenant stamping on mutations
`upsertRecord` now spreads `scope().tenantData()` into the
`create:` branch of the upsert. With pilot ON + ALS tenant attached,
new rows are stamped `tenantId = <active>`. With pilot OFF
`tenantData()` returns `{}` so the create is byte-identical to
pre-2.48. Update / delete reuse the Phase 2.47 parent gate
(`findRecordForMutationOrFail`) which already filters by
`tenantWhere()` — they cannot see, mutate, or delete a row
belonging to another tenant. Tag: `phase248-attendance-mutation-pilot`.

## B. Audit routing
`auditLog` now writes through `TenantAuditLogService.write(...)`
instead of `legacyPrisma.auditLog.create({...})`. With
`TENANT_AUDIT_LOG_PILOT_ENABLED=false` (default) the audit row is
emitted with no `tenantId` (legacy / NULL-tenant compatible). With
the audit pilot ON and an active ALS tenant, the row carries
`tenantId = <active>`. Rejected (NotFound) mutations short-circuit
BEFORE `auditLog` is called, so no audit row is emitted for a
denied cross-tenant attempt. Tag: `phase248-attendance-audit-log-pilot`.

## C. exportExcel
`exportExcel` now applies `scope().tenantWhere()` to the parent
`Employee` lookup AND to the bulk `attendanceRecord.findMany` that
populates the workbook. Under tenant A, an `employeeId = empB`
export request raises `BadRequestException('No employees found ...')`
because the employee lookup is filtered to tenant A's set. With the
flag off, behaviour is byte-identical legacy. Tag:
`phase248-attendance-export-scope`.

## D. Lock periods
Unchanged. `AttendanceLockedPeriod` has no `tenantId` column and is
intentionally global per the schema comment. The four lock-related
sites are re-tagged `phase248-attendance-lock-deferred` so that the
deferral is explicit at the source. A future product phase can
introduce per-tenant locks via schema migration.

## E. Harness — `attendance-mutation-isolation` 17/17 PASS

```
[attendance-mutation-isolation] 17/17 PASS
```

1. pilot off legacy create: tenantId NULL
2. pilot A create stamps tenantId = A
3. pilot A create for tenant B employee: NotFound
4. rejected create produces no row
5. tenant A update on tenant A row: success
6. tenant A update on tenant B row: NotFound
7. tenant B row unchanged after rejected update
8. tenant A delete on tenant A row: success
9. tenant A delete on tenant B row: NotFound
10. tenant B row unchanged after rejected delete
11. bulkApply tenant A creates rows tagged tenant A
12. bulkApply tenant B emp rejected; no rows created
13. NULL-tenant legacy row not mutated under pilot
14. concurrent ALS frames stamp correct tenantId per frame
15. audit row tenant A mutation carries tenantId=A (audit pilot ON)
16. rejected tenant B mutation does not emit audit row
17. exportExcel tenant A refuses tenant B employee

## F. Rollback
```sh
TENANT_PRISMA_PILOT_ENABLED=false           # disable mutation stamping + parent gate + export gate
# OR
TENANT_AUDIT_LOG_PILOT_ENABLED=false        # disable tenantId on audit rows (legacy)
# OR
TENANT_PRISMA_PILOT_MODULES=nothing         # disable attendance pilot only
```

---

# Phase 2.49 addendum — AttendanceLockedPeriod tenant scoping

The lock table now carries a nullable `tenantId` column with a
composite `@@unique([tenantId, year, month])`. A partial unique
index `(year, month) WHERE tenantId IS NULL` preserves the legacy
"one global lock per (year, month)" invariant.

Lock APIs (`lockPeriod`, `unlockPeriod`, `listLockedPeriods`,
`isPeriodLocked`) are tenant-scoped when the pilot is active and
fall back to NULL-tenant lookups when the pilot is off — so legacy
deployments remain byte-identical. Mutation paths inherit the
tenant-aware lock check via `assertPeriodUnlocked`.

Tags: `phase249-attendance-lock-period-tenant-scope`,
`phase249-attendance-lock-period-migration`,
`phase249-attendance-lock-period-backfill`.

Real-DB: `attendance-lock-period-isolation` 13/13. Cumulative:
**557/557**. See `SAAS_PHASE2_ATTENDANCE_LOCK_PERIOD_TENANT_SCOPE.md`
for schema, backfill strategies, and rollback runbook.

---

# Phase 2.50 addendum — Historic audit-log tenant backfill

A one-shot, dry-run-first script
(`scripts/saas/phase2/attendance-audit-backfill.ts`) backfills
`audit_logs.tenantId` for historic NULL-tenant rows where
`entity = 'AttendanceRecord'` and the joined
`attendance_records.tenantId` is non-NULL. Default-OFF; refuses
apply unless `ATTENDANCE_AUDIT_BACKFILL_APPLY=true` AND the runtime
classifies as SAFE_CLONE/SAFE_STAGING.

Tag: `phase250-attendance-audit-backfill`.

Real-DB harness: 13/13. Cumulative: **570/570**. See
`SAAS_PHASE2_ATTENDANCE_AUDIT_BACKFILL.md` for the full eligibility
matrix and rollback guidance.
