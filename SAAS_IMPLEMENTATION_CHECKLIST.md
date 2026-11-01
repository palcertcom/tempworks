# SaaS Implementation Checklist

A flat, ticketable checklist. Each item is sized to ~½–3 days. Phase tags map to `SAAS_MIGRATION_PLAN.md`.

Legend: `[ ]` open · `[~]` blocked-on · `[!]` critical-path · `[?]` decision needed

---

## Phase 0 — Preparation

- [!] Write ADR-001 … ADR-012 (see Migration Plan §0.2)
- [!] Add ESLint rule forbidding direct `PrismaClient` outside `infra/prisma/*`
- [!] Add CI job `pnpm test:isolation` (skipped initially; populated as models migrate)
- [ ] Add schema-lint: `tenantId` requires composite index; tenant-relevant `@unique` must include `tenantId`
- [ ] Create feature flags `MULTI_TENANT_ENABLED`, `TENANT_PRISMA_ENFORCED`, `RLS_ENFORCED`, `STORAGE_PRIVATE_ACL`, `WORKSPACE_SWITCHER_UI`
- [ ] Provision Redis for tenant resolution cache + per-tenant rate limits
- [ ] Pick subdomain host pattern: `<slug>.app.tempworks.com`; provision wildcard cert (cert-manager + DNS-01)
- [ ] Decide Phase-1 staging tenant slugs; reserve `platform`, `admin`, `www`, `api` as forbidden slugs
- [?] Confirm region pinning policy (single region first → EU)

---

## Phase 1 — Core Tenancy Foundation

### 1A. New Tables (additive only)

- [!] Add `Tenant` model + migration
- [!] Add `TenantMembership`, `MembershipRole`, `AgencyMembership`
- [!] Add `PlatformAdmin`, `PlatformAuditLog`, `TenantDomain`
- [ ] Seed: one `Tenant` (Tenant Zero) + memberships for all current users (to be populated during Phase 2)

### 1B. Tenant Context

- [!] `backend/src/common/context/tenant.context.ts` — AsyncLocalStorage store
- [!] `backend/src/common/middleware/tenant.middleware.ts` — host-based resolver, Redis-cached
- [!] Exclude `/healthz`, `/readyz`, `/auth/login`, `/auth/refresh` from middleware
- [ ] Custom-domain resolver via `TenantDomain.host`
- [ ] 404 page for unknown tenant slug

### 1C. Tenant Prisma Service

- [!] `infra/prisma/tenant-prisma.service.ts` (Prisma `$extends` wrapper)
- [!] Auto-generated `TENANT_SCOPED_MODELS` registry (Prisma generator)
- [!] Tenant-id injection for `find*`, `count`, `aggregate`, `create`, `createMany`, `update*`, `delete*`, `upsert`
- [!] `SET LOCAL app.tenant_id` inside transaction wrapper
- [ ] `infra/prisma/platform-prisma.service.ts` (separate Postgres role; audit-required)
- [ ] Unit tests verifying injection across all CRUD ops

### 1D. Identity & Auth Refactor

- [!] `IdentityService` (global user lookup, MFA, password)
- [!] `MembershipService` (list, invite, accept, suspend)
- [!] `JwtService` v2: `tid`, `mid`, `scp`, `agy`, `pa`
- [!] Dual-claim issuance for one release (`agencyId`, `agencyIsSystem` retained)
- [!] `JwtAuthGuard` rewrite: assert `claims.tid === ctx.tenantId`
- [ ] `PermissionGuard` — replaces string-role guards
- [ ] `AgencyScopeGuard`
- [ ] `RequirePlatformAdmin` decorator + guard
- [ ] `Audit` interceptor wired but no-op until Phase 3

### 1E. Login Flows

- [!] `POST /auth/login` returns single-membership access OR `tenant_select` token
- [!] `POST /auth/switch-tenant`
- [!] `GET /auth/me` upgraded
- [!] `GET /api/v1/bootstrap`
- [ ] `POST /tenant/invitations` + `POST /invitations/:token/accept`
- [ ] Tests: invite → accept → switch → suspend → re-invite

### 1F. Acceptance Gate (Phase 1 done)

- [ ] `MULTI_TENANT_ENABLED=true` in dev; legacy login still works
- [ ] All identity tests green
- [ ] No production traffic affected (flag off in prod)

---

## Phase 2 — Tenant Zero Migration

### 2A. Schema Expand (additive `tenant_id` per model)

For each model in `SAAS_DATABASE_MODEL_CLASSIFICATION.md` marked TENANT or TENANT(agency):

- [!] `ALTER TABLE <t> ADD COLUMN tenant_id UUID;`
- [!] Backfill `tenant_id` from `agencyId` lookup in batches of 5k
- [!] `ALTER TABLE <t> ALTER COLUMN tenant_id SET NOT NULL;`
- [!] `CREATE INDEX CONCURRENTLY ix_<t>_tenant_...`
- [!] Drop legacy global `@unique` constraints; add tenant-scoped ones
- [ ] Enable RLS audit mode (policies created, no `FORCE`)

Critical models (priority within Phase 2):

- [!] `User` (global; just verify untouched)
- [!] `Agency` (becomes child of `Tenant`)
- [!] `IdentifierSequence` ⇒ `(tenantId, prefix, year, month)` **before** any new applicant/employee insert
- [!] `Employee` ⇒ drop global `email @unique`; add `(tenantId, email)`
- [!] `JobAd` ⇒ drop global `slug @unique`; add `(tenantId, slug)`
- [!] `AttendanceLockedPeriod` ⇒ `(tenantId, year, month)`
- [!] `Workflow` ⇒ + `tenantId` (system templates `null`)
- [!] `Document` ⇒ `tenantId` denorm + drop `docId @unique`
- [!] `ComplianceAlert` ⇒ `tenantId` denorm
- [!] `FinancialRecord` ⇒ `tenantId` denorm
- [!] `Report` ⇒ `(tenantId, name)`
- [ ] All other TENANT models in classification doc

### 2B. Membership Backfill

- [!] Provision Tenant Zero(s): one Tenant per existing customer Agency
- [!] Each non-system User → one `TenantMembership(status=ACTIVE)` against the appropriate tenant
- [!] Each User's `roleId` cloned into `MembershipRole`
- [!] Each `EmployeeAgencyAccess` row → `AgencyMembership` where applicable
- [!] Each user from `Agency.isSystem=true` → `PlatformAdmin` row
- [ ] Validation report: count match between users and memberships

### 2C. Code Cutover (Tenant-aware enabled)

- [ ] Flip `TENANT_PRISMA_ENFORCED=true` in staging
- [ ] Each existing service compiles + functional tests pass
- [ ] Two-tenant isolation tests added per touched model
- [ ] Performance regression < 10%

### 2D. Storage Backfill

- [!] Inventory query producing `(table, id, tenant_id, current_key, target_key)`
- [!] Background job: server-side S3 copy `current_key → target_key`
- [!] DB updates `storageKey`
- [ ] Verify random sample post-migration

### 2E. Acceptance Gate (Phase 2 done)

- [ ] All E2E suites pass with `MULTI_TENANT_ENABLED=true`, `TENANT_PRISMA_ENFORCED=true`
- [ ] Two-tenant isolation tests pass for every TENANT model
- [ ] Tenant Zero functions identically to pre-migration prod for end users

---

## Phase 3 — Module Refactor & Hardening

### 3A. Reports (highest priority)

- [!] Refactor `SOURCE_DEFS` so each base query has parameterized `WHERE tenant_id = $1`
- [!] Forbid raw concatenation; use `Prisma.sql` with bound params
- [!] Two-tenant test for each source
- [!] Export paths (Excel/PDF/DOCX) reuse the same builder
- [ ] Drop `Report.name @unique` global

### 3B. Documents

- [!] `Document.tenantId` denormalized; backfill complete
- [!] Signed-URL endpoint `GET /api/v1/files/sign?d=<docId>`
- [!] Replace public `ACL: 'public-read'` with private (flag `STORAGE_PRIVATE_ACL`)
- [!] `bulkDownload` validates each id's tenant
- [ ] Public upload route gated by host + CAPTCHA + rate limit
- [ ] Frontend: `getSignedAssetUrl` everywhere; remove `resolveAssetUrl` direct paths

### 3C. Notifications + Scheduler

- [!] BullMQ `notifications.runChecks { tenantId }` queue
- [!] Scheduler enqueues one job per active tenant (every 6 h)
- [!] Worker rehydrates ALS context, uses `tenantPrisma`
- [ ] Run legacy + new in parallel for 1 week with dedup
- [ ] Retire legacy `setInterval`

### 3D. Applicants / Employees / Compliance / Finance

- [!] Replace `isExternalActor()` branches with guard-driven scoping
- [!] Email collision checks under `tenantPrisma`
- [!] `EmployeeAgencyAccess` enforced via `AgencyScopeGuard`
- [!] Soft-delete & restore preserves `tenantId`

### 3E. Attendance / Vehicles / Workflow / Job Ads / Settings

- [!] `AttendanceLockedPeriod` per-tenant lock implemented
- [!] Workshop / MaintenanceType decision (catalog + override)
- [!] Workflow templates clone-on-use
- [!] Job-ads public route resolves tenant from host
- [ ] Settings: branding moves to `Tenant.branding`; `SystemSetting branding_*` kept read-only during transition

### 3F. Audit & Recycle Bin

- [!] `@Audit` decorator wired across mutations
- [!] `audit_logs` partitioned (`HASH (tenant_id)` × 16)
- [ ] Recycle restore validates `tenantId` match

### 3G. Platform Admin

- [!] `/_platform` route prefix
- [!] `PlatformPrismaService` injected only here
- [!] Step-up MFA on entry; 30-min session
- [!] Every action writes `PlatformAuditLog`
- [ ] Migrate all remaining `agencyIsSystem` usages → `RequirePlatformAdmin`
- [ ] Remove `agencyIsSystem` from JWT (after one release)

### 3H. RLS Cutover

- [ ] Audit mode → no policy violations for 7 days
- [!] `ALTER TABLE <t> FORCE ROW LEVEL SECURITY` per table over 1 week
- [ ] On-call runbook for `permission denied` incidents

### 3I. Acceptance Gate (Phase 3 done)

- [ ] Internal red-team isolation review passes
- [ ] Third-party pentest report has no critical findings
- [ ] Coverage of two-tenant isolation tests ≥ 95%
- [ ] No `agencyIsSystem` references left

---

## Phase 4 — Frontend SaaS Refactor

- [!] `TenantContext` provider (`src/app/contexts/TenantContext.tsx`)
- [!] `AuthContext` refactor (drop agency fields)
- [!] `services/api.ts`: in-memory access token; switch-tenant interceptor; `getSignedAssetUrl`
- [!] `WorkspaceSwitcher` component
- [!] Sidebar role→permission migration
- [ ] Branding via CSS variables fed from `tenant.branding`
- [ ] i18n tenant default + per-tenant locale persistence
- [ ] React Query keys prefixed with `tenantId` (via `useTenantQuery`)
- [ ] `/select-workspace`, `/invite/accept/:token`, `/_platform/*` routes
- [ ] Public job-ad and apply pages resolve tenant from host
- [ ] BroadcastChannel auth/tenant-switch sync
- [ ] CSP review for new subdomains

---

## Phase 5 — Security Hardening

- [!] RLS `FORCE` on all TENANT tables
- [!] Audit logging full coverage
- [!] Per-tenant rate limits (Redis): `(tenant, user, endpoint)`
- [!] Per-tenant quotas at write boundary
- [ ] Threat models (reports, documents, finance, payroll)
- [ ] AV scan worker (ClamAV) for uploads
- [ ] SVG sanitizer
- [ ] CSP / HSTS / cookie audit
- [ ] Secret rotation policy (DB role for `app_user` vs `platform_admin`)
- [ ] Backup/restore runbook for per-tenant export
- [ ] Pen test #2 + remediation
- [ ] SOC2 controls map (change management, access reviews, incident response)
- [ ] GDPR: data export endpoint, deletion (cryptographic erasure) plan

---

## Phase 6 — SaaS Commercialization

### 6A. Billing

- [ ] `Plan`, `Subscription`, `Invoice`, `UsageRecord` tables
- [ ] Stripe Billing integration (cards + ACH)
- [ ] Manual-invoice path for enterprise
- [ ] Webhooks (subscription.updated, invoice.paid, etc.)
- [ ] Dunning emails / suspension flow

### 6B. Plans & Quotas

- [ ] Plan tiers (Starter / Pro / Business / Enterprise)
- [ ] `assertWithinQuota('candidates', tenantId)` at create
- [ ] 80% / 100% usage warnings
- [ ] Soft + hard limits

### 6C. Feature Flags & Gating

- [ ] `FeatureService.isEnabled(tenantId, key)`
- [ ] Surface in `/bootstrap`
- [ ] Server-side enforcement (never trust client)

### 6D. Usage Metering

- [ ] `UsageEvent` ingestion
- [ ] Daily rollup → Stripe usage records
- [ ] Reconciliation report (manual review weekly)

### 6E. SSO / SCIM (Enterprise)

- [ ] Per-tenant SAML/OIDC config
- [ ] JIT provisioning of `User` + `TenantMembership`
- [ ] SCIM 2.0 endpoint per tenant
- [ ] Claim/attribute mapping

### 6F. White-label & Custom Domains

- [ ] DNS verification flow
- [ ] cert-manager `Certificate` per verified host
- [ ] Email sender domain (DKIM/SPF) per tenant (optional)

---

## Cross-Cutting (always-on)

- [ ] PR template requires "tenant impact" section
- [ ] On-call runbooks: tenant resolution failure, RLS denied, BullMQ tenant-job stuck, signed-URL audit
- [ ] Quarterly tenant-isolation red-team
- [ ] Quarterly access review for `PlatformAdmin` rows
- [ ] Cost dashboard: per-tenant DB time, storage, egress
- [ ] On-tenant-deletion checklist: hard delete after retention; cryptographic erasure of DEK; storage prefix purge; audit-log retention exception

---

## "Definition of Done" for the Full Migration

1. `MULTI_TENANT_ENABLED=true`, `TENANT_PRISMA_ENFORCED=true`, `RLS_ENFORCED=true` in production.
2. Zero references to `agencyIsSystem` in the codebase.
3. All TENANT models have `(tenantId, ...)` indexes leading; tenant-scoped uniqueness only.
4. Two-tenant isolation tests cover ≥ 95% of TENANT models.
5. Reports engine has tenant filter forced in every base query.
6. All storage objects are private; downloads only via signed URLs scoped to tenant.
7. Per-tenant restore from logical export is rehearsed quarterly.
8. Platform-admin actions land in `PlatformAuditLog` with reason strings.
9. Pen test passed; no critical findings open > 30 days.
10. Onboarding a new pilot tenant takes < 30 minutes via the platform-admin console.
