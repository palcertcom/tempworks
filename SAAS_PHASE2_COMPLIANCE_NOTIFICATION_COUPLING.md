# Phase 2.43 — Compliance → Notifications Event Coupling

> Optionally fans out an in-app notification to compliance staff
> after a per-tenant compliance alert tick produces new alerts.
> Disabled by default; tenant-safe by construction.

---

## 1. Execution path

```
@Cron('0 */6 * * *')                                                    <-- src/compliance/compliance.cron.ts
  ComplianceCron.tick()
    -> ComplianceScheduler.runScheduledComplianceAlertGeneration()       <-- 2.40
      -> dispatchComplianceAlertGenerationForTenants()                   <-- 2.39
        -> generateAlertsForTenant(tenantId)                              <-- 2.38
          -> withRequestContext + TenantContext.attach({id: tenantId})
            -> generateAlerts()                                           <-- raw scanner; runs INSIDE the ALS frame
            -> maybeNotifyOnAlertGeneration(total)                        <-- Phase 2.43, INSIDE the ALS frame
              -> NotificationsService.notifyUsersByRoles(...)              <-- existing tenant-safe fan-out helper
```

The notification call happens **inside** the per-tenant ALS frame
established by `generateAlertsForTenant`. The existing
`notifyUsersByRoles` helper:
- narrows the recipient `User.findMany` query by `agency.tenantId`;
- stamps `Notification.create.data.tenantId` from the active ALS frame;
- never invokes EmailModule / SMS / external providers.

## 2. Flag chain

| Layer | Flag | Default | When off |
|---|---|---|---|
| Coupling | `COMPLIANCE_NOTIFY_ON_ALERT` | `false` | `maybeNotifyOnAlertGeneration` returns `null`; zero notifications |
| Aware-jobs | `TENANT_AWARE_JOBS_ENABLED` | `false` | helper returns `{refused: 'tenant fan-out gates off …'}`; zero notifications |
| Fan-out | `TENANT_JOB_FANOUT_ENABLED` | `false` | helper returns `{refused: …}`; zero notifications |
| Pilot scope | `TENANT_PRISMA_PILOT_ENABLED` + `TENANT_PRISMA_PILOT_MODULES` | off | `generateAlertsForTenant` refuses upstream; helper never runs |
| Env safety | `classifyRuntimeEnv() ∈ {SAFE_CLONE, SAFE_STAGING}` | enforced | upstream refusal |

**Turning on `COMPLIANCE_NOTIFY_ON_ALERT` alone is not enough.** All
five layers must align before a notification is created.

## 3. What the helper does

```ts
private async maybeNotifyOnAlertGeneration(total: number) {
  if (!this.flags.complianceNotifyOnAlert()) return null;
  if (!this.notifications) return { skipped: 'NotificationsService not provided' };
  if (!this.flags.tenantAwareJobsEnabled() || !this.flags.tenantJobFanoutEnabled()) {
    return { refused: 'tenant fan-out gates off (TENANT_AWARE_JOBS_ENABLED / TENANT_JOB_FANOUT_ENABLED)' };
  }
  if (total <= 0) return { skipped: 'no new alerts in this tick' };
  try {
    await this.notifications.notifyUsersByRoles(
      ['Compliance Officer', 'Compliance Manager', 'System Admin'],
      'compliance.alert.generated',
      'New compliance alerts',
      `${total} new compliance alert${total === 1 ? '' : 's'} were generated …`,
      'ComplianceAlert', undefined,
      { titleKey: 'compliance.alertGenerated.title', messageKey: 'compliance.alertGenerated.message', params: { total } },
    );
    return { notified: total };
  } catch (e) {
    this.logger.warn(`[notify] fan-out failed: …`);
    return { error: String(e?.message ?? e) };
  }
}
```

## 4. Recipient roles

`Compliance Officer`, `Compliance Manager`, `System Admin`.

The existing `notifyUsersByRoles` helper resolves `User.findMany`
narrowed by `role.name IN (...)` AND, when the fan-out gate is on,
`agency.tenantId = <active>`. Tenants without users in those roles
receive zero notifications for that tick — a safe no-op.

## 5. What this phase does NOT do

- **No email/SMS/external provider invocation.** The helper writes
  in-app `Notification` rows only.
- **No new role.** The harness seeds `Compliance Officer` users in
  tenants A and B for coverage; production already has these roles.
- **No automatic on-create alert notification.** `generateAlerts()`
  itself does not call any notification helper. The coupling lives
  one level up, inside `generateAlertsForTenant` after the per-tenant
  scan completes.
- **No retry / queue / ack semantics.** If the fan-out fails the
  result records `{ error }` and compliance alert generation is NOT
  rolled back.

## 6. Failure semantics

- A throw inside `notifyUsersByRoles` is caught by `maybeNotifyOnAlertGeneration`.
- The compliance alert generation result is unaffected (no rollback).
- The result returned by `generateAlertsForTenant` includes a
  structured `notify: { error: '...' }` field so the dispatch /
  scheduler / cron layers can log per-tick failures without
  crashing the host process.

## 7. Production safety

With every flag at default `false`:
- `maybeNotifyOnAlertGeneration` returns `null`. Zero notifications.
- `generateAlertsForTenant`'s return shape is identical to pre-2.43
  (no `notify` field present unless coupling fires).
- The Phase 2.41 cron decorator still fires on schedule, but every
  layer below is a no-op until all flags align.

## 8. Harness — 12/12 PASS

```
[compliance-notification-coupling] 12/12 PASS
```

1. flag off (default): zero notifications.
2. flag on + `TENANT_JOB_FANOUT_ENABLED=false`: refused.
3. flag on + `TENANT_AWARE_JOBS_ENABLED=false`: refused.
4. compliance pilot inactive: upstream refusal; zero notifications.
5. happy path: notifications created with `tenantId = A` only.
6. tenant B users do NOT receive tenant A notifications.
7. NULL-tenant notifications are NOT created.
8. notification fan-out runs inside the per-tenant ALS frame (tenantId stamped).
9. notification fan-out failure captured (no throw escapes).
10. **source-level**: raw `generateAlerts()` body does NOT call notification fan-out.
11. **source-level**: `ComplianceCron.tick()` body still calls only `runScheduledComplianceAlertGeneration()`.
12. **source-level**: `ComplianceScheduler` body does not call notification helpers directly.

## 9. Rollback runbook

```sh
COMPLIANCE_NOTIFY_ON_ALERT=false   # coupling no-op
# OR
TENANT_JOB_FANOUT_ENABLED=false    # fan-out gate refuses
# OR
TENANT_AWARE_JOBS_ENABLED=false    # fan-out gate refuses
# OR
TENANT_PRISMA_PILOT_ENABLED=false  # pilot inactive (upstream refusal)
# OR
TENANT_PRISMA_PILOT_MODULES=       # remove 'compliance'
```

No data, no schema migration introduced. Configuration-only rollback.

## 10. Future work

- **External provider (email/SMS) coupling** — out of scope.
  `EmailModule` already exists; a future phase may wire a
  per-tenant email summary. The existing tag
  `phase243-compliance-notification-deferred-provider` is reserved
  for that work.
- **Per-recipient deduplication** — today a six-hour cron may deliver
  duplicate "N new alerts" notifications across consecutive ticks
  if the same `Document` keeps producing new alerts. A future phase
  could add per-(tenantId, recipientUserId, dueDate) dedup.
- **Configurable role list** — the recipient roles are hard-coded.
  A future phase could read them from a tenant-scoped setting.

---

# Phase 2.44 addendum — health summary surfaces notify counters

`ComplianceScheduler.summarizeHealth(result)` now folds per-tenant
`notify` outcomes into `notifySucceeded` / `notifySkipped` /
`notifyFailed` counters and emits a `compliance.scheduler.health`
log line with stable JSON. See `SAAS_PHASE2_COMPLIANCE_SCHEDULER_HEALTH.md`.

The notification-coupling failure path
(`notify.error`) now reports as `status='partial_failure'` with
`notifyFailed >= 1` in the per-tick health log.

---

# Phase 2.45 addendum — relatedEntityId stable identity for dedup

`maybeNotifyOnAlertGeneration` now passes a stable
`relatedEntityId = 'tick:<tenantId>'` to `notifyUsersByRoles`. With
`NOTIFICATION_DEDUP_ENABLED=true` this allows consecutive cron ticks
to collapse to a single notification per recipient within the
configured window. The notify-coupling result gains an optional
`deduped` counter forwarded into the dispatch + scheduler results.

See `SAAS_PHASE2_NOTIFICATIONS_DEDUP.md`.
