# Phase 2.52 — Audit-log Retention Preview

> **NO ROWS ARE DELETED.** This document describes the read-only
> retention preview helper introduced in Phase 2.52.

## API

`TenantAuditLogService.previewRetention({ tenantId, days? })`

| Field | Type | Notes |
|---|---|---|
| `tenantId` | `string \| null` | `null` ⇒ count NULL-tenant legacy rows. |
| `days` | `number?` | Override `AUDIT_LOG_RETENTION_DAYS`. Falls back to env, then to `365` if env value is invalid or unset. |

Returns:
```ts
{
  enabled: boolean,           // mirrors AUDIT_LOG_RETENTION_ENABLED
  days: number,               // resolved retention window
  cutoffIso: string,          // now() - days, ISO-8601
  candidateCount: number,     // count of rows older than cutoff for the requested tenant scope
  tenantId: string | null,    // echoed input
}
```

## Flags

| Variable | Default | Effect |
|---|---|---|
| `AUDIT_LOG_RETENTION_ENABLED` | `false` | Reflected in result; never gates destructive behaviour because none exists in this phase. |
| `AUDIT_LOG_RETENTION_DAYS` | `365` | Default retention window. Invalid values fall back to `365`. |

## Source-level invariants

- The function calls `prisma.auditLog.count(...)` only.
- No `delete`, `deleteMany`, `update`, `updateMany`, or `$executeRaw`.
- No transactions wrapping destructive operations.
- The harness asserts these via regex inspection of the function body.

## Tenant scope

| `tenantId` arg | Counts rows where … |
|---|---|
| `null` | `audit_logs.tenantId IS NULL` |
| `<id>` | `audit_logs.tenantId = <id>` |

NULL-tenant rows are explicitly addressable (legacy operators may
need to know how many "global" rows are out of retention) but never
included in a per-tenant count.

## Harness — 10/10 PASS

(See `SAAS_PHASE2_AUDIT_LOG_READ_API.md` §8.)

## Rollback

Configuration-only: `AUDIT_LOG_RETENTION_ENABLED=false` is the
default. Rollback never requires data restoration because the
preview never modifies data.

## Recommended next phase

**2.53 — Retention enforcement** (dry-run-first apply, double-gated
by an explicit env flag and a SAFE classification, with a snapshot
capture step). The preview API is already the single source of
truth for "what would be retained vs deleted", so the enforcement
step can re-use it directly.

---

# Phase 2.53 update — Retention enforcement now exists (soft-delete only)

The Phase 2.52 preview helper is unchanged and remains
the count-only API. Phase 2.53 adds a separate enforcement
script (`scripts/saas/phase2/audit-log-retention-enforce.ts`)
that performs **soft-delete only** under three gates:
`AUDIT_LOG_RETENTION_ENABLED=true` AND
`AUDIT_LOG_RETENTION_APPLY=true` AND a SAFE classification.

See `SAAS_PHASE2_AUDIT_LOG_RETENTION_ENFORCEMENT.md`.

---

# Phase 2.54 cross-link — Hard-delete pass

Phase 2.54 introduces a separate dry-run-first script that
**physically removes** rows already soft-deleted by Phase 2.53 once
the grace window elapses. The Phase 2.52 `previewRetention` API
itself is unchanged.

---

# Phase 2.55 cross-link — Operator runbook

See `docs/runbooks/audit-retention-rollout.md` for the operator-facing
production rollout sequence.

---

# Phase 2.56 cross-link — RBAC tenant binding for audit reads

The retention preview is unchanged (still a count helper on
`TenantAuditLogService`). Phase 2.56 added an explicit RBAC tenant
binding to the `LogsService` audit *reads* (`findAll` / `getStats`).
See `SAAS_PHASE2_AUDIT_LOG_RBAC_TENANT_BINDING.md`.

---

# Phase 2.57 cross-link — HTTP retention preview

`GET /admin/tenant-audit/retention-preview` exposes the existing
`previewRetention` helper as a read-only HTTP endpoint, scoped to
the active ALS tenant. The endpoint never modifies data. Apply
mode (Phase 2.53/2.54) remains script-only. See
`SAAS_PHASE2_AUDIT_LOG_HTTP_ENDPOINTS.md`.
