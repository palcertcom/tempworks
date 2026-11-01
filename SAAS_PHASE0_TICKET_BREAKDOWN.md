# Phase 0 Ticket Breakdown

Each ticket is sized to ½–3 engineering days. Critical-path tickets are marked **CP**.
Tickets are independent unless `Depends-on` is listed.

> **Convention:** All tickets land **dormant** code (flag-gated). No production behavior changes.

---

## TKT-00 · Phase 0 kickoff & ADR ratification

- **Goal:** Land all seven ADRs as `Status: Accepted` and circulate to engineering + product.
- **Files:** `docs/adr/ADR-001…ADR-007`.
- **Steps:** Open PR with the seven ADRs; collect codeowner reviews; merge.
- **Acceptance:** All ADRs merged. Architect review (`SAAS_PHASE0_ARCHITECT_REVIEW.md`) referenced in PR description.
- **Tests:** N/A (docs).
- **Risk:** None.
- **Rollback:** Revert PR (no runtime impact).

---

## TKT-01 · Feature flags wired (default false) — **CP**

- **Goal:** Six new flags, defaults false, surfaced to backend code & ops.
- **Files:**
  - `backend/src/common/feature-flags/feature-flags.ts` (new)
  - `backend/src/common/feature-flags/feature-flags.module.ts`
  - `.env.example` (document new env vars; **do not** commit `.env`)
- **Steps:**
  1. Create `FeatureFlagsService` with typed accessors:
     `multiTenantEnabled()`, `tenantPrismaEnforced()`, `rlsEnforced()`, `storagePrivateAcl()`, `workspaceSwitcherUi()`, `dualClaimJwt()`.
  2. Read each from `process.env` with defaults `false`.
  3. Inject into `AppModule` global.
- **Acceptance:** Service accessible; switching env var changes return value; one log line at startup prints flag values.
- **Tests:** Unit test default values + env-driven override.
- **Risk:** None.
- **Rollback:** Revert; env vars are unread elsewhere in Phase 0.

---

## TKT-02 · CI guards: lint + AST scan + schema lint — **CP**

- **Goal:** Prevent direct Prisma usage and tenancy-unsafe schema changes from landing.
- **Files:**
  - `.eslintrc.cjs` or `eslint.config.js`
  - `scripts/scan-tenant-safe.ts` (new)
  - `scripts/schema-lint.ts` (new)
  - `package.json` (root) — add `scan:tenant-safe`, `schema:lint` npm scripts
  - `.github/workflows/ci.yml` (or equivalent) — add jobs
- **Steps:**
  1. Add ESLint `no-restricted-imports` rule for `@prisma/client` and `**/prisma.service` outside an allowlist:
     - `backend/src/infra/prisma/**`
     - `backend/src/modules/identity/**`
  2. Implement `scan-tenant-safe.ts` (regex on AST output): walks `backend/src/**/*.ts`, flags `prisma.<Model>.` outside allowlist. Exit non-zero on findings.
  3. Implement `schema-lint.ts`: parses `backend/prisma/schema.prisma`; for every model with `tenantId String`, asserts at least one composite index leading with `tenantId`; for every `@@unique` containing tenant-relevant columns, asserts `tenantId` is included.
  4. Wire all three into CI.
- **Acceptance:** Both scripts run green on `main`; deliberately broken PR fails the check.
- **Tests:** Snapshot tests with synthetic source files.
- **Risk:** Medium — false positives. Mitigation: ESLint runs as `warn` for one PR cycle, then `error`.
- **Rollback:** Revert script wiring.

---

## TKT-03 · Two-tenant test harness — **CP**

- **Goal:** Reusable Jest utilities for tenant-isolation tests.
- **Files:**
  - `backend/test/tenant-isolation/setup.ts` (new)
  - `backend/test/tenant-isolation/fixtures.ts` (new)
  - `backend/test/tenant-isolation/example.test.ts` (new — sanity check)
  - `package.json` (backend) — `test:isolation` script
- **Steps:**
  1. `createTenantWithFixtures(label)` — uses `PrismaClient` directly (allowlisted) to seed a Tenant + admin user + admin membership + 1 agency.
  2. `runAs(tenant, fn)` — sets ALS context for the closure.
  3. `expectNoLeakage(modelName, tenants[])` — placeholder; iterates models when populated.
  4. One example test that creates two tenants, asserts visibility on `Tenant` and `TenantMembership` only.
- **Acceptance:** `pnpm test:isolation` passes; example test runs in < 5s.
- **Tests:** Self-tested by the example.
- **Risk:** Low.
- **Rollback:** Delete the directory.

---

## TKT-04a · Spike — Prisma transactional GUC pattern under PgBouncer (2 days, time-boxed)

- **Goal:** Validate that wrapping every tenant-scoped op in `prisma.$transaction(...)` with `SET LOCAL app.tenant_id` works correctly and within performance budget under PgBouncer transaction-mode pooling.
- **Files:** spike branch only; results recorded in `docs/spikes/SPIKE-prisma-rls-tx.md`.
- **Steps:**
  1. Stand up local Postgres + PgBouncer (transaction mode).
  2. Write a microbenchmark: 10k `findMany` + 10k `create` operations with and without the transactional wrapper.
  3. Compare p50/p95 latency.
  4. Document caveats (e.g. nested transactions, interactive transactions, raw queries).
- **Acceptance:** A short report with measured overhead. Decision: proceed with TKT-04 if overhead < 15%; else design alternative (e.g. session-mode pool for API role).
- **Tests:** N/A.
- **Risk:** If overhead is too high, TKT-04's design must change.
- **Rollback:** Throwaway branch.

---

## TKT-04 · `TenantPrismaService` skeleton — **CP** (Depends-on TKT-04a)

- **Goal:** A flag-gated wrapper that injects `tenantId` and sets the GUC.
- **Files:**
  - `backend/src/infra/prisma/tenant-prisma.service.ts` (new)
  - `backend/src/infra/prisma/tenant-scoped-models.ts` (new — empty array; populated later)
  - `backend/src/infra/prisma/prisma.module.ts` (export it)
- **Steps:**
  1. Implement service that returns a `$extends` client.
  2. When `TENANT_PRISMA_ENFORCED=false`: pass-through.
  3. When `true`: for any operation on a model in `TENANT_SCOPED_MODELS`, open `$transaction`, run `SET LOCAL app.tenant_id = $1`, inject `tenantId` into `args.where` / `args.data`.
  4. Throw `MissingTenantContextError` if ALS has no tenant.
  5. Tests against an in-memory list of mock models.
- **Acceptance:** Unit tests cover all CRUD ops; behavior matches both flag states.
- **Tests:** Unit + integration (one model, two tenants, isolation verified).
- **Risk:** Medium — performance per TKT-04a.
- **Rollback:** Flag stays false; service unused.

---

## TKT-05 · `PlatformPrismaService` skeleton + DB role provisioning — **CP**

- **Goal:** A separate Prisma instance bound to a separate Postgres role, with audit hook.
- **Files:**
  - `backend/src/infra/prisma/platform-prisma.service.ts` (new)
  - `backend/prisma/migrations/<ts>_platform_admin_role/migration.sql` (new — creates the role, grants)
  - `docs/runbooks/platform-admin-db-role.md` (new)
- **Steps:**
  1. Migration: `CREATE ROLE platform_admin NOLOGIN; GRANT ...;` (login granted via separate password-rotated user). RLS bypass policies will be added per table in Phase 3.
  2. `PlatformPrismaService` constructor opens a separate `PrismaClient` with `PLATFORM_DATABASE_URL`.
  3. Every public method requires a `reason: string`; method writes a `PlatformAuditLog` row before returning.
  4. Throws if invoked outside a route guarded by `RequirePlatformAdmin`.
- **Acceptance:** Service exists; calling without a reason throws; audit row written; no consumers in Phase 0.
- **Tests:** Unit (constructor, audit interception).
- **Risk:** Medium — DB role provisioning hits ops; needs sign-off.
- **Rollback:** Revert service; revoke role.

---

## TKT-06 · ALS + RequestContext + TenantMiddleware skeleton — **CP**

- **Goal:** Resolve tenant from host; expose context via ALS.
- **Files:**
  - `backend/src/common/context/als.ts` (new)
  - `backend/src/common/context/request-context.ts` (new — types & helpers)
  - `backend/src/common/middleware/tenant.middleware.ts` (new)
  - `backend/src/common/middleware/public-routes.ts` (new — allowlist)
  - `backend/src/app.module.ts` (wire middleware globally)
- **Steps:**
  1. Define `RequestContext = { tenant?: TenantSnapshot; user?: UserSnapshot; requestId: string }`.
  2. Middleware:
     - Skip if path matches `PUBLIC_ROUTES_NO_TENANT`.
     - When flag off: `als.run({ tenant: null, ... }, next)`.
     - When flag on: resolve tenant by host (Redis-cached, TTL 5 min); 404 if missing/inactive; run.
  3. Helper accessors: `TenantContext.current()`, `UserContext.current()`.
- **Acceptance:** Middleware runs in app; flag gates behavior; e2e test against dev port shows context propagation.
- **Tests:** Unit (middleware), integration (request → context).
- **Risk:** Low.
- **Rollback:** Remove middleware registration; tenant context never set.

---

## TKT-07 · New Prisma models + migration (additive only) — **CP**

- **Goal:** Land schema for `Tenant`, `TenantMembership`, `MembershipRole`, `AgencyMembership`, `MembershipPermissionOverride` (renamed from `AgencyUserPermission`; create new table, leave old table alone), `PlatformAdmin`, `PlatformAuditLog`, `TenantDomain`.
- **Files:**
  - `backend/prisma/schema.prisma` (additions only — do not modify existing models)
  - `backend/prisma/migrations/<ts>_phase0_tenancy_foundations/migration.sql`
- **Steps:**
  1. Add models per `SAAS_DATABASE_MODEL_CLASSIFICATION.md` §A and ADR-002 schema block.
  2. **Do not** touch existing models. **Do not** add `tenantId` columns to existing tables.
  3. Indexes & uniques as documented in classification.
  4. Migration is reversible (`down` drops the tables).
- **Acceptance:** `prisma migrate deploy` clean; tables exist; Prisma client regenerates.
- **Tests:** Migration roundtrip test (apply → revert → reapply).
- **Risk:** Low (purely additive). Do not run on prod until Phase 1 acceptance.
- **Rollback:** `prisma migrate resolve --rolled-back ...` + manual `DROP TABLE` on dev/staging.

---

## TKT-08 · Tenancy module skeleton (`TenantService`, `MembershipService`, `TenantDomainService`)

- **Goal:** Type-safe service layer over the new tables. **No HTTP routes yet.**
- **Files:**
  - `backend/src/modules/tenancy/tenancy.module.ts`
  - `backend/src/modules/tenancy/tenant.service.ts`
  - `backend/src/modules/tenancy/membership.service.ts`
  - `backend/src/modules/tenancy/tenant-domain.service.ts`
  - `backend/src/modules/tenancy/reserved-slugs.ts`
  - `backend/src/modules/tenancy/slug.ts` (validate via regex from architect review §I-17)
- **Steps:**
  1. CRUD methods using `PrismaService` directly (allowlisted): `Tenant.create/findBySlug/findByHost/list`, `TenantMembership.create/find/listForUser/listForTenant/setStatus`, `TenantDomain.upsert/verify`.
  2. Slug validation with reserved set.
  3. Tenant resolution helper: `resolveByHost(host)` (used by TenantMiddleware in TKT-06).
  4. No controllers in Phase 0.
- **Acceptance:** Unit tests cover CRUD; slug regex tests.
- **Tests:** Unit.
- **Risk:** Low.
- **Rollback:** Revert.

---

## TKT-09 · Identity module skeleton & dual-claim JWT issuer

- **Goal:** New JWT shape rolled out **alongside** legacy claims. Verifier accepts both.
- **Files:**
  - `backend/src/modules/identity/identity.module.ts`
  - `backend/src/modules/identity/identity.service.ts`
  - `backend/src/modules/identity/jwt.service.ts` (new — replaces direct `JwtModule` issuance)
  - `backend/src/auth/strategies/jwt.strategy.ts` (modify only the verifier side to accept both shapes — no flow change)
- **Steps:**
  1. `IdentityService.authenticate(email, password)` — wraps existing logic.
  2. `IdentityService.listMemberships(userId)` — returns rows from `TenantMembership`.
  3. `JwtService.issueAccessToken(userId, opts)` — when `DUAL_CLAIM_JWT=true`, also includes `tid`, `mid`, `scp`, `agy`, `pa` (resolved from memberships if any; otherwise null/empty).
  4. `JwtAuthGuard` verifier accepts presence of either old or new claims; if both present, prefers new.
- **Acceptance:** Existing login still works (no behavior change). With `DUAL_CLAIM_JWT=true` in dev, decoded tokens carry both claim sets.
- **Tests:** Unit (issuer in both modes); integration (login with `DUAL_CLAIM_JWT=true` succeeds; token verifies).
- **Risk:** Medium — JWT changes are sensitive. Mitigation: dual-claim only; flag default false.
- **Rollback:** Flag false; new claim emission disabled.

---

## TKT-10 · Custom Prisma generator stub for `TENANT_SCOPED_MODELS`

- **Goal:** Single source of truth for the tenant-scoped model list, consumed by `TenantPrismaService`, schema-lint, and tests.
- **Files:**
  - `backend/prisma/generators/tenant-scoped-models/index.ts` (new — minimal Prisma generator)
  - `backend/prisma/generators/tenant-scoped-models/manifest.json` (new — empty array initially)
  - `backend/prisma/schema.prisma` — add `generator tenantScopedModels { ... }` block
- **Steps:**
  1. Generator reads the manifest; emits `backend/src/infra/prisma/tenant-scoped-models.generated.ts` exporting `TENANT_SCOPED_MODELS: ReadonlyArray<string>`.
  2. Phase 0: manifest is empty.
  3. Phase 2: each model migration adds itself to the manifest.
- **Acceptance:** `prisma generate` regenerates the file; importing it returns `[]`.
- **Tests:** Unit on the generator.
- **Risk:** Low.
- **Rollback:** Remove generator; ship manifest as a hand-maintained `.ts` file.

---

## TKT-11 · `RequirePlatformAdmin` decorator + guard skeleton

- **Goal:** Decorator + guard wired; **no routes use it yet**.
- **Files:**
  - `backend/src/common/decorators/require-platform-admin.decorator.ts`
  - `backend/src/common/guards/platform-admin.guard.ts`
- **Steps:**
  1. Decorator stamps metadata `requirePlatformAdmin: 'SUPPORT' | 'OPERATOR' | 'SUPER'`.
  2. Guard reads metadata; verifies `claims.pa === true` and a `PlatformAdmin` row exists for the user with `level >= required`; checks step-up MFA flag on the session (skeleton: returns false if no `pa_mfa_at` claim recent enough).
  3. Audit interception via `PlatformAuditLog` is a TODO comment (wired in Phase 3 with `PlatformPrismaService`).
- **Acceptance:** Guard exists; one unit test validates metadata reading.
- **Tests:** Unit.
- **Risk:** Low.
- **Rollback:** Remove file.

---

## TKT-12 · Health/ready route hardening

- **Goal:** `/healthz`, `/readyz` are explicitly excluded from Tenant middleware. No regressions.
- **Files:**
  - `backend/src/common/middleware/public-routes.ts` (allowlist)
  - tests
- **Steps:**
  1. Confirm health routes return 200 even when `MULTI_TENANT_ENABLED=true` and host has no tenant.
  2. Document allowlist in README of common module.
- **Acceptance:** Smoke test passes against an unknown host.
- **Tests:** Integration.
- **Risk:** Low.
- **Rollback:** N/A.

---

## TKT-13 · Logging structured request context (foundation only)

- **Goal:** Pino (or current logger) emits `requestId`, `tenantId` (if any), `userId` (if any) on every request. PII redaction added later (Phase 5).
- **Files:**
  - `backend/src/common/logging/request-logger.middleware.ts` (new)
  - `backend/src/main.ts` — wire after Tenant middleware
- **Steps:**
  1. Middleware generates a `requestId` (cuid/uuid v7), stamps into ALS, sets `X-Request-Id` response header.
  2. Logger config reads ALS at log time (Pino with `mixin`).
- **Acceptance:** Local request shows the IDs in logs.
- **Tests:** Unit (middleware), integration (header present).
- **Risk:** Low.
- **Rollback:** Remove middleware.

---

## TKT-14 · Documentation: runbooks & developer onboarding for Phase 0

- **Goal:** Engineers know how to run with flags on locally and what's safe to merge.
- **Files:**
  - `docs/runbooks/saas-flags.md`
  - `docs/runbooks/tenant-aware-development.md`
  - `backend/README.md` — link section
- **Steps:**
  1. How to set each flag locally; which features each unlocks.
  2. How to add a new tenant-scoped model after Phase 2 begins.
  3. How to write isolation tests.
- **Acceptance:** Reviewed by 2 backend engineers.
- **Tests:** N/A.
- **Risk:** None.
- **Rollback:** N/A.

---

## TKT-15 · Pre-flight migration audit queries (read-only)

- **Goal:** Run the read-only checks from `SAAS_AGENCY_TO_TENANT_SPLIT_STRATEGY.md` §2.1 against staging and prod replica; record results.
- **Files:**
  - `backend/scripts/saas/preflight.sql` (new)
  - `docs/saas/preflight-results.md` (results captured here)
- **Steps:**
  1. SQL bundle for the five preflight queries.
  2. Run on staging and a prod replica snapshot.
  3. Identify any duplicate emails, orphan users, or unexpected counts.
- **Acceptance:** Report committed; any blockers escalated to product before Phase 1.
- **Tests:** N/A.
- **Risk:** Read-only — no rollback needed.

---

## Phase 0 Critical Path (sequence)

```
TKT-00  ─▶ TKT-01 ─▶ TKT-02 ─▶ TKT-03
                 │
                 ├─▶ TKT-04a (spike) ─▶ TKT-04 ─▶ TKT-10
                 │
                 ├─▶ TKT-06 ─▶ TKT-08 ─▶ TKT-09
                 │
                 ├─▶ TKT-05 ─▶ TKT-11
                 │
                 └─▶ TKT-07 (anytime after TKT-00)

TKT-12, TKT-13, TKT-14 in parallel.
TKT-15 runs in parallel and gates Phase 1, not Phase 0.
```

---

## Phase 0 Definition of Done

- All TKT-00..15 closed.
- All ADRs `Accepted`.
- CI guards mandatory on PRs.
- Two-tenant test harness usable.
- New schema present; flags off.
- No production behavior change.
- Pre-flight migration report reviewed.
- A canary deploy and a release-candidate build prove that flag-off behavior == today's behavior.
