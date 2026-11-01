# Phase 2.58 — Tenant-Scoped Audit CSV Export

> Read-only HTTP CSV export of audit logs, tenant-scoped via the
> Phase 2.56 RBAC contract, hard-capped to a configurable max-row
> count. **Never destructive.**

---

## 1. Endpoint

`GET /admin/tenant-audit/export.csv`

| Aspect | Value |
|---|---|
| Method | `GET` only |
| Roles | `System Admin`, `Compliance Officer` |
| Body | n/a (download) |
| Content-Type | `text/csv; charset=utf-8` |
| Content-Disposition | `attachment; filename="audit-export-<iso-timestamp>.csv"` |

## 2. Allowed roles

Pinned at the controller level via `@Roles('System Admin', 'Compliance Officer')`.
Any other role is rejected by `RolesGuard` before the service is
reached. The service still applies the Phase 2.56 RBAC binding from
inside, so even an elevated role cannot export another tenant's
rows in pilot mode unless the global-read gate is on.

## 3. Tenant-binding behaviour

The export delegates to `LogsService.exportCsvForActor(filters, scope)`,
which:

1. calls `assertAuditReadAccess(scope)` → refuses with `Forbidden`
   if the audit-logs pilot is active and the ALS tenant frame is
   missing (Phase 2.56 contract);
2. composes the `where` from `auditTenantWhereForActor(scope)`
   (Phase 2.56) plus the requested filters;
3. layers the existing `resolveVisibleUserIds` role visibility on
   top (so non-FULL_ACCESS roles still get per-user restriction).

| Pilot allow-listed? | ALS attached? | Global gate | Actor role | Outcome |
|---|---|---|---|---|
| no | n/a | n/a | any | legacy union (byte-identical to pre-2.58) |
| yes | no | n/a | any | `ForbiddenException` |
| yes | yes | off | FULL_ACCESS or tenant-scoped | tenant-bound |
| yes | yes | on | FULL_ACCESS | global rows allowed |
| yes | yes | on | tenant-scoped | tenant-bound (gate is no-op) |

## 4. Global read gate behaviour

`AUDIT_LOG_GLOBAL_READ_ENABLED` (Phase 2.56) governs whether
FULL_ACCESS roles can bypass the tenant predicate. With the gate
ON, the export under a FULL_ACCESS caller includes tenant A,
tenant B, and NULL-tenant rows; with the gate OFF (default), only
the active tenant's rows are exported.

## 5. Filters supported

Query params (all optional):

- `entity` — exact match
- `entityId` — exact match
- `action` — substring (case-insensitive)
- `userId` — exact match
- `fromDate`, `toDate` — `createdAt` ISO range

The service always applies `deletedAt: null`, so soft-deleted rows
(Phase 2.53) are excluded from exports.

## 6. Columns exported

```
id, tenantId, createdAt, userId, userEmail, action, entity, entityId, ipAddress, userAgent
```

`changes` is **omitted** by design to keep the CSV small and to
avoid arbitrary jsonb that would need careful CSV escaping. If a
future product phase needs the `changes` payload, that's a separate
phase with explicit operator review.

## 7. CSV escaping rules

Implements RFC-4180-style escaping:

- Fields containing `,`, `"`, CR, or LF are wrapped in double-quotes.
- Internal double-quotes are escaped as `""`.
- Lines are joined with `\r\n` (CRLF) for Excel compatibility.
- Encoding is UTF-8.

Example tricky `userAgent` value:

```
csv,"with","quotes"
newline
```

is encoded as:

```
"csv,""with"",""quotes""<LF>newline"
```

The harness includes a row with this exact userAgent value and
asserts the encoded CSV matches.

## 8. Row cap

`AUDIT_LOG_EXPORT_MAX_ROWS`:

| Default | Effect |
|---|---|
| `50000` | Maximum rows per response. |
| invalid / non-positive | Falls back to `50000`. |
| `5` (e.g. test override) | Cap takes effect; harness asserts. |

The query takes `take: maxRows + 1` to detect overflow without a
separate `count` round-trip. The first `maxRows` rows are written
to the CSV body; the remaining row is discarded but used to set
`X-Audit-Export-Capped: true`.

Response headers:

| Header | Meaning |
|---|---|
| `X-Audit-Export-Row-Count` | actual rows in the body |
| `X-Audit-Export-Max-Rows` | resolved cap |
| `X-Audit-Export-Capped` | `true` if the underlying query had more rows |

The CSV body itself contains no metadata comments, keeping it
machine-parseable.

## 9. Destructive-route exclusion proof

- Source-level (case 16): `TenantAuditController` has only `@Get`
  decorators — no `@Post`, `@Put`, `@Patch`, or `@Delete`.
- Source-level (case 17): the controller has no imports of
  `runRetentionEnforce` / `runHardDelete` and no string literals
  matching `audit-log-retention-enforce` / `audit-log-hard-delete`.
- The service `exportCsvForActor` only calls `prisma.auditLog.findMany`.
  No `delete*`, `update*`, `$executeRaw`.
- Phase 2.53 (soft-delete) and Phase 2.54 (hard-delete) remain
  script-only. The Phase 2.55 runbook still gates them behind
  operator approval and snapshots.

## 10. Harness — `audit-log-export-csv` 17/17 PASS

```
[audit-log-export-csv] 17/17 PASS
```

1. export under tenant A returns only tenant A rows
2. export under tenant A excludes tenant B rows
3. export under tenant A excludes NULL-tenant rows
4. entity filter preserved
5. entityId filter cannot leak tenant B row
6. date range filter preserved
7. CSV header contains expected safe columns
8. CSV escaping handles comma, quote, and newline safely
9. row cap enforced (test override `MAX_ROWS=5`)
10. invalid `AUDIT_LOG_EXPORT_MAX_ROWS` falls back to `50000`
11. FULL_ACCESS with global gate OFF remains tenant-bound
12. FULL_ACCESS with global gate ON exports global rows (B + NULL)
13. missing ALS tenant context refuses safely (Forbidden)
14. controller `@Roles` allow-list pinned for `export.csv`
15. export route is GET-only
16. no Post/Put/Patch/Delete in controller
17. controller does not import retention/hard-delete scripts

## 11. Validation results

- `nest build` clean
- `npx prisma validate` clean
- `npm run saas:validate` 6/6 suites
- `npm run saas:schema-lint` 0 issues
- `npm run saas:scan:annotations` 0 findings
- `npm run saas:scan:raw-sql` 26 findings — **baseline unchanged**
- All Phase 2.47–2.57 audit / attendance / backfill / runbook /
  RBAC / HTTP harnesses green
- Full sentinel chain green
- **Cumulative: 730/730**

## 12. Production behaviour change

**None with default flags.** The new route is additive; it only
activates for `System Admin` / `Compliance Officer` callers who
explicitly hit it. With `TENANT_PRISMA_PILOT_ENABLED=false` or
audit-logs not in the allow-list, the route degrades to the same
legacy union as the existing reads and the row cap still applies.

## 13. Rollback

Configuration-only:
```sh
TENANT_PRISMA_PILOT_ENABLED=false           # disables pilot path
TENANT_PRISMA_PILOT_MODULES=nothing         # opts audit-logs out only
AUDIT_LOG_GLOBAL_READ_ENABLED=true          # restores FULL_ACCESS global visibility on the export
AUDIT_LOG_EXPORT_MAX_ROWS=<n>               # narrow / widen the cap (always positive int)
```

To remove the route entirely, revert:
- `src/logs/tenant-audit.controller.ts` `exportCsv(...)` method,
- `src/logs/logs.service.ts` `exportCsvForActor` + `renderAuditCsv` + `resolveExportMaxRows`.

No data rollback required.

## 14. Remaining blockers

None.

## 15. Recommended next phase

**2.59 — Per-tenant rate limit on `/admin/tenant-audit/*`.** With
read endpoints (Phase 2.57) and CSV export (Phase 2.58) live,
introduce a small in-memory or Redis-backed per-tenant rate
limiter (`AUDIT_LOG_HTTP_RATE_LIMIT_RPM`, default off) gated by
the same flag pattern. Defaults must remain off so production
behaviour stays byte-identical when not configured.

---

# Phase 2.59 cross-link — rate limit

The CSV export is now also subject to the optional per-tenant
rate limiter (`AUDIT_LOG_HTTP_RATE_LIMIT_*`). Default-OFF; when
enabled, an exhausted quota returns HTTP 429 BEFORE the service
runs the underlying `findMany`. See
`SAAS_PHASE2_AUDIT_LOG_HTTP_RATE_LIMIT.md`.

---

# Phase 2.60 cross-link — 429 envelope on export.csv

When the Phase 2.59 limiter rejects an export request, the route
no longer emits a partial CSV — it throws a structured 429
envelope with `Retry-After`. Successful exports still return
`text/csv; charset=utf-8` with all Phase 2.58 headers. See
`SAAS_PHASE2_AUDIT_LOG_HTTP_RATE_LIMIT_ENVELOPE.md`.
