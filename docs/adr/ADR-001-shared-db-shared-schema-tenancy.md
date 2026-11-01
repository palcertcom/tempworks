# ADR-001 — Shared Database, Shared Schema, `tenant_id` Isolation

- **Status:** Accepted
- **Date:** 2026-05-09
- **Deciders:** Platform Engineering, Architecture
- **Related:** ADR-004 (TenantPrismaService), ADR-007 (Reports isolation)

## Context

We are converting the existing Tempworks recruitment & compliance platform from single-tenant (one customer per deployment) into a multi-tenant SaaS. The platform must host many isolated customer organizations.

Three canonical multi-tenant DB models exist:

1. **Database-per-tenant** — strongest isolation; operational cost and migration complexity scale linearly with tenant count. Connection pool explosion at hundreds of tenants. Cross-tenant analytics require ETL.
2. **Schema-per-tenant** — good isolation; Postgres catalog bloat at high tenant counts (one set of `pg_class` rows per table per tenant); Prisma generates a single schema per `PrismaClient`, forcing dynamic schema switching or N clients.
3. **Shared schema with `tenant_id`** — single tables, single indexes, single Prisma client. Defense-in-depth via Postgres Row-Level Security. Linear horizontal scaling via partitioning and read replicas.

The current platform already partially implements (3) via the `Agency` concept — most domain tables carry `agencyId`, used as the de-facto isolation key. This is a strong precondition for a shared-schema migration.

## Decision

The platform will use **one PostgreSQL database, one shared schema, with `tenant_id` (UUID) on every tenant-owned table**, enforced at three layers:

1. **Application** — `TenantPrismaService` injects `tenant_id` into every query (ADR-004).
2. **Database** — Postgres Row-Level Security (`ENABLE ROW LEVEL SECURITY ... FORCE`) with a `current_setting('app.tenant_id')`-based policy, set per request inside a transaction.
3. **Test** — every TENANT-scoped model has a two-tenant isolation test asserting cross-tenant invisibility.

Specific rules:

- Every TENANT-scoped table gains `tenant_id UUID NOT NULL`.
- Composite indexes lead with `tenant_id` on every hot read path.
- `@unique` constraints involving tenant-relevant columns are reformulated as `(tenant_id, …)`.
- High-volume tables (audit_logs, attendance, notifications) are partitioned (`HASH(tenant_id)`) — not per-tenant partitions.
- Per-tenant restore is provided via a logical export job, not a separate DB.

## Consequences

**Positive**
- Linear scaling on managed Postgres; no per-tenant migration burden.
- Cross-tenant analytics first-class.
- Single Prisma client; one CI pipeline; one connection pool.
- Catalog stays small.

**Negative**
- Strong discipline required at the application layer; one bad query can leak.
- Per-tenant restore is non-trivial (must filter by `tenant_id`).
- Noisy-neighbor effects must be mitigated with rate limits and quotas.
- RLS interacts with PgBouncer pooling (see ADR-004).

## Alternatives Considered

- **Database-per-tenant.** Rejected: operational cost prohibitive at the projected tenant count; migration becomes N-fold; existing managed-DB pricing prefers a single primary.
- **Schema-per-tenant.** Rejected: Prisma single-client limitation; catalog bloat; per-tenant migration drift risk.
- **Hybrid (paid tier on dedicated DB).** Considered for enterprise; deferred to a Phase 5+ option. Today's blueprint is shared-schema only.

## Implementation Notes

- A `Tenant` table is the new top-level identity for a customer.
- `Agency.id` is reused as `Tenant.id` during backfill (see `SAAS_AGENCY_TO_TENANT_SPLIT_STRATEGY.md`) so existing `agencyId` values become `tenantId`.
- RLS rolled out in two stages per table: (a) policies enabled but not `FORCE`d for 7 days of monitoring; (b) `FORCE`d after no-violation window.
- Identifier-sequence cutover uses a Postgres advisory lock per tenant during the dual-key window.
- `SystemSetting branding_*` writes are removed during the transition; reads continue from legacy until `/bootstrap` rolls out, at which point the keys are dropped.
- Recycle-bin restore validates `tenantId` match transactionally; restored row is re-inserted via `TenantPrismaService`.

## Risks

- **Cross-tenant leakage** through a missed query, raw SQL, or background job. Mitigation: ADR-004 guard + ADR-007 reports refactor + isolation tests.
- **Partition pruning regression** if queries don't filter by `tenant_id`. Mitigation: schema-lint + composite index audit.
- **Hot-tenant noise.** Mitigation: per-tenant rate limits; long-term move to dedicated read replica for hottest tenants.

## Rollback Considerations

- Schema additions (the `tenant_id` columns) are reversible only as long as no rows have been written by new tenants. Once a second tenant is provisioned, rollback is operationally infeasible.
- The expand-contract migration sequence (`SAAS_MIGRATION_PLAN.md` §11) keeps every step independently reversible until commercial cutover.
- Feature flags (`MULTI_TENANT_ENABLED`, `TENANT_PRISMA_ENFORCED`, `RLS_ENFORCED`) provide a per-step kill switch through Phases 0–2.
