# Phase 2.47 — Attendance Pilot Results

> Reads-first TenantPrisma pilot for `src/attendance` plus mutation
> parent-gate. Default-off; configuration-only rollback.

## Module status

| Aspect | Status |
|---|---|
| Read paths under pilot | 2/2 (`listEmployeesWithStats`, `getEmployeeAttendance`) |
| Mutation parent gate | 4 sites (`upsertRecord`, `bulkApply`, `updateRecord`, `deleteRecord`) |
| Excel export | deferred (`phase247-attendance-deferred-export`) |
| Audit emission | unchanged (`legacyPrisma.auditLog.create`) |
| Locked-period table | unchanged (intentionally global) |
| Schema migration | none |
| Production behaviour change with flags off | none |

## Harness results — confirmed against `saas_phase1_fixture` (Phase 2.47B)

```
[attendance-equivalence] 12/12 PASS
[attendance-isolation]   12/12 PASS
```

## Cumulative regression chain — confirmed real-DB

Phase 2.47 adds 24 cases to the cumulative chain:
**527/527 PASS** (was 503/503 after Phase 2.46).

Sentinels re-run green:
- notifications-internal-scan-dedup 13/13
- notifications-dedup 12/12
- compliance-scheduler-health 12/12
- compliance-notification-coupling 12/12
- notifications-equivalence 11/11
- notifications-isolation 10/10
- compliance-equivalence + compliance-isolation
- audit-log-tenancy 8/8
- agencies-mutation-isolation 9/9
- employees-mutation-isolation 12/12
- applicants-mutation-isolation 11/11
- finance-mutation-isolation 16/16
- documents-mutation-isolation 9/9
- vehicles-isolation 10/10
- workflow-mutation-isolation 11/11

## Rollback

```sh
TENANT_PRISMA_PILOT_ENABLED=false
# OR
TENANT_PRISMA_PILOT_MODULES=nothing
```

No data, no schema migration introduced.

## Recommended next phase

- **2.48 — Attendance mutation pilot**: route `AttendanceRecord.create`
  / `upsert` writes through a tenant-stamping helper, route audit
  emission through `TenantAuditLogService`, and apply tenant
  predicate to the Excel export queries.

---

# Phase 2.48 results — mutation pilot

## Module status (post-2.48)

| Aspect | Status |
|---|---|
| Read paths under pilot | unchanged (12/12 equivalence + 12/12 isolation) |
| Mutation tenant stamping | `upsertRecord` create-branch spreads `tenantData()` |
| Mutation parent gate | unchanged (Phase 2.47) |
| Audit emission | routed through `TenantAuditLogService.write` |
| `exportExcel` | gated via `scope().tenantWhere()` on employee + records |
| `AttendanceLockedPeriod` | unchanged (intentionally global; tagged `phase248-attendance-lock-deferred`) |
| Schema migration | none |
| Production behaviour change with flags off | none |

## Real-DB harness results (`saas_phase1_fixture`)

```
[attendance-mutation-isolation] 17/17 PASS
[attendance-equivalence]        12/12 PASS  (regression sentinel)
[attendance-isolation]          12/12 PASS  (regression sentinel)
```

## Cumulative regression chain

Phase 2.48 adds 17 cases on top of Phase 2.47:
**544/544 PASS** (was 527/527 after 2.47B).

## Rollback

```sh
TENANT_PRISMA_PILOT_ENABLED=false           # disables stamping + parent gate + export gate
# OR
TENANT_AUDIT_LOG_PILOT_ENABLED=false        # disables tenantId on audit rows only
# OR
TENANT_PRISMA_PILOT_MODULES=nothing         # opts attendance out only
```

## Recommended next phase

**2.49 — Lock periods tenant scoping (schema change)**: introduce a
`tenantId` column on `AttendanceLockedPeriod` and unique-by
`(tenantId, year, month)` so per-tenant payroll locks become
possible. Requires a Prisma migration and a backfill plan for
existing global rows.

---

# Phase 2.49 results — lock-period tenant scoping

```
[attendance-lock-period-isolation] 13/13 PASS
[attendance-mutation-isolation]    17/17 PASS  (regression)
[attendance-equivalence]           12/12 PASS  (regression)
[attendance-isolation]             12/12 PASS  (regression)
```

Cumulative regression: **557/557 PASS**.

Schema migration: `prisma/migrations/saas_phase249_attendance_locked_period_tenant/`
(idempotent, reversible). Adds `tenantId` column, replaces global
`(year, month)` unique with `(tenantId, year, month)`, plus a
partial unique on `(year, month) WHERE tenantId IS NULL` to keep
the legacy global invariant.

Production behaviour change: none with flags off; lock APIs continue
to read/write NULL-tenant rows.

## Recommended next phase

2.50 — historic audit-row tenant backfill pass for the attendance
entity now that mutation/lock paths emit `tenantId` natively.

---

# Phase 2.50 results — historic audit-log tenant backfill

```
[attendance-audit-backfill-harness] 13/13 PASS
[attendance-lock-period-isolation] 13/13 PASS  (regression)
[attendance-mutation-isolation]    17/17 PASS  (regression)
[attendance-equivalence]           12/12 PASS  (regression)
[attendance-isolation]             12/12 PASS  (regression)
```

Cumulative regression: **570/570 PASS**.

No schema migration. No runtime production behaviour change.
Apply mode is double-gated (`ATTENDANCE_AUDIT_BACKFILL_APPLY=true`
+ SAFE_CLONE/SAFE_STAGING).

## Recommended next phase

**2.51 — Cross-module audit-row tenant backfill** (Document,
FinancialRecord, WorkPermit, Visa, ComplianceAlert, Notification)
following the Phase 2.50 template.
