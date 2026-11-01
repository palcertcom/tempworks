# SaaS Query Isolation Audit

**Goal:** Identify every Prisma usage that will leak data after multi-tenant cutover, classify the risk, and prescribe the safe replacement pattern.

**Replacement contract.** All tenant-data access must go through `TenantPrismaService.client` (introduced in Phase 1). Direct `PrismaService` injection becomes an architectural violation outside `infra/prisma/*` and `modules/identity/*`.

---

## 1. Risk Tiers

- **R1 — Cross-tenant leakage** (returns/mutates rows outside the actor's tenant).
- **R2 — Constraint collision** (unique constraints scoped wrong; can break inserts or hide collisions).
- **R3 — Privilege escalation surface** (uses `agencyIsSystem` to bypass scoping; no audit).
- **R4 — Operational** (jobs/exports that need tenant context but don't have it).
- **R5 — Public surface** (unauthenticated routes that must still resolve a tenant).

---

## 2. Inventory of Risky Queries

### 2.1 Auth / Users

| File | Symbol | Current | Risk | Safe replacement |
|---|---|---|---|---|
| `backend/src/auth/auth.service.ts` | `validateUser(email, password)` | `prisma.user.findUnique({ where: { email } })` | LOW (intended global) | Keep global; **must NOT** load any tenant-scoped relations here. After auth, load memberships via `IdentityService.listMemberships(userId)`. |
| `backend/src/auth/auth.service.ts` | `login(...)` | mints JWT with `agencyId`, `agencyIsSystem` | R3 | Replace with `tid`, `mid`, `scp`, `agy[]` claims. If user has multiple memberships, return tenant-selection token. |
| `backend/src/users/users.service.ts` | `create()` / `update()` | `email` collision check via `findFirst({ where: { email } })` | R2 | For tenant-bound user records (member-of-tenant), check via membership: `tenantPrisma.client.tenantMembership.findFirst({ where: { user: { email } } })`. The global `User.email` stays unique but acquiring a membership is the tenant-scoped operation. |
| `backend/src/users/users.service.ts` | `findAll()` admin list | `prisma.user.findMany()` | R1 | List **memberships** for the tenant: `tenantPrisma.client.tenantMembership.findMany({ include: { user: true, roles: true } })`. Never list `User` directly outside platform-admin. |
| `backend/src/auth/strategies/jwt.strategy.ts:47-59` | `validate()` | returns `agencyId`, `agencyIsSystem` | R3 | Return `userId`, `tenantId(=tid)`, `membershipId(=mid)`, `permissions`, `agencyIds`. Validate membership active before returning. |

### 2.2 Applicants

| File | Symbol | Current | Risk | Safe replacement |
|---|---|---|---|---|
| `backend/src/applicants/applicants.service.ts:47` | `findAll(filter, actor)` | conditional `where.agencyId = actor.agencyId` based on `isExternalActor()` | R1 (drift if forgotten) | Drop the conditional. `tenantPrisma` injects `tenantId` automatically. Apply `agencyId IN (...)` only when membership has `AgencyMembership` rows (handled by `AgencyScopeGuard`). |
| `backend/src/applicants/applicants.service.ts:192` | email duplicate check | `findFirst({ where: { email, NOT: { id } } })` | R2 | `tenantPrisma.client.applicant.findFirst({ where: { email, NOT: { id } } })` (tenant injected automatically). |
| `applicants.service.ts:97-109` | `findOne(id)` | re-checks `actor.agencyId` after fetch | R1 | Replace with `findUniqueOrThrow` under `tenantPrisma`; no manual check needed. |
| `applicants/applicants.service.ts` | identifier generation | `IdentifierSequence` increment | R2 | Use `tenantPrisma.client.identifierSequence.upsert({ where: { tenantId_prefix_year_month: { tenantId, prefix, year, month } } })`. |

### 2.3 Employees

| File | Symbol | Current | Risk | Safe replacement |
|---|---|---|---|---|
| `backend/src/employees/employees.service.ts:42` | `findAll()` scope via `EmployeeAgencyAccess` | hand-rolled IN list | R1 | Move scope resolution into `AgencyScopeGuard`; service uses `tenantPrisma` only. |
| `employees.service.ts:~207` | email collision check | `findFirst({ where: { email, deletedAt: null } })` | R2 | Tenant-scoped via `tenantPrisma`. Drop legacy `Employee.email @unique` after schema change (see DB classification). |
| `employees.service.ts:110-111` | `EmployeeAgencyAccess.findUnique` | direct prisma | R1 | Move to `AgencyAccessService` that uses `tenantPrisma`. |

### 2.4 Documents

| File | Symbol | Current | Risk | Safe replacement |
|---|---|---|---|---|
| `backend/src/documents/documents.service.ts` | `findByEntity(entityType, entityId)` | `prisma.document.findMany({ where: { entityType, entityId } })` | R1 | Backfill `Document.tenantId`. Then `tenantPrisma` injection makes this safe. Until then, **also** validate `entityId`'s parent has `tenantId == ctx.tenantId`. |
| `documents.service.ts` | `readDocumentBytes(id)` | loads from local FS or Spaces | R1 + R5 | Validate `document.tenantId == ctx.tenantId` **before** issuing signed URL. Strip ACL=public-read. |
| `documents.controller.ts` | `POST /documents/public/upload` | `@Public()` | R5 | Resolve tenant from host; require CAPTCHA + IP rate-limit; write doc with `tenantId` from host. |
| `documents.service.ts` | `bulkDownload(ids[])` | zips files | R1 | `tenantPrisma` returns only this tenant's docs; reject if any id missing. |

### 2.5 Reports (HIGHEST-RISK SURFACE)

| File | Symbol | Current | Risk | Safe replacement |
|---|---|---|---|---|
| `backend/src/reports/reports.service.ts` `SOURCE_DEFS` | raw SQL via `Prisma.raw()` | `SELECT ... FROM employees JOIN ...` no `tenant_id` filter | **R1 (CRITICAL)** | Refactor `SOURCE_DEFS` so every base query template has a parameterized `WHERE tenant_id = $tenantId AND ...`. The query builder must reject any source missing this WHERE. Add unit test that fails if `EXPLAIN` plan touches another tenant's partition. |
| `reports.service.ts` `runReport()` | builds final SQL from user filters | filters appended by user | R1 | After refactor: tenant filter is **fixed** by builder; user filters are `AND` only. |
| `reports.service.ts` exports | Excel/PDF/DOCX generation | streams full result set | R1 + R4 | Same fix; export goes through the same query builder. |
| `reports.service.ts` `Report.name @unique` | global | R2 | `@@unique([tenantId, name])`. |

### 2.6 Notifications

| File | Symbol | Current | Risk | Safe replacement |
|---|---|---|---|---|
| `backend/src/notifications/notifications-scheduler.service.ts:~19-28` | `setInterval(runAllChecks, 6h)` | global scan | R1 + R4 | Replace with BullMQ. A scheduler enqueues one job per active tenant: `notifications.runChecks { tenantId }`. Worker rehydrates ALS with `tenantId` and uses `tenantPrisma`. |
| `notifications.service.ts` | `runAllChecks()` body | `prisma.document.findMany({ where: { expiresAt: { lt: ... } } })` | R1 | Inside the per-tenant job — `tenantPrisma` injects `tenantId`. |
| `notifications.service.ts` | createNotification | `prisma.notification.create({ data: { userId, ... } })` | R2 | Add `tenantId` (from job context). Membership check before delivering. |

### 2.7 Workflow / Pipeline

| File | Symbol | Current | Risk | Safe replacement |
|---|---|---|---|---|
| `backend/src/workflow/workflow.service.ts` | `findAll()` | returns all workflows; `isPublic=true` default | R1 | After schema patch, system templates have `tenantId=null` and are read-only; tenant-owned workflows go through `tenantPrisma`. Provide a `cloneTemplate(workflowId)` API. |
| `workflow.service.ts` | `assign(employeeId, workflowId)` | direct lookup | R1 | Validate workflow is either `tenantId=ctx.tenantId` or system template. |

### 2.8 Job Ads

| File | Symbol | Current | Risk | Safe replacement |
|---|---|---|---|---|
| `backend/src/job-ads/job-ads.service.ts` | `findBySlug(slug)` | global `slug @unique` lookup | R1 + R5 | Public route resolves tenant from host first; then `findFirst({ where: { tenantId, slug } })`. |
| `job-ads.service.ts` | `create()` slug generation | global uniqueness | R2 | Constraint becomes `@@unique([tenantId, slug])`; generation retries within tenant. |

### 2.9 Finance

| File | Symbol | Current | Risk | Safe replacement |
|---|---|---|---|---|
| `backend/src/finance/finance.service.ts` | `findAll(entityType, entityId)` | no agencyId | R1 | Add `tenantId` denorm; use `tenantPrisma`. Validate entity belongs to tenant. |
| `finance.service.ts` | deduction history | inserts | R2 | Inherit `tenantId` from parent record at write. |

### 2.10 Attendance

| File | Symbol | Current | Risk | Safe replacement |
|---|---|---|---|---|
| `backend/src/attendance/attendance.service.ts` | lock period check | `AttendanceLockedPeriod (year, month)` global | R1 (CRITICAL correctness) | `@@unique([tenantId, year, month])`; check via `tenantPrisma`. |
| `attendance.service.ts` | bulk import | `createMany` | R2 | Inject `tenantId` per row; reject if employee tenant mismatch. |

### 2.11 Backup

| File | Symbol | Current | Risk | Safe replacement |
|---|---|---|---|---|
| `backend/src/backup/backup.service.ts` | `createBackup()` runs `pg_dump` of whole DB | platform-admin path | R3 (today's behavior is fine if access controlled) | Move endpoint behind `PlatformAdminGuard`. Add a separate `/tenant-export` endpoint that emits per-tenant logical export (JSON + signed object URLs). |

### 2.12 Logs / Audit

| File | Symbol | Current | Risk | Safe replacement |
|---|---|---|---|---|
| `backend/src/logs/audit-log.service.ts` | `findAll()` | global | R1 | Add `tenantId`; `tenantPrisma` filters. Platform-admin sees a separate `platform_audit_log`. |
| audit-log writes | every service | inconsistent | R2 + R4 | Introduce `@Audit('module.action')` interceptor that writes `{tenantId, userId, action, target, before, after}` automatically. |

### 2.13 Recycle Bin

| File | Symbol | Current | Risk | Safe replacement |
|---|---|---|---|---|
| `backend/src/recycle-bin/*` | restore by id | polymorphic | R1 | Restore must `assert restoreItem.tenantId === ctx.tenantId`; reject otherwise. |

### 2.14 Settings / Branding

| File | Symbol | Current | Risk | Safe replacement |
|---|---|---|---|---|
| `backend/src/settings/settings.service.ts` | `SystemSetting` | global key/value | R1 (when used as branding) | Move all `branding_*` keys into `Tenant.branding` JSONB. Truly global keys remain. |

---

## 3. Raw SQL & `Prisma.raw()` Inventory

| File | Pattern | Action |
|---|---|---|
| `backend/src/reports/reports.service.ts` | `Prisma.raw()` constructing SELECT/JOIN per source | **Refactor `SOURCE_DEFS`** to inject `WHERE tenant_id = $1` via parameter; lint to forbid raw concatenation of identifiers/values. Add an integration test that runs every source against two tenants and asserts no leakage. |
| `backend/prisma/*.sql` migration scripts | DDL only | Re-run audit when `tenant_id` migrations land; ensure no DML touches existing rows without filter. |

No `$queryRaw` / `$executeRaw` outside reports, per audit. CI guard must keep it that way (allowlist file).

---

## 4. Public / Unauthenticated Surfaces (R5)

| Route | File | Tenant resolution required |
|---|---|---|
| `POST /documents/public/upload` | `documents.controller.ts` | Host-based; reject if no tenant resolved. Add CAPTCHA + per-IP rate limit. Bind document to host's tenant. |
| `GET /jobs/:slug` (public job ads) | `job-ads.controller.ts` | Host-based; `findFirst({ tenantId, slug, status: PUBLISHED })`. |
| `POST /apply/:slug` (apply to job) | `applicants.controller.ts` (public apply path) | Host-based; create applicant with tenant from host. |
| Health/ready endpoints | various | **No** tenant resolution — exclude from middleware. |

---

## 5. CI Guards (must be added in Phase 0)

```jsonc
// eslint rule: no direct PrismaClient outside infra
"no-restricted-imports": ["error", {
  "patterns": [{
    "group": ["@prisma/client", "**/prisma/prisma.service"],
    "message": "Use TenantPrismaService. Direct PrismaClient is forbidden outside infra/prisma."
  }]
}]
```

```ts
// jest test: cross-tenant isolation
describe('tenant isolation', () => {
  it.each(TENANT_SCOPED_MODELS)('%s does not leak across tenants', async (model) => {
    const a = await createTenantWithFixtures();
    const b = await createTenantWithFixtures();
    await runAs(a, async () => {
      const rows = await tenantPrisma.client[model].findMany();
      expect(rows.every(r => r.tenantId === a.id)).toBe(true);
    });
  });
});
```

```yaml
# AST scan in CI: forbid `prisma.<model>.` outside allowlist
- run: pnpm scan:tenant-safe
```

---

## 6. The "Forgotten Path" Checklist

Before declaring Phase 3 complete, confirm none of these can return cross-tenant rows:

- [ ] Free-text search endpoints (employees, candidates, documents)
- [ ] Bulk export (Excel/PDF/DOCX) in reports
- [ ] Recycle-bin restore
- [ ] Email body templates that include record links (`/employees/<id>`) — must validate the recipient has access
- [ ] Webhooks (if any) emitting record IDs cross-tenant
- [ ] WebSocket / SSE channels (notifications) — channel keyed `tenant:<id>:user:<id>`
- [ ] PDF/DOCX generation that follows file references
- [ ] CSV/Excel imports — every imported row must have `tenantId` injected at the boundary
- [ ] Background image/file processing
- [ ] OCR / PDF parsing pipelines (if added)
- [ ] Two-Factor email links — must include tenant in URL only via host

