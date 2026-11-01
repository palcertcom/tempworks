# Phase 2.57 — Tenant-Scoped Audit HTTP Endpoints

> Read-only HTTP surface over `LogsService` + `TenantAuditLogService`,
> reusing the Phase 2.56 RBAC tenant-binding contract. **No
> destructive routes.** Phase 2.53/2.54 retention/hard-delete remain
> script-only.

---

## 1. Endpoint list

Mounted under `/admin/tenant-audit` by `TenantAuditController`:

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/admin/tenant-audit` | Tenant-scoped audit log list. |
| `GET` | `/admin/tenant-audit/stats` | Tenant-scoped stats (totals, byEntity, byAction, topUsers). |
| `GET` | `/admin/tenant-audit/retention-preview` | Read-only count of rows older than the cutoff. |
| `GET` | `/admin/tenant-audit/:id` | Tenant-scoped audit row by id. |

All four are `@Get`. The harness asserts no `@Post`, `@Put`,
`@Patch`, or `@Delete` decorators exist in the controller.

## 2. Allowed roles

```ts
@Roles('System Admin', 'Compliance Officer')
```

Pinned at the controller level. Any other role is rejected by
`RolesGuard` before the service is reached. The Phase 2.56 RBAC
tenant-binding still applies *inside* the service, so even a
System Admin cannot read another tenant's rows in pilot mode
unless `AUDIT_LOG_GLOBAL_READ_ENABLED=true` (and they are in
`FULL_ACCESS_ROLES`, which they are).

## 3. Tenant-binding behaviour

`TenantAuditController` is a thin wrapper around `LogsService`:

| Route | Service call | Tenant binding |
|---|---|---|
| `GET /` | `logsService.findAll(pagination, filters, scope)` | Phase 2.56 (`assertAuditReadAccess` + `auditTenantWhereForActor`) |
| `GET /stats` | `logsService.getStats(scope)` | same |
| `GET /retention-preview` | `logsService.previewRetentionForActor(scope, days?)` | tenant id from active ALS frame; refuses without ALS in pilot mode |
| `GET /:id` | `logsService.findOneForActor(id, scope)` | tenant predicate + role visibility; cross-tenant ⇒ `NotFoundException` |

## 4. Global-read gate behaviour

| `AUDIT_LOG_GLOBAL_READ_ENABLED` | FULL_ACCESS caller | Tenant-scoped caller |
|---|---|---|
| `false` (default) | tenant-bound | tenant-bound |
| `true` | global (NULL-tenant + B + A visible) | tenant-bound (gate is no-op) |

## 5. Filters supported

`GET /admin/tenant-audit` query params:

- `page`, `limit` — pagination.
- `entity`, `entityId` — exact match filters.
- `action` — substring (case-insensitive).
- `userId` — exact match (still composes with `resolveVisibleUserIds`).
- `fromDate`, `toDate` — `createdAt` ISO range.

`GET /admin/tenant-audit/retention-preview` query params:

- `days` — overrides `AUDIT_LOG_RETENTION_DAYS`. Invalid values
  fall back to the documented default (`365`).

## 6. Response shape

`GET /admin/tenant-audit` returns the existing `PaginatedResponse`:

```ts
{ data: AuditLog[], meta: { total, page, limit, totalPages } }
```

`GET /admin/tenant-audit/:id` returns a single `AuditLog` (with
`user` relation included) or raises `NotFoundException`.

`GET /admin/tenant-audit/stats` returns:

```ts
{ total, last24hCount, last7dCount, byEntity, byAction, topUsers }
```

`GET /admin/tenant-audit/retention-preview` returns:

```ts
{ enabled, days, cutoffIso, candidateCount, tenantId }
```

## 7. Retention preview behaviour

- Read-only. Wraps `TenantAuditLogService.previewRetention` (Phase
  2.52). The Phase 2.52 source-level harness already asserts that
  function contains no destructive Prisma calls.
- Tenant id is derived from the active ALS frame; the controller
  does NOT accept a tenant id in the URL or body.
- The HTTP route does NOT expose retention apply / soft-delete /
  hard-delete. Those remain script-only.

## 8. Destructive retention remains script-only

Phase 2.53 (`audit-log-retention-enforce.ts`) and Phase 2.54
(`audit-log-hard-delete.ts`) live in `scripts/saas/phase2/`. They
are not imported by `TenantAuditController` or `LogsService`. The
harness verifies this via source-level grep (case 18:
"controller does not call retention/hard-delete scripts").

## 9. Harness — `audit-log-http-endpoints` 18/18 PASS

```
[audit-log-http-endpoints] 18/18 PASS
```

1. list endpoint under tenant A returns only tenant A rows
2. list endpoint under tenant A excludes tenant B rows
3. list endpoint under tenant A excludes NULL-tenant rows
4. list endpoint preserves entity filter
5. list endpoint preserves entityId filter without tenant leakage
6. list endpoint preserves date range filter
7. list endpoint preserves pagination shape
8. byId endpoint returns tenant A row for tenant A
9. byId endpoint hides tenant B row from tenant A (NotFound)
10. stats endpoint counts only tenant A rows
11. retention-preview endpoint returns count only and modifies zero rows
12. retention-preview endpoint excludes tenant B rows for tenant A
13. missing ALS tenant context refuses safely (Forbidden)
14. controller @Roles pinned to System Admin / Compliance Officer only
15. FULL_ACCESS with global gate OFF remains tenant-bound (delegates to LogsService)
16. FULL_ACCESS with global gate ON sees global rows (B + NULL)
17. no HTTP route exposes retention apply, soft-delete, or hard-delete
18. controller does not call retention/hard-delete scripts

## 10. Validation results

- `nest build` clean
- `npx prisma validate` clean
- `npm run saas:validate` 6/6 suites
- `npm run saas:schema-lint` 0 issues
- `npm run saas:scan:annotations` 0 findings
- `npm run saas:scan:raw-sql` 26 findings — **baseline unchanged**
- All Phase 2.47–2.56 audit / attendance / backfill / runbook /
  RBAC harnesses green
- Full sentinel chain green
- **Cumulative: 713/713**

## 11. Production behaviour change

**None with default flags.** Adding new HTTP routes is additive —
the routes only activate for callers with the right JWT + role
that explicitly hit them. With `TENANT_PRISMA_PILOT_ENABLED=false`
or `audit-logs` not in the allow-list, the new routes return
legacy union (and `findOneForActor` still raises `NotFoundException`
for missing rows). With pilot active, the routes are tenant-bound
exactly as the Phase 2.56 contract dictates.

Note on testing approach: this harness invokes
`TenantAuditController` directly (no Nest HTTP bootstrap). It
covers the routing wiring and tenant-binding behaviour. The
RolesGuard (`@Roles(...)`) is verified by source-level assertion
(case 14) and the JwtAuthGuard is unchanged.

## 12. Rollback (configuration-only)

```sh
TENANT_PRISMA_PILOT_ENABLED=false           # disables pilot path; routes degrade to legacy union
# OR
TENANT_PRISMA_PILOT_MODULES=nothing         # opts audit-logs out only
# OR
AUDIT_LOG_GLOBAL_READ_ENABLED=true          # restores FULL_ACCESS global visibility on the new routes
```

Removing the routes themselves requires reverting
`src/logs/tenant-audit.controller.ts` and the `controllers` array
in `src/logs/logs.module.ts`. No data change involved.

## 13. Remaining blockers

None.

## 14. Recommended next phase

**2.58 — Tenant-scoped audit export (CSV/Excel) endpoint.** Add a
single `GET /admin/tenant-audit/export.csv` route that streams a
tenant-scoped export, reusing the same RBAC binding. Out of scope:
hard-delete export bundles (must remain script-only) and full-row
backups (already covered by `pg_dump`). The export endpoint must
have a row cap to prevent Excel-DoS.

---

# Phase 2.58 cross-link — CSV export endpoint

`GET /admin/tenant-audit/export.csv` joins the controller as a
fifth read-only route. Reuses the Phase 2.56 RBAC binding and
adds a hard row cap (`AUDIT_LOG_EXPORT_MAX_ROWS`, default 50000).
See `SAAS_PHASE2_AUDIT_LOG_EXPORT_CSV.md`.

Tags: `phase258-audit-log-export-csv`,
`phase258-audit-log-export-row-cap`,
`phase258-audit-log-export-no-destructive`.

---

# Phase 2.59 cross-link — per-tenant rate limit

`TenantAuditController` now gates every GET route through
`enforceRateLimit(caller, res?)` BEFORE delegating to
`LogsService`. The limiter is OFF by default; activation requires
`AUDIT_LOG_HTTP_RATE_LIMIT_ENABLED=true` AND
`AUDIT_LOG_HTTP_RATE_LIMIT_RPM > 0`. See
`SAAS_PHASE2_AUDIT_LOG_HTTP_RATE_LIMIT.md`.

Tags: `phase259-audit-log-http-rate-limit`,
`phase259-audit-log-rate-limit-keying`,
`phase259-audit-log-rate-limit-disabled-default`.

---

# Phase 2.60 cross-link — 429 envelope + Retry-After

All five GET routes on `TenantAuditController` now share a stable
JSON envelope on rate-limit rejection and emit a `Retry-After`
header. See `SAAS_PHASE2_AUDIT_LOG_HTTP_RATE_LIMIT_ENVELOPE.md`.
