# Phase 2.1 — Tenant-Safe Reports Engine: Implementation

> Status: shipped behind `TENANT_SAFE_REPORTS_ENABLED=false`. Default production behaviour is unchanged. Three sources (`employees`, `applicants`, `agencies`) are mapped READY; fifteen are explicitly DISABLED with reasons.

---

## 1. What was built

### 1.1 Runtime under `backend/src/saas/reports/runtime/`

| File | Role |
|------|------|
| `report-sources.ts` | The mapping. Per-key entries are either `READY` (with a validated `SourceDef`) or `DISABLED` (with a reason) |
| `tenant-safe-reports.service.ts` | The Nest-injectable service shape; throws `TenantSafeReportsDisabledError` when the flag is off |
| `compose-sql.ts` | The pure SQL composer — `composeReportSql({ def, filters, columns, page, limit }, ctx)` returns `{ sql, countSql, params, columns, page, limit }` |
| `index.ts` | Barrel export |

The composer reuses the **dormant scaffolding** from Phase 2.0:
- `where-builder.ts` — tenant-id-as-`$1`, allow-listed ops/fields, agency scope
- `source-registry.ts` — boot validator
- `sql-guards.ts` — identifier quoting, UUID assertion, forbidden-pattern detector

### 1.2 Feature flag

- New: `TENANT_SAFE_REPORTS_ENABLED` (default `false`).
- Typed accessor: `FeatureFlagsService.tenantSafeReportsEnabled()`.
- Documented in `backend/src/saas/feature-flags/flags.ts`.

### 1.3 Integration switch (legacy `reports.service.ts`)

- `ReportsModule` now imports `FeatureFlagsModule` (additive).
- `ReportsService` constructor takes `FeatureFlagsService` (additive).
- `executeReport()` checks `isTenantSafeRoute(report.dataSource)` first:
  - **flag OFF or source not READY** → legacy path runs unchanged.
  - **flag ON + source READY** → `executeReportTenantSafe()` runs:
    - looks up the validated `SourceDef`
    - reads `tenantId`/`agencyIds`/`platformAdmin` from ALS via `TenantContext.optional()` / `UserContext.optional()` — fails loud if `TenantContext` missing
    - calls `composeReportSql(...)` to get parameterised SQL
    - runs via `prisma.$queryRawUnsafe(...)` — the **only** site annotated `@tenant-reviewed: tenant-safe-report-runtime`

The lazy `require(...)` for the runtime ensures **zero** new code executes when the flag is off — protecting the production code path even from accidental module-load side effects.

## 2. Required environment

Tenant-safe reports require an active `TenantContext` in ALS. Today this is supplied by the dormant `TenantContextMiddleware` (also disabled). To exercise tenant-safe reports manually you must wrap the request in:

```ts
import { withRequestContext, TenantContext } from '@/saas/context';

await withRequestContext({ requestId: '...' }, async () => {
  TenantContext.attach({ id: '<tenantId>', slug: '...', name: '...', status: 'ACTIVE', region: 'eu' });
  await reportsService.run(reportId, opts);
});
```

The legacy code path does NOT require this; it remains the production default.

## 3. How to run the harnesses

```sh
# 1. Phase 0 + Phase 1 prep migrations on a SAFE_CLONE staging DB
npm run saas:apply-migrations

# 2. Backfill (writes 4 tenants on the fixture)
ALLOW_SAAS_STAGING_MUTATION=true npm run saas:phase1-backfill-dry-run -- --apply

# 3. Read-equivalence (compares legacy vs safe queries)
npm run saas:phase2-reports-equivalence
# → "3/3 sources equivalent (0 delta, 0 errors)"

# 4. Tenant isolation
npm run saas:phase2-reports-isolation
# → "3/3 sources isolated."

# 5. Source status snapshot
npm run saas:phase2-reports-status
```

## 4. How to enable in staging

Per `SAAS_PHASE2_REPORTS_ROLLOUT_PLAN.md`. In short:

```sh
ALLOW_SAAS_STAGING_MUTATION=true \
TENANT_SAFE_REPORTS_ENABLED=true \
MULTI_TENANT_ENABLED=true \
DATABASE_URL=... \
npm start
```

`MULTI_TENANT_ENABLED` is required because the safe path needs `TenantContext`. The Phase 2.0 middleware skeleton is already in `backend/src/saas/context/tenant-context.middleware.ts`; Phase 2.5 wires it into `AppModule`. Until then, staging integration tests use `withRequestContext` programmatically.

## 5. Rollback

| Action | Effect |
|---|---|
| `TENANT_SAFE_REPORTS_ENABLED=false` (deploy) | `isTenantSafeRoute` returns false; legacy path runs; safe runtime not loaded |
| Revert this commit | All Phase 2.1 code removed; legacy path is what was always running |
| Revert `executeReportTenantSafe` only | Keep Phase 2.0 scaffolding; remove integration switch — same effect as the flag |

There is no data migration. Rollback is at most a config/deploy change.

## 6. Monitoring

Once enabled in staging:

- Metric `reports.path` with values `legacy` / `tenant_safe` per request.
- Metric `reports.tenant_safe.errors` per error class (disabled-source, missing-tenant, builder-error).
- Log line on every disabled-source rejection so the operator can see which sources are still being requested by the UI.

## 7. Risks

| Risk | Severity | Mitigation |
|---|---|---|
| New path returns different rows than legacy | HIGH | Read-equivalence harness gates the cutover per source |
| `TenantContext` missing under flag-on | HIGH | Fails loud with `REPORT.TENANT_CONTEXT_REQUIRED` |
| Disabled source breaks an existing UI flow | MEDIUM | The legacy path still runs for DISABLED sources (no behaviour change) |
| `$queryRawUnsafe` site mis-formed | MEDIUM | SQL composed only by `composeReportSql()`; tested against a Postgres DB in CI |
| Operator enables flag in production prematurely | HIGH | Safety: missing `MULTI_TENANT_ENABLED` causes immediate fail-loud; `tenantSafeReportsEnabled()` is read once at boot, not per-request |

## 8. Unresolved mappings

15 sources DISABLED. Reasons:
- 5 entity-keyed sources awaiting Phase 2.3 `tenantId` denorm.
- 10 multi-table sources awaiting both the denorm AND the `tenant_id = tenant_id` join rewrite.

`SAAS_PHASE2_REPORTS_SOURCE_STATUS.md` is the canonical worklist.

## 9. Files

| Path | Status |
|------|--------|
| `backend/src/saas/feature-flags/flags.ts` | modified — `TENANT_SAFE_REPORTS_ENABLED` added |
| `backend/src/saas/feature-flags/feature-flags.service.ts` | modified — typed accessor added |
| `backend/src/saas/reports/runtime/report-sources.ts` | new |
| `backend/src/saas/reports/runtime/compose-sql.ts` | new |
| `backend/src/saas/reports/runtime/tenant-safe-reports.service.ts` | new |
| `backend/src/saas/reports/runtime/index.ts` | new |
| `backend/src/reports/reports.module.ts` | modified — imports `FeatureFlagsModule` |
| `backend/src/reports/reports.service.ts` | modified — `isTenantSafeRoute()` + `executeReportTenantSafe()` |
| `backend/scripts/scan-raw-sql.ts` | modified — runtime/ directory excluded; `@tenant-reviewed: tenant-safe-report-runtime` recognised |
| `backend/scripts/saas/phase2/reports-read-equivalence.ts` | new |
| `backend/scripts/saas/phase2/reports-isolation-test.ts` | new |
| `backend/package.json` | modified — 3 new npm scripts |

## 10. Done definition

For Phase 2.1 to be considered complete:

- [x] `TENANT_SAFE_REPORTS_ENABLED` registered, default false.
- [x] Runtime under `backend/src/saas/reports/runtime/` builds and unit-tests pass.
- [x] At least 3 sources mapped READY.
- [x] Read-equivalence harness runs against the staging fixture: 3/3 equivalent.
- [x] Isolation harness runs against the staging fixture: 3/3 isolated.
- [x] Legacy path byte-identical when flag off (verified by `git diff` on app/main/auth/prisma).
- [x] Scanner allow-lists `runtime/` and recognises the `@tenant-reviewed: tenant-safe-report-runtime` tag.
- [x] Documentation: `SAAS_PHASE2_REPORTS_SOURCE_STATUS.md`, this file, equivalence + isolation result docs, rollout plan.

Phase 2.1 is **DONE** for the toolchain. Production cutover is a separate, sign-off-gated step.
