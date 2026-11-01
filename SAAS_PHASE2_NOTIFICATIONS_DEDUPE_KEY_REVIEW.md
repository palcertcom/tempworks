# Phase 2.14.1 — Notifications Dedupe Key Review

> Decision: include `tenantId` in the dedupe `findFirst` query when
> tenant-aware mode is active. Implemented in this PR.

---

## 1. Current dedupe behaviour (pre-2.14.1)

Each `check*` method dedupes via a `Notification.findFirst` query
just before the `notification.create`:

```ts
// checkExpiringCompliance + checkServiceDue + checkScheduledMaintenance:
where: {
  userId: manager.id,
  relatedEntityId: vehicle.id,
  type: <NotificationType>,
  isRead: false,
  createdAt: { gte: new Date(Date.now() - 86400000) }, // last 24h
}

// checkOverdue (no time window — HIGH alerts persist):
where: {
  userId: manager.id,
  relatedEntityId: vehicle.id,
  severity: 'HIGH',
  isRead: false,
}
```

This is **GLOBAL** today: the dedupe matches any unread notification
for the same `(user, entity, type)` tuple regardless of which tenant
the existing notification belongs to.

## 2. Risk of the global dedupe

Practically zero today because:

- Production has no users that span multiple tenants.
- Notifications written before Phase 2.10 had `tenantId=NULL`; the
  dedupe was internally consistent.

In a future world where a single `User` belongs to multiple tenants
(via `TenantMembership`), the global dedupe would suppress a
legitimate per-tenant alert: tenant A's vehicle expires → notification
created → tenant B's vehicle (same user, same id by collision) tries
to alert → blocked by dedupe.

Cross-`relatedEntityId` collision is unlikely (uuids), but the same
fleet manager in both tenants is realistic.

## 3. Decision

**Include `tenantId` in the dedupe query when tenant-aware mode is
active.**

The change is a single-line spread:

```ts
where: {
  userId: ..., relatedEntityId: ..., type: ..., isRead: false,
  createdAt: { gte: new Date(Date.now() - 86400000) },
  ...(tid ? { tenantId: tid } : {}),
}
```

When `tid === null` (legacy / production), the spread is `{}` and
the query behaves byte-identically to pre-2.14.1.

When `tid` is set:
- The dedupe ONLY matches notifications belonging to the active
  tenant.
- Tenant A and tenant B can both produce a notification for the same
  `(user, entity, type)` tuple — they are distinct records.
- Each tenant's notification dedupes independently.

## 4. Transition risks

### 4.1 NULL-tenant legacy rows

Production has notification rows with `tenantId=NULL` from before
Phase 2.10's denorm. The Phase 2.14.1 dedupe `findFirst` includes
`tenantId: tid` — it will NOT match those NULL rows.

Consequence: the **first** cron tick after enabling tenant-aware
mode in production could create a duplicate of any in-flight
notification that still has `tenantId=NULL`.

Mitigation:

1. Production stays on the legacy `runAllChecks` path until a
   notification-table backfill writes `tenantId` for all open rows.
2. Staging rehearsal resets the `notifications` table between runs.
3. Documented in the rollout runbook (see
   `SAAS_PHASE2_NOTIFICATIONS_SCHEDULER_PILOT_RESULTS.md`).

### 4.2 Cross-tenant duplicate suppression in legacy mode

Unchanged — legacy mode keeps the global dedupe. This is the
desired backward-compatible behaviour: production sees no
observable change.

### 4.3 Per-tenant alert volume

When tenant-aware mode is on AND the same fleet manager is
membership-attached to N tenants, a single pseudo-alert (e.g. a
shared vehicle expiring) could now fan out to N notifications
instead of 1.

There are no shared vehicles in production today (`Vehicle.tenantId`
is per-tenant). No observable change.

## 5. Implementation summary

Phase 2.14.1 implements the decision in a single helper:

```ts
private narrowingTenantId(): string | null { ... }
```

Called once at the top of each `check*` method. Spreads applied to:

- `User.findMany.where` (`agency: { tenantId: tid }`)
- inner `Vehicle.findMany.where` / `MaintenanceRecord.findMany.where`
  (`tenantId: tid`)
- dedupe `Notification.findFirst.where` (`tenantId: tid`)
- `Notification.create.data` (`tenantId: tid`)

When `tid === null`, every spread is `{}`. Legacy mode is byte-
identical.

The harness covers the source-level invariants (case-12 through
case-18) plus the runtime helper behaviour (cases 19, 20, 21).

## 6. Out of scope (deferred)

- **Backfill `Notification.tenantId` on legacy rows.** A separate
  Phase 3 backfill task; no schema change needed (column already
  exists).
- **Schema-level constraint** linking notifications to tenants. Not
  feasible while the column is nullable; deferred to Phase 3 RLS
  / tenant-prisma enforcement work.
- **Per-tenant rate limits / dedupe windows.** Out of scope; today
  the 24h window is global per-tenant.
