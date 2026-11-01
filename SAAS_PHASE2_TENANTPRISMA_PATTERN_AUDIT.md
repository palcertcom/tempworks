# Phase 2.12 — TenantPrisma Pilot Pattern Audit

> Cross-pilot review of Phases 2.6–2.11 to extract the standard
> before scaling to higher-risk modules.

---

## 1. What every pilot does

Every successful pilot module has the same five-line skeleton in its
service constructor:

```ts
constructor(
  private legacyPrisma: PrismaService,
  // ...other deps...
  private pilot: PilotPrismaAccessor,
) {}

private get prisma(): PrismaService { return this.pilot.client(); }
private scope(): PilotScope { return getPilotScope(this.pilot, '<module>'); }
```

And the same module wiring:

```ts
imports:   [FeatureFlagsModule],
providers: [SomeService, TenantPrismaService, PilotPrismaAccessor],
```

This is the universal shape. Six pilots, no exceptions.

## 2. Common patterns

| Pattern | Pilots that use it |
|---|---|
| `pilot.client()` getter | all 6 |
| `getPilotScope(pilot, moduleName)` | 5 (post-2.8) |
| `scope.tenantWhere()` spread into reads | EWH, compliance, job-ads, notifications, recycle-bin |
| `scope.tenantData()` spread into create payload | EWH, compliance, job-ads, recycle-bin |
| Pre-check `findFirst` then mutate-by-id | EWH, compliance, job-ads (update + remove) |
| Pre-check `findFirst` for the WHOLE service via single entry point | recycle-bin (`assertTenantOwnership`) |
| `legacyPrisma.<auditLog\|preferences>.create` for global side-effect tables | EWH, compliance, notifications |
| `phase2X-pilot-scope` annotation per call site | all 6 |
| `phase2X-excluded-*` annotation for intentional opt-out | notifications (background), recycle-bin (platform cleanup) |
| `phase2X-global` annotation for catalog-only tables | compliance (DocumentType joins), notifications (NotificationPreference), recycle-bin (USER/ROLE/etc.) |

## 3. Repeated harness code

Every equivalence + isolation harness re-implements:

- `getDatabaseUrl()` (16 copies — one per harness file).
- `withFlags(env, fn)` — process.env mutation wrapper.
- `classifyRuntimeEnv()` + abort-if-not-staging.
- Tenant lookup query (some variant of `SELECT id FROM tenants WHERE EXISTS …`).
- `withRequestContext + TenantContext.attach` ALS frame.
- JSON + Markdown report writer with the same shape:
  `{ generatedAt, environment, counts: { total, passed, failed }, results }`.
- Markdown table renderer `| # | Case | Result | Detail |`.
- Exit codes `0/2/3` for PASS / FAIL / runtime-error.

Estimated duplication: ~120 lines per harness × 12 harnesses = ~1440
lines of mostly-mechanical scaffolding. Phase 2.12 extracts the parts
that are actually identical.

## 4. Divergences between pilots

| Concern | Divergence | Decision |
|---|---|---|
| Audit log access | EWH + compliance + notifications + recycle-bin all use `legacyPrisma.auditLog` directly. Roles uses an injected `AuditLogService`. | Keep both shapes; consolidation NOT required. |
| `tenantWhere` spread location | Some pilots spread inline (`{ ...t }`); others build a `where` object then spread. | Stylistic. Either is fine. |
| `findUnique` vs `findFirst` for the pre-check | EWH/compliance use `findFirst`; recycle-bin uses `findFirst`; some legacy code uses `findUnique({ where: { id, deletedAt: null } })` with non-unique extra args. | Standardise on `findFirst` for tenant-aware pre-checks. |
| Pre-check then mutate vs. atomic `update({ where: { id, tenantId } })` | All pilots use pre-check + mutate-by-id today. | Keep. Atomic where requires a `tenantId` in `WhereUniqueInput` which Prisma 7 does not naturally provide. |
| Module allow-list reading | `getPilotScope(pilot, moduleName?)` consults `TENANT_PRISMA_PILOT_MODULES` in `tenant-pilot-scope.ts`. | Already centralised. |
| Per-entity scope map | Recycle-bin invented `tenant-scope-map.ts` (10 tenant-scoped vs 6 global entity types). Other pilots are single-model so don't need it. | Keep recycle-bin's local map. Phase 3 may centralise once a second multi-entity service appears. |

## 5. Anti-patterns observed

1. **Hand-rolled `withFlags` in every harness** — copy-paste risk.
   A typo in any one would silently leave a flag set across the run.
   Fix: shared `withFlags` from a harness lib.

2. **Tenant lookup query duplication** — the same `SELECT t.id FROM tenants t WHERE EXISTS (SELECT 1 FROM employees e WHERE e."tenantId" = t.id::text)`
   appears in 8+ harness files. A drift in the predicate (e.g. someone
   removes the EXISTS) would silently change the test fixture.
   Fix: shared `discoverPilotTenants(client)` helper.

3. **String UUID literals scattered through harness files** — Phase 2.10
   had a real bug where the harness IDs (`c00000000001`) didn't match
   the fixture IDs (`000000c00001`) because of an inconsistent regex
   replace. Fix: keep harness fixture-id constants near the SQL fixture
   that creates them.

4. **Annotation-tag drift** — early pilots used `phase26-pilot-accessor`,
   later ones used `phaseXX-pilot-scope`. The semantic intent is the
   same. Fix: documented allow-list in
   `SAAS_PHASE2_SCANNER_ANNOTATION_POLICY.md`.

5. **Background-path annotations applied to wrong files** — risk in
   future PRs that someone adds `phase210-excluded-background` to a
   non-notifications service. Fix: scanner can validate the
   annotation-to-path mapping.

6. **Per-harness exit-code paths** — every harness manually does
   `if (failed) process.exit(2)`. Fix: shared `writeReportAndExit`
   helper in the harness lib.

## 6. Risks before scaling to larger modules

- **Finance, vehicles, documents, applicants, employees, workflow** all
  have order-of-magnitude more prisma call sites than any pilot to date.
  Hand-annotating them at the pace of Phase 2.6 is sustainable; doing
  it without a shared scope-map / harness scaffold is not.
- **Background workers** still owe a job-context framework. The
  Phase 2.10 scope-split documented the design but didn't ship it.
- **Scheduler-touching services** (vehicles via maintenance reminders,
  finance via balance alerts) cannot adopt the pilot until the
  job-context framework lands.
- **Schema-per-tenant uniqueness** for slug / email / name will eventually
  require a Phase 3 migration. Pilot pattern has no opinion on it.

## 7. Recommended standard (consolidated)

For every future pilot module:

### 7.1 Wiring

```ts
// <module>/<module>.module.ts
imports:   [FeatureFlagsModule],
providers: [<Service>, TenantPrismaService, PilotPrismaAccessor],
```

### 7.2 Service shape

```ts
constructor(
  private legacyPrisma: PrismaService,
  // ...non-prisma deps unchanged...
  private pilot: PilotPrismaAccessor,
) {}

private get prisma(): PrismaService { return this.pilot.client(); }
private scope(): PilotScope { return getPilotScope(this.pilot, '<module>'); }
```

### 7.3 Reads

```ts
const t = this.scope().tenantWhere();
return this.prisma.foo.findMany({ where: { ...existing, ...t } });
```

### 7.4 Writes (creates)

```ts
return this.prisma.foo.create({
  data: { ...existing, ...this.scope().tenantData() },
});
```

### 7.5 Updates / deletes

Pre-check + mutate-by-id:

```ts
const existing = await this.prisma.foo.findFirst({
  where: { id, ...this.scope().tenantWhere() },
});
if (!existing) throw new NotFoundException('Not found');
await this.prisma.foo.update({ where: { id }, data });
```

### 7.6 Multi-entity services (recycle-bin shape)

Add a module-local `tenant-scope-map.ts` listing which entity types
are tenant-scoped vs. global. Provide `tenantWhereFor(entityType)`
and `assertTenantOwnership(entityType, id)` helpers.

### 7.7 Excluded paths (notifications shape)

When a service has both in-scope and out-of-scope code paths, route
the out-of-scope ones explicitly through `legacyPrisma` and annotate
them `phase2X-excluded-<reason>`. Add a source-level meta-assertion
in the isolation harness.

### 7.8 Annotations

Every retained `this.prisma.*` line must carry one of the policy-allowed
annotations (see `SAAS_PHASE2_SCANNER_ANNOTATION_POLICY.md`). The
scanner will eventually fail builds where unknown reasons appear.

### 7.9 Harnesses

Use the shared helpers in
`backend/scripts/saas/phase2/lib/harness.ts`:

```ts
import { runHarness, writeReport, withFlags, getDatabaseUrl,
         abortUnlessStaging, discoverPilotTenants } from './lib/harness';
```

### 7.10 Documentation

Three files per pilot:

- `SAAS_PHASE2_<MODULE>_AUDIT.md` (pre-refactor audit)
- `SAAS_PHASE2_<MODULE>_PILOT_RESULTS.md` (post-refactor)
- One scope-related file if the module has unusual semantics
  (e.g. `…_SCOPE_SPLIT.md`, `…_SCOPE_MAP.md`, `…_SLUG_SAFETY.md`).

## 8. Estimated savings

Once consolidated:

- ~120 lines saved per new harness (× harness factory).
- ~30% reduction in PR diff for new pilots (uniform service shape).
- 0 to 1 lines per pilot for scope helpers (vs. ~5 today).

Phase 2.12 is purely consolidation. No business logic moves; no flags
flip; no fixtures change.
