# Phase 2 — Tenant Context Activation Plan

> Goal: turn the dormant `TenantContextMiddleware` and the dual-claim JWT issuer ON, in staging only, with **zero regression in legacy login**, then per-environment per-flag rollout.

The middleware exists (`backend/src/saas/context/tenant-context.middleware.ts`) but is **not registered** in `AppModule`. Phase 2 plans how it gets registered safely.

---

## 1. Activation prerequisites

Before any flag flip:

- [ ] Phase 1 backfill ran on the target environment (staging); `tenants` populated; `tenant_memberships` populated for every active user.
- [ ] `User.agencyId` may still be non-NULL; it remains the legacy authority during the dual-claim window.
- [ ] `npm run saas:env-safety` returns `SAFE_CLONE` or `SAFE_STAGING` for the target.
- [ ] All P0+P1 modules in the runtime inventory have been migrated to `tenantPrisma` (flag remains OFF).
- [ ] `TENANT_PRISMA_ENFORCEMENT=false`. We turn the middleware on **before** the wrapper, never the other way around.

## 2. Activation order

The middleware activates in **layered** flag flips, so the failure mode of each layer is "the request looks like today" not "production is broken":

```
Step 1.  MULTI_TENANT_ENABLED=true on a single staging pod.
         TenantContextMiddleware resolves tenant from host; failures
         are logged but the request still proceeds (legacy mode).

Step 2.  Wire the middleware into AppModule (config-gated).

Step 3.  DUAL_CLAIM_JWT=true on the same pod.
         Issuer emits both claim sets; verifier accepts both.

Step 4.  Frontend hits /api/v1/bootstrap; observation window 24h.

Step 5.  Promote to all staging pods.

Step 6.  TENANT_PRISMA_ENFORCEMENT=true on a single staging pod.
         Tenant filter is now active in the data layer.
         RLS still off.

Step 7.  Promote enforcement across staging.

Step 8.  RLS_ENFORCEMENT=true (audit-mode) for 7 days.

Step 9.  RLS FORCE per-table.

Step 10. Production rollout (separate phase; sign-off gated).
```

**Each step is gated by:**
- A 24-hour observation window with no error-rate regression on `GET /healthz`, `POST /auth/login`, three representative tenant-scoped endpoints.
- A read-equivalence diff against the previous step (zero unexpected deltas).
- Sign-off in the staging-apply checklist.

## 3. How tenant resolution works during the transition

Order of resolution inside `TenantContextMiddleware` once active:

1. If the request path is in `PUBLIC_NO_TENANT_PATHS` (health, login, refresh, forgot-password, reset-password, `/_platform/auth/*`) → no tenant. Legacy path runs.
2. Else: parse `req.hostname`.
   - Match `<slug>.<base>` against `tenants.slug`.
   - Match against `tenant_domains.host`.
   - Cache the result in Redis for 5 min (per ADR-004 §7).
3. If no tenant matches:
   - **Legacy mode** (Phase 2.1–2.3): log a warning; treat as no-tenant; legacy code path proceeds with `req.user.agencyId` as authority. **No 404.** This is the safety valve while users are still hitting the unbranded host.
   - **Strict mode** (Phase 2.5+): return 404. Rolling out behind a feature flag (`MULTI_TENANT_STRICT_HOST=true`) per-environment.

## 4. How current users map to active tenant

- Existing users have one `TenantMembership` (Phase 1 backfill: one membership per non-system user, against the tenant that subsumed their original Agency).
- After login, `IdentityService.listMemberships(userId)` → exactly 1 row → mint access token with `tid=<that>` and redirect to that tenant's host.
- For users with multiple memberships (post-cutover, when invites land): mint a `tenant_select` token; redirect to `/select-workspace`.

There is **no automatic tenant switch by URL host alone** — the user's JWT is still the authority. If the JWT's `tid` doesn't match the host's resolved tenant, the request returns 401 with `WWW-Authenticate: switch-tenant`. The frontend then calls `/auth/switch-tenant`.

## 5. JWT evolution

The dual-claim window is the safest path:

```
Phase 0 (current)     legacy { id, email, agencyId, agencyIsSystem, ... }
Phase 2.0–2.5         dual    { ...legacy + tid, mid, scp, agy, pa }
Phase 3+              new     { id, email, tid, mid, scp, agy, pa }
```

`JwtAuthGuard` accepts both shapes for the duration of the dual-claim window (≥ 30 days = one refresh-token TTL). Verifier prefers the new shape if both are present; falls back to legacy.

Phase 3 retires legacy claims once all clients have refreshed at least once.

## 6. How to avoid breaking login

| Risk | Mitigation |
|------|------------|
| Login endpoint accidentally requires a host that resolves to a tenant | `/auth/login` is in `PUBLIC_NO_TENANT_PATHS`. Dual-tested. |
| Verifier rejects legacy-only tokens | Verifier accepts both shapes throughout Phase 2. |
| User has zero memberships post-backfill | Backfill produces one membership per non-system user. Verified by `verify-tenant-backfill`. Edge cases (orphans) are quarantined and remain in the legacy path. |
| 2FA challenge state confused by tenant context | 2FA happens **before** tenant context is required; `TwoFactorChallenge` table is global. |
| Password-reset tokens carry tenant info | They don't — they're keyed on `userId`. No change. |

## 7. Keeping tenant context nullable during the transition

`TenantContext.optional()` returns `TenantSnapshot | null`. Legacy code paths use `optional()`; only Phase 2-migrated services call `.current()` (which throws). The middleware sets the context based on host, but the absence of a context is **not** itself an error during the dual-claim window.

A dedicated metric (`saas.middleware.no_tenant_resolved`) counts requests that ran without tenant context, broken down by path. This metric must approach zero before Step 9 (RLS FORCE).

## 8. Testing with flags ON in staging

Two staging variants run side-by-side:

| Variant | `MULTI_TENANT_ENABLED` | `TENANT_PRISMA_ENFORCEMENT` | `RLS_ENFORCEMENT` | Audience |
|---------|:---:|:---:|:---:|----------|
| `staging-legacy` | false | false | false | smoke parity test (must match prod) |
| `staging-tenant` | true  | true  | false | Phase 2 testing |
| `staging-rls`    | true  | true  | true  | Phase 2.6+ rollout testing |

Each variant has its own DB clone (or schema). Read-equivalence tests run nightly across pairs.

## 9. Manual smoke-test checklist (per flag flip)

- [ ] `POST /auth/login` for a user from each tenant (curl + UI both).
- [ ] `GET /api/v1/bootstrap` returns the expected tenant + memberships.
- [ ] Switch-workspace flow works (when N memberships exist; build via invite).
- [ ] Three representative tenant-scoped endpoints return the same row counts as the legacy variant.
- [ ] Three representative cross-tenant attempts (Tenant A user, Tenant B id in URL) return 404 (not 200, not 500).
- [ ] No 5xx in last 100 application log lines.

## 10. Rollback

| Flag | Rollback action | Effect |
|------|-----------------|--------|
| `MULTI_TENANT_ENABLED=false` | redeploy with env var off | middleware becomes a no-op; `TenantContext.optional()` returns null everywhere |
| `TENANT_PRISMA_ENFORCEMENT=false` | redeploy with env var off | wrapper becomes a pass-through |
| `RLS_ENFORCEMENT=false` | revoke `FORCE` per table; downgrade to audit-mode | log-only |

Rollback is **always per-flag**, never per-table-of-data. The data is unchanged across all states.

## 11. Operational runbooks (added in Phase 2.5)

- `docs/runbooks/phase2-flag-flip.md` — per-flag flip procedure.
- `docs/runbooks/phase2-incident-response.md` — what to do if read-equivalence diffs explode after a flip.
- `docs/runbooks/phase2-emergency-rollback.md` — full-stack rollback to Phase 0 dormant.
