# Phase 2.13 — Tenant-Aware Job Context Architecture

> Build the clockwork before letting the clocktower ring per tenant.

This document describes the tenant-aware job context framework
shipped (dormant) in Phase 2.13, and the staged rollout that will
later move scheduler / queue workloads onto it.

---

## 1. Current scheduler / background risks

The codebase has three classes of cron / background paths today:

1. **Cron orchestrators** (`NotificationsSchedulerService` + others)
   that fire on a fixed cadence and iterate `User`/`Vehicle` rows
   across all tenants.
2. **Fanout writers** (`NotificationsService.notifyUploaderAndRoles`,
   `notifyUsersByRoles`) called from inside HTTP handlers; they look
   up users by role across all tenants.
3. **Queue workers** (the existing `TenantAwareJobProcessor` BullMQ
   skeleton from Phase 0) that today only stub the tenant-scoped path.

Phase 2.10 explicitly excluded these paths from the pilot because
none of them carries a tenant context in ALS. The risks if they were
moved without infrastructure:

- A cron tick wrapped in `runForTenant(<single tenant>, runAllChecks)`
  would only service one tenant per tick — silently breaking
  per-tenant fleet observability.
- A fanout writer that filters by role across all tenants would
  start filtering by the calling tenant, dropping notifications for
  cross-tenant recipients (rare but real, e.g. shared documents).
- A queue worker reading off Redis has no way to recover an ALS frame
  from the payload alone — the worker has to re-attach the tenant.

Phase 2.13 ships the framework that solves these problems.
**Scheduler/business code is NOT yet wired to it.**

## 2. Target tenant-aware job lifecycle

```
                ┌────────────────────────┐
   cron tick ──▶│ TenantJobFanoutPlanner │
                │   .plan(...)           │
                └─────────┬──────────────┘
                          │ ExecutionPlan
                          ▼
                ┌────────────────────────┐
                │  enqueue per tenant    │ ← `toPayloads()`
                │  (BullMQ / direct)     │
                └─────────┬──────────────┘
                          │ TenantJobPayload<T>
                          ▼
                ┌────────────────────────┐
                │  queue runner          │
                │  ▸ assertTenantJobPayload
                │  ▸ runForTenant(...)   │ ← attaches ALS frame
                │  ▸ <domain code>       │
                └────────────────────────┘
```

Three pluggable layers; each has a single responsibility.

## 3. Tenant discovery for jobs

The orchestrator is responsible for discovering candidate tenants.
The framework offers no opinion on the source — typical sources:

- `prisma.tenant.findMany({ where: { status: 'ACTIVE' } })`.
- A platform-admin allow-list when only specific tenants opt into a
  feature.
- A fan-OUT trigger from a per-tenant event (e.g. document upload
  emits a queue job with a single tenant id).

The `TenantJobFanoutPlanner` then filters by status, excludes
platform tenants, applies the `maxTenants` cap, and emits a plan.

## 4. ALS rehydration per job

`runForTenant(tenantId, fn)` is the single point of ALS attachment
for non-HTTP entry points. Implementation:

1. Validate `tenantId` is a UUID. Throw `InvalidTenantIdError`
   otherwise.
2. Run `gateOrThrow`: refuse if `TENANT_AWARE_JOBS_ENABLED=false` OR
   the env classifier reports UNSAFE_PRODUCTION/UNKNOWN. The test
   harness uses `{ allowDormant: true }` to bypass these gates
   in-process.
3. Open a fresh `withRequestContext({ requestId })` ALS frame.
4. Call `TenantContext.attach({ id, ... })` so all downstream
   `TenantContext.optional()` / `getPilotScope(...)` calls return the
   correct tenant.
5. `await fn()` and propagate the return value (or error).

ALS isolation is enforced by Node's `AsyncLocalStorage`. The harness
verifies (case 2) that three concurrent `runForTenant` frames do not
bleed into each other.

## 5. Cron fanout strategy

A cron tick that wants to run a job per tenant follows this pattern:

```ts
async function runNotificationsTick() {
  const candidates = await loadCandidates(prisma);                 // db
  const planner = new TenantJobFanoutPlanner();
  const plan = planner.plan('notifications.runAllChecks',
    candidates, () => ({}), { dryRun: !flags.tenantJobFanoutEnabled() });

  if (plan.dryRun) {
    log.info({ plan }, 'dry-run fanout plan');
    return;
  }

  // Either enqueue (recommended) or run inline:
  await runForTenantBatch(
    plan.tenants.map((t) => t.tenantId),
    async (tid) => notificationsService.runAllChecks(tid),
    { concurrency: 4, perTenantTimeoutMs: 30_000 },
  );
}
```

The plan is the data contract between the orchestrator and the queue
runner / inline runner. Two flag layers:

- `TENANT_AWARE_JOBS_ENABLED` — gates `runForTenant`/`runForTenantBatch`.
- `TENANT_JOB_FANOUT_ENABLED` — gates whether the orchestrator
  actually enqueues (when off, `dryRun` is forced regardless of the
  caller's wish — orchestrators check this themselves).

Both default `false` in production.

## 6. BullMQ / queue payload strategy

`TenantJobPayload<TBody>` is the wire format. Every queued job MUST
serialise to this shape. The framework provides:

- `buildTenantJobPayload({...})` — construct from minimal args.
- `assertTenantJobPayload(raw)` — validate at the queue boundary;
  throws `TenantJobPayloadError` with the specific bad field.
- `buildRetryPayload(prev)` — bump `retry.attempt`, preserve
  `idempotencyKey`.
- `makeIdempotencyKey({...})` — deterministic, minute-bucketed,
  body-fingerprinted.

A queue runner's responsibility:

1. `assertTenantJobPayload(job.data)` — refuse malformed payloads.
2. Optionally consult its own dedupe store with `idempotencyKey`.
3. Call `runForTenant(payload.tenantId, () => handler(payload))`.
4. On failure, the queue runner constructs the retry via
   `buildRetryPayload(payload)` and re-enqueues.

## 7. Retry behaviour

The framework records retry metadata but does NOT enforce a backoff
policy. The queue runner is responsible. The framework guarantees
that across retries:

- `tenantId` is unchanged.
- `idempotencyKey` is unchanged.
- `retry.attempt` is incremented.
- `retry.maxAttempts` is preserved.
- `actor` and `body` are preserved.

This contract is verified by the harness (case 8).

## 8. Idempotency

`makeIdempotencyKey({ sourceJobName, tenantId, scheduledAt, body })`
computes a stable key:

```
<sourceJobName>|<tenantId>|<minute-bucket-iso>|<body-djb2-base36>
```

- Minute bucket truncates seconds + millis. Two cron ticks fired
  within the same minute produce the same key — letting the queue
  dedupe naturally.
- Body fingerprint is deterministic (sorted keys, recursive). The
  framework verifies (case 9) that `{ foo: 1, bar: 2 }` and
  `{ bar: 2, foo: 1 }` produce the same key.

## 9. Noisy-neighbor mitigation

The framework provides:

- `runForTenantBatch({ concurrency })` — bound the number of
  concurrent per-tenant frames.
- `runForTenantBatch({ perTenantTimeoutMs })` — cap any one tenant's
  contribution to wall-clock time. Failures are recorded in the
  per-tenant `JobResult`; OTHER tenants in the batch continue.
- `TenantJobFanoutPlanner({ maxTenants })` — hard cap on tenants per
  fanout plan. Excess tenants are reported as `skipped: 'over-max'`.

A future Phase 3 may add per-tenant priority and rate limits via the
queue runner's own knobs — out of scope here.

## 10. Observability

See `SAAS_PHASE2_JOB_CONTEXT_OBSERVABILITY.md` for the required log
fields, metrics, and rollback triggers. Summary: every `JobResult`
carries `{ tenantId, ok, durationMs, error? }` so a queue runner can
emit per-tenant success/failure metrics without further plumbing.

## 11. Rollback

Rollback is the feature flags. To disable:

```sh
export TENANT_AWARE_JOBS_ENABLED=false
export TENANT_JOB_FANOUT_ENABLED=false
```

Then redeploy. Within seconds:

- `runForTenant` throws `MissingSafeEnvError` for any new caller.
- Existing schedulers (which do NOT call `runForTenant` today) are
  unaffected — they continue to use legacy iteration.
- Queued jobs that were already mid-flight finish out under the
  active flag combination at enqueue time. The framework does not
  re-validate flags per-attempt.

The framework introduces NO database state, so there's nothing to
clean up on rollback.

## 12. Production rollout phases

Phase 2.13: infrastructure only. Defaults OFF.
Phase 2.14 ✅ shipped: notifications scheduler adapter — first user of
  `TenantJobFanoutPlanner` + `runForTenantBatch`. Stays gated by
  `TENANT_JOB_FANOUT_ENABLED=false` until staging rehearsal. See
  `SAAS_PHASE2_NOTIFICATIONS_SCHEDULER_PILOT_RESULTS.md`.
Phase 2.14.1 (planned): per-method narrowing of the four `check*`
  methods. Each method reads `TenantContext.optional()` and narrows
  its `prisma.user.findMany` to the active tenant.
Phase 2.15+ (planned): vehicles maintenance reminders, finance
  balance alerts, document-expiry creators, applicant follow-ups,
  workflow scheduler.
Phase 3 (cutover): flip `TENANT_AWARE_JOBS_ENABLED=true` in production
  per environment, after running per-tenant duration / success-rate
  metrics for ≥ 7 days at staging.

## 13. Out of scope for Phase 2.13

- BullMQ wiring (`TenantAwareJobProcessor` from Phase 0 is unrelated;
  Phase 2.14 will integrate).
- Per-tenant queue prioritisation.
- Cross-tenant job composition (a job that requires data from two
  tenants — none today; product decision pending if needed).
- Job result persistence (logs only today; a `tenant_job_runs` table
  is a Phase 3 design).
- Orchestrator scaffolding (the cron driver itself is module-specific;
  the framework gives the orchestrator the lego, not the
  orchestrator).
