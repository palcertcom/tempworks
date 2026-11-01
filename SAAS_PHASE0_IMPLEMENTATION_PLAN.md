# Phase 0 Implementation Plan

**Scope:** Foundations only. **No runtime behavior change.** Production users see exactly today's behavior at the end of Phase 0. Every new capability is gated by a feature flag set to `false`.

**Duration:** 4–6 weeks.

**Workstreams:**

1. ADRs & policies
2. Feature flags
3. Schema foundations (additive; new tables only; no `tenantId` on existing models yet)
4. Tenant context infrastructure (ALS, middleware)
5. Prisma safety infrastructure (`TenantPrismaService`, `PlatformPrismaService` skeletons)
6. CI safety guards (lint, AST scan, schema lint, isolation test scaffold)
7. Test harness (two-tenant fixture; isolation matcher)
8. Identity service skeleton & dual-claim JWT (no production cutover)

---

## 1. Workstream Goals

### 1.1 ADRs & Policies (locks decisions before code)
- Ratify ADR-001 … ADR-007.
- Codify reserved-slug list and slug regex in a constants file (no runtime use yet).

### 1.2 Feature Flags (off in prod)
- Flags: `MULTI_TENANT_ENABLED`, `TENANT_PRISMA_ENFORCED`, `RLS_ENFORCED`, `STORAGE_PRIVATE_ACL`, `WORKSPACE_SWITCHER_UI`, `DUAL_CLAIM_JWT`.
- Implementation: env-driven via existing config module (no new infra). Flag defaults documented in `backend/src/common/feature-flags/feature-flags.ts`.

### 1.3 Schema Foundations
- Add new models **only**. No edits to existing tables. No `tenantId` columns on legacy tables yet.
- New: `Tenant`, `TenantMembership`, `MembershipRole`, `AgencyMembership`, `MembershipPermissionOverride`, `PlatformAdmin`, `PlatformAuditLog`, `TenantDomain`.
- Migration: a single Prisma migration that creates these tables; reversible.

### 1.4 Tenant Context Infrastructure
- AsyncLocalStorage store: `RequestContext = { tenant?, user?, requestId }`.
- `TenantMiddleware` skeleton with three resolution strategies (custom domain → subdomain → header), plus a `PUBLIC_ROUTES_NO_TENANT` allowlist.
- Behavior: when `MULTI_TENANT_ENABLED=false`, middleware is a no-op (sets `tenant=null`).

### 1.5 Prisma Safety Infrastructure
- `TenantPrismaService`: a Prisma `$extends`-based wrapper that, when `TENANT_PRISMA_ENFORCED=true`, opens a transaction, executes `SET LOCAL app.tenant_id`, injects `tenant_id` into args, runs the operation. When the flag is false, it is a thin pass-through to the underlying Prisma client.
- `PlatformPrismaService`: separate Prisma instance bound to a separate Postgres role (`platform_admin`); skeleton only — no consumers in Phase 0.
- Custom Prisma generator stub that emits `TENANT_SCOPED_MODELS = []` (empty in Phase 0 — populated in Phase 2 as models get `tenantId`).

### 1.6 CI Safety Guards
- ESLint rule `no-direct-prisma`: forbid importing `PrismaClient` outside `backend/src/infra/prisma/*` and `backend/src/modules/identity/*`. Allowlist file checked into repo.
- AST scanner: `pnpm scan:tenant-safe` walks `backend/src` and flags `prisma.<model>.` outside the allowlist.
- Schema lint: a small script run from CI that parses `schema.prisma` and asserts: any `@@unique([..., tenantId])` is paired with a leading-`tenantId` index; any model with a `tenantId` field has at least one composite index that leads with it.
- Migration lint: a CI script that parses each new Prisma migration and warns if it adds a `UNIQUE` constraint that does not include `tenant_id` on a tenant-scoped model. (Tenant-scoped models list is the same as `TENANT_SCOPED_MODELS` — empty in Phase 0; warnings begin in Phase 2.)

### 1.7 Test Harness
- `backend/test/tenant-isolation/` — Jest setup utilities:
  - `createTenantWithFixtures(label)` — provisions a `Tenant` row + 1 admin membership + 1 sample agency.
  - `runAs(tenant, fn)` — sets ALS to that tenant for the duration.
  - `expectNoLeakage(modelName, tenants)` — generic matcher using `TENANT_SCOPED_MODELS`.
- A first sample test that runs against the empty `Tenant` table to validate the harness.

### 1.8 Identity Service Skeleton & Dual-Claim JWT
- `IdentityService` (skeleton): `authenticate(email, password)`, `listMemberships(userId)`. Does not change login flow yet.
- JWT issuer updated to **also** emit new claims `tid`, `mid`, `scp`, `agy`, `pa` **alongside** legacy `agencyId`, `agencyIsSystem`. New claims are no-ops when `MULTI_TENANT_ENABLED=false`. Verifier accepts both shapes.
- New JWKS endpoint exposes both keys (key rotation pre-wired). No prod rotation in Phase 0.

---

## 2. Phase 0 Acceptance Gate

Phase 0 is "done" when **all** of the following are true:

1. ADR-001 … ADR-007 are merged and marked `Accepted`.
2. New tables exist in dev/staging; production migration is approved but not yet applied (or applied with no consumers).
3. All flags exist; all default to `false`; flipping them in dev produces the documented behavior.
4. `pnpm scan:tenant-safe` passes on `main` and is required on PRs.
5. `pnpm test:isolation` runs (passes trivially with empty model list).
6. JWT issuer emits dual claims under `DUAL_CLAIM_JWT=true`; verifier accepts both. Validated in dev only.
7. **No production behavior has changed.** A canary deploy proves it.

---

## 3. Out of Scope (Defer)

- Adding `tenantId` to existing models — Phase 2.
- RLS policies on existing tables — Phase 2 audit-mode, Phase 3 `FORCE`.
- Backfill of memberships — Phase 2.
- Frontend `TenantContext`, `WorkspaceSwitcher` — Phase 4.
- Storage ACL flip — Phase 3 (frontend cutover precedes flip).
- Reports engine refactor — Phase 3.
- Notifications scheduler refactor — Phase 3.

---

## 4. Phase 0 Risks (after the architect review)

| Risk | Likelihood | Mitigation |
|---|---|---|
| `TenantPrismaService` transactional pattern hurts perf under PgBouncer | Medium | 2-day spike (TKT-04a) before TKT-04 lands |
| Prisma generator emitting `TENANT_SCOPED_MODELS` is brittle | Low | Use a simple JSON manifest checked into repo; generator just reads it |
| Dual-claim JWT issuer rejected by existing verifier | Medium | Verifier accepts both shapes from day one |
| ESLint rule too strict, breaks existing imports | Medium | Start with `--warn`, flip to `--error` after one PR cycle |
| Schema lint false positives | Low | Allowlist exceptions per-model |

---

## 5. Cross-Cutting Phase 0 Conventions

- All new files live under `backend/src/infra/`, `backend/src/common/`, or `backend/src/modules/{tenancy,identity,platform-admin}/`.
- All new code is **dead code in production** until flags flip.
- All new tables have `createdAt`, `updatedAt` (where applicable), and `id` (UUID v7 preferred where supported).
- Migrations are single-purpose and reversible (`up`/`down`).
- Every Phase 0 ticket links back to its ADR and its acceptance test.
