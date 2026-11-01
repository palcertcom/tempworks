# Phase 2.2 — Staging Flags Runbook

> Goal: an operator running this branch on a staging cluster knows
> exactly which env vars to set, in what order, what to verify, and
> how to disable in seconds.

---

## 1. Pre-flight (one-time per environment)

- [ ] Branch `claude/design-multitenant-recruitment-8H42T` deployed.
- [ ] Phase 0 + Phase 1 prep migrations applied (`saas:apply-migrations`).
- [ ] Phase 1 backfill executed on the SAFE_CLONE / SAFE_STAGING DB so `tenants` is populated.
- [ ] `npm run saas:env-safety` returns `SAFE_CLONE` or `SAFE_STAGING`.

If any of the above is false, **do not turn on the flags**. The
middleware will refuse the request, but the operational waste of a
botched deploy outweighs the cost of running pre-flight first.

## 2. Required environment variables

```sh
# Mandatory for staging activation
MULTI_TENANT_ENABLED=true

# Optional: route reports through the new engine
TENANT_SAFE_REPORTS_ENABLED=true

# Optional: refuse reports that have no tenant context
TENANT_CONTEXT_REQUIRED_FOR_SAFE_REPORTS=true

# Tripwire only (does nothing at runtime; documents intent for ops review)
TENANT_CONTEXT_STAGING_ONLY=true

# Staging clone allow-list signal
ALLOW_SAAS_STAGING_MUTATION=true

# DB
DATABASE_URL=postgres://postgres@<staging-host>/<dbname>?sslmode=...
```

Recommended profile for a fresh staging activation:

```
MULTI_TENANT_ENABLED=true
TENANT_SAFE_REPORTS_ENABLED=false           # turn on later, after diagnostics confirm health
TENANT_CONTEXT_REQUIRED_FOR_SAFE_REPORTS=false
TENANT_CONTEXT_STAGING_ONLY=true
```

After 24h of clean diagnostics, flip `TENANT_SAFE_REPORTS_ENABLED=true`.
After another 24h, flip `TENANT_CONTEXT_REQUIRED_FOR_SAFE_REPORTS=true`.

## 3. Boot logs to expect

On a staging-classified host:

```
[FeatureFlags] Phase 0 feature flags: MULTI_TENANT_ENABLED=true ...
[TenantContextMiddleware] [ACTIVE] MULTI_TENANT_ENABLED=true, env=SAFE_CLONE,
                                   reason=localhost + fixture pattern (db=saas_phase1_fixture)
```

On a production-classified host (the safety net you should never see):

```
[TenantContextMiddleware] [FAIL-FAST] MULTI_TENANT_ENABLED=true outside staging — env=UNSAFE_PRODUCTION,
                                       reason=NODE_ENV=production. Middleware will refuse every request.
```

If you see the FAIL-FAST line, **deploy `MULTI_TENANT_ENABLED=false` immediately**. The middleware is refusing every request.

## 4. Diagnostics walk-through

Once the app is up:

```sh
# Flags
curl http://localhost:3000/api/v1/saas/diagnostics/flags
# → { "flags": { "MULTI_TENANT_ENABLED": true, ... } }

# Context (with auth + tenant header)
curl -H 'X-Tenant-Id: <uuid>' \
     -H 'Authorization: Bearer <jwt>' \
     http://localhost:3000/api/v1/saas/diagnostics/context
# → { "requestId": "...", "tenant": { "id": "...", "slug": "..." }, "user": { ... redacted } }

# Resolution method
curl -H 'X-Tenant-Id: <uuid>' \
     -H 'Authorization: Bearer <jwt>' \
     http://localhost:3000/api/v1/saas/diagnostics/tenant-resolution
# → { "method": "header", "tenantId": "<uuid>", "detail": "X-Tenant-Id (staging)" }
```

If the endpoints return `404`:
- the env classifier has not classified the host as staging, OR
- `MULTI_TENANT_ENABLED=false`.

## 5. Tenant-safe reports — how to test

```sh
# 1. Confirm safe-mode is active
curl http://localhost:3000/api/v1/saas/diagnostics/flags

# 2. Run a known report against a known tenant
curl -X POST \
     -H 'X-Tenant-Id: <uuid>' \
     -H 'Authorization: Bearer <jwt>' \
     -H 'Content-Type: application/json' \
     http://localhost:3000/api/v1/reports/<id>/run \
     -d '{}'
# Inspect the response. Compare row counts to the legacy-mode response.
```

For automated comparison, run:

```sh
DATABASE_URL=... npm run saas:phase2-reports-equivalence
DATABASE_URL=... npm run saas:phase2-reports-isolation
```

Both must report `0 delta, 0 errors` and `N/N isolated` respectively
before promoting the flag profile to a wider audience.

## 6. Rollback

| Symptom | Action | RTO |
|---|---|---|
| Reports started returning 400 `REPORT.TENANT_CONTEXT_REQUIRED` | `TENANT_CONTEXT_REQUIRED_FOR_SAFE_REPORTS=false` | seconds (deploy) |
| Tenant-safe path producing different row counts | `TENANT_SAFE_REPORTS_ENABLED=false` | seconds |
| Anything weird with login or middleware | `MULTI_TENANT_ENABLED=false` | seconds |
| Worst case | revert to commit before Phase 2.2 | minutes |

The data is unchanged across all states. Rollback is config / deploy
only.

## 7. Daily monitoring checklist

- [ ] `[ACTIVE]` line in startup log (or absent if flags off — verify intent).
- [ ] `/api/v1/saas/diagnostics/flags` reachable in staging, 404 in prod.
- [ ] `npm run saas:phase2-context-smoke` passes (CI / nightly).
- [ ] `npm run saas:phase2-reports-equivalence` passes against the staging clone.
- [ ] No `[FAIL-FAST]` log lines anywhere.
- [ ] Counter `reports.path` shows the expected `legacy` vs `tenant_safe` mix.

## 8. Known constraints

- The diagnostics endpoints expect `Host` header to look like a staging host. Frontend integrations on staging that proxy through `localhost` must include `--resolve <host>:80:127.0.0.1` (curl) or equivalent in their local config.
- The legacy-fallback path (`TENANT_CONTEXT_REQUIRED_FOR_SAFE_REPORTS=false`) re-enters `executeReport` once per failing call. It does not silently swallow other errors.
- The `X-Tenant-Id` header is case-insensitive (Express normalises). Both `X-Tenant-Id` and `x-tenant-id` work.
