# Phase 2.59 — Per-tenant Rate Limit on Tenant Audit HTTP Endpoints

> Optional, default-OFF in-memory per-tenant rate limiter that
> protects every `/admin/tenant-audit/*` GET route. Returns
> `429 Too Many Requests` when exceeded. **Never destructive.**

---

## 1. Routes protected

Every GET route on `TenantAuditController`:

| Route | Limited |
|---|---|
| `GET /admin/tenant-audit` | ✅ |
| `GET /admin/tenant-audit/stats` | ✅ |
| `GET /admin/tenant-audit/retention-preview` | ✅ |
| `GET /admin/tenant-audit/export.csv` | ✅ |
| `GET /admin/tenant-audit/:id` | ✅ |

Source-level harness (case 16) walks every `@Get(...)` in the
controller and verifies each handler invokes `enforceRateLimit(...)`
within its body window. No destructive HTTP routes exist (case 17).

## 2. Disabled-by-default behaviour

| Variable | Default | Effect |
|---|---|---|
| `AUDIT_LOG_HTTP_RATE_LIMIT_ENABLED` | `false` | Limiter is fully inert; routes behave byte-identically to Phase 2.58. |
| `AUDIT_LOG_HTTP_RATE_LIMIT_RPM` | `0` | Even with `_ENABLED=true`, an RPM ≤ 0 (or non-numeric) leaves the limiter inert. |
| `AUDIT_LOG_HTTP_RATE_LIMIT_WINDOW_SECONDS` | `60` | Window length in seconds; invalid values fall back to 60. |

Activation requires both `AUDIT_LOG_HTTP_RATE_LIMIT_ENABLED=true`
**and** `AUDIT_LOG_HTTP_RATE_LIMIT_RPM > 0`. With either gate
missing, the controller short-circuits and routes work exactly as
in Phase 2.58.

## 3. Key strategy

`TenantAuditController.rateLimitKey(caller)`:

| Caller | `AUDIT_LOG_GLOBAL_READ_ENABLED` | Key |
|---|---|---|
| any role | `false` | `tenant:<ALS-tenant-id>` (or `tenant:none` if ALS missing) |
| FULL_ACCESS | `true` | `global:<userId>` |
| tenant-scoped | `true` | `tenant:<ALS-tenant-id>` (gate is no-op for non-FULL_ACCESS) |

This means:

- Tenant A and tenant B have **independent quotas** by default.
- A FULL_ACCESS user reading globally consumes their **own** quota,
  not any tenant's quota — so they can't exhaust a tenant's
  capacity.
- Switching the ALS frame across calls in a single global session
  does NOT refresh the quota — the global key stays stable.

Tag: `phase259-audit-log-rate-limit-keying`.

## 4. RPM / window behaviour

The limiter implements a fixed-window counter:

- One bucket per `(key, window)` of `WINDOW_SECONDS` seconds.
- Each `consume(key)` increments the current bucket counter.
- When the counter exceeds RPM, subsequent calls in the same
  window throw HTTP 429 with status `TOO_MANY_REQUESTS`.
- When the bucket ages past the window length, the next call
  opens a fresh bucket.

Harness case 15 verifies expiry by setting the window to 1 second,
exhausting the quota, waiting > 1s, and confirming the next request
succeeds.

## 5. Retry-After / response headers

When the limiter is enabled, allowed responses include:

```
X-RateLimit-Limit: <RPM>
X-RateLimit-Remaining: <slots-left-in-current-window>
X-RateLimit-Window: <seconds>
```

The 429 path raises `HttpException(429, 'Too Many Requests')`. A
`Retry-After` header is computed inside `AuditLogRateLimiter`'s
`AuditRateLimitDecision.retryAfterSeconds` and is available to a
future Nest exception filter that emits it on the response — but
direct controller-thrown exceptions bypass that filter, so the
header is **deferred** for now and documented as such. The 429
itself is sufficient for the brief's contract.

## 6. Global-read behaviour

When `AUDIT_LOG_GLOBAL_READ_ENABLED=true`:

- FULL_ACCESS callers reading globally are keyed by `global:<userId>`.
  Tenant A and tenant B requests count against the **same** quota
  (case 14 of the harness verifies this).
- Tenant-scoped callers are still keyed by `tenant:<id>` because
  the global gate is a no-op for them.

## 7. Order of checks

The controller order is: `enforceRateLimit(caller)` → service call
→ Phase 2.56 RBAC `assertAuditReadAccess` (raised inside the
service). This means a request that is over the limit is rejected
WITHOUT reaching the data path (case 10 of the harness verifies
the `findAll` spy count is unchanged across a 429). A request that
is under the limit but lacks an ALS frame still raises
`Forbidden` from RBAC (case 12), so the limiter never **masks** a
real access error.

## 8. Harness — `audit-log-http-rate-limit` 17/17 PASS

```
[audit-log-http-rate-limit] 17/17 PASS
```

1. limiter disabled ⇒ list behaves as Phase 2.58
2. limiter disabled ⇒ export.csv behaves as Phase 2.58
3. RPM=2 ⇒ third list request returns 429
4. tenant A exhaustion does not block tenant B
5. tenant B exhaustion does not block tenant A separately
6. stats route is rate-limited
7. retention-preview route is rate-limited
8. export.csv route is rate-limited
9. byId route is rate-limited
10. rejected 429 does NOT call LogsService data query
11. invalid `AUDIT_LOG_HTTP_RATE_LIMIT_RPM` falls back to disabled
12. missing ALS in pilot still raises Forbidden (RBAC reachable through limiter)
13. FULL_ACCESS with global gate OFF is tenant-keyed
14. FULL_ACCESS with global gate ON is global/user-keyed
15. limiter window expiry allows requests again
16. every TenantAuditController GET handler invokes `enforceRateLimit`
17. no destructive routes added

## 9. Validation results

- `nest build` clean
- `npx prisma validate` clean
- `npm run saas:validate` 6/6 suites
- `npm run saas:schema-lint` 0 issues
- `npm run saas:scan:annotations` 0 findings
- `npm run saas:scan:raw-sql` 26 findings — **baseline unchanged**
- All Phase 2.47–2.58 audit / attendance / backfill / runbook /
  RBAC / HTTP / export harnesses green
- Full sentinel chain green
- **Cumulative: 747/747**

## 10. Production behaviour change

**None with default flags.** The limiter is fully inert unless an
operator explicitly sets `AUDIT_LOG_HTTP_RATE_LIMIT_ENABLED=true`
**and** `AUDIT_LOG_HTTP_RATE_LIMIT_RPM > 0`. With those flags, the
five GET routes on `/admin/tenant-audit/*` start emitting `429`s
when a per-tenant (or per-global-actor) quota is exceeded. No
destructive paths are added.

## 11. Rollback (configuration-only)

```sh
AUDIT_LOG_HTTP_RATE_LIMIT_ENABLED=false   # the default — fully inert
# OR
AUDIT_LOG_HTTP_RATE_LIMIT_RPM=0           # invalid / non-positive ⇒ disabled
# OR
AUDIT_LOG_HTTP_RATE_LIMIT_WINDOW_SECONDS=60   # default; tweak only if needed
```

To remove the limiter entirely, revert
`src/logs/audit-log-rate-limiter.service.ts`, the constructor /
provider entries, and the `enforceRateLimit(...)` calls in
`tenant-audit.controller.ts`. No data rollback required (the
limiter state is in-memory only).

## 12. Remaining blockers

- `Retry-After` header is currently deferred (see §5). Adding it
  requires a Nest exception filter wired into the global pipeline,
  which is a separate phase to keep this one minimal.
- The limiter is per-process (in-memory). Multi-instance
  deployments share quotas only when the same process sees the
  call. Phase 2.60 (or later) can introduce a Redis-backed
  implementation guarded by the same flags.

## 13. Recommended next phase

**2.60 — `Retry-After` header + structured 429 envelope.** A
small Nest exception filter that converts
`HttpException(429, ...)` into a response with a populated
`Retry-After` header (seconds) and a stable JSON envelope
(`{ error: 'rate_limited', retryAfterSeconds: <n> }`). The filter
must apply only to the audit routes (or be globally idempotent).
Defaults remain off; behaviour with limiter disabled is unchanged.

---

# Phase 2.60 cross-link — structured 429 envelope + Retry-After

The deferred header from §11 is now wired. Rejected requests
return a stable JSON envelope (`error: 'rate_limited'`,
`retryAfterSeconds`, `limit`, `remaining`, `windowSeconds`) and
a matching `Retry-After: <seconds>` header. See
`SAAS_PHASE2_AUDIT_LOG_HTTP_RATE_LIMIT_ENVELOPE.md`.

Tags: `phase260-audit-log-rate-limit-envelope`,
`phase260-audit-log-retry-after-header`.
