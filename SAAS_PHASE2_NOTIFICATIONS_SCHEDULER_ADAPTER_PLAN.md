# Phase 2.14 — Notifications Scheduler Adapter Plan

> Status: **adapter + per-method narrowing SHIPPED**.
>   - Phase 2.14: orchestrator + ALS adapter + fanout-writer guards.
>   - Phase 2.14.1: per-method narrowing of the four `check*` methods
>     + dedupe key tenant-scoping. See
>     `SAAS_PHASE2_NOTIFICATIONS_CHECK_METHOD_AUDIT.md` and
>     `SAAS_PHASE2_NOTIFICATIONS_DEDUPE_KEY_REVIEW.md`.
>
> Original design (kept verbatim below for the historical record).
>
> Describes how `NotificationsScheduler`, the four `check*` methods,
> and the two `notify*` writers will adopt the Phase 2.13 job-context
> framework, replacing today's `phase210-excluded-background`
> annotations with `phase214-pilot-scope`.

---

## 1. Today (Phase 2.10 outcome)

- `NotificationsScheduler.runAllChecks` runs cross-tenant. Cron tick
  hits every fleet manager regardless of tenant.
- `checkExpiringCompliance / checkServiceDue / checkOverdue /
  checkScheduledMaintenance` iterate `prisma.user.findMany({ role:
  fleet manager })` across all tenants.
- `notifyUploaderAndRoles / notifyUsersByRoles` look up users by role
  across all tenants and create `Notification` rows with
  `tenantId = NULL`.
- All annotated `// @tenant-reviewed: phase210-excluded-background`
  to mark the explicit opt-out.

## 2. Target shape (Phase 2.14)

### 2.1 `NotificationsSchedulerService.runAllChecks` wrapper

```ts
async runAllChecks() {
  const planner = new TenantJobFanoutPlanner();
  const candidates = await this.legacyPrisma.tenant.findMany({
    where: { status: 'ACTIVE' },
    select: { id: true, slug: true, status: true },
  });
  const plan = planner.plan(
    'notifications.runAllChecks', candidates, () => ({}),
    { dryRun: !this.flags.tenantJobFanoutEnabled() },
  );

  if (plan.dryRun) {
    this.logger.log(`[fanout-dry-run] tenants=${plan.tenants.length} skipped=${plan.skipped.length}`);
    return;
  }

  await runForTenantBatch(
    plan.tenants.map((t) => t.tenantId),
    (tid) => this.notifications.runAllChecksForTenant(tid),
    { concurrency: 4, perTenantTimeoutMs: 60_000 },
  );
}
```

### 2.2 Per-tenant entry point

`NotificationsService` gains a public method:

```ts
async runAllChecksForTenant(_tenantId: string): Promise<void> {
  // tenantId is in ALS via runForTenant; the existing check* methods
  // can read it via TenantContext.optional() if they want.
  await this.checkExpiringCompliance();
  await this.checkServiceDue();
  await this.checkScheduledMaintenance();
  await this.checkOverdue();
}
```

The existing `runAllChecks()` keeps its current signature for tests
that call it directly, but is a wrapper that does NOT iterate tenants.

### 2.3 `check*` methods receive tenant via ALS

Each `check*` method reads the active tenant from ALS:

```ts
async checkExpiringCompliance(): Promise<void> {
  const tenantId = TenantContext.optional()?.id;
  if (!tenantId) {
    this.logger.warn('checkExpiringCompliance called outside tenant context — skipping');
    return;
  }

  const fleetManagers = await this.prisma.user.findMany({
    where: {
      role: { name: { contains: 'Fleet Manager' } },
      status: 'ACTIVE',
      // NEW: scope to the active tenant.
      agency: { tenantId },
      notificationPreference: { isNot: null },
    },
    include: { notificationPreference: true, agency: true },
  });
  // ...rest unchanged...
}
```

Critically: today's `check*` methods iterate ALL fleet managers
regardless of agency. The new shape iterates only fleet managers
whose agency belongs to the active tenant. The cron ticks N times
per tenant; the planner emits N tenant-scoped jobs per tick.

### 2.4 `notify*` writers accept tenant context

`notifyUploaderAndRoles` / `notifyUsersByRoles` are called from HTTP
handlers (e.g. document upload). Their callers already have a tenant
in ALS via the request middleware. The writers should:

```ts
async notifyUsersByRoles(roles: string[], eventKey, ...): Promise<void> {
  const tenantId = TenantContext.optional()?.id;

  const users = await this.prisma.user.findMany({
    where: {
      role: { name: { in: roles } },
      status: 'ACTIVE',
      ...(tenantId ? { agency: { tenantId } } : {}),
    },
    select: { id: true },
  });

  // ...the create now persists tenantId from ALS via the existing
  // `getPilotScope(...).tenantData()` spread on the create payload...
}
```

### 2.5 `Notification.tenantId` populated on create

Once the writers carry tenant context, the creates in `check*` and
`notify*` should spread `getPilotScope(this.pilot, 'notifications').tenantData()`
into the `data` payload. The existing Phase 2.10 read-path scope is
already in place; Phase 2.14 extends it to writes.

## 3. Required tests before moving scheduler paths

Each one needs a harness case BEFORE `phase214-pilot-scope` replaces
`phase210-excluded-background`:

- **runAllChecks fanout coverage** — given N active tenants, the
  planner emits N entries; the runner attaches each tenant's ALS
  frame.
- **per-tenant check isolation** — `checkExpiringCompliance` for
  tenant A reads only tenant A's fleet managers (no fleet managers
  from tenant B).
- **per-tenant notification creation** — `Notification.tenantId` on
  newly-created rows equals the tenant-context tenant.
- **dry-run plan** — with `TENANT_JOB_FANOUT_ENABLED=false`, the
  cron tick logs the plan and exits without enqueuing.
- **flag rollback** — toggling `TENANT_JOB_FANOUT_ENABLED=false`
  mid-run does NOT abort in-flight tenant jobs (queue contract).
- **timeout** — a tenant whose `runAllChecksForTenant` exceeds
  `perTenantTimeoutMs` records `ok=false` with `error.name='TimeoutError'`;
  other tenants finish normally.
- **idempotency** — two cron ticks in the same minute produce the
  same idempotency keys; the queue runner's dedupe store can drop
  the second tick safely.
- **observability** — per-tenant duration + success/failure metrics
  emit at the right cardinality (one timeseries per tenant).

## 4. Operator runbook (Phase 2.14)

```sh
# 1. Confirm Phase 2.13 framework is healthy
DATABASE_URL=... npm run saas:phase2-job-context-harness

# 2. Stage the flag profile
export TENANT_AWARE_JOBS_ENABLED=true     # already verified per-tenant runs
export TENANT_JOB_FANOUT_ENABLED=false    # cron prints plan; doesn't enqueue
# Run for 24h, monitor logs.

# 3. Flip fanout on
export TENANT_JOB_FANOUT_ENABLED=true
# Cron ticks now enqueue per-tenant jobs.

# 4. After 7 clean days, drop the `phase210-excluded-background`
#    annotations and replace with `phase214-pilot-scope`.
```

## 5. Rollback (Phase 2.14)

```sh
export TENANT_JOB_FANOUT_ENABLED=false   # stop fanouts
export TENANT_AWARE_JOBS_ENABLED=false   # stop new tenant frames
# Redeploy. In-flight tenant jobs finish. New cron ticks revert to
# legacy global iteration (which still exists in this phase as a
# safety fallback).
```

## 6. Out of scope for the adapter

- A new `Notification` schema column. The `tenantId` denorm already
  landed in Phase 2.3.
- Cross-tenant fanout (one alert routed to recipients in multiple
  tenants). If product wants this, it's a Phase 3 design.
- Email/SMS delivery worker tenant routing. The notification CREATE
  path lands `tenantId`; the email worker's tenant routing is a
  Phase 3 task.
- Removing the legacy `runAllChecks` cross-tenant code path. Keep it
  as a fallback while `TENANT_JOB_FANOUT_ENABLED=false`. Phase 3
  removes the legacy path after the per-tenant path has run cleanly
  for ≥ 30 days in production.
