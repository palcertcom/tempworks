# Phase 2.45 — Per-Recipient Notification Dedup

> Optional, default-off helper that suppresses identical in-app
> notifications for the same `(tenantId, userId, type, relatedEntity,
> relatedEntityId)` within a configurable time window.

---

## 1. Where the dedup lives

`NotificationsService.createInAppWithDedup(data, tid)` — a single
private helper called by both fan-out methods:

- `notifyUploaderAndRoles(...)`
- `notifyUsersByRoles(...)`

**Compliance code is unchanged** — no compliance call site invokes
`notification.create` directly. The dedup gate is entirely inside
the notifications module.

## 2. Flag chain

| Flag | Default | Effect |
|---|---|---|
| `NOTIFICATION_DEDUP_ENABLED` | `false` | dedup probe is skipped; every fan-out call creates the row as legacy behaviour |
| `NOTIFICATION_DEDUP_WINDOW_MINUTES` | `360` (= 6 h) | look-back window for the dedup probe |

The Phase 2.42-2.44 fan-out gates still apply on top:
`TENANT_AWARE_JOBS_ENABLED` + `TENANT_JOB_FANOUT_ENABLED` plus an ALS
tenant frame. `assertTenantForFanout` already refuses the call when
ALS is missing — the dedup helper inherits that protection.

## 3. Dedup identity

```ts
where: {
  tenantId,                  // required — never crosses tenants
  userId,                    // per-recipient
  type,                      // event-key → NotificationType (e.g. DOCUMENT_EXPIRY)
  relatedEntity,             // required for dedup
  relatedEntityId,           // required for dedup
  createdAt: { gte: now - window },
  deletedAt: null,
}
```

If `relatedEntity` or `relatedEntityId` is **absent**, the helper
falls through to a plain create. Type-only dedup is too coarse
because two unrelated events can share a NotificationType (e.g.
`DOCUMENT_UPLOADED` and `DOCUMENT_EXPIRED` both → `DOCUMENT_EXPIRY`).
This is documented as a known limitation: callers that need dedup
must pass a stable `relatedEntityId`.

## 4. What dedup deliberately does NOT do

- **Cross tenants** — `tenantId` is always in the lookup.
- **Cross users** — `userId` is always in the lookup.
- **Cross event types** — the resolved `NotificationType` is in the
  lookup. Two callers with different `NotifEventKey` resolving to
  different types are not deduped.
- **Suppress NULL-tenant legacy rows from suppressing tenant-scoped
  rows** — the lookup explicitly requires `tenantId = <active>`.
- **Apply to internal scheduler scans** — only the two fan-out
  methods (`notifyUsersByRoles`, `notifyUploaderAndRoles`) route
  through the helper. The Phase 2.10/2.14 `check*` methods that
  create their own notifications are unchanged; they already produce
  one row per detected condition and dedup there is a future phase.

## 5. Return shape

```ts
notifyUsersByRoles(...): Promise<{ created: number; deduped: number }>
notifyUploaderAndRoles(...): Promise<{ created: number; deduped: number }>
```

Backward-compatible: existing callers `await` and discard the value;
TypeScript permits the new shape against the old `Promise<void>`.

## 6. Compliance coupling integration (Phase 2.43 + 2.44)

`ComplianceService.maybeNotifyOnAlertGeneration` now passes a stable
`relatedEntityId = 'tick:<tenantId>'` so consecutive cron ticks for
the same tenant collapse into a single notification per recipient
within the window. The result shape gains an optional `deduped`
counter:

```ts
{ skipped?, refused?, notified?, deduped?, error? }
```

`ComplianceScheduler.summarizeHealth(result)` now folds per-tenant
`notify.deduped` into the operator-visible health log line as
`notifyDeduped`:

```json
{
  "job": "compliance-alert-generation",
  "status": "ok",
  "processed": 2,
  "succeeded": 2,
  "failed": 0,
  "alertsCreated": 2,
  "notifySucceeded": 0,
  "notifySkipped": 0,
  "notifyFailed": 0,
  "notifyDeduped": 2,
  "cron": "0 */6 * * *",
  "timestamp": "..."
}
```

A scheduler tick that suppresses a duplicate now reports
`status='ok'` (no failure) but with `notifyDeduped > 0` — operators
can monitor that distinct counter independently.

## 7. Production safety

With `NOTIFICATION_DEDUP_ENABLED=false` (default):
- The helper does **zero** extra DB queries.
- Every fan-out call falls through to the same
  `legacyPrisma.notification.create({ data })` it executed before
  Phase 2.45.
- Result counters are populated but the values are byte-equivalent
  to the count of rows created, so existing `await fn()` callers
  see no difference.

## 8. Harness — 12/12 PASS

```
[notifications-dedup] 12/12 PASS
```

1. flag off → duplicates created (legacy)
2. flag on → second identical suppressed
3. dedup does NOT suppress different user (same tenant)
4. dedup does NOT cross tenants
5. dedup does NOT suppress different event type
6. window respected — old row outside window does not suppress
7. tenant A dedup does NOT see tenant B rows
8. NULL-tenant legacy row does NOT suppress tenant-scoped notification
9. compliance coupling — first tick creates, second tick deduped
10. scheduler health includes `notifyDeduped` counter
11. missing tenant context refuses safely (`assertTenantForFanout`)
12. concurrent tenant fan-outs remain isolated

## 9. Rollback runbook

```sh
NOTIFICATION_DEDUP_ENABLED=false   # disable dedup probe
# OR
TENANT_JOB_FANOUT_ENABLED=false    # disables fan-out altogether
# OR
COMPLIANCE_NOTIFY_ON_ALERT=false   # disables compliance → notifications coupling
```

No data, no schema migration introduced. Configuration-only rollback.

## 10. Known limitations

- **`relatedEntityId` required for dedup.** Callers without a stable
  identity fall through to a create. This is intentional — type-only
  dedup is too coarse.
- **No retry-aware dedup.** The window is wall-clock from the row's
  `createdAt`. A tenant whose cron ticks faster than the window will
  see one notification per window per recipient regardless of how
  many alerts are produced.
- **Internal scheduler scans (`check*`)** are unchanged. A future
  phase can route them through `createInAppWithDedup` once the call
  sites have stable identity strings.

## 11. Future work

- **Per-tenant window override** — read window from a tenant-scoped
  setting instead of process env.
- **Apply dedup to internal `check*` scans** — needs identity strings
  per condition (`vehicle:<id>:mot-expiry` etc.).
- **External provider dedup** — out of scope; in-app only today.

---

# Phase 2.46 addendum — internal `check*` scans now route through the helper

`checkExpiringCompliance`, `checkServiceDue`, `checkOverdue`, and
`checkScheduledMaintenance` now route their `notification.create`
through `createInAppWithDedup`. Identity uses the existing
`(relatedEntity, relatedEntityId, type)` triple — no new identity
strings introduced. See
`SAAS_PHASE2_NOTIFICATIONS_INTERNAL_SCAN_DEDUP.md`.

New tag: `phase246-notifications-internal-scan-dedup` (allowed in
`src/notifications/`).

New harness: `notifications-internal-scan-dedup` — 13/13 PASS.
