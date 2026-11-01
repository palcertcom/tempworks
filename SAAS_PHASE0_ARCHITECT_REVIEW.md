# Phase 0 Architect Review — Strict Pass

**Reviewer stance:** Skeptical senior architect. Goal: surface inconsistencies, gaps, and unsafe assumptions in the eight planning documents **before** any code is written.

**Files reviewed:**
1. `SAAS_CODEBASE_AUDIT.md`
2. `SAAS_DATABASE_MODEL_CLASSIFICATION.md`
3. `SAAS_QUERY_ISOLATION_AUDIT.md`
4. `SAAS_AUTH_RBAC_REDESIGN.md`
5. `SAAS_FRONTEND_REFACTOR_PLAN.md`
6. `SAAS_FILE_STORAGE_SECURITY_PLAN.md`
7. `SAAS_MIGRATION_PLAN.md`
8. `SAAS_IMPLEMENTATION_CHECKLIST.md`

---

## 1. Verdict by Topic

| Topic | Status | Notes |
|---|---|---|
| Shared DB + shared schema + `tenantId` | ✅ Consistent | Uniformly stated; no contradictions |
| Global identity + tenant memberships | ✅ Consistent | Slack/Notion-style model assumed throughout |
| `Tenant` vs `Agency` separation | ⚠️ **Under-specified** | High-level intent is right; mechanics of the split are not fully detailed (backfill rules, the system-agency disposition, whether some "agencies" become tenants vs sub-orgs). Resolved by the new doc `SAAS_AGENCY_TO_TENANT_SPLIT_STRATEGY.md`. |
| Agency-scoped permissions | ⚠️ Partial | `AgencyMembership` defined, `AgencyScopeGuard` defined, but the *enforcement contract* (does the guard inject `agencyId IN (...)` into queries automatically, or do services apply it?) is not fixed. Decision below. |
| Platform Admin model | ✅ Consistent | `PlatformAdmin` + `PlatformPrismaService` + `PlatformAuditLog` consistent across docs |
| JWT shape | ✅ Consistent | `tid`, `mid`, `scp`, `agy`, `pa` consistent. Dual-claim transition mentioned. |
| Tenant switching | ✅ Consistent | `POST /auth/switch-tenant`, host redirect; React Query cache flush |
| Tenant Zero migration | ⚠️ Ambiguous | Migration Plan says "Tenant Zero (one tenant)" in §2.5 but elsewhere implies "one Tenant per existing customer Agency". This is a critical contradiction. Decided below. |
| Storage security | ✅ Consistent | Private ACL + signed URLs + tenant prefix uniformly |
| Reports isolation | ✅ Consistent | Highest-risk surface; refactor of `SOURCE_DEFS` |
| Scheduler isolation | ✅ Consistent | BullMQ per-tenant fanout; legacy parallel-run for one week |
| RLS strategy | ⚠️ Gap | `SET LOCAL app.tenant_id` only works inside a transaction. Many Prisma operations are non-transactional by default. **This is a runtime correctness risk** and must be fixed in Phase 0 design. |
| Unique constraints | ✅ Consistent | Tenant-leading composite uniqueness across docs |
| Frontend bootstrap contract | ⚠️ Endpoint dependency | `getSignedAssetUrl()` depends on `GET /api/v1/files/sign?d=<docId>` which is mentioned in Storage Plan but **not** listed in the Implementation Checklist as a Phase 3 backend deliverable. Add ticket. |

---

## 2. Inconsistencies & Gaps (Numbered, Authoritative)

### I-1. "Tenant Zero" semantics: ONE tenant or N tenants?

- **Files:** `SAAS_MIGRATION_PLAN.md` §1 ("Tenant Zero (4 wks): existing org runs in multi-tenant code paths") **vs** §2.2 / §2 Phase 2 ("Provision Tenant Zero(s): one Tenant per existing customer Agency"). `SAAS_IMPLEMENTATION_CHECKLIST.md` §2B says "Provision Tenant Zero(s): one Tenant per existing customer Agency".
- **Problem:** "Tenant Zero" implies a single tenant, while the actual backfill must create one Tenant per customer Agency. The misnomer will confuse engineers and ops.
- **Correct decision:** Use **two distinct terms**:
  - **"Multi-tenant cutover"** — the moment when `MULTI_TENANT_ENABLED=true`.
  - **"Tenant backfill"** — the data step that creates one `Tenant` per existing customer `Agency`.
  Drop the "Tenant Zero" label entirely; it is misleading because there is no single zero tenant.
- **Recommended correction:** Search-and-replace "Tenant Zero" → "Tenant Backfill" in Migration Plan and Implementation Checklist (deferred to a follow-up edit pass; for now, this review is the single source of truth).

### I-2. RLS + `SET LOCAL` requires transactional context

- **Files:** `SAAS_DATABASE_MODEL_CLASSIFICATION.md` §L; `SAAS_QUERY_ISOLATION_AUDIT.md` (mentions `SET LOCAL`); `SAAS_MIGRATION_PLAN.md` §2.1.
- **Problem:** `SET LOCAL app.tenant_id = '<uuid>'` only persists for the **current transaction**. Most Prisma calls are issued **outside** an explicit transaction, and PgBouncer in transaction-pooling mode (the recommended default) gives back the connection between statements. As a result, the GUC will not be set when the row-level policies evaluate, and **every tenant-scoped query will fail** under RLS `FORCE`.
- **Correct decision:** Two-part fix.
  1. **Wrap every tenant-scoped operation in a transaction** inside `TenantPrismaService` (`prisma.$transaction(async (tx) => { await tx.$executeRawUnsafe('SET LOCAL app.tenant_id = ...'); return query(args); })`).
  2. **Disallow `connection_pool` mode "transaction"** for the API DB user; use a dedicated session-pooled connection or PgBouncer in `session` mode for any code path that cannot be wrapped in a transaction. Prefer (1).
- **Recommended correction:** Update the `TenantPrismaService` design in Phase 0 to make the transactional wrapping mandatory and the documentation explicit. Captured as ADR-004 and as a Phase 0 ticket.

### I-3. `AgencyScopeGuard` enforcement contract not pinned

- **Files:** `SAAS_AUTH_RBAC_REDESIGN.md` §6 (guard sets `req.tenantScope`); `SAAS_QUERY_ISOLATION_AUDIT.md` §2.2 (says scope handled by guard).
- **Problem:** Two different enforcement shapes are implied: (a) guard injects `agency_id IN (…)` into every query automatically (like `tenantId`), or (b) services read `req.tenantScope.agencyIds` and add `where: { agencyId: { in: ... } }` themselves.
- **Correct decision:** **Option (a) is unsafe** because `agencyId` is per-model (some entities don't have it, some have it on a parent). Use **Option (b)** — guard exposes `agencyIds`; services apply via a small helper `applyAgencyScope(where, agencyField, ctx)`. Lint rule enforces presence on every list/read endpoint that targets agency-scoped models.
- **Recommended correction:** Pin Option (b) in ADR-004. Add a static analysis/test that walks tenant-scoped controllers and asserts each list/read calls `applyAgencyScope`.

### I-4. `User.roleId` / `User.agencyId` removal timing

- **Files:** `SAAS_AUTH_RBAC_REDESIGN.md` §1 ("kept nullable as legacy"); `SAAS_MIGRATION_PLAN.md` §3 ("Remove `agencyIsSystem` from JWT. Drop `User.roleId, User.agencyId` (or keep nullable if any reports rely on them)").
- **Problem:** "Or keep nullable" is a non-decision.
- **Correct decision:** **Keep both columns nullable** through Phase 4 to avoid retraining the report engine and any cached frontend artifacts on legacy clients; drop them in Phase 5 once `agencyIsSystem` has been gone for ≥ 2 release cycles. Deprecation comment in schema.
- **Recommended correction:** Captured as ADR-002.

### I-5. Workshop/MaintenanceType/DocumentType/NotificationRule catalog vs tenant overrides

- **Files:** `SAAS_DATABASE_MODEL_CLASSIFICATION.md` §F/§H; `SAAS_CODEBASE_AUDIT.md` §1 (rows A8/A9/A12).
- **Problem:** "Catalog + tenant overrides" is correctly named in the classification doc but no concrete data model is given (override resolution order, fallback semantics). Without that, services will diverge.
- **Correct decision:** A single table with `tenantId` nullable. `tenantId IS NULL` rows are the system catalog (read-only from tenant code). Resolution order at query time: tenant-owned row by `(tenantId, key)` first; falls through to `(NULL, key)` if missing. `@@unique([tenantId, key])` (with NULLS NOT DISTINCT) covers both.
- **Recommended correction:** Document the resolution helper in ADR-004 §"Catalog Lookup". Tickets to follow in Phase 3, not Phase 0.

### I-6. `AgencyUserPermission` migration is hand-waved

- **Files:** `SAAS_DATABASE_MODEL_CLASSIFICATION.md` §C ("Migrate to `MembershipRole` overrides + retain table for fine-grained per-user grants (rename `MembershipPermission`)").
- **Problem:** Two competing actions ("migrate to MembershipRole" and "retain and rename") are conflated. Engineers will not know what to ship.
- **Correct decision:** **Retain** the table; **rename** the columns to point at `membershipId` (not `userId`); **add** `tenantId`. Keep it as a per-membership permission override layer (additive grants beyond role permissions). Roles still come from `MembershipRole`; this table is for exceptions.
- **Recommended correction:** Captured in ADR-002.

### I-7. `WorkflowAccessUser` and "system templates" interaction

- **Files:** `SAAS_DATABASE_MODEL_CLASSIFICATION.md` §G.
- **Problem:** If a workflow is a system template (`tenantId = NULL`, read-only), how do `WorkflowAccessUser` rows behave? Can templates have access lists?
- **Correct decision:** System templates are **public read** to all members of all tenants. `WorkflowAccessUser` only applies to **tenant-owned** workflows. Adding a row with `workflowId` referencing a template is rejected at write time.
- **Recommended correction:** Note this in ADR-004; Phase 3 ticket adds the check.

### I-8. `Workshop` backfill semantics

- **Files:** `SAAS_DATABASE_MODEL_CLASSIFICATION.md` §F.
- **Problem:** The model is currently global and shared across all customers. Promoting it to TENANT requires a decision on what to do with existing rows.
- **Correct decision:** Workshops today are tied to vehicles by `Vehicle.agencyId` indirectly. At backfill, create a workshop **per tenant** by copying the global rows referenced by that tenant's vehicles. Drop unreferenced rows.
- **Recommended correction:** Phase 3 ticket; flagged in this review for traceability.

### I-9. Frontend depends on backend `/files/sign` endpoint not in checklist

- **Files:** `SAAS_FRONTEND_REFACTOR_PLAN.md` §3.3; `SAAS_FILE_STORAGE_SECURITY_PLAN.md` §3.2.
- **Problem:** The Implementation Checklist Phase 3B mentions the endpoint loosely ("Signed-URL endpoint"), but does not pin the URL or response schema, and the Frontend Plan tasks already reference it.
- **Correct decision:** Endpoint is `GET /api/v1/files/sign?d=<documentId>` returning `{ url, expiresAt }`. Belongs to `documents` module; the API contract must be merged before frontend Phase 4 begins.
- **Recommended correction:** Add a ticket to Phase 3B explicitly named "ship `/files/sign` v1 contract".

### I-10. BullMQ worker tenant rehydration is under-specified

- **Files:** `SAAS_MIGRATION_PLAN.md` §3 (3.C); `SAAS_QUERY_ISOLATION_AUDIT.md` §2.6.
- **Problem:** The plan says "Worker rehydrates ALS context, uses `tenantPrisma`" but doesn't say *where* the rehydration happens. If left to ad-hoc service code, every worker will reinvent it.
- **Correct decision:** A single `TenantAwareJobProcessor` base class wraps the BullMQ `process()` callback in `als.run({ tenant, user }, () => …)`. All tenant-aware workers extend this base. Lint rule disallows direct `@Processor` without extending the base.
- **Recommended correction:** Phase 0 includes a ticket to define the base class signature; full implementation lands in Phase 3.

### I-11. PII redaction in logs is asserted but not implemented

- **Files:** `SAAS_MIGRATION_PLAN.md` §7.5 mentions "PII redacted at source"; no other doc concretizes.
- **Problem:** Without a redaction layer, audit logs and request logs will leak emails, IDs, and document filenames into shared log infrastructure — cross-tenant data smell.
- **Correct decision:** Add a structured-logger middleware (Pino) with a fixed deny-list of fields and a key-name regex. Document fields explicitly: `email`, `passwordHash`, `nationalId`, `bankAccount`, `passportNumber`, `addressLine*`. Bodies of mutating endpoints are not logged by default.
- **Recommended correction:** Phase 5 (security hardening). Flagged here for visibility.

### I-12. Custom-domain TLS edge cases

- **Files:** `SAAS_CODEBASE_AUDIT.md` §2; `SAAS_AUTH_RBAC_REDESIGN.md` §11; `SAAS_MIGRATION_PLAN.md` Phase 4.
- **Problem:** Cert provisioning lag, DNS verification failure modes, and apex-vs-subdomain CNAME limitations are not addressed.
- **Correct decision:** Custom domains require subdomain CNAME (no apex `A`-record support). Provide a customer-facing UI page that polls verification status. During provisioning lag, serve a maintenance page from the wildcard cert host with a clear message. Captured for Phase 4; not a Phase 0 blocker.

### I-13. Identifier sequence backfill timing vs new inserts

- **Files:** `SAAS_DATABASE_MODEL_CLASSIFICATION.md` §J; `SAAS_IMPLEMENTATION_CHECKLIST.md` Phase 2A.
- **Problem:** During the window between (a) adding `tenantId` to `IdentifierSequence` and (b) flipping all writers to use the new key, two writers could collide on the old `(prefix, year, month)` key.
- **Correct decision:** Take a brief write-lock window: deploy a code change that **first** writes against the new `(tenantId, prefix, year, month)` key while the old `(prefix, year, month)` constraint still exists. Reads keep working from either. After the migration verifies counters match, drop the old constraint. Use a Postgres advisory lock keyed by tenant during cutover for safety.

### I-14. Public ACL flip ordering

- **Files:** `SAAS_FILE_STORAGE_SECURITY_PLAN.md` §4 (Steps 3 + 4).
- **Problem:** "Step 3 — Flip ACL" precedes "Step 4 — Frontend cutover." If FE is still using direct public URLs at Step 3, every existing image/document breaks.
- **Correct decision:** Reverse the order: Frontend cutover (`getSignedAssetUrl`) ships first to all clients (tracked via release version), then per-tenant ACL flip. Add a metric: "% of asset requests using signed URLs" — must be ~100% before flip.
- **Recommended correction:** Edited into Storage Plan in a follow-up; tracked in this review.

### I-15. JWT key rotation procedure not pinned

- **Files:** `SAAS_AUTH_RBAC_REDESIGN.md` §13 mentions `kid` rotation; no procedure.
- **Problem:** Rotation is a known operational hazard (locks users out if both keys aren't accepted).
- **Correct decision:** JWKS endpoint serves both old and new keys for at least one refresh-token TTL (30 days). New tokens minted with new key; old tokens accepted until expiry. Captured in ADR-002.

### I-16. Tenant resolution cache TTL & invalidation not specified

- **Files:** `SAAS_AUTH_RBAC_REDESIGN.md` §8.
- **Problem:** Redis-cached tenant lookup with no stated TTL or invalidation. Stale data after slug change → wrong-tenant routing.
- **Correct decision:** TTL 5 min; explicit invalidation on `Tenant.update`, `TenantDomain.upsert`, or status change via Redis pub/sub. Slugs immutable after first 30 days (already in DB classification §A).

### I-17. Slug reservation & validation

- **Files:** `SAAS_IMPLEMENTATION_CHECKLIST.md` Phase 0 ("reserve `platform`, `admin`, `www`, `api`").
- **Problem:** No validation rules listed (length, charset, profanity, RFC 1035 compliance).
- **Correct decision:** Slugs match `^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])?$`, lowercased, must not match a reserved list. Reserved set codified in the codebase (`backend/src/modules/tenancy/reserved-slugs.ts`), not in DB.

### I-18. `RolePermission` cascade behavior with tenant-owned roles

- **Files:** `SAAS_AUTH_RBAC_REDESIGN.md` §1 (schema).
- **Problem:** When a tenant role is deleted, `RolePermission` rows go with it (`onDelete: Cascade`). But what about `MembershipRole` rows? If `MembershipRole` cascades from `Role`, deleting a role mass-removes assignments without warning.
- **Correct decision:** `MembershipRole.role` uses `onDelete: Restrict`. UI requires the admin to unassign or migrate before delete.

### I-19. Recycle-bin cross-tenant restore risk

- **Files:** `SAAS_QUERY_ISOLATION_AUDIT.md` §2.13.
- **Problem:** "Restore must verify tenantId match" is correct but the actual recycle-bin model fields (`entityType`, `entityId`, `data: jsonb`?) aren't enumerated, so the verification path isn't designed.
- **Correct decision:** Recycle bin gets `tenantId` directly + a `payload` JSON snapshot. Restore opens a transaction, verifies `payload.tenantId === ctx.tenantId`, re-inserts via `tenantPrisma`, deletes the bin row.

### I-20. SystemSetting branding migration leaves `branding_*` keys

- **Files:** `SAAS_DATABASE_MODEL_CLASSIFICATION.md` §H; `SAAS_IMPLEMENTATION_CHECKLIST.md` Phase 3E.
- **Problem:** "kept read-only during transition" — but for which tenant? `SystemSetting` is global; promoting per-tenant means writes during the transition could leak across tenants.
- **Correct decision:** During the transition, the **API surface** for branding writes is removed entirely (only reads work, and only for the legacy single-tenant); new writes go to `Tenant.branding`. After all clients read from `/bootstrap`, drop `branding_*` keys from `SystemSetting`.

---

## 3. Themes Across Inconsistencies

1. **Operational details inferred but not pinned** — TTLs, ordering, caches, locks. These are exactly the items that fail in production. Phase 0 must lock them down via ADRs and tickets.
2. **Two-mode plans** ("either/or") have appeared twice (`AgencyUserPermission`, `User.roleId` removal). Both are decided here.
3. **The biggest correctness hazard** is RLS + `SET LOCAL` in non-transactional Prisma calls. This must be addressed in the very design of `TenantPrismaService`.
4. **The biggest semantic hazard** is the Tenant-vs-Agency split. Without a written split rule, backfill will produce inconsistent data. Resolved by `SAAS_AGENCY_TO_TENANT_SPLIT_STRATEGY.md`.

---

## 4. Decisions Locked by This Review

| # | Decision | Captured in |
|---|---|---|
| D-1 | Drop "Tenant Zero" terminology; use "Tenant Backfill" | This doc |
| D-2 | `TenantPrismaService` wraps every tenant-scoped op in `$transaction` to set GUC for RLS | ADR-004 |
| D-3 | API DB role uses session-mode pooling for any non-transactional admin path; transaction-mode otherwise | ADR-004 |
| D-4 | `AgencyScopeGuard` exposes `agencyIds`; services apply via `applyAgencyScope(where, field, ctx)` helper | ADR-002 / ADR-004 |
| D-5 | `User.agencyId` / `User.roleId` kept nullable as legacy through Phase 4; dropped in Phase 5 | ADR-002 |
| D-6 | Catalog tables resolve `tenantId IS NULL` first as system catalog, then per-tenant overrides | ADR-004 |
| D-7 | `AgencyUserPermission` retained; renamed to `MembershipPermissionOverride`; columns repointed to `membershipId`; `tenantId` added | ADR-002 |
| D-8 | `MembershipRole.role` `onDelete: Restrict` | ADR-002 |
| D-9 | System templates (`Workflow.tenantId IS NULL`) public-read; `WorkflowAccessUser` only valid on tenant-owned workflows | ADR-004 |
| D-10 | `Workshop` backfilled per-tenant from referenced vehicles; orphans dropped | This doc + Phase 3 ticket |
| D-11 | `/files/sign` v1 contract: `GET /api/v1/files/sign?d=<documentId>` → `{ url, expiresAt }` | ADR-006 |
| D-12 | `TenantAwareJobProcessor` base class is mandatory for tenant-aware queues | ADR-004 |
| D-13 | Frontend signed-URL cutover precedes ACL flip; metric gates the flip | ADR-006 |
| D-14 | JWKS exposes both keys for ≥ 30 days during JWT key rotation | ADR-002 |
| D-15 | Tenant resolution cache TTL = 5 min; invalidated via pub/sub | ADR-004 |
| D-16 | Slug regex `^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])?$`; reserved list in code | ADR-004 |
| D-17 | Recycle bin gets `tenantId` and `payload` JSON; restore validated transactionally | ADR-001 |
| D-18 | Branding writes API removed during transition; reads continue from legacy until `/bootstrap` rolled out | ADR-001 |
| D-19 | Identifier-sequence cutover uses Postgres advisory lock per tenant | ADR-001 |
| D-20 | RLS deployment: audit-mode first per table; promote to `FORCE` per-table after 7 days no-violation | ADR-001 |

---

## 5. Phase 0 Critical Path

In order, no item can start before the previous is in motion:

1. **ADRs ratified** (the seven new files) — alignment & decision record.
2. **Feature flags** registered in code (off by default) — `MULTI_TENANT_ENABLED`, `TENANT_PRISMA_ENFORCED`, `RLS_ENFORCED`, `STORAGE_PRIVATE_ACL`, `WORKSPACE_SWITCHER_UI`.
3. **CI guards** in place — ESLint rule, AST scanner allowlist, schema lint, isolation test scaffold (initially zero models tested; framework only).
4. **`TenantPrismaService` skeleton** — implementing the transactional GUC pattern from ADR-004; no models registered yet.
5. **`PlatformPrismaService` skeleton** + DB role provisioning script (separate Postgres role for super-admin path).
6. **Tenant context (ALS) & middleware** — host-based resolver against an empty `Tenant` table; routes that don't require a tenant are explicitly excluded.
7. **New Prisma models added** (`Tenant`, `TenantMembership`, `MembershipRole`, `AgencyMembership`, `MembershipPermissionOverride` (renamed), `PlatformAdmin`, `PlatformAuditLog`, `TenantDomain`) — additive only, no behavior change.
8. **Identity service skeleton & dual-claim JWT** — issuer can mint both old and new claims; verifier accepts both.
9. **Two-tenant fixture utility & isolation test base** — used by every later module migration.

Phase 0 ends without any change to user-visible behavior; flags remain off in production.

---

## 6. Blockers Before Implementation

| # | Blocker | Owner | Resolution |
|---|---|---|---|
| B-1 | ADR-004's transactional Prisma design must be prototyped in spike to confirm performance under PgBouncer | Backend | Time-boxed 2-day spike before ticket TKT-04 |
| B-2 | Choice of PgBouncer pooling mode for the API role (session vs transaction) | DevOps + Backend | Decision in ADR-004; resolved here |
| B-3 | Decision on which existing Agency rows become Tenants vs sub-agencies (split rules) | Product + Backend | `SAAS_AGENCY_TO_TENANT_SPLIT_STRATEGY.md` codifies; product confirmation needed |
| B-4 | Slug strategy for backfilled tenants (derived from Agency name?) | Product | Default: kebab-case of name + uniqueness suffix; product can override by hand |
| B-5 | Reserved-slug list approved | Product | List in code; product reviews PR |
| B-6 | DNS plan for `*.app.tempworks.com` wildcard cert | DevOps | Prerequisite to Phase 2 cutover (not Phase 0) |
| B-7 | Existing `agencyIsSystem` users enumerated (basis for `PlatformAdmin` backfill) | Backend | Run a read-only audit query before Phase 1 ends |
| B-8 | Confirmation that `Applicant.email` non-uniqueness is acceptable (current behavior) | Product | Default: keep non-unique (matches current) |

---

## 7. Risks Surfaced by Review (Newly Promoted to Top-Tier)

- **R-α:** Non-transactional Prisma calls under RLS `FORCE` will fail entire request paths. Mitigation: ADR-004.
- **R-β:** Split-decision drift (Agency → Tenant vs Agency → sub-agency) will produce inconsistent backfill. Mitigation: split-strategy doc + product approval.
- **R-γ:** Identifier collision during cutover window. Mitigation: advisory locks + dual-key transition.
- **R-δ:** ACL flip before frontend cutover ships breaks every image. Mitigation: order reversed in ADR-006.
- **R-ε:** PII in shared logs across tenants. Mitigation: structured logger redaction in Phase 5; flagged Phase 0.
- **R-ζ:** PgBouncer transaction mode incompatible with `SET` (session-level) — only `SET LOCAL` is safe. Mitigation: ADR-004 forbids session-level `SET`.

---

## 8. What This Review Does NOT Decide

- Pricing, plan tiers, billing model — Phase 6 product input required.
- Region selection beyond initial EU — out of Phase 0 scope.
- AI/marketplace — out of scope.
- Specific role taxonomy beyond what already exists — keep current roles, evolve in Phase 3.
- Tenant onboarding self-service vs admin-provisioned — Phase 2/4 product decision.
