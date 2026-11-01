# Phase 2.60 — Retry-After Header + Structured 429 Envelope

> Adds a stable JSON envelope and `Retry-After` header to every
> rate-limited 429 response on `/admin/tenant-audit/*`. Default-OFF;
> envelope only fires when the Phase 2.59 limiter is enabled and a
> request is rejected.

---

## 1. Response envelope

When the limiter rejects, `enforceRateLimit` throws an
`HttpException` with this body:

```json
{
  "statusCode": 429,
  "error": "rate_limited",
  "message": "Too Many Requests",
  "retryAfterSeconds": 60,
  "limit": 1,
  "remaining": 0,
  "windowSeconds": 60
}
```

| Field | Type | Meaning |
|---|---|---|
| `statusCode` | `number` | always `429` |
| `error` | `string` | always `'rate_limited'` (stable) |
| `message` | `string` | always `'Too Many Requests'` |
| `retryAfterSeconds` | `number` (positive integer) | seconds until the current window expires |
| `limit` | `number` | resolved RPM at the time of rejection |
| `remaining` | `number` | always `0` on rejection |
| `windowSeconds` | `number` | resolved window (`AUDIT_LOG_HTTP_RATE_LIMIT_WINDOW_SECONDS`) |

## 2. Retry-After behaviour

When the controller has access to the response object (all five
GET routes — list / stats / retention-preview / export.csv /
byId — declare `@Res({ passthrough: true })` or `@Res()`), the
following header is added on the 429:

```
Retry-After: <retryAfterSeconds>
```

For routes invoked directly in unit/harness contexts where `res`
is undefined, the header is silently skipped — the JSON body still
carries the same value, so clients can implement back-off without
the header.

## 3. Route coverage

Every protected GET route returns the same envelope on rejection:

| Route | Limiter | Envelope on 429 | Retry-After |
|---|---|---|---|
| `GET /admin/tenant-audit` | ✅ | ✅ | ✅ |
| `GET /admin/tenant-audit/stats` | ✅ | ✅ | ✅ |
| `GET /admin/tenant-audit/retention-preview` | ✅ | ✅ | ✅ |
| `GET /admin/tenant-audit/export.csv` | ✅ | ✅ (NOT CSV) | ✅ |
| `GET /admin/tenant-audit/:id` | ✅ | ✅ | ✅ |

Source-level harness (case 17) walks each `@Get(...)` and verifies
each handler invokes `enforceRateLimit(..., res)`.

## 4. CSV 429 behaviour

`GET /admin/tenant-audit/export.csv` is the only protected route
whose success path emits non-JSON. On 429:

- The handler throws BEFORE `res.send(<csv>)` runs.
- `res.body` remains empty (case 11 of harness).
- `res.headers['Content-Type']` is **NOT** `text/csv` (Nest's
  default exception filter sets `application/json`).
- `Retry-After` header is set on the same response object.

So clients receive a JSON envelope on 429 even on the export
endpoint, while a successful response still streams text/csv with
all Phase 2.58 headers (case 13).

## 5. Disabled-by-default behaviour

When the limiter is disabled (`AUDIT_LOG_HTTP_RATE_LIMIT_ENABLED=false`
or `AUDIT_LOG_HTTP_RATE_LIMIT_RPM ≤ 0`):

- `decision.enabled === false` ⇒ no header is set.
- No `HttpException` is thrown.
- Routes behave byte-identically to Phase 2.58 (case 1 of harness).

## 6. RBAC error interaction

The Phase 2.56 RBAC contract still wins on missing ALS:

- A request with no ALS frame in pilot mode raises
  `ForbiddenException('Audit-log read requires an active tenant context')`
  from inside `LogsService` AFTER the limiter consumes a slot.
- Case 16 of the harness verifies the caller still sees the
  Forbidden error, not a 429.

The limiter never **masks** a real access error.

## 7. Implementation summary

`AuditLogRateLimiter` (Phase 2.59) gains a non-throwing variant:

```ts
tryConsume(key: string): AuditRateLimitDecision
```

`AuditRateLimitDecision` already carries `retryAfterSeconds`,
`limit`, `remaining`, `windowSeconds`, and `enabled` (Phase 2.59).

`TenantAuditController.enforceRateLimit(caller, res?)`:

1. Calls `tryConsume(...)`.
2. When `decision.enabled` is true AND `res` is present, sets
   `X-RateLimit-{Limit,Remaining,Window}` (Phase 2.59 behaviour).
3. When `decision.enabled` is true AND `decision.allowed` is false:
   - sets `Retry-After: <retryAfterSeconds>` if `res` is present,
   - throws `HttpException(<envelope>, 429)`.

All five GET handlers now declare `@Res({ passthrough: true }) res?: Response`
(or `@Res() res: Response` for `exportCsv` which manages its own
response stream) so the controller can attach headers without
taking over Nest's response handling.

## 8. Harness — `audit-log-http-rate-limit-envelope` 17/17 PASS

```
[audit-log-http-rate-limit-envelope] 17/17 PASS
```

1. limiter disabled ⇒ no Retry-After header added
2. enabled RPM=1 ⇒ second list request returns status 429
3. 429 body has `error='rate_limited'`
4. 429 body has `retryAfterSeconds` positive integer
5. 429 body has `limit`
6. 429 body has `remaining=0`
7. 429 body has `windowSeconds`
8. `Retry-After` header equals `retryAfterSeconds`
9. stats route returns same structured 429 envelope
10. retention-preview route returns same structured 429 envelope
11. export.csv returns structured 429 envelope, **not CSV**
12. byId route returns same structured 429 envelope
13. successful export.csv still returns text/csv and export headers
14. tenant A 429 envelope does not affect tenant B
15. global FULL_ACCESS rate-limit envelope uses global/user key
16. missing ALS in pilot returns Forbidden, not rate-limit envelope
17. every TenantAuditController GET handler passes `res` to `enforceRateLimit`

## 9. Validation results

- `nest build` clean
- `npx prisma validate` clean
- `npm run saas:validate` 6/6 suites
- `npm run saas:schema-lint` 0 issues
- `npm run saas:scan:annotations` 0 findings
- `npm run saas:scan:raw-sql` 26 findings — **baseline unchanged**
- All Phase 2.47–2.59 audit / attendance / backfill / runbook /
  RBAC / HTTP / export / rate-limit harnesses green
- Full sentinel chain green
- **Cumulative: 764/764**

## 10. Production behaviour change

**None with default flags.** With the limiter disabled, the new
envelope path is unreachable — `enforceRateLimit` short-circuits
because `decision.enabled === false`. The handlers' response shape
is byte-identical to Phase 2.59. Activation of the envelope
behaviour requires:

```sh
AUDIT_LOG_HTTP_RATE_LIMIT_ENABLED=true
AUDIT_LOG_HTTP_RATE_LIMIT_RPM=<positive integer>
```

## 11. Rollback (configuration-only for behaviour)

```sh
AUDIT_LOG_HTTP_RATE_LIMIT_ENABLED=false   # default — fully inert
# OR
AUDIT_LOG_HTTP_RATE_LIMIT_RPM=0           # invalid / non-positive ⇒ disabled
```

To remove the envelope itself:
- Revert `enforceRateLimit` (Phase 2.60 sections — the
  `tryConsume` call, `Retry-After` header set, structured
  `HttpException`),
- Revert `tryConsume` from `AuditLogRateLimiter`.

The Phase 2.59 behaviour (raw 429 with no envelope) returns. No
data rollback required.

## 12. Remaining blockers

- The limiter is still per-process (in-memory). Multi-instance
  deployments need a shared store. Phase 2.61 (or later) can
  introduce a Redis-backed limiter behind a separate flag.
- The envelope is delivered through Nest's default exception
  filter. If the project later introduces a custom global
  exception filter, the envelope must remain stable.

## 13. Recommended next phase

**2.61 — Redis-backed rate-limit store (optional).** Add an
optional driver behind `AUDIT_LOG_HTTP_RATE_LIMIT_STORE=memory|redis`
(default `memory`) that, when set to `redis` and
`REDIS_URL` is configured, uses Redis `INCR` + `EXPIRE` for shared
quotas across instances. Default remains `memory` so production
behaviour is unchanged unless the operator opts in. The envelope
shape MUST remain identical to this phase.
