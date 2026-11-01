# Phase 2.14 — Notifications Scheduler Audit

> Pre-adapter audit of the notifications scheduler / background paths.
> The Phase 2.10 read-paths audit covered the user-facing surface; this
> audit covers the cron-driven paths that Phase 2.10 explicitly excluded.

---

## 1. Files in scope

| File | Lines | Role |
|------|------|------|
| `notifications-scheduler.service.ts` | 39→78 | cron orchestrator (now flag-aware dispatcher) |
| `notifications.service.ts` (cron-related parts) | ~430 of 700+ | check / fanout / runAll methods |
| `notification-events.ts` | 147 | event-key → notification-type map (data only, no Prisma) |

## 2. Cron entry points

The scheduler has two firing points, both unchanged by Phase 2.14:

1. `onModuleInit` → `runOnce()` once at boot.
2. `setInterval(runOnce, 6 hours)` thereafter.

Phase 2.14 changes WHAT `runOnce()` calls, not when. The cron timing
is verified by harness case 11 (a source-file regex check that the
`6 * 60 * 60 * 1000` constant is intact).

## 3. Check methods (cron-driven)

| Method | Lines | What it iterates today | Phase 2.14 status |
|--------|------|------------------------|-------------------|
| `checkExpiringCompliance` | ~75 | `User.findMany({ role: 'Fleet Manager' })` across all tenants → per-vehicle compliance probe → `notification.create` if absent | wrapped by `runForTenant` in tenant-aware mode; per-method narrowing deferred to 2.14.1 |
| `checkServiceDue` | ~80 | same fleet-manager scan → per-vehicle service mileage probe | same |
| `checkOverdue` | ~60 | same fleet-manager scan → expired vehicles → notification | same |
| `checkScheduledMaintenance` | ~70 | same fleet-manager scan → upcoming maintenance records | same |
| `runAllChecks` | 10 | Sequential await of the four `check*` methods | LEGACY — kept untouched as the fallback path |
| `runAllChecksTenantAware` | ~60 | NEW: planner + `runForTenantBatch` | THIS PR |
| `runAllChecksForTenant(tenantId)` | ~15 | NEW: per-tenant entry inside ALS frame; calls the four `check*` | THIS PR |

## 4. Fanout writers

| Method | Lines | What it does | Phase 2.14 status |
|--------|------|--------------|-------------------|
| `notifyUploaderAndRoles` | ~45 | `User.findMany({ role: { name: { in: roles } } })` across all tenants → `notification.create` per recipient | adapter: refuses without ALS tenant in tenant-aware mode |
| `notifyUsersByRoles` | ~35 | same shape, no uploader | same |
| `wasHighBalanceAlertRecentlySent` | ~10 | scoped read (Phase 2.10 already pilot-scoped) | unchanged |

## 5. Prisma call sites

Pre-Phase 2.14:
- 27 sites in `notifications.service.ts` annotated `phase210-pilot-scope` (read paths) or `phase210-excluded-background` (cron/fanout) or `phase210-global` (per-user prefs).

Phase 2.14 additions:
- 1 new site in `notifications.service.ts`:
  `legacyPrisma.tenant.findMany(...)` for tenant-catalog discovery.
  Annotated `phase214-pilot-scope` (the planner consumes this list).

The `check*` methods themselves keep their `phase210-excluded-background`
annotations until 2.14.1 narrows their per-method scans.

## 6. Current global scans

The four `check*` methods iterate `User` across all tenants. In
tenant-aware mode these run inside a per-tenant ALS frame. They
behave identically to legacy until 2.14.1 narrows them — at which
point they will read only fleet managers from the active tenant.

This is intentional Phase 2.14 scope: ship the orchestrator + ALS
adapter first, narrow the per-method scans second. The ALS frame
provides the safety boundary for downstream notification.create
calls (which already pick up `tenantId` via the Phase 2.10 pilot
scope when the pilot module is on).

## 7. Current notification creation logic

- `check*` methods: `notification.create({ userId, ... })`. The
  Phase 2.10 pilot scope adds `tenantId` to the data when the pilot
  module is on. With Phase 2.14 wrapped in `runForTenant`, the pilot
  scope sees the active tenant and persists it.
- `notifyUploaderAndRoles` / `notifyUsersByRoles`: same shape; the
  Phase 2.14 guard refuses without ALS tenant in tenant-aware mode,
  so these calls cannot persist `tenantId=NULL` rows in tenant-aware
  mode.

## 8. Tenant ownership path

```
Notification.tenantId (Phase 2.3 denorm)
  ← derived from User → Agency → Tenant at create-time
```

Phase 2.14 makes the active tenant explicit via ALS, so the
notification creates can populate `tenantId` from
`TenantContext.optional()?.id` (via the existing pilot scope).

## 9. Expected tenantId propagation

Tenant-aware mode:
1. cron tick → `runOnce` → `runAllChecksTenantAware`.
2. tenants discovered via `legacyPrisma.tenant.findMany`.
3. planner produces `ExecutionPlan` with N entries.
4. `runForTenantBatch` opens one ALS frame per tenant.
5. inside each frame, `runAllChecksForTenant(tid)` runs the four `check*`.
6. each `notification.create` inside `check*` lands `tenantId=tid` via
   the Phase 2.10 pilot scope.
7. fanout writers (called from HTTP handlers, not cron) refuse without
   ALS tenant.

## 10. Risks

- **`check*` global iteration** in tenant-aware mode. The cron now
  fires N times (once per tenant), and each tick's `check*` re-iterates
  every fleet manager across every tenant. With the Phase 2.14 ALS
  frame that produces N² fleet-manager scans per cron tick.
  Mitigation: deferred to Phase 2.14.1, which narrows the `check*`
  reads to the active tenant. Until then, tenant-aware mode is
  flag-gated and only enabled in staging — production stays on the
  legacy path.
- **Notification spam** if the same user belongs to multiple tenants.
  Notification de-duplication today uses
  `(userId, type, relatedEntityId, isRead, createdAt > now-24h)` —
  this is global and would dedupe across tenants. In tenant-aware
  mode the dedupe is still global (not per-tenant). For Phase 2.14
  this is acceptable because no users in production span tenants;
  Phase 2.14.1 should add `tenantId` to the dedupe key.
- **Backpressure**: with `concurrency: 4` and `perTenantTimeoutMs:
  60_000`, a misbehaving tenant can park up to 4 concurrent slots
  for one minute each. Documented in the observability checklist.

## 11. Scope INCLUDED in Phase 2.14

- New `runAllChecksTenantAware` method on `NotificationsService`.
- New `runAllChecksForTenant(tenantId)` per-tenant entry point.
- `NotificationsSchedulerService.runOnce` flag-aware dispatcher.
- Fanout writer guards (`assertTenantForFanout`).
- Annotation tag `phase214-pilot-scope` for the new tenant-discovery
  call site.
- Harness `saas:phase2-notifications-scheduler-harness` (9 cases).
- Documentation: this audit, scheduler pilot results, scope-split
  update, scanner policy update, runtime inventory update.

## 12. Scope EXCLUDED from Phase 2.14 (deferred to 2.14.1)

- Per-method narrowing of the four `check*` methods (their
  `prisma.user.findMany` still iterates all tenants inside the per-
  tenant frame).
- `tenantId` in the notification dedupe key.
- Removal of the legacy `runAllChecks` path. Kept as a fallback while
  flags remain off.
- Changes to the existing `Notification` schema or migrations.
- BullMQ wiring (`TenantAwareJobProcessor` integration). The Phase
  2.14 adapter calls `runForTenantBatch` directly; queue runner
  integration is a Phase 3 concern.
