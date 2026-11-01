# Phase 2.56 — Audit-log RBAC Tenant Binding

> Makes audit-log read access explicitly tenant-bound by RBAC and
> request-time actor. Default-OFF; configuration-only rollback.

---

## 1. Audit RBAC scope map

| Endpoint | Service path | Status | Tag |
|---|---|---|---|
| `GET /logs` | `LogsService.findAll` | tenant-bound (pilot active) / legacy union (pilot off) | `phase256-audit-log-rbac-tenant-binding` |
| `GET /logs/stats` | `LogsService.getStats` | tenant-bound (pilot active) / legacy union (pilot off) | `phase256-audit-log-rbac-tenant-binding` |
| `DELETE /logs`, `DELETE /logs/:id` | `clearLogs`, `deleteOne` | unchanged (System Admin only; no destructive change in this phase) | — |

## 2. Actor / tenant binding strategy

`LogsService` gains three small helpers:

- `assertAuditReadAccess(scope?)` — explicit refusal contract.
- `auditTenantWhereForActor(scope?)` — composes the tenant predicate
  with the global-read gate.
- `isGlobalReadEnabled()` — reads `AUDIT_LOG_GLOBAL_READ_ENABLED`
  (default `false`).

Decision matrix:

| Pilot allow-listed? | ALS tenant attached? | `AUDIT_LOG_GLOBAL_READ_ENABLED` | Actor role | Outcome |
|---|---|---|---|---|
| inactive (off / module not allow-listed) | n/a | n/a | any | legacy union (byte-identical to pre-2.56) |
| active | no | n/a | any | `ForbiddenException` |
| active | yes | `false` | FULL_ACCESS | tenant-bound (`tenantId = ALS`) |
| active | yes | `false` | tenant-scoped | tenant-bound (`tenantId = ALS`) + role visibility |
| active | yes | `true` | FULL_ACCESS | global (no tenant predicate) |
| active | yes | `true` | tenant-scoped | tenant-bound (gate is a no-op for non-FULL_ACCESS) |

The composition is always: `tenant predicate ∩ role visibility`. The
existing `resolveVisibleUserIds` (`FULL_ACCESS_ROLES`,
`Agency Manager`, fallback to self) is unchanged and layered on top.

## 3. READ_ROLES behavior

Roles allowed at the controller level (`@Roles(...)`):
`System Admin`, `HR Manager`, `Compliance Officer`, `Recruiter`,
`Finance`, `Read Only`.

In pilot mode:
- Tenant-scoped roles (`Recruiter`, `Finance`, `Read Only`,
  `Agency Manager`, etc.) require an active ALS tenant frame. The
  tenant predicate is always applied.
- The role-based `visibleIds` restriction (self / agency users) layers
  on top of the tenant predicate.

## 4. FULL_ACCESS_ROLES behavior

`['System Admin', 'HR Manager', 'Compliance Officer']`.

- Pilot inactive ⇒ legacy union (every row visible, role is sole gate).
- Pilot active + global gate **off** (default) ⇒ tenant-bound to the
  active tenant. This is a deliberate narrowing: the global-read gate
  is opt-in.
- Pilot active + global gate **on** ⇒ global visibility (tenant A,
  tenant B, NULL-tenant rows).

## 5. Global-read gate status

Gate variable: `AUDIT_LOG_GLOBAL_READ_ENABLED`.

| Default | Effect |
|---|---|
| `false` | FULL_ACCESS roles in pilot mode are tenant-bound by default. |
| `true` | FULL_ACCESS roles bypass the tenant predicate; tenant-scoped roles still get the tenant predicate. |

Tag: `phase256-audit-log-global-read-gate`.

## 6. Legacy behavior with flags off

With `TENANT_PRISMA_PILOT_ENABLED=false`:
- `pilot.pilotReason().active === false` ⇒ `assertAuditReadAccess`
  short-circuits silently.
- `auditTenantWhereForActor` returns `{}`.
- `LogsService.findAll` and `getStats` queries are byte-identical to
  pre-2.56.

With `TENANT_PRISMA_PILOT_MODULES=nothing` (or any value not
including `audit-logs`):
- Pilot is on globally but `audit-logs` is opted out.
- The assertion silently falls through; queries fall back to the
  legacy union. This preserves Phase 2.52's `audit-log-read-isolation`
  case 10 ("pilot opt-out returns legacy union") byte-identically.

## 7. Pilot behavior with flags on

With `TENANT_PRISMA_PILOT_ENABLED=true` AND `TENANT_PRISMA_PILOT_MODULES`
includes `audit-logs`:
- Tenant-scoped or FULL_ACCESS-without-global-gate roles MUST present
  an ALS tenant frame; otherwise `ForbiddenException`.
- Tenant predicate `tenantId = ALS` is applied unconditionally.
- NULL-tenant rows are excluded.
- Cross-tenant entityId filters return empty.
- Pagination cannot escape the tenant predicate.
- `getStats` shares the same predicate.

## 8. Harness — `audit-log-rbac-tenant-binding` 15/15 PASS

```
[audit-log-rbac-tenant-binding] 15/15 PASS
```

1. tenant A FULL_ACCESS actor sees only tenant A audit rows
2. tenant A FULL_ACCESS actor does not see tenant B audit rows
3. tenant A FULL_ACCESS actor does not see NULL-tenant audit rows
4. tenant B FULL_ACCESS actor sees only tenant B audit rows
5. entity filter under tenant A cannot leak tenant B row
6. entityId filter for tenant B id under tenant A returns empty
7. READ_ROLES actor requires active tenant context in pilot mode
8. FULL_ACCESS without global gate also refuses without ALS frame
9. FULL_ACCESS role with global gate OFF remains tenant-scoped
10. FULL_ACCESS with explicit global gate ON sees global rows (B + NULL)
11. non-allowed role cannot read audit rows (RBAC roles decorator pinned)
12. pagination under tenant A cannot page into tenant B rows
13. `getStats` respects tenant-bound RBAC scope
14. concurrent ALS frames remain isolated for `findAll`
15. helpers wired (assertAuditReadAccess + auditTenantWhereForActor + global gate)

## 9. Validation results

- `nest build` clean
- `npx prisma validate` clean
- `npm run saas:validate` 6/6 suites
- `npm run saas:schema-lint` 0 issues
- `npm run saas:scan:annotations` 0 findings
- `npm run saas:scan:raw-sql` 26 findings — **baseline unchanged**
- All Phase 2.47–2.55 audit / attendance / backfill / runbook
  harnesses green
- Full sentinel chain green
- **Cumulative: 695/695**

## 10. Production behaviour change

**None with default flags.**

- `TENANT_PRISMA_PILOT_ENABLED=false` ⇒ assertion short-circuits and
  query is byte-identical to pre-2.56.
- `TENANT_PRISMA_PILOT_MODULES` not including `audit-logs` ⇒ legacy
  union is preserved.
- `AUDIT_LOG_GLOBAL_READ_ENABLED=false` is the default; an
  installation that flips the pilot ON for audit-logs gets
  tenant-scoped reads even for FULL_ACCESS roles. To restore
  pre-pilot global-admin visibility on the same row of flags,
  `AUDIT_LOG_GLOBAL_READ_ENABLED=true` is the explicit opt-in.

## 11. Rollback

Configuration-only:
```sh
TENANT_PRISMA_PILOT_ENABLED=false           # disables the entire pilot path
# OR
TENANT_PRISMA_PILOT_MODULES=nothing         # opts audit-logs out only
# OR
AUDIT_LOG_GLOBAL_READ_ENABLED=true          # restores FULL_ACCESS global visibility while keeping tenant-scoped roles bound
```

No data change, no schema migration. Rollback never requires data
restoration.

## 12. Remaining blockers

None.

## 13. Recommended next phase

**2.57 — Tenant-scoped audit search index / read API surfaced as
HTTP endpoints.** With the read service contract finalised, the next
step is to expose `TenantAuditLogService.listForTenant` /
`countForTenant` / `getByIdForTenant` as small Nest endpoints under
`/admin/tenant-audit/...` (System Admin / Compliance Officer only),
and add a per-tenant retention preview endpoint that wraps
`previewRetention` for product / compliance dashboards. Read-only
by contract; same triple-gated apply chain (Phase 2.53/2.54)
remains script-only.

---

# Phase 2.57 cross-link — HTTP endpoints

`TenantAuditController` (`src/logs/tenant-audit.controller.ts`) is
a thin wrapper around `LogsService` exposing four read-only routes
under `/admin/tenant-audit/*`. It REUSES this phase's RBAC contract
unchanged — `assertAuditReadAccess` + `auditTenantWhereForActor` still
fire from inside the service. See
`SAAS_PHASE2_AUDIT_LOG_HTTP_ENDPOINTS.md`.

---

# Phase 2.58 cross-link — CSV export endpoint

`LogsService.exportCsvForActor` is the third caller of
`assertAuditReadAccess` + `auditTenantWhereForActor` (after
`findAll` / `getStats` and `findOneForActor` /
`previewRetentionForActor`). Same RBAC binding; adds a row cap.
See `SAAS_PHASE2_AUDIT_LOG_EXPORT_CSV.md`.

---

# Phase 2.59 cross-link — rate limit ordering

`enforceRateLimit` runs at the controller layer BEFORE the
service is invoked, but the rate limit never masks an RBAC
access error: a request with no ALS frame is rejected by Phase
2.56's `assertAuditReadAccess` after consuming a slot, so the
caller still sees `ForbiddenException` (case 12 of the rate-limit
harness). See `SAAS_PHASE2_AUDIT_LOG_HTTP_RATE_LIMIT.md`.
