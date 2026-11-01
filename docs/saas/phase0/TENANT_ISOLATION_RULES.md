# Tenant Isolation Rules

The complete set of rules every contributor must follow when writing code that will eventually touch tenant data. Each rule is paired with a spike or ADR that justifies it.

---

## R-1. There is one and only one way to read tenant data

```ts
import { TenantPrismaService } from '@/saas';
constructor(private readonly tprisma: TenantPrismaService) {}

const candidates = await this.tprisma.client.candidate.findMany({ where: ... });
```

**Forbidden** outside `src/prisma/*` and `src/saas/prisma/*`:

```ts
import { PrismaClient } from '@prisma/client';
import { PrismaService } from '@/prisma/prisma.service';
```

**Justification:** ADR-001, ADR-004; SPIKE-001 demonstrated that any direct query bypasses both tenant injection and RLS.

## R-2. There is one and only one way to set the tenant GUC

```ts
await tx.$executeRawUnsafe(setLocalTenantSql(tenantId));
```

**Forbidden:** `SET app.tenant_id = ...` (no `LOCAL`); string-interpolated UUIDs without `assertUuid()`; setting any GUC other than `app.tenant_id` from application code.

**Justification:** SPIKE-001 F-2 — plain `SET` persists across pooled requests; `assertUuid` is the injection boundary.

## R-3. RLS policies use the canonical NULLIF template

```sql
USING      ("tenantId" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
WITH CHECK ("tenantId" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
```

**Forbidden:** `current_setting(...)::uuid` without `NULLIF`. SPIKE-001 F-1 reproduced a runtime ERROR when the GUC was previously set then RESET in the session.

## R-4. Background jobs re-enter ALS with `tenantId` from payload

Subclass `TenantAwareJobProcessor`. The base class:
- validates `payload.tenantId`,
- resolves a tenant snapshot,
- runs your `handle()` inside a fresh ALS frame.

**Forbidden:** queue handlers that call `tenantPrisma.client` *before* re-entering ALS (it will throw `MissingTenantContextError`); module-load `setInterval` patterns that scan tenants in-process.

**Justification:** SPIKE-002 (ALS doesn't cross worker thread boundaries); SPIKE-006 (concurrency, retry, fanout all safe with the base class).

## R-5. Reports compose SQL only via the registry-driven engine

A new data source must:
- declare a `tenantColumn` (boot validator throws if missing),
- expose only whitelisted fields and a closed enum of operators,
- run inside a `TenantPrismaService` transaction.

**Forbidden:** `Prisma.raw(...)`, `$queryRawUnsafe`, ad-hoc SQL in service code, user-controllable `ORDER BY`, `OR` at the top of user filters.

**Justification:** ADR-007; SPIKE-004 verified all attack vectors are rejected by the contract.

## R-6. Storage keys are server-derived and tenant-prefixed

Always:
```
tenants/<tenantId>/<resourceClass>/<resourceId>
```

The `tenantId` segment comes from `TenantContext.current()`, **never** from the request body, headers, or query string.

**Forbidden:** client-supplied storage keys; long-lived signed URLs in emails or PDFs; `ACL: 'public-read'` on any new upload (Phase 3+).

**Justification:** ADR-006; SPIKE-005 F-1 confirmed server-side derivation is the only safe pattern.

## R-7. Cross-tenant access goes through `PlatformPrismaService` with `reason`

Every method on `PlatformPrismaService` requires a `reason: string` (≥ 10 chars) and writes to `PlatformAuditLog`. Step-up MFA is enforced by `PlatformAdminGuard`.

**Forbidden:** any other path to read or mutate cross-tenant data; reusing the API role's `PrismaService` to "just check something" across tenants.

**Justification:** ADR-005.

## R-8. Tenant-scoped uniqueness leads with `tenantId`

```prisma
@@unique([tenantId, email])
@@index([tenantId, status, createdAt])
```

**Forbidden:** `@unique` on email/code/slug fields without `tenantId`; trailing-`tenantId` composite uniques (`@@unique([email, tenantId])` — partition pruning fails).

**Justification:** ADR-001; `schema-lint` script flags violations.

## R-9. Membership-based authorization is the only authorization

A user's effective permissions for a tenant come from `TenantMembership.roles` + `MembershipPermissionOverride`. The legacy `User.roleId` field is read-only legacy through Phase 4; never trust it for authorization decisions on tenant-scoped resources after Phase 1.

**Forbidden:** new code that reads `User.roleId` for authorization; new tenant-scoped roles without a `tenantId`.

**Justification:** ADR-002.

## R-10. Tenant resolution is host-based; clients never name a tenant

`TenantMiddleware` resolves tenant from `Host` header (custom domain → subdomain). Service-to-service callers may pass `X-Tenant-Id` only with an internal token. The browser never sends `X-Tenant-Id`.

**Forbidden:** request-body / query-string `tenantId` parameters in tenant-scoped routes; route paths shaped like `/tenants/:id/...`.

**Justification:** ADR-001, ADR-004; SPIKE-005 F-1.

## R-11. Audit-log everything that mutates

Every controller mutation eventually carries an `@Audit('module.action')` decorator (Phase 3). Until then, services that bulk-modify tenant data must include an inline `auditLog.create({ action, target, ... })` call. Reads of sensitive resources also audit (signed URL issuance, financial record exports).

**Justification:** ADR-005, ADR-006.

## R-12. Cache keys are tenant-prefixed

Redis keys: `t:<tenantId>:<resource>:<id>`. React Query keys: `['t', tenantId, ...]`. Tenant switch flushes the cache.

**Forbidden:** caching by `userId` only; storing tenant data under a global key.

---

## Decision tree: "is my change safe?"

```
Does my change touch tenant data (or a model that will become tenant-scoped)?
│
├── No  →  use plain PrismaService; you may ignore R-1..R-12.
│
└── Yes →  R-1..R-12 apply. Specifically:
           ├── New query path?         R-1, R-3, R-8
           ├── New SQL composition?    R-5
           ├── New background job?     R-4
           ├── New file upload/dl?     R-6
           ├── New cross-tenant read?  R-7
           ├── New auth check?         R-9
           └── New mutation?           R-11, R-12
```

Failing to apply a rule **does not** crash the app today (Phase 0 is dormant). It will cause an isolation failure in Phase 2+ when flags flip. Catch it in code review, not in production.
