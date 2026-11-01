# SaaS Phase 0 — Foundations

## What landed in Phase 0

A **safety scaffold** for the multi-tenant migration that does not change any production behaviour.

| Layer | Component |
|---|---|
| Configuration | `FeatureFlagsService`, six typed flags (default `false`) |
| Context | `tenantALS`, `TenantContext`, `UserContext`, `TenantContextMiddleware` (skeleton) |
| Data access | `TenantPrismaService` (pass-through), `PlatformPrismaService` (skeleton) |
| Schema | 8 new tables (additive, unread): `tenants`, `tenant_memberships`, `membership_roles`, `agency_memberships`, `membership_permission_overrides`, `platform_admins`, `platform_audit_logs`, `tenant_domains` |
| Storage | `SignedUrlService` (skeleton), key derivation, MIME/size policies |
| Background work | `TenantAwareJobProcessor` base class |
| Bootstrap | `BootstrapResponse` types (consumed by Phase 4 frontend) |
| Observability | `RequestIdMiddleware`, `getLogContext()` |
| Safety | `saas:scan` AST scanner, `saas:schema-lint`, `saas:validate` (28 tests, 5 suites) |
| Documentation | This guide + 4 reference docs + 7 ADRs |

## Files of interest

- `backend/src/saas/` — all foundation code (NOT registered in `AppModule`)
- `backend/prisma/saas-phase0.prisma.append` — schema delta to append when ready
- `backend/prisma/migrations/saas_phase0_foundations/` — applied migration with rollback
- `backend/scripts/scan-tenant-safe.ts` — Prisma usage scanner
- `backend/scripts/schema-lint.ts` — schema convention linter

## Entry points

```sh
# Run validation suites (28 tests across 5 suites)
pnpm --filter backend run saas:validate

# Scan for direct Prisma usage (advisory in Phase 0)
pnpm --filter backend run saas:scan

# Strict mode (fails on findings; for Phase 2+ enforcement)
pnpm --filter backend run saas:scan:strict

# Schema convention check
pnpm --filter backend run saas:schema-lint
```

## What's intentionally absent

| Concern | Why deferred |
|---|---|
| Wiring `SaasModule` into `AppModule` | Phase 1 (TKT-01..09) |
| `tenantId` columns on existing models | Phase 2 (TKT for each model) |
| `MULTI_TENANT_ENABLED=true` in any env | Requires the missing pieces above |
| RLS policies on existing tables | Phase 2 audit-mode, Phase 3 `FORCE` |
| Frontend `TenantProvider` | Phase 4 |
| `agencyIsSystem` removal from JWT | Phase 3 (after `PlatformAdmin` backfill) |
| `setInterval` notifications retirement | Phase 3 |
| Storage ACL flip | Phase 3 (after frontend cutover) |

## Reference docs

- [`PHASE0_RUNTIME_INVARIANTS.md`](./PHASE0_RUNTIME_INVARIANTS.md) — what must remain true while Phase 0 is active
- [`TENANT_ISOLATION_RULES.md`](./TENANT_ISOLATION_RULES.md) — R-1..R-12 with rationale
- [`PRISMA_SAFETY_GUIDE.md`](./PRISMA_SAFETY_GUIDE.md) — copy-paste-ready safe patterns
- [`DEVELOPER_MULTI_TENANCY_GUIDE.md`](./DEVELOPER_MULTI_TENANCY_GUIDE.md) — onboarding for everyone else
