# Developer Multi-Tenancy Guide

**Audience:** Anyone shipping backend code while the SaaS migration is in flight.

This guide answers "how do I get my work done without tripping a tenant-isolation rule?" and "what changed in Phase 0 that I need to know?"

---

## What just happened (Phase 0)

We landed eight new tables, a `src/saas/` module tree, a typed feature-flag service, an ALS-based context, a tenant-aware Prisma wrapper (dormant), a platform-admin guard skeleton, signed-URL types, a tenant-aware job base class, observability scaffolding, four ADR-based docs, and a 28-test validation harness.

**Production behaviour did not change.** All flags default `false`. The `SaasModule` is not registered in `AppModule`. New tables exist or are pending, but nothing reads them.

## What you should do today (the 90% case)

For tickets unrelated to multi-tenancy, **nothing changes**. Continue using `PrismaService`, existing services, existing storage, existing notifications. Existing patterns continue to work.

You may, however, see:
- a `pnpm saas:scan` advisory listing your file (827 findings exist before your PR; report-only).
- a `saas-phase0` migration in the `prisma/migrations` directory — not yet applied to dev unless you ran it.

Neither is a blocker.

## What you should do for Phase 1+ work

If you're implementing a Phase 1 ticket (TKT-04, TKT-06, etc.):

1. Open `docs/adr/ADR-00X-…md` for your ticket's reference ADR.
2. Open `docs/saas/phase0/TENANT_ISOLATION_RULES.md` and `PRISMA_SAFETY_GUIDE.md`.
3. Follow R-1..R-12.
4. Add tests under `backend/src/saas/__validation__/`.
5. Run:
   ```
   pnpm --filter backend run saas:validate
   pnpm --filter backend run saas:scan
   pnpm --filter backend run saas:schema-lint
   ```

## How to set a flag locally

```sh
MULTI_TENANT_ENABLED=true \
TENANT_PRISMA_ENFORCEMENT=true \
RLS_ENFORCEMENT=true \
pnpm --filter backend run start:dev
```

Today, doing this will produce explicit "not implemented in Phase 0" errors. That is correct: it tells you which Phase 1 component to build next.

## How to apply the new schema in dev

The new tables are NOT applied automatically.

```sh
# 1. Append the new models to schema.prisma
cat backend/prisma/saas-phase0.prisma.append >> backend/prisma/schema.prisma

# 2. Generate the new client
cd backend && npx prisma generate

# 3. Apply the migration
npx prisma migrate dev --name saas_phase0_foundations
```

To roll back:

```sh
psql "$DATABASE_URL" -f backend/prisma/migrations/saas_phase0_foundations/migration.down.sql
git checkout backend/prisma/schema.prisma   # if you appended the schema delta
```

## How to write a new validation test

```ts
// backend/src/saas/__validation__/my-feature.check.ts
import { suite, test, expect, run } from './runner';

suite('my-feature');

test('describe what is being asserted', () => {
  expect(2 + 2).toBe(4);
});

run();
```

Add it to the list in `__validation__/all.ts` so `saas:validate` runs it.

## How to debug a tenant-context bug

1. Print the active context:
   ```ts
   import { currentRequestContext } from '@/saas';
   console.log(currentRequestContext());
   ```
2. If `undefined` outside of a request: you're not inside an ALS frame. Either you're at module load, or in a callback that doesn't inherit one (rare — see SPIKE-002 for the validated paths).
3. If the tenant is wrong inside a job: ensure the producer set `tenantId` and the worker extends `TenantAwareJobProcessor`.
4. If "MissingTenantContextError" fires in a unit test: wrap the test body in `withRequestContext({ requestId: '...' }, () => { ... TenantContext.attach(snapshot); ... })`.

## How to think about timelines

| When | What |
|---|---|
| Now | Phase 0 done. Foundations dormant. Production unchanged. |
| Next 4 weeks | Phase 1: wire SaasModule, add `TenantContextMiddleware` for real, ship dual-claim JWT, build identity service. |
| Phase 2 (~6 weeks after) | Backfill `tenantId` on existing models; populate `TENANT_SCOPED_MODELS`; flip flags in staging. |
| Phase 3 (~3 months) | Module-by-module refactor; reports engine; storage cutover; RLS FORCE. |
| Phase 4 | Frontend `TenantProvider`, workspace switcher, branding. |

If a ticket says "use `TenantPrismaService`" and you're working in Phase 0, that's fine — the wrapper is callable; it's just a pass-through until enforcement turns on.

## Where to ask questions

- ADRs are the source of truth for design. Disagreements should be resolved by amending an ADR.
- Spike reports (`docs/spikes/SPIKE-00*.md`) document what was actually measured.
- The ticket breakdown (`SAAS_PHASE0_TICKET_BREAKDOWN.md`) maps Phase 0 work into reviewable units.
- For everything else, file a question against the SaaS code-owners.

## Common mistakes new contributors make

1. **Adding `tenantId` to `where`** out of habit. Don't — the wrapper does it.
2. **Importing `@prisma/client` directly** for "just one query." Don't — go through `TenantPrismaService`.
3. **Setting a flag in a CI environment** to test it. Don't — local first; CI only after the corresponding implementation lands.
4. **Editing existing services to use `TenantPrismaService`** ahead of Phase 2. Don't — Phase 2 has a model-by-model migration order to avoid concurrency issues.
5. **Storing `tenantId` in JWT and trusting it for authorization** without server-side membership lookup. Don't — trust ALS only after `JwtAuthGuard` (Phase 1+) validates membership.
