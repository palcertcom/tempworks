# Phase 2.16 — Finance Module Audit

> A coin only counts when it lands in the right hand.
>
> Inventory of every Prisma touchpoint in `src/finance` plus the
> read/write split that drives the Phase 2.16 reads-first pilot.

---

## 1. Module surface

| File | Role | Lines |
|------|------|------:|
| `src/finance/finance.service.ts` | business logic, every Prisma site | 1118 |
| `src/finance/finance.controller.ts` | HTTP surface (no DB) | 250 |
| `src/finance/finance.module.ts` | Nest module wiring | 25 |
| `src/finance/dto/*.ts` | request/response shapes | n/a |

Total Prisma sites in service: **32** (9 read-path, 23 write/mutation/helper).

## 2. Read-path sites — pilot scope

These nine sites narrow with `scope.tenantWhere()` when the pilot is
active. Annotation tag: `phase216-pilot-scope`.

| # | Method | Operation | Tenant filter |
|--:|--------|-----------|---------------|
| 1 | `findAll`        | `financialRecord.findMany`  | `where.tenantId` (pilot)
| 2 | `findAll`        | `financialRecord.count`     | same `where`
| 3 | `getTotals`      | `financialRecord.aggregate` | `where.tenantId`
| 4 | `getPersonRecords` | `applicant.findFirst`     | id + `tenantId`
| 5 | `getPersonRecords` | `employee.findFirst`      | id + `tenantId`
| 6 | `getPersonRecords` | `financialRecord.findMany`| `applicantId` + `tenantId`
| 7 | `getPersonRecords` | `financialRecord.aggregate` | same
| 8 | `findOne`        | `financialRecord.findFirst` | id + `tenantId`
| 9 | `getHistory`     | `financialRecord.findFirst` | id + `tenantId` (parent existence check)

`findOne` and `getHistory` switched from `findUnique` to `findFirst`
so the additional `tenantId` predicate can be added without changing
the row-by-id legacy semantics.

## 3. Read-path sites — global / audit

| Method | Operation | Annotation | Reason |
|--------|-----------|------------|--------|
| `listTransactionTypes` | `financeTransactionType.findMany` | `phase216-global` | catalog table; tenantless by design |
| `getHistory` | `auditLog.findMany` | `phase216-audit-log` | global audit log; parent already tenant-checked |

## 4. Write/mutation sites — explicitly legacy

These 11 sites stay on `legacyPrisma` for Phase 2.16. Annotation
tag: `phase216-excluded-mutation`.

| Method | Operation |
|--------|-----------|
| `create`         | `financialRecord.create` |
| `update`         | `financialRecord.update` |
| `updateStatus`   | `financialRecord.update` (×2) |
| `addDeduction`   | `financialRecord.update` |
| `removeDeduction`| `financialRecord.findUnique`, `financialRecord.update` |
| `addAttachment`  | `financialRecordAttachment.create` |
| `removeAttachment`| `financialRecordAttachment.findFirst`, `financialRecordAttachment.update` |
| `auditLog`       | `auditLog.create` (`phase216-audit-log`) |

## 5. Helper / global sites — legacy with tagged annotation

| Helper | Operation | Annotation |
|--------|-----------|------------|
| `attachEntityNames` | `applicant.findMany` / `employee.findMany` / `agency.findMany` | `phase216-helper-read` |
| `resolvePersonIdentity` | `applicant.findUnique` / `employee.findUnique` / `applicant.findFirst` / `agency.findUnique` | `phase216-helper-read` |
| `resolveEntityNameForNotif` | `applicant.findUnique` / `employee.findUnique` / `agency.findUnique` | `phase216-helper-read` |
| `checkAndNotifyHighBalance` | `systemSetting.findUnique` | `phase216-global` |

The helpers are reads but operate by IDs sourced from already
tenant-filtered records. They could be tightened in a follow-up;
for Phase 2.16 the records they enrich are already tenant-scoped,
so cross-tenant enrichment by ID is structurally improbable.

## 6. Wiring change — `finance.module.ts`

```ts
imports: [NotificationsModule, FeatureFlagsModule],
providers: [FinanceService, TenantPrismaService, PilotPrismaAccessor],
```

The constructor injection signature on `FinanceService` is:

```ts
constructor(
  private readonly legacyPrisma: PrismaService,
  private readonly notifications: NotificationsService,
  private readonly storage: StorageService,
  private readonly pilot: PilotPrismaAccessor,
) {}

private get prisma(): PrismaService { return this.pilot.client(); }
private scope(): PilotScope { return getPilotScope(this.pilot, 'finance'); }
```

`this.prisma` is the pilot-aware client and is used **only** for
read paths. Mutation paths use `this.legacyPrisma` directly.

## 7. Schema dependency

`FinancialRecord.tenantId` was denormed in Phase 2.3 with
`@@index([tenantId])` and `@@index([tenantId, transactionDate])`.
No schema change in Phase 2.16.

## 8. Out-of-scope — Phase 2.17+

- Mutation paths (`create` etc.) need a tenant pre-check + `tenantId`
  spread into `data`. Will be the Phase 2.17 reads-then-writes split.
- Helper enrichment narrowing (`attachEntityNames` et al).
- Audit log tenancy (deferred to a cross-module audit phase).
- Cross-entity reassignment via `update({ entityType, entityId, ... })`
  needs explicit tenant validation.
