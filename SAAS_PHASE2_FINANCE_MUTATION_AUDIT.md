# Phase 2.17 — Finance Mutation Audit

> Every finance mutation method, mapped to its Prisma writes,
> ownership path, cross-tenant risk, and Phase 2.17 disposition.

---

## 1. Method-by-method inventory

### 1.1 `create(dto, actorId)`

- Prisma calls: `legacyPrisma.financialRecord.create`, plus
  `legacyPrisma.auditLog.create`, plus
  `notifications.notifyUsersByRoles` (HTTP-context fanout) and
  `checkAndNotifyHighBalance` (background read+notify).
- Models touched: `FinancialRecord`, `AuditLog`, `Notification` (via fanout).
- Action: CREATE.
- Tenant ownership path: caller-supplied `entityType + entityId`;
  the entity (Applicant / Employee / Agency) carries `tenantId`.
  Today the new record's `tenantId` column is left NULL because the
  service does not write it.
- Required `tenantId` behavior in pilot mode: write
  `tenantId = TenantContext.id` via `scope.tenantData()`.
- Cross-tenant risk: HIGH today (any HTTP caller could pass an
  `entityId` from another tenant; the service does not verify).
  Phase 2.16 read paths already filter by `tenantId`, so a cross-
  tenant create would be invisible to its own tenant's reads. The
  `resolvePersonIdentity` helper does not yet enforce tenant.
- Notification side effects: `notifyUsersByRoles` runs inside the
  HTTP request middleware's ALS frame ⇒ when fanout-tenant-aware
  flags are on, recipients are scoped to the active tenant.
- Rollback risk: stranded record persists if `auditLog.create`
  fails. Same as legacy.
- Phase 2.17: **INCLUDED_NOW** — pilot-mode write of `tenantId`.

### 1.2 `update(id, dto, actorId)`

- Prisma calls: `findOne(id)` (tenant-scoped in pilot mode),
  `legacyPrisma.financialRecord.update({ where: { id } })`,
  `legacyPrisma.auditLog.create`, `notifyUsersByRoles`.
- Models touched: `FinancialRecord`, `AuditLog`, `Notification`.
- Action: UPDATE.
- Tenant ownership path: `findOne(id)` returns 404 in pilot mode
  for a cross-tenant id ⇒ the by-id `update` never executes.
- Required `tenantId` behavior: no change to row tenancy.
- Cross-tenant risk: NONE in pilot mode after Phase 2.16
  (`findOne` is tenant-scoped). LOW in legacy (existing behavior).
- Notification side effects: as above.
- Rollback risk: low.
- Phase 2.17: **INCLUDED_WITH_GUARD** — pre-check via tenant-scoped
  `findOne` is the tenant gate; annotate the by-id update site.

### 1.3 `remove(id, actorId)`

- Prisma calls: `findOne(id)`,
  `legacyPrisma.financialRecord.update({ where: { id }, data: { deletedAt } })`,
  `auditLog`, `notifyUsersByRoles`.
- Action: SOFT DELETE.
- Same tenant gate as `update`. Pilot mode safe via `findOne`.
- Phase 2.17: **INCLUDED_WITH_GUARD**.

### 1.4 `updateStatus(id, dto, actorId)`

- Prisma calls: `findOne(id)`,
  `legacyPrisma.financialRecord.update({ where: { id } })`,
  `auditLog`, conditional `notifyUsersByRoles`.
- Action: UPDATE (status + deduction aggregates).
- Same tenant gate as `update`. Recalculates deduction
  aggregates inline.
- Phase 2.17: **INCLUDED_WITH_GUARD**.

### 1.5 `addDeduction(recordId, dto, actorId)`

- Prisma calls: `findOne(recordId)`,
  `prisma.financialRecordDeduction.create` (currently uses
  `this.prisma` — pilot client; child table has no `tenantId`),
  `legacyPrisma.financialRecord.update`, `auditLog`,
  conditional `notifyUsersByRoles`.
- Action: CREATE child row + UPDATE parent aggregates.
- Tenant gate via `findOne(recordId)`.
- Phase 2.17: **INCLUDED_WITH_GUARD**.

### 1.6 `removeDeduction(deductionId, actorId)`

- Prisma calls: `prisma.financialRecordDeduction.findUnique`,
  `prisma.financialRecordDeduction.delete`,
  `prisma.financialRecordDeduction.findMany`,
  `legacyPrisma.financialRecord.findUnique`,
  `legacyPrisma.financialRecord.update`, `auditLog`.
- Action: DELETE child row + RECALCULATE parent.
- Tenant ownership path: NONE today — the `deductionId` is direct
  and there is no tenant-scoped pre-check on the parent.
- Cross-tenant risk: HIGH today. A caller with a deduction id from
  another tenant can delete it.
- Required behavior in pilot mode: load the parent
  `FinancialRecord` with `findFirst({ where: { id, tenantWhere() } })`
  and raise 404 if not found, BEFORE deleting the child.
- Phase 2.17: **INCLUDED_NOW** — add the parent tenant pre-check.

### 1.7 `addAttachment(recordId, file, uploadedById)`

- Prisma calls: `findOne(recordId)`,
  `legacyPrisma.financialRecordAttachment.create`, `auditLog`.
- Side effect: object-storage upload (cannot be transactional).
- Tenant gate via `findOne(recordId)`.
- Phase 2.17: **INCLUDED_WITH_GUARD**.

### 1.8 `removeAttachment(recordId, attachmentId, actorId)`

- Prisma calls: `findOne(recordId)` (tenant-scoped),
  `legacyPrisma.financialRecordAttachment.findFirst({ id, financialRecordId, deletedAt: null })`,
  `legacyPrisma.financialRecordAttachment.update`, `auditLog`.
- Side effect: object-storage deletion.
- Tenant gate via `findOne(recordId)` plus the `financialRecordId`
  predicate on the attachment lookup.
- Phase 2.17: **INCLUDED_WITH_GUARD**.

## 2. Audit-log writes

`auditLog(actorId, action, entityId, changes)` calls
`legacyPrisma.auditLog.create`. The audit log is global by design
(`AuditLog` has no `tenantId`). Phase 2.17 retains
`legacyPrisma` for audit writes; tagging stays
`phase216-audit-log`. A future cross-module phase will introduce
audit-log tenancy.

## 3. Notification side effects

All mutation methods emit notifications via
`notifications.notifyUsersByRoles`. After Phase 2.15 the fanout
writers refuse without an ALS tenant when tenant-aware mode is
engaged. In production (flags off) behavior is unchanged. In
SAFE_STAGING with both `TENANT_AWARE_JOBS_ENABLED` and
`TENANT_JOB_FANOUT_ENABLED` on, the fanout is tenant-scoped via
the HTTP request's ALS frame.

`checkAndNotifyHighBalance` runs as a fire-and-forget background
read; it does NOT yet engage the pilot scope and is documented as
a Phase 2.18+ deliverable.

## 4. Rollback risk summary

| Method | Rollback flag | Rollback action |
|--------|---------------|------------------|
| create | TENANT_PRISMA_PILOT_ENABLED=false | new rows stop writing tenantId; legacy reads see them |
| update / remove / updateStatus / addDeduction / addAttachment / removeAttachment | TENANT_PRISMA_PILOT_ENABLED=false | findOne falls back to legacy (no tenant filter); cross-tenant pre-check disengages |
| removeDeduction | same | tenant pre-check disengages; legacy by-id deletion behavior restored |

No DB state introduced. No migration. Pure configuration rollback.

## 4.5 Phase 2.17.1 — helper narrowing addendum

Three helper methods were re-routed in 2.17.1:

| Helper | Pre-2.17.1 | Post-2.17.1 |
|--------|-----------|-------------|
| `attachEntityNames` | `legacyPrisma.X.findMany({ where: { id: { in } } })` (`phase216-helper-read`) | `this.prisma.X.findMany({ where: { id: { in }, ...t } })` (`phase2171-helper-narrowed`) |
| `resolvePersonIdentity` | `legacyPrisma.X.findUnique({ where: { id } })` (`phase216-helper-read`) | `this.prisma.X.findFirst({ where: { id, ...t } })` (`phase2171-helper-narrowed`) — **closes a real cross-tenant create bug** |
| `resolveEntityNameForNotif` | `legacyPrisma.X.findUnique({ where: { id } })` (`phase216-helper-read`) | `this.prisma.X.findFirst({ where: { id, ...t } })` (`phase2171-helper-narrowed`) |

Plus a defensive scrub in `update` strips any smuggled
`entityType` / `entityId` / `applicantId` / `stageAtCreation`
fields. See `SAAS_PHASE2171_FINANCE_CROSS_ENTITY_GUARD_REVIEW.md`
and `SAAS_PHASE2171_FINANCE_HELPER_ENRICHMENT_REVIEW.md`.

## 4.6 Phase 2.18 — APPLICANT entity coverage

The 2.17.1 helper narrowing covered all three `entityType`
branches symmetrically in code; Phase 2.18 adds the missing
APPLICANT real-DB harness coverage (cases 11, 12, 13 in
`finance-mutation-isolation`). New fixture extension:
`phase218-finance-applicant-seed.sql` (idempotent). No service
code change.

| Entity branch | Code narrowed | Real-DB harness coverage |
|---------------|:-------------:|:-----------------------:|
| EMPLOYEE | 2.17.1 | case 9 (2.17.1) |
| APPLICANT | 2.17.1 | **cases 11+12+13 (2.18)** |
| AGENCY | 2.17.1 | **cases 14+15+16 (2.19)** |

## 5. Production safety

With production defaults (`TENANT_PRISMA_PILOT_ENABLED=false`) every
new spread (`tenantData()`, `tenantWhere()`) collapses to `{}`. The
pre-check on `removeDeduction` adds one extra `findFirst` query
per call which is the only behavior delta — a read with no tenant
predicate (i.e. legacy semantics: 404 only on missing id).
