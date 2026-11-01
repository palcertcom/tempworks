# Prisma Safety Guide

How to use Prisma correctly in a multi-tenant codebase. Concrete examples; copy-paste-ready.

---

## TL;DR

| Doing | Use |
|---|---|
| Reading user (login flow) | `PrismaService` — global identity (allowlisted) |
| Reading any tenant-owned data | `TenantPrismaService.client` |
| Writing tenant data | `TenantPrismaService.client` |
| Cross-tenant analytics (super admin) | `PlatformPrismaService` with `reason` |
| Background job touching tenant data | extend `TenantAwareJobProcessor`, then `tenantPrisma` |
| Reports SQL | the registry engine; never raw |

---

## Safe pattern — service

```ts
import { Injectable } from '@nestjs/common';
import { TenantPrismaService } from '@/saas/prisma/tenant-prisma.service';

@Injectable()
export class CandidatesService {
  constructor(private readonly tprisma: TenantPrismaService) {}

  list(filter: ListFilter) {
    return this.tprisma.client.candidate.findMany({
      where: {
        // tenantId is injected by the wrapper; do NOT pass it manually
        status: filter.status,
        createdAt: { gte: filter.from },
      },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
  }

  create(input: CreateCandidate) {
    return this.tprisma.client.candidate.create({
      data: {
        // tenantId injected
        email: input.email,
        fullName: input.fullName,
      },
    });
  }
}
```

## Safe pattern — interactive transaction (advanced)

```ts
await this.tprisma.withTenant(async (tx) => {
  const c = await tx.candidate.create({ data: { email, fullName } });
  await tx.auditLog.create({ data: { action: 'candidate.create', targetId: c.id }});
  return c;
});
```

`withTenant` opens a transaction, sets `app.tenant_id`, and runs the callback. Use when multiple writes must be atomic.

## Anti-patterns and what they cause

### A1. Direct `PrismaService` import in a service module
```ts
// ❌
import { PrismaService } from '@/prisma/prisma.service';
constructor(private prisma: PrismaService) {}
return this.prisma.candidate.findMany();
```
**Effect:** When `TENANT_PRISMA_ENFORCEMENT=true` (Phase 2+), this query bypasses tenant injection. RLS may catch it (returning 0 rows), but the developer experience is "data has disappeared" — confusing and dangerous.
**Fix:** Use `TenantPrismaService`.

### A2. Manually adding `tenantId` to `where`
```ts
// ❌
return this.tprisma.client.candidate.findMany({
  where: { tenantId: req.user.tenantId, status: 'ACTIVE' },
});
```
**Effect:** Redundant when the wrapper is on; **wrong** if the user-supplied `tenantId` differs from ALS — an indirect cross-tenant leak.
**Fix:** Trust ALS. Drop the `tenantId` clause.

### A3. Raw SQL outside the engine
```ts
// ❌
return this.prisma.$queryRaw`SELECT * FROM candidates WHERE status = ${status}`;
```
**Effect:** Bypasses both injection and RLS (when set via `PrismaService`). When set via `tenantPrisma`, RLS catches it but you've lost composability.
**Fix:** Add the source to `SOURCE_DEFS` (reports engine) or use the typed Prisma API.

### A4. Looking up by email on a tenant-scoped model
```ts
// ❌
return this.prisma.employee.findUnique({ where: { email } });
```
**Effect:** Today: relies on global uniqueness. Phase 2+: `(tenantId, email)` becomes the unique key; this query won't compile.
**Fix:** `tprisma.client.employee.findFirst({ where: { email } })` (tenant injected) or use `findUnique` with the composite key.

### A5. `prisma.$transaction([promises])` shorthand
```ts
// ❌
await this.prisma.$transaction([
  this.prisma.candidate.create(...),
  this.prisma.auditLog.create(...),
]);
```
**Effect:** Cannot run `SET LOCAL app.tenant_id` inside the array form. Wrapper cannot apply.
**Fix:** Use the callback form: `prisma.$transaction(async (tx) => { ... })`.

### A6. `setInterval` at module load
```ts
// ❌
constructor() { setInterval(() => this.scanAllData(), 6 * 60 * 60_000); }
```
**Effect:** Runs outside any ALS frame; scans all tenants in one pass.
**Fix:** Use `@Cron` to enqueue per-tenant BullMQ jobs; workers extend `TenantAwareJobProcessor`.

### A7. EventEmitter outliving a request
```ts
// ❌  shared bus that captures TenantContext.current() at construction time
this.bus.on('something', () => doStuff(TenantContext.current()));
```
**Effect:** The first request's context is captured forever.
**Fix:** Pass `tenantId` into the event payload; resolve fresh inside the handler.

---

## When to use `// @tenant-reviewed`

The scanner accepts a single-line bypass:

```ts
const u = await this.prisma.user.findUnique({ where: { email } }); // @tenant-reviewed: login is global identity (R-9)
```

Use sparingly:
- **Yes:** code paths in `auth/`, `users/` (the global identity path), some platform-admin paths in Phase 3.
- **No:** "I'll fix it later" — that's a TODO, not a tenant review.

The reviewer note must reference a rule (`R-1`, `R-9`, etc.) or an ADR.

---

## How to add a new tenant-scoped model (Phase 2 preview)

1. Add `tenantId String` to the Prisma model + `@@index([tenantId, …])` + `@@unique([tenantId, …])` for any natural key.
2. Write the additive migration (column nullable → backfill → NOT NULL → drop legacy unique).
3. Add the model name to `TENANT_SCOPED_MODELS` in `tenant-scoped-models.ts`.
4. Run `pnpm saas:schema-lint`; no warnings for the new model.
5. Write a per-model isolation probe in `__validation__/<model>.check.ts`.
6. Get a SaaS code-owner review.
7. Add the RLS policy from `RLS_POLICY_TEMPLATE` (audit-mode first).

---

## Performance notes (from SPIKE-001)

- Per-request transaction overhead: +43% at 1 query/req → −17% at 30 queries/req. Net positive on multi-query requests.
- Per-query overhead: ~0.3–0.5 ms BEGIN+SET LOCAL+COMMIT. Negligible vs. typical query latency.
- Pool size of 4 absorbs 200 interleaved mixed-tenant requests with **0 leaks** and no errors.
- Long-running operations (reports, exports) **must** run on a separate session-mode pool (Phase 3+) to avoid holding API-tier backends.

If you suspect performance regression after Phase 2 cutover, profile a representative endpoint with both flags off and on.
