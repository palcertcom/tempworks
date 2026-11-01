# Phase 0 Runtime Invariants

**Status:** Authoritative for the duration of Phase 0.
**Audience:** Every backend engineer and reviewer.

These invariants describe what *must hold true* in production while Phase 0 is active. They define the line between "safe Phase 0 change" and "out of scope, postpone."

---

## I-1. No tenant resolution at runtime

`TenantContextMiddleware` in `backend/src/saas/context/tenant-context.middleware.ts` is **not registered** in `AppModule`. Tenant context is never populated. Every existing controller, service, and Prisma query continues to receive `req.user` exactly as today.

If you find yourself wanting to attach a tenant snapshot during a request: **don't**. That's Phase 1 (TKT-06).

## I-2. All feature flags default `false`

Six flags exist:

| Flag | Phase 0 default | What it gates |
|---|---|---|
| `MULTI_TENANT_ENABLED` | `false` | Tenant resolution + ALS attach |
| `TENANT_PRISMA_ENFORCEMENT` | `false` | `TenantPrismaService.client` extension |
| `RLS_ENFORCEMENT` | `false` | Postgres `FORCE ROW LEVEL SECURITY` policies |
| `SIGNED_URLS_ENABLED` | `false` | `SignedUrlService.issue()` is callable |
| `TENANT_SWITCHING_ENABLED` | `false` | `/auth/switch-tenant` route active |
| `PLATFORM_ADMIN_ENABLED` | `false` | `PlatformAdminGuard` permits the route |

Setting any of them to `true` in production today will fail loudly (most services throw "not implemented in Phase 0"). This is intentional: incomplete behaviour must not silently activate.

## I-3. The `tenant_id` GUC is never set

The application establishes no Postgres GUC. `current_setting('app.tenant_id', true)` returns `NULL` for every connection. RLS policies (when added in Phase 2) using the spike-validated `NULLIF` template will return zero rows under that condition — which is also the safe default.

## I-4. New schema tables are present (or pending) and unread

The migration `prisma/migrations/saas_phase0_foundations/migration.sql` creates eight new tables:

`tenants`, `tenant_memberships`, `membership_roles`, `agency_memberships`, `membership_permission_overrides`, `platform_admins`, `platform_audit_logs`, `tenant_domains`.

**No production code reads or writes these tables in Phase 0.** They exist so Phase 1 can begin populating them without a schema-migration cycle on the critical path.

The schema delta lives in `prisma/saas-phase0.prisma.append`. It is appended to `schema.prisma` only when an engineer is ready to run `prisma generate` + `prisma migrate dev`. **Do not** auto-append.

## I-5. The legacy `Agency.isSystem` JWT bypass is unchanged

`backend/src/auth/strategies/jwt.strategy.ts:47-59` still emits `agencyId` and `agencyIsSystem`. Removal is a Phase 3 deliverable conditional on `PlatformAdmin` rows being provisioned (per ADR-005).

## I-6. `TenantPrismaService` is a pass-through

When `TENANT_PRISMA_ENFORCEMENT=false` (always, in Phase 0):

```ts
tenantPrisma.client === prismaService
```

There is no overhead, no transaction wrapping, no `tenantId` injection. The wrapper exists only so consumers can be authored against the eventual API.

## I-7. `TENANT_SCOPED_MODELS` is empty

`backend/src/saas/prisma/tenant-scoped-models.ts` exports a frozen empty `Set`. Adding a model to this set is a **Phase 2 act** that requires:

- a corresponding `tenantId` column on the model (via expand-contract migration),
- a composite `(tenantId, …)` index,
- a per-model isolation test under `__validation__/`,
- a PR review by a SaaS code-owner.

## I-8. The Prisma safety scanner is advisory

`pnpm run saas:scan` reports findings; it does **not** fail. Phase 2 promotes it to `--strict`. Phase 0 expectation: scanner output is a snapshot of pre-Phase-2 technical debt, not a regression signal. *Do not* add `// @tenant-reviewed` comments today; that bypass is for Phase 2 review.

## I-9. The new SaaS module is not loaded

`SaasModule` in `backend/src/saas/saas.module.ts` is not imported by `AppModule`. The Nest DI container does not see it. Importing it from a test or pilot integration is the only sanctioned use.

## I-10. The legacy `setInterval` notifications scheduler is unchanged

`backend/src/notifications/notifications-scheduler.service.ts` still runs every 6 hours and scans all data. Migration to BullMQ + `TenantAwareJobProcessor` is Phase 3.

## I-11. Existing `StorageService` continues to issue public-read URLs

`backend/src/common/storage/storage.service.ts` is untouched. Storage objects continue to be uploaded with `ACL: 'public-read'`. The `SignedUrlService` is dormant.

## I-12. ALS frames may be created opportunistically

`RequestIdMiddleware` (when wired in Phase 1) creates an ALS frame containing `{ requestId }` even on routes that have no tenant. This is harmless: services that don't read from ALS see no behaviour change.

## I-13. No additional Postgres roles are required for Phase 0

The migration script creates no Postgres roles. The hypothetical `platform_admin` role used by `PlatformPrismaService` is created in Phase 3. Until then, the service throws.

## I-14. Build artefacts must include the SaaS module

`nest build` compiles `src/saas/**` into `dist/src/saas/**`. This is expected — the code is dormant, not absent. Do not add path exclusions to `tsconfig.build.json`.

## I-15. Validation harness is the source of truth for Phase 0 contracts

`pnpm run saas:validate` runs five suites and must remain green on every PR that touches `src/saas/**`. CI is not yet wired (no CI config in repo) but local execution is required before merge.

---

## How to violate an invariant *deliberately*

If you have a legitimate Phase 0 need to test something flag-on:

1. Set the flag locally (`MULTI_TENANT_ENABLED=true pnpm start:dev`).
2. Expect throws — they are the seatbelts. Capture stack traces to plan Phase 1 work.
3. **Never** ship a production deploy with any of these flags `true` until the corresponding Phase 1+ tickets land.

A flag set `true` in production with the corresponding implementation missing is a **rollback-required** incident.
