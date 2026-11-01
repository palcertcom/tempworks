# Phase 2.2 — Tenant Context Activation (Staging)

> **Default production behaviour: unchanged.**
> The middleware, the auth bridge, and the diagnostics controller are
> all registered in `AppModule` but inert until both
> `MULTI_TENANT_ENABLED=true` AND the host is classified
> `SAFE_CLONE` / `SAFE_STAGING`. Production hosts with the flag on
> are refused at request time with a clear log line.

---

## 1. New feature flags (default `false`)

| Flag | Effect when `true` |
|---|---|
| `MULTI_TENANT_ENABLED` | Tenant resolution + ALS attach run for every request (in staging only). |
| `TENANT_SAFE_REPORTS_ENABLED` | Reports route through the new tenant-safe runtime when the source is READY. |
| `TENANT_CONTEXT_STAGING_ONLY` | Documentation marker — confirms operator intent. The middleware always self-gates on the env classifier; this flag is a tripwire for ops review. |
| `TENANT_CONTEXT_REQUIRED_FOR_SAFE_REPORTS` | Tenant-safe reports refuse with `REPORT.TENANT_CONTEXT_REQUIRED` when the request has no tenant in scope. When `false`, the safe path falls back to the legacy engine for the failing request. |

Existing flags (`PLATFORM_ADMIN_ENABLED`, `TENANT_SWITCHING_ENABLED`, etc.) are unchanged.

## 2. Files

### Created

| Path | Role |
|------|------|
| `backend/src/saas/tenancy/env-safety.ts` | Runtime classifier (`SAFE_CLONE` / `SAFE_STAGING` / `UNSAFE_PRODUCTION` / `UNKNOWN`) |
| `backend/src/saas/tenancy/tenant-resolver.service.ts` | Resolution by `X-Tenant-Id` (staging only) → custom domain → subdomain → legacy `agencyId` fallback |
| `backend/src/saas/tenancy/auth-bridge.interceptor.ts` | Bridges `req.user` (legacy JWT) into `UserContext` ALS |
| `backend/src/saas/tenancy/diagnostics.controller.ts` | `/api/v1/saas/diagnostics/{context,flags,tenant-resolution}` — staging only |
| `backend/src/saas/tenancy/tenancy.module.ts` | Wires all of the above; registers middleware via `NestModule.configure()` |
| `backend/scripts/saas/phase2/context-smoke-test.ts` | Seven in-process scenarios; `npm run saas:phase2-context-smoke` |
| `backend/scripts/saas/phase2/diagnostics-probe.ts` | Live HTTP probe of the diagnostics endpoints |

### Modified

| Path | Change |
|------|------|
| `backend/src/saas/feature-flags/flags.ts` | Two new flag keys + defaults `false` |
| `backend/src/saas/feature-flags/feature-flags.service.ts` | Two new typed accessors |
| `backend/src/saas/context/tenant-context.middleware.ts` | Activated: empty frame when off; resolves tenant when on; refuses outside staging |
| `backend/src/app.module.ts` | Imports `TenancyModule` (additive; the module is INERT when flag off) |
| `backend/src/reports/reports.service.ts` | When `TENANT_CONTEXT_REQUIRED_FOR_SAFE_REPORTS=true` and no context → fail loud; else → soft-fall-back to legacy engine for that request |
| `backend/package.json` | Two new scripts |

## 3. Tenant resolver behaviour (in order)

1. **`X-Tenant-Id` header** — accepted only when `classifyRuntimeEnv()` returns `SAFE_CLONE` / `SAFE_STAGING`. Strict UUID-shape match. Production hosts: header is logged and ignored.
2. **Custom domain** — `tenant_domains.host` exact match (case-insensitive).
3. **Subdomain** — leading label of `Host` header parsed against `tenants.slug`. Reserved labels (`www`, `api`) skipped.
4. **Legacy agency** — `req.user.agencyId` looked up in `agencies.tenantId` (Phase 1 backfill column). This is the safety bridge for staging users still authenticating with legacy JWTs that carry only `agencyId`.

If none match, `tenant: null` is returned and the middleware proceeds with an empty ALS frame. The downstream feature gates (e.g. `REPORT.TENANT_CONTEXT_REQUIRED`) decide whether absence is fatal.

## 4. Middleware activation

```
MULTI_TENANT_ENABLED=false                       → empty ALS frame, no DB hit
MULTI_TENANT_ENABLED=true on prod-classified host → request fails with clear error
MULTI_TENANT_ENABLED=true on safe-classified host → resolver runs, ALS populated
```

PUBLIC_NO_TENANT_PATHS (health, login, refresh, forgot/reset password, `/_platform/auth/*`) bypass resolution even when the flag is on.

## 5. Auth bridge

The `TenantContextAuthBridgeInterceptor` runs after the legacy `JwtAuthGuard`. When `MULTI_TENANT_ENABLED=true`:

- `req.user.id` → `UserContext.id`
- `req.user.email` → `UserContext.email` (used redacted in diagnostics)
- `req.user.agencyId` → `UserContext.agencyIds[]` (single entry)
- `req.user.agencyIsSystem` → `UserContext.platformAdmin`
- `permissions` left empty until Phase 3 wires the role projection

`req.user` is **not** modified. Existing controllers see the legacy shape exactly as today.

## 6. Diagnostics endpoints

| Method+Path | Returns |
|---|---|
| `GET /api/v1/saas/diagnostics/flags` | `{ flags: { MULTI_TENANT_ENABLED: ..., ... } }` |
| `GET /api/v1/saas/diagnostics/context` | redacted `{ requestId, tenant, user }` |
| `GET /api/v1/saas/diagnostics/tenant-resolution` | `{ method, tenantId, detail }` (set by middleware) |

Behaviour outside staging:
- `MULTI_TENANT_ENABLED=false` → `404 Not Found`
- env not `SAFE_*` → `404 Not Found`
- Never returns the JWT, secrets, or `process.env`.

## 7. Reports integration with context

| Flag combo | Behaviour for source S |
|---|---|
| `TENANT_SAFE_REPORTS_ENABLED=false` | Legacy engine. Always. |
| `=true`, source DISABLED | Legacy engine for S. Other sources unaffected. |
| `=true`, source READY, context absent, `TENANT_CONTEXT_REQUIRED=true` | `400 REPORT.TENANT_CONTEXT_REQUIRED` |
| `=true`, source READY, context absent, `TENANT_CONTEXT_REQUIRED=false` | Soft fall-back to legacy engine for THIS request only. |
| `=true`, source READY, context present | Tenant-safe runtime. |

The bypass is implemented via a single-shot instance flag (`__forceLegacyOnce`) read by `isTenantSafeRoute`. It can never escape the calling stack frame.

## 8. Smoke-test results (in-process)

```
context-smoke: 7/7 cases PASS
```

| # | Case | Result |
|---|---|---|
| 1 | Flags off → resolver no-op | PASS |
| 2 | Staging flags on + valid header → resolves from header | PASS |
| 3 | Production flags on → middleware refuses with clear error | PASS |
| 4 | Tenant-safe builder requires a valid tenantId | PASS |
| 5 | Disabled report source remains DISABLED | PASS |
| 6 | Ready source builder emits `tenantId = $1` first | PASS |
| 7 | Two parallel ALS frames do not bleed | PASS |

## 9. How to enable in staging (operator quick-ref)

```sh
# Required
export MULTI_TENANT_ENABLED=true
export TENANT_SAFE_REPORTS_ENABLED=true       # to actually route through new engine

# Recommended (tripwires + strictness)
export TENANT_CONTEXT_STAGING_ONLY=true
export TENANT_CONTEXT_REQUIRED_FOR_SAFE_REPORTS=true

# Database must classify SAFE_CLONE or SAFE_STAGING
export DATABASE_URL=postgres://...staging...

# Boot — middleware logs [ACTIVE] line on success or [FAIL-FAST] on prod hosts
npm start
```

Then:

```sh
curl -H 'X-Tenant-Id: 11111111-1111-1111-1111-111111111111' \
     -H 'Authorization: Bearer <jwt>' \
     http://localhost:3000/api/v1/saas/diagnostics/context
```

## 10. Rollback

| Action | RTO | Effect |
|---|---|---|
| `MULTI_TENANT_ENABLED=false` | seconds (deploy/restart) | middleware = empty ALS frame; auth bridge no-ops; diagnostics return 404 |
| Revert this commit | minutes | All Phase 2.2 code removed; Phase 2.1 reports integration also removed |
| `TENANT_CONTEXT_REQUIRED_FOR_SAFE_REPORTS=false` | seconds | If reports start failing with `REPORT.TENANT_CONTEXT_REQUIRED`, this flag immediately re-enables the soft legacy fallback |

## 11. Risks

| Risk | Severity | Mitigation |
|---|---|---|
| Operator enables `MULTI_TENANT_ENABLED=true` in production | HIGH | Middleware refuses every request with a clear log line; all `/api/v1/saas/diagnostics/*` returns 404; the failure is visible immediately, not silent |
| Auth bridge reads malformed `req.user` | LOW | Type-checks `id` is a string before mapping; falls through silently on unexpected shapes |
| Header `X-Tenant-Id` leak from a frontend in production | LOW | Resolver ignores the header outside staging; same header in legacy production paths is no-op |
| Diagnostics expose PII | LOW | Email/id redacted; full JWT never returned; `process.env` never returned |
