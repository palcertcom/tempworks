# SaaS Codebase Audit — Tempworks

**Scope:** Concrete inventory of single-tenant assumptions in the existing codebase.
**Repo:** `/home/user/Tempworksemployeerecruitmentcompliancemanagementsystem`
**Backend:** NestJS + Prisma (`backend/`) — 66 Prisma models, ~2058-line schema
**Frontend:** React + Vite + Tailwind (`src/`)
**Storage:** Local `backend/uploads` (legacy) + DigitalOcean Spaces (current)

> **Headline finding.** The codebase already has an `Agency` concept with `agencyId` propagated through most domain entities, and the JWT carries an `agencyIsSystem` flag used to bypass scoping. This is **single-level tenancy implemented as agencies**: the Tempworks "system" agency is the platform admin, and customer agencies are de-facto tenants. Migrating to true multi-tenant SaaS is therefore **not a green-field tenancy bolt-on** — it is a **promotion of `Agency` semantics**:
>
> - Introduce a new top-level `Tenant` entity.
> - Re-cast existing `Agency` rows as **either** Tenants (the Tempworks-managed top level) **or** sub-agencies inside a tenant.
> - Replace the implicit "Tempworks-runs-everything" model with explicit Platform Admin (global users) + per-tenant memberships.
>
> This both simplifies and complicates the migration: simplifies because `agencyId` is already wired through services; complicates because every existing reference must be re-interpreted as either `tenantId` (data-scope boundary) or `agencyId` (sub-scope inside a tenant), and the existing `agencyIsSystem` bypass must be retired in favor of a properly-audited platform-admin code path.

---

## 1. Single-Tenant Assumptions (the things that break under SaaS)

| # | Assumption | Location | Risk |
|---|---|---|---|
| A1 | `User.email @unique` is **global** | `backend/prisma/schema.prisma` (User) | CRITICAL — same person at two tenants impossible; collision DoS |
| A2 | `Employee.email @unique` is **global** | schema.prisma (Employee) | CRITICAL — two tenants cannot have an employee with the same email |
| A3 | `Role.name @unique` is global; roles are shared across all agencies | schema.prisma (Role) | HIGH — tenants cannot define their own role names; rename collisions |
| A4 | `Permission.name @unique` global, but acceptable as a system catalog | schema.prisma (Permission) | LOW — keep as global catalog |
| A5 | `IdentifierSequence` `@@unique([prefix, year, month])` is global | schema.prisma (IdentifierSequence) | CRITICAL — applicant/employee identifiers (`A-2025-…`, `E-2025-…`) collide across tenants |
| A6 | `JobAd.slug @unique` is global | schema.prisma (JobAd) | CRITICAL — public job-ad URLs collide across tenants |
| A7 | `Report.name @unique` is global | schema.prisma (Report) | HIGH — two tenants cannot both have a "Monthly KPI" report |
| A8 | `DocumentType.name @unique` global; arguably OK as catalog | schema.prisma (DocumentType) | DECIDE — keep global (system catalog) but allow tenant overrides |
| A9 | `MaintenanceType.name @unique` global | schema.prisma (MaintenanceType) | LOW — keep global catalog with optional tenant overrides |
| A10 | `AttendanceLockedPeriod @@unique([year, month])` is global → payroll lock is system-wide | schema.prisma | CRITICAL — locking June for one tenant locks it for everyone |
| A11 | `Workflow` has **no** `agencyId`; `isPublic=true` by default | schema.prisma (Workflow / WorkflowStage) | CRITICAL — every tenant sees every other tenant's workflows |
| A12 | `Workshop` has no scoping | schema.prisma (Workshop) | MEDIUM — vehicle workshops shared across tenants |
| A13 | `Document` has no direct `tenantId/agencyId` (uses `entityType + entityId`) | schema.prisma (Document) | HIGH — tenancy must be derived through the parent entity; lookups risk leakage |
| A14 | `ComplianceAlert` has no direct `agencyId` (entity-derived) | schema.prisma | HIGH — same as Document |
| A15 | `FinancialRecord` has no direct `agencyId` (entity-derived) | schema.prisma | HIGH — same |
| A16 | `Visa` has no direct `agencyId` (entity-derived) | schema.prisma | HIGH — same |
| A17 | `AuditLog` has no direct `agencyId` | schema.prisma | HIGH — cannot offer per-tenant audit export |
| A18 | `SystemBackup` is global; `BackupService` runs `pg_dump` on the entire DB | `backend/src/backup/backup.service.ts` | CRITICAL — restoring a "tenant backup" today restores everyone |
| A19 | `SystemSetting` is global; branding lives in this table | schema.prisma + `useBranding()` | HIGH — must move to per-tenant `tenant.branding` |
| A20 | `NotificationsSchedulerService` runs every 6 h with no tenant scope | `backend/src/notifications/notifications-scheduler.service.ts` (`setInterval`, line ~19) | CRITICAL — global scan, generates notifications across all tenants |
| A21 | `JwtAuthGuard` only validates the JWT; no tenant-context middleware | `backend/src/auth/guards/jwt-auth.guard.ts` | CRITICAL — `agencyId` from JWT is the only isolation, enforced ad-hoc per service |
| A22 | Tenant scoping enforced **inside services** via `isExternalActor()` + `if (actor.agencyId) where.agencyId = ...` | `applicants.service.ts:47`, `employees.service.ts:42` | CRITICAL — every service is a potential leak; missed branches = leak |
| A23 | `agencyIsSystem` from JWT bypasses **all** scoping — no audit, no step-up auth | `auth/strategies/jwt.strategy.ts:54-58`, used across services | HIGH — this becomes the platform-admin path and must be replaced with an audited bypass |
| A24 | Email uniqueness checks done as `prisma.<model>.findFirst({ where: { email } })` without tenant filter | `applicants.service.ts:192`, `employees.service.ts:~207`, `users.service.ts` (login) | CRITICAL — collisions across tenants |
| A25 | Login lookup is `findUnique({ where: { email } })` (global) | `auth.service.ts` | EXPECTED for global users — but must NOT lookup tenant-scoped data here |
| A26 | Reports raw SQL has no automatic tenant filter | `reports/reports.service.ts` (`SOURCE_DEFS`, `Prisma.raw()`) | CRITICAL — anyone with report access can write a filter that returns all tenants |
| A27 | Frontend stores `current_user` + tokens in `localStorage` keyed without tenant | `src/app/services/api.ts` | HIGH — multi-tenant tab sessions can pollute |
| A28 | Frontend route guards check `role.name` strings, not membership | `src/app/components/layout/*` | MEDIUM — must move to permissions + tenant membership |
| A29 | Storage objects uploaded with `ACL: 'public-read'` | `backend/src/common/storage/storage.service.ts` | CRITICAL — sensitive PII documents (ID, contracts) publicly accessible by URL |
| A30 | Storage keys are not strictly tenant-prefixed (some are `documents/{entityType}/{entityId}/...`) | `storage.service.ts` upload paths | HIGH — must enforce `tenants/{tenantId}/...` |
| A31 | Public unauthenticated upload endpoint `/documents/public/upload` | `documents.controller.ts` (~line 115) | HIGH — needs CAPTCHA, rate limit, tenant-binding |
| A32 | API client (`fetch` wrapper) sends only Bearer; no `X-Tenant-Id` header | `src/app/services/api.ts` | MEDIUM — fine if subdomain-based, but no fallback for API clients |
| A33 | i18n is global (locale per user/system); no per-tenant defaults | `src/i18n/`, `LanguageProvider` | LOW — already supports user override; add tenant default |
| A34 | No request-scoped `TenantContext`; services receive `actor` argument manually | every service | HIGH — drift-prone, easy to forget |
| A35 | Numerous `db:migrate:*` ts-node scripts in `backend/package.json` (40+) | `backend/package.json` | MEDIUM — operational debt; must each be re-validated for tenant safety |

---

## 2. Module-by-Module Inventory

| Module path | Tenant readiness today | Highest-risk issue |
|---|---|---|
| `auth/` | Token-only; no tenant resolution | No `tid`/`mid` claim; switching tenants requires re-login |
| `users/` | `agencyId` present | Email globally unique (A1); no membership concept |
| `roles/` | Global | Names not tenant-scoped (A3) |
| `agencies/` | Owns `agencyIsSystem` bypass (A23) | Conflates "tenant" with "sub-agency" |
| `applicants/` | `agencyId` enforced via `isExternalActor()` | Email check (A24); tenant filter is per-service code |
| `applications-drafts/` | Via `createdById` | Indirect scope only |
| `employees/` | `agencyId` + `EmployeeAgencyAccess` cross-grants | Email global (A2); cross-grant logic must extend to tenants |
| `employee-work-history/` | Via Employee | Document attachments share storage path |
| `attendance/` | Via Employee | Global payroll lock (A10) |
| `compliance/` | Entity-indirect | No direct scope (A14) |
| `documents/` | Entity-indirect; storage paths partial | Public ACL (A29); paths not tenant-prefixed (A30); public upload (A31) |
| `finance/` | Entity-indirect | No direct `agencyId` (A15); deduction history must be tenant-scoped |
| `job-ads/` | None | Slug global (A6); public pages need tenant resolution |
| `logs/` | Global | AuditLog not tenant-scoped (A17) |
| `notifications/` | Per-User; scheduler global | Scheduler scans all tenants (A20) |
| `pipeline/`, `workflow/` | None — fully global | Cross-tenant visibility (A11) |
| `recycle-bin/` | Polymorphic; via entity | Restore can leak tenancy (must verify on restore) |
| `reports/` | None | Raw SQL, no tenant filter (A26) |
| `settings/` | Global | Branding must move to tenant (A19) |
| `vehicles/` | `agencyId` ✓ | Workshop / MaintenanceType global (A9, A12) |
| `backup/` | Global `pg_dump` | Cannot do per-tenant restore (A18) |
| `email/` | Global SMTP | Tenants will eventually want their own sender domains |
| `common/` | Has `StorageService`, decorators | No `TenantContext`/ALS (A34); `StorageService` defaults to public ACL (A29) |

---

## 3. Identity & RBAC Reality Check

Today’s effective identity model is:

```
User { id, email(@unique), roleId, agencyId, agencyIsSystem(via Agency.isSystem) }
```

This is **`User ↔ 1 Agency`** with a single role per user. The blueprint requires **`User ↔ N Tenants`** with a per-membership role set and per-membership agency scope. The migration therefore introduces three new tables (`tenants`, `tenant_memberships`, `agency_memberships`) and **demotes `User.agencyId` and `User.roleId`** to legacy fields preserved only for backward compatibility during cutover.

The `agencyIsSystem` shortcut (currently used as a "see everything" flag) is replaced by **platform-admin memberships** stored in a new `platform_admins` table with explicit, audited bypass via a separate `PlatformPrismaService`.

---

## 4. Frontend Reality Check

- `AuthContext.tsx` (`src/app/contexts/AuthContext.tsx`) holds the user + reads `agencyIsSystem` already — easy hook point for `TenantContext`/`MembershipsContext`.
- `services/api.ts` is a `fetch` wrapper with token refresh and `resolveAssetUrl()` — needs to inject `Authorization` always, host-derive tenant, and rebuild cache on tenant switch.
- `LanguageProvider`, `ThemeContext`, `useBranding()` — already runtime-driven; bend them to read `/bootstrap` per tenant.
- `routes.ts` enumerates ~120 routes; sidebar visibility is role-name-based — refactor to permission keys + agency-scope checks.
- `localStorage` is the source of truth for `current_user`, `access_token`, `refresh_token` — cookie or in-memory tokens are safer for multi-tenant subdomains; refresh stays in `localStorage` keyed per origin only.

---

## 5. Storage & Security Posture

- Default `ACL: 'public-read'` is a **bring-your-own-data-leak** for compliance documents. Must flip to private + signed URLs.
- Storage prefixes are entity-typed but **not** tenant-prefixed at the bucket level — re-key existing objects and validate every download path against `TenantContext.tenant.id` before issuing signed URLs.
- The legacy `/uploads` static route is mounted in NestJS; once Spaces migration is complete, retire it (and all rows must be re-keyed before).

---

## 6. Background-Job & Reporting Posture

- `notifications-scheduler.service.ts` is a single `setInterval` running every 6 h. It runs `notificationsService.runAllChecks()` which fans out across all employees/applicants/vehicles. This must (a) iterate tenants, (b) carry `tenantId` into ALS, and (c) be migrated to BullMQ for retry / observability.
- `reports/reports.service.ts` is a metadata-driven report engine using `Prisma.raw()` to compose SELECTs. There is **no automatic tenant filter** in `SOURCE_DEFS`. This is the single highest-risk surface for cross-tenant leakage in the codebase.

---

## 7. Blockers (Must Be Resolved Before Phase 2)

1. **Email uniqueness model** for `User` and `Employee` — confirm: `(tenantId, email)` for Employee; **global verified email** for User (login is global) but allow same email across multiple memberships.
2. **Identifier sequence ownership** (`A-2025-…`) — must become `(tenantId, prefix, year, month)`.
3. **`agencyIsSystem` retirement** — every service that branches on it must be rewritten to use `PlatformAdminGuard` + audited `PlatformPrismaService`.
4. **Workflow ownership** — decide: per-tenant only? or "system templates" + per-tenant copies? Recommended: system templates (read-only), tenants clone into their own workflows on first use.
5. **Report engine** — decide: refactor `SOURCE_DEFS` to inject `WHERE tenant_id = $1` automatically, or rebuild on a tenant-aware query builder. Recommended: inject; reuse the rest.
6. **Storage ACL flip** — coordinate with frontend so all asset URLs go through API-issued signed URLs.
7. **Backup strategy** — full `pg_dump` retained for ops; **per-tenant export** built as a separate logical export job.

---

## 8. What Already Helps (Migration Accelerators)

- `agencyId` is already on User, Applicant, Employee, Vehicle and is enforced (imperfectly) in services — adding `tenantId` next to it is a mechanical pass.
- `EmployeeAgencyAccess` and `AgencyPermissionOverride` already model fine-grained scope and overrides — natural fit for `agency_memberships` and per-membership permission overrides.
- `agencyIsSystem` JWT claim is the conceptual ancestor of "platform admin" — a clean rename + audit wrapper.
- Frontend already has `LanguageProvider`, `ThemeContext`, `useBranding()` — wiring tenant config through them is small.
- Storage already supports a Spaces driver + `resolveAssetUrl()` normalization — flipping to signed URLs is contained to `StorageService`.
