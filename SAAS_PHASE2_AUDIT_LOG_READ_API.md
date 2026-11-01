# Phase 2.52 — Audit-log Tenant-Scoped Read API

> Tenant-aware reads over `audit_logs` via the existing `LogsService`
> plus new helpers on `TenantAuditLogService`. Default-OFF;
> configuration-only rollback; no data change; no schema migration.

---

## 1. Audit module scope map

| Path | Status | Tag |
|---|---|---|
| `LogsService.findAll` | **PILOT** — adds `scope().tenantWhere()` to the where clause | `phase252-audit-log-read-pilot` |
| `LogsService.getStats` | **PILOT** — adds `scope().tenantWhere()` to base scopeWhere | `phase252-audit-log-read-pilot` |
| `LogsService.clearLogs`, `deleteOne` | unchanged (no destructive change in this phase) | — |
| `TenantAuditLogService.write` | unchanged (Phase 2.30+) | — |
| `TenantAuditLogService.listForTenant` | new tenant-scoped read helper | `phase252-audit-log-read-pilot` |
| `TenantAuditLogService.countForTenant` | new tenant-scoped count helper | `phase252-audit-log-read-pilot` |
| `TenantAuditLogService.getByIdForTenant` | new tenant-scoped by-id lookup | `phase252-audit-log-read-pilot` |
| `TenantAuditLogService.previewRetention` | new read-only retention preview | `phase252-audit-log-retention-preview` |
| Audit export | not present in this module today | (deferred — `phase252-audit-log-export-deferred` reserved) |

## 2. Tenant read strategy

`LogsService` joins the established TenantPrisma pilot pattern:
- `LogsModule` provides `TenantPrismaService` + `PilotPrismaAccessor`.
- `LogsService` constructor takes `(legacyPrisma, pilot)`.
- `private get prisma()` returns `pilot.client()`.
- `private scope()` returns `getPilotScope(this.pilot, 'audit-logs')`.
- `findAll` and `getStats` spread `scope.tenantWhere()` into both the
  base where and (in `getStats`) the per-user scoped where, so role
  resolution still works alongside tenant scope.

With pilot inactive, `tenantWhere()` returns `{}` and behaviour is
byte-identical to pre-2.52. With pilot active and an ALS tenant
attached:
- only rows with `audit_logs.tenantId = <active>` are returned;
- NULL-tenant rows are **excluded** in pilot mode;
- existing role-based visibility (`resolveVisibleUserIds`) layers on
  top, so a non-admin still only sees their own users' rows within
  their tenant.

## 3. Filters preserved

`entity`, `entityId`, `action` (substring), `userId`,
`createdAt` range (`fromDate`/`toDate`), pagination (`page`,
`limit`), sort (`createdAt` desc), and free-text `search` over
`action` / `entity` / `userEmail` are unchanged.

## 4. Retention preview strategy

`TenantAuditLogService.previewRetention({ tenantId, days })` is a
read-only count. It never deletes or modifies anything; case 10 of
the harness asserts the source contains no destructive Prisma
calls (`delete`, `deleteMany`, `update`, `updateMany`, `$executeRaw`).

Inputs:
- `tenantId === null` ⇒ count NULL-tenant legacy rows.
- `tenantId === <id>` ⇒ count rows for that tenant only.
- `days` ⇒ override `AUDIT_LOG_RETENTION_DAYS` (env default `365`;
  invalid env value falls back to `365`).

Output:
```ts
{
  enabled: boolean,    // mirrors AUDIT_LOG_RETENTION_ENABLED
  days: number,
  cutoffIso: string,
  candidateCount: number,
  tenantId: string | null,
}
```

`enabled` reflects the env flag for operator visibility but is
never used to gate destructive behaviour because there **is no
destructive behaviour** in Phase 2.52.

## 5. Explicitly: no deletion happens

Phase 2.52 does NOT delete any audit_logs rows under any flag
combination. Case 7 of the retention harness asserts the
`audit_logs` row count is identical before and after running the
preview multiple times.

## 6. Equivalence — 14/14 PASS

```
[audit-log-read-equivalence] 14/14 PASS
```

1. pilot disabled returns legacy list shape
2. pilot disabled count matches legacy
3. pilot enabled response shape preserved
4. pilot enabled list ⊂ legacy union
5. entity filter preserved
6. entityId filter preserved
7. action filter preserved
8. userId filter preserved
9. date range filter preserved
10. pagination/sorting shape preserved
11. allow-list unset ⇒ all modules allowed
12. allow-list `audit-logs` allows audit-logs, denies others
13. allow-list comma-separated allows both
14. allow-list `nothing` ⇒ scope inactive (legacy behaviour)

## 7. Isolation — 10/10 PASS

```
[audit-log-read-isolation] 10/10 PASS
```

1. tenant A sees only audit rows with `tenantId=A`
2. tenant A does not see tenant B audit rows
3. tenant A does not see NULL-tenant audit rows in pilot mode
4. tenant B sees only tenant B rows
5. entity filter under tenant A does not leak tenant B rows
6. entityId filter for tenant B entity under tenant A returns empty
7. count under tenant A includes only tenant A rows
8. pagination under tenant A cannot page into tenant B rows
9. concurrent ALS frames remain isolated
10. pilot opt-out (`TENANT_PRISMA_PILOT_MODULES=nothing`) returns the
    legacy union, including NULL-tenant rows

## 8. Retention preview — 10/10 PASS

```
[audit-log-retention-preview] 10/10 PASS
```

1. retention disabled ⇒ enabled=false; no destructive action
2. preview returns candidate count only
3. tenant A preview counts only tenant A rows
4. tenant B preview counts only tenant B rows
5. NULL-tenant rows excluded from tenant preview; included in NULL preview
6. date threshold respected (large days ⇒ zero candidates)
7. no rows are deleted or modified (snapshot before/after equal)
8. preview is idempotent
9. retention days env fallback works for invalid values (defaults to 365)
10. retention preview source contains no destructive Prisma calls

## 9. Production behaviour status

**None changed.** With `TENANT_PRISMA_PILOT_ENABLED=false`
(default), `LogsService` queries reduce to the original where
clauses — byte-identical to pre-2.52. With
`AUDIT_LOG_RETENTION_ENABLED=false` (default), `previewRetention`
still works as a count helper but `enabled=false` is reported in
the result. There is no path that deletes audit rows in this phase.

## 10. Rollback

Configuration-only:
```sh
TENANT_PRISMA_PILOT_ENABLED=false           # disables tenant-aware read pilot
# OR
TENANT_PRISMA_PILOT_MODULES=nothing         # opts audit-logs out only
# OR
AUDIT_LOG_RETENTION_ENABLED=false           # disables retention 'enabled' flag
```
No data change, no schema migration. Rollback never requires
data restoration because no rows are written, modified, or
deleted by Phase 2.52.

## 11. Remaining blockers

None. Audit reads are tenant-aware and a retention preview hook
is available. The actual retention enforcement (delete or
soft-delete with a snapshot) is the natural next step.

## 12. Recommended next phase

**2.53 — Audit retention enforcement (dry-run-first apply).**
Wire the preview into a one-shot script analogous to Phase 2.50/2.51:
default-off, dry-run-first, apply double-gated by
`AUDIT_LOG_RETENTION_APPLY=true` AND a SAFE_CLONE/SAFE_STAGING
classification, with a pre-apply snapshot capture step and a
reversal SQL template documented next to it.

---

# Phase 2.53 update — Soft-delete retention enforcement

A new script `scripts/saas/phase2/audit-log-retention-enforce.ts`
performs soft-delete (`deletedAt = now()`) only. The existing
`LogsService.findAll`, which already filters `deletedAt: null` in
its base where clause, naturally hides soft-deleted rows from
non-admin reads. Callers that need historical visibility can use
`TenantAuditLogService.listForTenant` with an explicit
`includeDeleted` parameter — out of scope for Phase 2.53 and
deferred.

Tag: `phase253-audit-log-retention-enforce`.

---

# Phase 2.55 cross-link — Operator runbook

See `docs/runbooks/audit-retention-rollout.md` for the operator-facing
production rollout sequence covering Phases 2.50–2.54.

---

# Phase 2.56 cross-link — RBAC tenant binding

`LogsService.findAll` / `getStats` now call `assertAuditReadAccess(scope)`
and use `auditTenantWhereForActor(scope)` to compose tenant predicate
with the new global-read gate. With `AUDIT_LOG_GLOBAL_READ_ENABLED=false`
(default) FULL_ACCESS roles in pilot mode are tenant-bound; with
`true` they bypass the tenant predicate. See
`SAAS_PHASE2_AUDIT_LOG_RBAC_TENANT_BINDING.md`.

Tags: `phase256-audit-log-rbac-tenant-binding`,
`phase256-audit-log-global-read-gate`,
`phase256-audit-log-actor-scope`.

---

# Phase 2.57 cross-link — HTTP endpoints

A new `TenantAuditController` exposes
`GET /admin/tenant-audit{,/:id,/stats,/retention-preview}` (read-only).
Uses `LogsService.findAll` / `getStats` / `findOneForActor` /
`previewRetentionForActor`. See
`SAAS_PHASE2_AUDIT_LOG_HTTP_ENDPOINTS.md`.

---

# Phase 2.58 cross-link — CSV export

`LogsService.exportCsvForActor(filters, scope)` produces an
RFC-4180-style CSV body with hard row cap. Exposed at
`GET /admin/tenant-audit/export.csv`. See
`SAAS_PHASE2_AUDIT_LOG_EXPORT_CSV.md`.
