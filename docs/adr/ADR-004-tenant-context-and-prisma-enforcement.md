# ADR-004 — Tenant Context Propagation & Prisma Enforcement

- **Status:** Accepted
- **Date:** 2026-05-09
- **Related:** ADR-001 (RLS), ADR-002 (membership), ADR-005 (platform admin)

## Context

Tenant data must be filtered on every query by `tenant_id`. The chosen architecture (ADR-001) relies on three layers — application, RLS, tests — and the application layer is the primary, **fast** filter. Postgres RLS is a **defense-in-depth** check that catches developer mistakes.

Two design questions must be locked:

1. How is the tenant identifier propagated from request to Prisma call without parameter-drilling through every service?
2. How is the Postgres GUC (`app.tenant_id`) reliably set when many Prisma calls are non-transactional, especially under PgBouncer pooling?

A spike (`TKT-04a`) is required to validate the chosen approach against PgBouncer.

## Decision

### 1. Tenant context is carried in AsyncLocalStorage (ALS)

A request-scoped `RequestContext = { tenant?, user?, requestId }` is stored in Node's AsyncLocalStorage. Helpers `TenantContext.current()` and `UserContext.current()` read from ALS. No parameter drilling.

`TenantMiddleware` sets the context near the start of the request lifecycle (after CORS / body parsing, before route handling). Routes excluded from middleware (health, login, refresh) do not have a tenant in context.

### 2. `TenantPrismaService` is the only sanctioned data-access surface

A singleton wrapper over `PrismaClient` using Prisma's `$extends` API:

- For models in `TENANT_SCOPED_MODELS` (auto-generated, ADR-001), the wrapper:
  - Opens a transaction via `prisma.$transaction(async (tx) => { ... })`.
  - Inside the transaction, executes `SET LOCAL app.tenant_id = $1`.
  - Injects `tenant_id` into `args.where` (reads, updates, deletes), `args.data` (creates), and `args.create` / `args.update` (upserts).
  - Runs the operation and returns its result.
- For non-tenant models (`User`, `Plan`, etc.), pass-through to underlying client.
- Throws `MissingTenantContextError` if ALS contains no tenant.

Every tenant-scoped operation is therefore transactional. **Why this is required:** Postgres RLS reads `current_setting('app.tenant_id')`. `SET LOCAL` only persists for the active transaction. Outside a transaction, the GUC is unset and RLS would reject the query. Wrapping in `$transaction` makes the GUC reliably present.

### 3. PgBouncer pooling mode

The API DB role uses **transaction-mode** pooling. This is compatible with `SET LOCAL` because the GUC is bound to the transaction, which is bound to a single backend connection.

Session-level `SET` is **forbidden** for this role; the schema-lint and Prisma extension reject any `SET` (without `LOCAL`) appearing in `$executeRaw`.

A separate session-mode pool is used **only** by the `platform_admin` Postgres role (ADR-005), which has different behavior anyway.

### 4. `PlatformPrismaService` for super-admin bypass

A separate `PrismaClient` bound to the `platform_admin` Postgres role. This role has policy-level RLS bypass on tenant tables. Only modules under `backend/src/modules/platform-admin/` may inject this service. Every public method requires a `reason: string` parameter and writes a `PlatformAuditLog` row before returning. ESLint forbids importing it elsewhere.

### 5. Agency scoping — Option (b)

The architect review pinned Option (b) (services apply scoping via a helper) over Option (a) (guard injects automatically). Reason: not all models have `agency_id`; some inherit through a parent. Auto-injection on a model that lacks the column would silently no-op.

`AgencyScopeGuard` exposes `req.tenantScope.agencyIds`. Services apply via:

```ts
function applyAgencyScope<T>(where: T, field: keyof T, ctx: UserContext): T {
  if (!ctx.agencyIds?.length) return where; // full-tenant
  return { ...where, AND: [{ [field]: { in: ctx.agencyIds } }, where] };
}
```

A static check enumerates all controllers; each list/read endpoint targeting an agency-scoped model must call `applyAgencyScope` (asserted via AST scanner in CI).

### 6. Catalog tables resolution order

Catalog-style models (`DocumentType`, `MaintenanceType`, `NotificationRule`) allow `tenantId IS NULL` rows for the system catalog. Resolution at query time:

```ts
async function resolveCatalogEntry(key: string) {
  return (
    await tenantPrisma.client.documentType.findFirst({ where: { key, tenantId: ctx.tenantId } })
  ) ?? (
    await prisma.documentType.findFirst({ where: { key, tenantId: null } })
  );
}
```

`@@unique([tenantId, key])` with NULLS NOT DISTINCT prevents duplicate catalog entries.

### 7. Tenant resolution cache

Redis-backed; TTL 5 minutes. Invalidated on `Tenant.update`, `TenantDomain.upsert`, or status changes via Redis pub/sub channel `tenant:invalidate`. Slug is immutable after the first 30 days (enforced in `TenantService`).

### 8. Slug rules

Regex: `^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])?$`. Reserved set in `backend/src/modules/tenancy/reserved-slugs.ts`. Lowercased, no leading/trailing dash, length 2–40.

### 9. Tenant-aware background jobs

A base `TenantAwareJobProcessor` abstract class wraps BullMQ `process()`:

```ts
abstract class TenantAwareJobProcessor<T extends { tenantId: string; userId?: string }> {
  async process(job: Job<T>) {
    const tenant = await this.tenants.requireById(job.data.tenantId);
    return this.als.run({ tenant, user: job.data.userId ? await this.users.snapshot(job.data.userId) : null }, () =>
      this.handle(job),
    );
  }
  protected abstract handle(job: Job<T>): Promise<void>;
}
```

ESLint forbids `@Processor()` decorators on classes that don't extend `TenantAwareJobProcessor` for queues registered as tenant-scoped.

### 10. System templates and `WorkflowAccessUser`

System-template workflows (`Workflow.tenantId IS NULL`) are public-read to all members of all tenants. `WorkflowAccessUser` is only valid on tenant-owned workflows; insert is rejected at write time if `workflow.tenantId IS NULL`.

## Consequences

**Positive**
- Tenant filter is correct by construction in the application; RLS is a redundant safety net.
- A single allowlisted module owns DB access; ESLint enforces it.
- Background jobs cannot accidentally run without tenant context.
- Catalog overrides have a single, well-defined resolution path.

**Negative**
- Every tenant-scoped operation incurs a transaction. Performance verified by spike `TKT-04a`.
- Services must remember to call `applyAgencyScope` (Option b). Mitigated by AST scanner + integration tests.
- Catalog resolution requires two queries on cache miss; mitigated by caching at the service layer.

## Alternatives Considered

- **Connection-bound `SET app.tenant_id`** (no `LOCAL`). Rejected: incompatible with PgBouncer transaction mode; one connection serving multiple tenants would leak the GUC across requests.
- **Custom Postgres role per tenant.** Rejected: thousands of roles, role-switch cost, RLS would still need policy.
- **Inject `tenant_id` purely at the application layer; skip RLS.** Rejected: a single missed query leaks. RLS is the safety net.
- **Auto-inject agency scope (Option a).** Rejected per §5.

## Implementation Notes

- `TenantPrismaService` is wired into `PrismaModule`; `PrismaService` (raw client) is **only** exported to allowlisted modules.
- `TENANT_SCOPED_MODELS` is generated from `backend/prisma/generators/tenant-scoped-models/manifest.json`. Phase 0 manifest is empty; Phase 2 populates per migration.
- `MissingTenantContextError` includes the offending operation name and a stack pointer to the calling site for fast debugging.
- The transactional wrapper detects nested invocations and reuses the outer transaction's GUC (no inner `SET LOCAL`).
- Health checks call `prisma.$queryRaw\`SELECT 1\`` directly via `PrismaService` (allowlisted) and bypass the wrapper.

## Risks

- **Performance overhead** of `$transaction` on hot paths. Spike result must show < 15% overhead; otherwise design must change (consider session-mode pool for the API role with explicit per-request `RESET` of the GUC).
- **Forgetting `applyAgencyScope`.** Mitigation: AST scanner + integration tests for each agency-scoped controller.
- **Catalog resolution cache invalidation.** Mitigation: bump catalog version on write; cache key includes version.
- **Background-job context leakage** if `als.run` is bypassed. Mitigation: ESLint rule + base class.

## Rollback Considerations

- `TENANT_PRISMA_ENFORCED=false` reverts the wrapper to pass-through; legacy direct-`agencyId` services continue to work.
- `RLS_ENFORCED=false` keeps RLS in audit mode (no enforcement).
- `PlatformPrismaService` consumers are zero in Phase 0; rollback is a no-op.
- Removing the `TenantAwareJobProcessor` base class is safe pre-Phase 3 since no jobs depend on it yet.

---

## Addendum (Phase 1 preflight findings)

Added 2026-05-09.

- **`TENANT_SCOPED_MODELS` in Phase 1:** still empty in code. Even though the prep migration adds `tenantId` columns to `applicants`, `employees`, `vehicles`, the application **does not yet** filter through `TenantPrismaService`. The columns are populated by the backfill but read by nothing until Phase 2 wires the wrapper.
- **Catalog resolution model (§6) is locked as the default**: `DocumentType`, `MaintenanceType`, `NotificationRule`, `Workshop` keep `tenantId IS NULL` rows as the system catalog; tenants override per-key. Replicate-mode is rejected (data duplication; no clear product win).
- **Reports engine impact:** Audit G surfaced 13 raw-SQL occurrences in `backend/src/reports`. The Phase 3 reports refactor (ADR-007) is a **hard prerequisite** for Phase 2's `TENANT_PRISMA_ENFORCEMENT=true` cutover — otherwise reports become a leakage channel even with RLS on.
- **Identifier sequence cutover** is the first time the wrapper actually rewrites a query (Phase 2 TKT). Until then, the legacy single-key writer continues — Phase 1 only stages the snapshot.
