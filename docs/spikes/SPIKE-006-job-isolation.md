# SPIKE-006 — Background Jobs Tenant Isolation

- **Status:** PASS WITH CONSTRAINTS
- **Date:** 2026-05-09
- **Artifact:** `spikes/spike-006-jobs/job-fanout.mjs` (executable)
- **Validates:** ADR-004 §9, ADR-001 (cross-cutting)

## Hypothesis

A `TenantAwareJobProcessor` base class that re-enters AsyncLocalStorage with `tenantId` from the job payload — combined with a per-tenant cron fan-out producer — provides reliable tenant isolation for BullMQ jobs, even under concurrency, retry, and delay.

## Findings (measured, in-process simulation matching BullMQ contract)

| Probe | Setup | Result |
|---|---|---|
| Fan-out | 100 jobs across 3 tenants interleaved, concurrency 8 | ✅ 0 leaks |
| Retry | 50 jobs × ≤4 attempts, random `throw` ratio 30%, concurrency 4 | ✅ 0 mismatches across 10 retries |
| Cron fan-out | 3 ticks × 3 tenants | ✅ each tenant ran exactly 3 times |

The simulation is in-process but mirrors BullMQ semantics: the worker callback runs in the **producer's process or another node** with a serialized `job.data` payload; ALS does not cross the boundary; the base class re-enters ALS with the tenant from `job.data.tenantId`.

## BullMQ Tenant Propagation Pattern

```ts
// Producer
queue.add('notifications.checkExpiringDocs',
  { tenantId, userId: ctx.user?.id },
  { attempts: 3, backoff: { type: 'exponential', delay: 1000 } }
);

// Worker
@Processor('notifications')
class NotificationsWorker extends TenantAwareJobProcessor<{tenantId: string; userId?: string}> {
  constructor(private alerts: AlertsService) { super(); }
  async handle(job) {
    // ALS already populated by base class
    return this.alerts.runExpiringDocsCheck();
  }
}
```

`TenantAwareJobProcessor.process()` (per ADR-004 §9):

```ts
async process(job) {
  const tenant = await this.tenants.requireById(job.data.tenantId);
  const user   = job.data.userId ? await this.users.snapshot(job.data.userId) : undefined;
  return als.run({ tenant, user, requestId: `job:${job.id}` }, () => this.handle(job));
}
```

## Retry Safety

- BullMQ's retry mechanism re-invokes `process()` with the same `job.data`. **`tenantId` is preserved.** Probe confirms.
- The base class re-enters ALS each invocation, so context loss between attempts is impossible.
- Idempotency: handlers must be idempotent because retries are inevitable. Use a deterministic dedup key for any side effect (e.g. `notification.uniqueKey = sha256(tenantId+kind+targetId+periodKey)`).
- Backoff: exponential with jitter; per-tenant rate limit fits as a "wait until tenant token bucket has capacity" check inside the handler — not an external dependency.

## Delayed Jobs

- `queue.add(name, data, { delay: ms })` — BullMQ stores the job in a delayed-queue ZSET; `tenantId` in `job.data` is preserved. Probe confirms the same handler shape works.
- Time-shifted reminders (e.g. "send reminder 24 h before document expiry") use this. Producer is the existing scheduler refactored.

## Cron Fan-out Strategy

The current `notifications-scheduler.service.ts` uses `setInterval(runAllChecks, 6h)` and scans **all** tenants in one pass — see SPIKE-002 L-2 and SPIKE-006 fan-out probe.

Replace with:

```ts
@Cron('0 */6 * * *')
async fanout() {
  const tenants = await this.tenants.listActive();   // platform query, not tenant-scoped
  for (const t of tenants) {
    await this.queue.add('notifications.checkExpiringDocs',
      { tenantId: t.id }, { jobId: `chk:${t.id}:${currentBucket()}` });
  }
}
```

`jobId` deduplication (BullMQ) ensures a missed/duplicate enqueue across pods doesn't fan out twice for the same tenant per period.

## Tenant-Aware Batching

- Workers read `tenantPrisma` inside the ALS context; queries are auto-tenant-filtered.
- Inside a job, batch by tenant data only (the job is already a tenant). For example: paginate documents in 1k chunks; never `findMany()` without a `take`.

## Noisy-Neighbor Mitigation

- Per-tenant queue concurrency cap via BullMQ rate limiter:
  ```ts
  new Worker(name, processor, { limiter: { max: 50, duration: 1000, groupKey: 'tenantId' } });
  ```
  - 50 jobs/sec per tenant; the `groupKey` rate-limits per `job.data.tenantId`.
- Long-running tenants get isolated queue names (`notifications:enterprise`) when promoted; not Phase 0.

## Queue Partitioning Strategy

| Queue | Sharding key | Reason |
|---|---|---|
| `notifications` | none (low volume) | Single queue; rate-limited per tenant |
| `documents.ocr` (future) | `groupKey: tenantId` | Heavy CPU; per-tenant fairness |
| `reports.export` | `groupKey: tenantId` | Per-tenant fairness |
| `email.send` | none | SMTP rate limit dominates |
| `audit.indexer` (if added) | `groupKey: tenantId` | High volume |

Partitioning **by tenant** (one queue per tenant) is rejected — too many queues at scale; BullMQ's group-key rate limiter gives equivalent fairness.

## Platform-Wide Jobs

Some jobs are intentionally cross-tenant (the cron fan-out producer; the storage-rekey migration; daily orphan-draft sweep). These run **without** ALS tenant context and **must not** call `tenantPrisma`. Lint rule: a worker class that does not extend `TenantAwareJobProcessor` is forbidden from importing `TenantPrismaService`.

## Risks Surfaced

| # | Risk | Mitigation |
|---|---|---|
| R-1 | Producer forgets `tenantId` in payload | Type-system enforced: `Job<{ tenantId: string; ... }>`; handler base class throws if missing |
| R-2 | Worker handler ignores ALS and uses raw `prisma` | ESLint allowlist (extends `TenantAwareJobProcessor` ⇒ allowed; otherwise blocked) |
| R-3 | Retry storm overwhelms a tenant's DB | `groupKey` rate limit + exponential backoff |
| R-4 | Long-running job holds a transaction (RLS GUC) too long | Workers use a separate session-mode pool; tx is opened per-DB-operation, not per-job |
| R-5 | Job data contains tenant-foreign IDs (cross-tenant reference) | At job entry, validate every id belongs to `ctx.tenantId` (existence check via `tenantPrisma`) |
| R-6 | Webhook-out / outbound emails leak data across tenants | Outbound integrations live in tenant-aware workers; email service reads sender from `ctx.tenant.branding` |
| R-7 | Dead-letter queue accumulates with mixed-tenant payloads | DLQ inspector UI runs in `/_platform`; reads with `PlatformPrismaService`; audited |

## Verdict: **PASS WITH CONSTRAINTS**

Constraints:

1. **`TenantAwareJobProcessor` is mandatory** for any worker reading tenant data. Lint enforces.
2. Job payloads must include `tenantId` and a typed shape; producer functions are typed wrappers.
3. Cron jobs schedule one job per active tenant; no cron handler reads tenant data directly.
4. BullMQ rate limiter `groupKey: 'tenantId'` for high-volume queues.
5. DLQ access only via `/_platform` (audited).
6. Workers run on a separate Postgres session-mode pool dedicated to long-lived backends; HTTP API stays on transaction-mode pool.
7. The legacy `setInterval` notifications scheduler runs in parallel for one week against new BullMQ fan-out; deduplication via deterministic `jobId` per period.

## Cleanup

```sh
rm -rf spikes/spike-006-jobs
```
