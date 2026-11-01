# Phase 2.46 — Dedup for Internal Notification check* Scans

> Routes the four internal scheduled notification scans through the
> Phase 2.45 `createInAppWithDedup` helper. Default-off; tenant-safe.

---

## 1. What changed

The four scan methods on `NotificationsService`:

- `checkExpiringCompliance()`
- `checkServiceDue()`
- `checkOverdue()`
- `checkScheduledMaintenance()`

…each contained a direct `legacyPrisma.notification.create({ data: { … } })`
call. Phase 2.46 replaces all four with a call to the existing
`createInAppWithDedup({ … }, tid)` helper. **No other behaviour
change.**

The pre-existing per-method "recently created within 24 h" probe
that runs BEFORE the create is preserved unchanged. The dedup helper
adds a second, configurable layer that fires only when
`NOTIFICATION_DEDUP_ENABLED=true`.

## 2. Dedup identity

Each scan already populates a stable `(relatedEntity, relatedEntityId)`
pair plus a condition-discriminating `type`. Phase 2.46 reuses these
exactly — no new identity strings, no migration:

| Scan | `relatedEntity` | `relatedEntityId` | `type` discriminator |
|---|---|---|---|
| `checkExpiringCompliance` | `'Vehicle'` | `<vehicle.id>` | per-check `NotificationType` (e.g. `VEHICLE_MOT_EXPIRING`, `VEHICLE_INSURANCE_EXPIRING`, …) |
| `checkServiceDue` | `'Vehicle'` | `<vehicle.id>` | `VEHICLE_SERVICE_DUE` |
| `checkOverdue` | `'Vehicle'` | `<vehicle.id>` | `VEHICLE_SERVICE_OVERDUE` |
| `checkScheduledMaintenance` | `'MaintenanceRecord'` | `<record.id>` | `INFO` |

The full identity used by `createInAppWithDedup` is:
`(tenantId, userId, type, relatedEntity, relatedEntityId, createdAt >= now - window)`.

Because each scan's `type` is distinct per condition (e.g. MOT vs.
insurance for the same vehicle), different conditions for the same
vehicle are NOT deduped against each other.

## 3. What this phase deliberately does NOT do

- **No identity change.** The values stored in `relatedEntity` and
  `relatedEntityId` are byte-identical to pre-2.46. Existing readers
  that key off `relatedEntityId === vehicle.id` continue to work.
- **No PII in dedup identity.** The lookup uses only ids and
  enumerated types — no document titles, vehicle reg numbers, user
  names, or message text.
- **No external provider invocation.** In-app `Notification` rows
  only.
- **No schema migration.**
- **Behaviour unchanged when `NOTIFICATION_DEDUP_ENABLED=false`.**
  The helper falls through to a plain `legacyPrisma.notification.create`
  with the same data.

## 4. Production safety

With `NOTIFICATION_DEDUP_ENABLED=false` (default):
- The helper executes zero extra DB queries.
- Every scan create call falls through to the same
  `legacyPrisma.notification.create({ data })` it executed before
  Phase 2.46.
- The pre-existing 24h "already created" probe inside each scan is
  unchanged.

## 5. Harness — 13/13 PASS

```
[notifications-internal-scan-dedup] 13/13 PASS
```

1. flag off: scan create produces duplicate (legacy)
2. checkExpiringCompliance condition deduped
3. checkServiceDue condition deduped
4. checkOverdue condition deduped
5. checkScheduledMaintenance condition deduped
6. different user (same tenant) NOT deduped
7. same user different tenant NOT deduped
8. different condition types for same vehicle NOT deduped
9. window respected — old row outside window does not suppress
10. NULL-tenant legacy row does NOT suppress tenant-scoped row
11. dedup with `tid=null` falls through (no probe; legacy create)
12. concurrent tenant-aware scans remain ALS-isolated
13. **source-level**: all four `check*` methods route through `createInAppWithDedup`

## 6. Rollback runbook

```sh
NOTIFICATION_DEDUP_ENABLED=false           # disable dedup probe (legacy create)
# OR
TENANT_AWARE_JOBS_ENABLED=false            # disables the tenant-aware scheduler path
# OR
TENANT_JOB_FANOUT_ENABLED=false            # disables tenant fan-out gates
```

No data, no schema migration introduced. Configuration-only rollback.

## 7. Known limitations

- **Pre-existing 24h probe still applies.** The Phase 2.10 / 2.14
  per-method "look back 24 hours" check inside each scan was not
  removed. With the dedup helper layered on top, the effective
  suppression window is `min(24h, NOTIFICATION_DEDUP_WINDOW_MINUTES)`.
  Operators tuning the dedup window for less than 24h need to know
  the per-method probe still applies.
- **Internal scan return shape unchanged.** The four `check*`
  methods still return `Promise<void>`. Per-method counters are
  NOT plumbed back to the caller; dedup is observable only via the
  resulting row count and the harness reports.
- **Cross-condition dedup (same vehicle, different `type`s)** is not
  performed by design. Different `NotificationType` values are
  considered distinct conditions; an MOT-expiring notification for
  vehicle X does not suppress a SERVICE-DUE notification for the
  same vehicle X.

## 8. Annotation tag

`phase246-notifications-internal-scan-dedup` — allowed in
`src/notifications/`. Applied at the four `createInAppWithDedup`
call sites that replaced the prior `legacyPrisma.notification.create`
calls.
