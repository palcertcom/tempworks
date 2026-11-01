# SaaS Migration Plan — Tempworks

**Strategy:** Strangler / expand-contract. Every database change is additive first, contractive last. Every code change is feature-flagged (`MULTI_TENANT_ENABLED`, `RLS_ENFORCED`, `TENANT_ISOLATION_TESTS_REQUIRED`). The current single-tenant behavior remains functional throughout Phases 0–2 by treating the legacy customer dataset as **Tenant Zero**.

---

## Phase 0 — Preparation (4–6 weeks)

**Goal:** Land the scaffolding without changing runtime behavior.

### 0.1 Codebase Inventory (already produced)

- `SAAS_CODEBASE_AUDIT.md`
- `SAAS_DATABASE_MODEL_CLASSIFICATION.md`
- `SAAS_QUERY_ISOLATION_AUDIT.md`
- `SAAS_AUTH_RBAC_REDESIGN.md`
- `SAAS_FRONTEND_REFACTOR_PLAN.md`
- `SAAS_FILE_STORAGE_SECURITY_PLAN.md`

### 0.2 ADRs to Write

| ADR | Decision |
|---|---|
| ADR-001 | `User.email` global unique (login is global) |
| ADR-002 | Email uniqueness on `Employee` is `(tenantId, email)`; `Applicant.email` non-unique |
| ADR-003 | `DocumentType` / `MaintenanceType` / `NotificationRule` = catalog + per-tenant overrides |
| ADR-004 | `Workflow` system templates; clone-on-use into tenant |
| ADR-005 | `AuditLog` per-tenant + separate `PlatformAuditLog` for super-admin actions |
| ADR-006 | `IdentifierSequence` keyed by `(tenantId, prefix, year, month)` |
| ADR-007 | Per-tenant export is a **separate** path from `pg_dump` backups |
| ADR-008 | Branding moves to `Tenant.branding`; `SystemSetting branding_*` deprecated |
| ADR-009 | Subdomain primary; custom domain in Phase 4 |
| ADR-010 | `agencyIsSystem` retired — replaced by `PlatformAdmin` table + `PlatformPrismaService` |
| ADR-011 | RLS enabled in audit mode in Phase 2; `FORCE` enabled in Phase 3 |
| ADR-012 | Tenants pinned to a region at provisioning |

### 0.3 Feature Flags to Create

- `MULTI_TENANT_ENABLED` (server-side; gates new login flow & guards)
- `TENANT_PRISMA_ENFORCED` (gates the wrapped Prisma client; off → legacy direct prisma)
- `RLS_ENFORCED` (off → audit-only; on → policy `FORCE`)
- `STORAGE_PRIVATE_ACL` (gates new uploads being private)
- `WORKSPACE_SWITCHER_UI` (frontend)

### 0.4 CI Guards to Add

- ESLint rule: no direct `PrismaClient` outside `infra/prisma/*` (allowlist).
- AST grep: any new file using `prisma.<model>.` requires `// tenant-safe: <reason>` comment OR uses `tenantPrisma.client`.
- Test job: `pnpm test:isolation` — runs two-tenant fixture, asserts no leakage per model.
- Schema lint: every new model with a `tenantId` field must have `@@index([tenantId, ...])`.
- Migration lint: every new `@unique` containing tenant-relevant columns must include `tenantId`.

---

## Phase 1 — Core Tenancy Foundation (4 weeks)

**Goal:** Land the new tenancy primitives in code and DB without touching domain modules.

### 1.1 New Database Models (additive only)

Create `Tenant`, `TenantMembership`, `MembershipRole`, `AgencyMembership`, `PlatformAdmin`, `PlatformAuditLog`, `TenantDomain`. None affect existing reads/writes.

### 1.2 Tenant Context Middleware

- `backend/src/common/context/tenant.context.ts` — AsyncLocalStorage store.
- `backend/src/common/middleware/tenant.middleware.ts` — host-based resolution, Redis caching.
- `backend/src/modules/tenancy/tenancy.module.ts` — `TenantService`, `MembershipService`, `TenantDomainService`.

### 1.3 `TenantPrismaService`

- `backend/src/infra/prisma/tenant-prisma.service.ts` — Prisma `$extends` wrapping all operations on tenant-scoped models with `tenant_id` injection and `SET LOCAL app.tenant_id`.
- `backend/src/infra/prisma/platform-prisma.service.ts` — separate client for super-admin, audited.
- `TENANT_SCOPED_MODELS` registry (auto-generated from a Prisma generator).

### 1.4 Membership Model + JWT Update

- `IdentityService`, `MembershipService`, `JwtService` rewritten.
- New JWT carries `tid`, `mid`, `scp`, `agy`. Legacy claims (`agencyId`, `agencyIsSystem`) remain alongside for one release cycle.
- `JwtAuthGuard` rewritten to validate `tid === ctx.tenantId` and load membership.

### 1.5 Login Changes

- `/auth/login` returns access (single-membership) or `tenant_select` (multi-membership) plus refresh.
- `/auth/switch-tenant` mints new access for the chosen tenant.
- `/auth/me` upgraded to return memberships + permissions.
- `/api/v1/bootstrap` introduced (read-only, returns tenant + branding + featureFlags + memberships).

### 1.6 Acceptance Gate

- Tests cover: membership invite, accept, switch, suspend.
- `MULTI_TENANT_ENABLED=false` in prod (foundations dormant).

---

## Phase 2 — Tenant Zero Migration (4 weeks)

**Goal:** Promote the existing dataset into a single tenant; flip codepaths to tenant-aware.

### 2.1 Schema Expansion (expand-contract)

For each TENANT-scoped model in `SAAS_DATABASE_MODEL_CLASSIFICATION.md`:

1. `ALTER TABLE <t> ADD COLUMN tenant_id UUID;`  *(nullable initially)*
2. Backfill `tenant_id`:
   - Provision **Tenant Zero** (`slug = 'tempworks-prod'`, region `eu`).
   - For models with `agencyId`: `UPDATE <t> SET tenant_id = (SELECT tenant_id_from_agency_mapping)` — initial mapping is **one tenant per existing customer Agency**, with the Tempworks `isSystem=true` agency excluded (its users become PlatformAdmins).
   - For derived models (Document, ComplianceAlert, FinancialRecord): backfill from parent entity in batches of 5k rows.
3. `ALTER TABLE <t> ALTER COLUMN tenant_id SET NOT NULL;` (after backfill)
4. Add new composite indexes (`CREATE INDEX CONCURRENTLY`).
5. Add new tenant-scoped unique constraints; **drop** old global ones (`DROP INDEX CONCURRENTLY`).
6. Enable RLS in **audit mode** (logs but does not enforce):
   ```sql
   ALTER TABLE <t> ENABLE ROW LEVEL SECURITY;
   -- policies defined; FORCE not yet applied
   ```

### 2.2 Identifier-Sequence Backfill (CRITICAL)

- Per-tenant counters initialized at the maximum existing identifier per `(prefix, year, month)`.
- Switch to `(tenantId, prefix, year, month)` upsert. Verify two tenants can issue overlapping identifiers without collision.

### 2.3 Membership Backfill

- Each existing user receives one `TenantMembership` (status=ACTIVE) for their existing customer agency's tenant.
- A `MembershipRole` is created cloning the user's existing `User.roleId`.
- Tempworks staff (`Agency.isSystem = true`) → `PlatformAdmin` rows.

### 2.4 Code Cutover (per module, behind flag)

- Each module's repository / service is migrated to `tenantPrisma.client.<model>...`.
- Remove ad-hoc `if (actor.agencyId) where.agencyId = ...` branches — handled by the wrapper.
- Verify by toggling `TENANT_PRISMA_ENFORCED=true` in staging.

### 2.5 Storage Prefix Backfill

- Background job copies each existing object into its tenant-prefixed key (server-side S3 copy).
- Updates DB `storageKey` references.
- See `SAAS_FILE_STORAGE_SECURITY_PLAN.md` §4.

### 2.6 Acceptance Gate

- All existing E2E tests pass with `MULTI_TENANT_ENABLED=true` and `TENANT_PRISMA_ENFORCED=true`.
- Two-tenant isolation tests pass for **all** TENANT-scoped models.
- Performance regression < 10% on hot endpoints (verified via load test against staging-with-replica).

---

## Phase 3 — Module-by-Module Refactor & Hardening (8–12 weeks)

**Goal:** Eliminate every legacy bypass; turn RLS on `FORCE`; harden public surfaces.

For each module, the refactor template is:

```
1. List queries (already in SAAS_QUERY_ISOLATION_AUDIT.md)
2. Replace direct prisma → tenantPrisma
3. Drop `actor.agencyId` checks where redundant
4. Add @RequirePermission to every controller method
5. Add @Audit to every mutation
6. Write 2-tenant isolation test (must fail before refactor; pass after)
7. Migrate storage keys for any module-owned files
```

Modules in priority order (highest leakage / blast radius first):

| # | Module | Files | Models touched |
|---|---|---|---|
| 1 | `reports` | `reports.service.ts` (`SOURCE_DEFS`, `runReport`) | every reportable model — must inject `tenant_id` in every base query |
| 2 | `documents` | `documents.service.ts`, `documents.controller.ts` | Document, denorm `tenantId` |
| 3 | `notifications` (+ scheduler) | `notifications.service.ts`, `notifications-scheduler.service.ts` | Notification, NotificationPreference; refactor to BullMQ tenant-fanout |
| 4 | `applicants` | `applicants.service.ts` | Applicant, drafts, financial profiles, agency history |
| 5 | `employees` | `employees.service.ts` | Employee, EmployeeStage, work history, work permits |
| 6 | `compliance` | `compliance.service.ts` | ComplianceAlert |
| 7 | `finance` | `finance.service.ts` | FinancialRecord |
| 8 | `attendance` | `attendance.service.ts` | AttendanceRecord, AttendanceLockedPeriod |
| 9 | `vehicles` | `vehicles.service.ts` | Vehicle, MaintenanceRecord, Workshop |
| 10 | `workflow` / `pipeline` | `workflow.service.ts` | Workflow, WorkflowStage, assignments |
| 11 | `job-ads` | `job-ads.service.ts`, `job-ads.controller.ts` | JobAd, public route refactor |
| 12 | `agencies` | `agencies.service.ts` | Agency, AgencyMembership |
| 13 | `users` / `roles` | identity refactor | User, Role, MembershipRole |
| 14 | `recycle-bin` | `recycle-bin.service.ts` | restore validation |
| 15 | `logs` | `audit-log.service.ts` | AuditLog tenant-aware |
| 16 | `backup` | `backup.service.ts` | platform-only; introduce `TenantExport` |
| 17 | `settings` | `settings.service.ts` | move branding to Tenant |

### 3.1 RLS Cutover

After all modules pass isolation tests:

```sql
ALTER TABLE <t> FORCE ROW LEVEL SECURITY;
```

Roll per-table over a week; monitor for `permission denied` errors.

### 3.2 Platform-Admin Console

- `modules/platform-admin/` — separate route prefix `/_platform`.
- Uses `PlatformPrismaService`; each call requires a `reason: string` and writes `PlatformAuditLog`.
- Step-up MFA at the entry; session expires aggressively (30 min).

### 3.3 Acceptance Gate

- Internal red-team: attempt cross-tenant access from a Tenant-A session against Tenant-B IDs across all modules.
- Pentest report (third party).
- All `agencyIsSystem` references removed.

---

## Phase 4 — Frontend SaaS Refactor (concurrent with Phase 3)

See `SAAS_FRONTEND_REFACTOR_PLAN.md`. Sequence inside Phase 4:

1. `/api/v1/bootstrap` endpoint live.
2. `TenantProvider` and `MembershipsContext` shipped.
3. `services/api.ts` token model + `getSignedAssetUrl`.
4. `WorkspaceSwitcher` UI.
5. Sidebar role→permission migration.
6. Branding/theme runtime loading.
7. React Query keys gain tenant prefix.
8. Public apply / job-ads page resolve tenant by host.

---

## Phase 5 — Security Hardening (concurrent late Phase 3)

- RLS `FORCE` on all TENANT tables (§3.1 above).
- Audit logging across all modules (`@Audit` interceptor).
- `audit_logs` partitioning (`PARTITION BY HASH (tenant_id)` × 16) — created during Phase 2 schema expansion.
- Tenant-isolation test coverage report ≥ 95%.
- Platform-admin audit dashboard.
- File access security: private ACL across the bucket (§4 of storage plan).
- Pen test + remediation.
- Per-tenant rate limits + quotas (Redis).
- Threat model review per high-risk module (reports, documents, finance).

---

## Phase 6 — SaaS Commercialization (8 weeks)

### 6.1 Billing & Plans

- `Plan`, `Subscription`, `Invoice`, `UsageRecord` (global tables).
- Stripe Billing integration; ACH + card; manual invoice for enterprise.
- `FeatureService.isEnabled(tenantId, key)` — plan + tenant overrides.
- Quotas: `assertWithinQuota('candidates', tenantId)` at write boundaries.

### 6.2 Feature Flags & Gating

- Hierarchical: plan default → tenant override → user override.
- Flags surfaced in `/bootstrap`.

### 6.3 Usage Metering

- `UsageEvent` (kind, tenantId, value, occurredAt) ingested asynchronously.
- Daily rollup job → `UsageRecord` → posted to Stripe.

### 6.4 SSO / SCIM (per Enterprise tenant)

- Per-tenant SAML/OIDC config table.
- JIT provisioning of `User` + `TenantMembership`.
- SCIM endpoint per tenant (token-scoped).

### 6.5 White-label & Custom Domains

- Tenant-managed `customDomain`; cert-manager Certificate resource per verified host.
- DNS verification flow.

---

## Cross-Cutting: Rollback & Risk Controls

| Risk | Control |
|---|---|
| Migration ALTER takes long lock | All schema changes via `CONCURRENTLY` indexes; `ALTER TABLE` only nullable adds; use `pg_repack` for rewrites |
| `tenant_id` backfill causes table bloat | Backfill in batches, then `VACUUM (ANALYZE)` |
| RLS unexpectedly blocks valid query | Audit mode first (logs only); promote per-table over a week |
| JWT shape change locks users out | Dual-claim issuance for one release; key id rotation with two keys live |
| Storage flip breaks legacy clients | Frontend cutover precedes ACL flip; retain double-read window |
| Performance regression | Composite-index audit on every model before flag flip; load test against replica |
| Long-running migrations block deploys | Each migration step is reversible; ship behind flag; deploys not gated on backfill completion |
| Reports engine refactor | Two-tenant fixture test for every `SOURCE_DEFS` entry; canary tenants first |
| Platform-admin lockout | Provision `PlatformAdmin` rows BEFORE removing `agencyIsSystem` |
| Notification scheduler outage during BullMQ migration | Run old + new in parallel for one week, dedupe by deterministic notification key |

---

## Parallel-Run Strategy

- **Database**: single DB; both legacy and new code paths read the same tables. The transition is in the **wrapper** (`tenantPrisma`) and the **flag**, not in physical infra.
- **Application**: `MULTI_TENANT_ENABLED=false` keeps the system effectively single-tenant for any pod. Flip per environment: dev → staging → canary → prod.
- **Frontend**: legacy build remains deployable behind `WORKSPACE_SWITCHER_UI=false`. Once on, no feature regression — switcher only appears for users with N memberships.
- **Notifications scheduler**: while BullMQ migration is in progress, both `setInterval` (legacy) and BullMQ (new) run; both write to the same `Notification` table; deduplicate via deterministic `(tenantId, kind, targetId, periodKey)` unique constraint.

---

## Deployment Transition

- Migrations run as part of expand-contract; deploys never wait for backfill.
- Use a **release train** approach: each two-week cycle ships one or two modules' Phase-3 refactor.
- Long-running data migrations (storage backfill, identifier-sequence backfill) run as Kubernetes Jobs on a worker node-pool tagged `migration`.
