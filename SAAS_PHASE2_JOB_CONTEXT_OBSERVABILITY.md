# Phase 2.13 — Job Context Observability & Safety

> What an operator must see when `TENANT_AWARE_JOBS_ENABLED=true` is
> in effect. Defines the log shape, metric set, and rollback triggers.

---

## 1. Required log fields

Every `runForTenant` invocation MUST produce at least one log line at
job completion (success or failure). Recommended fields:

| Field | Type | Source |
|---|---|---|
| `event` | string | `'job.run'` |
| `sourceJobName` | string | `payload.sourceJobName` |
| `tenantId` | string (UUID) | `payload.tenantId` (also from ALS) |
| `requestId` | string | `currentRequestContext()?.requestId` |
| `idempotencyKey` | string | `payload.idempotencyKey` |
| `actor.kind` | `'system'\|'user'` | `payload.actor.kind` |
| `attempt` | int | `payload.retry.attempt` |
| `durationMs` | int | wall-clock |
| `ok` | boolean | true on success |
| `error.name` | string | when `ok=false` |
| `error.message` | string | when `ok=false` |

The framework does not auto-log; the queue runner / orchestrator is
responsible. Why: the framework is the lego, not the orchestrator;
log shape is a per-deployment decision.

## 2. Required metrics

| Metric | Type | Labels | Notes |
|---|---|---|---|
| `tenant_jobs_total` | counter | `sourceJobName`, `tenantId`, `ok` | one increment per `runForTenant` completion |
| `tenant_jobs_duration_ms` | histogram | `sourceJobName`, `tenantId` | per-tenant runtime distribution |
| `tenant_jobs_failures_total` | counter | `sourceJobName`, `tenantId`, `error_name` | failures by error class |
| `tenant_jobs_skipped_total` | counter | `sourceJobName`, `reason` | from `ExecutionPlan.skipped[]` |
| `tenant_jobs_retries_total` | counter | `sourceJobName`, `attempt` | every `buildRetryPayload(...)` call |
| `tenant_jobs_idempotent_dropped_total` | counter | `sourceJobName` | queue runner's dedupe drops |
| `tenant_jobs_inflight` | gauge | `sourceJobName` | concurrency observable |

Cardinality note: a `tenantId` label is fine for low-tenant-count
deployments. For deployments above ~1k tenants, consider a separate
metric scoped to `cron-driver` only (no per-tenant label) and rely on
log queries for per-tenant drill-down.

## 3. Per-tenant duration

The harness records `JobResult.durationMs` for every batch run.
Operators should set alerts on the p99 of `tenant_jobs_duration_ms`
per `sourceJobName`. Suggested thresholds (operator-tunable):

- p99 < 5s for `notifications.runAllChecksForTenant`.
- p99 < 30s for any tenant-scoped maintenance check.
- Any single tenant exceeding `perTenantTimeoutMs` triggers an alert.

## 4. Per-tenant failures

Alert when:

- `tenant_jobs_failures_total{tenantId=<X>}` rate > 0.5/min for
  10 min — a single tenant is consistently failing; pause its
  fanout via `TENANT_JOB_FANOUT_ENABLED=false` until investigated.
- `tenant_jobs_failures_total{}` rate > 5% of `tenant_jobs_total{}` —
  systemic problem; full rollback indicated.

## 5. Skipped tenants

`SkippedTenant.reason` values to watch:

- `inactive` — expected when `activeOnly=true` and tenants are
  suspended; non-zero is fine.
- `system-tenant` — expected; baseline is the platform tenant count.
- `over-max` — should be zero unless an operator explicitly capped
  the run. Sustained non-zero = capacity issue; raise `maxTenants`
  or split into multiple ticks.
- `invalid-tenant-id` / `duplicate-id` — should be zero. Non-zero =
  bug in the candidate-loading step; investigate.

## 6. Retries

Every retry should emit `tenant_jobs_retries_total` and a log line
with `attempt` set. Operators care about:

- `attempt > maxAttempts / 2` is the warning threshold.
- `attempt === maxAttempts` and still failing — the queue runner
  should park the payload in a dead-letter queue, NOT silently drop.

## 7. Duplicate / idempotency events

Queue runners that consult an external dedupe store (Redis, etc.)
should emit `tenant_jobs_idempotent_dropped_total` for every
deduplicated job. Steady-state: ~0 (one cron tick per minute, single
fanout, no duplicates). A spike indicates two orchestrators racing —
investigate the cron infrastructure.

## 8. Rollback triggers

Auto-rollback (page on-call AND set `TENANT_JOB_FANOUT_ENABLED=false`):

| Trigger | Threshold |
|---|---|
| Per-tenant p99 duration > 5× legacy baseline | sustained 15 min |
| Failure rate > 10% across all tenants | sustained 10 min |
| Any single tenant failing consecutively | 5 attempts back-to-back |
| `MissingSafeEnvError` in production logs | 1 occurrence — env classifier disagrees with the operator |
| `TenantJobPayloadError` | > 1% of payloads — orchestrator producing malformed payloads |

Manual rollback:

```sh
export TENANT_JOB_FANOUT_ENABLED=false   # stop new fanouts
# Existing in-flight per-tenant jobs finish; cron returns to legacy
# global iteration on the next tick.
```

## 9. Safety invariants the framework guarantees

- Concurrent `runForTenant` frames do NOT bleed (proven by harness
  case 2 + Node's `AsyncLocalStorage` semantics).
- `runForTenant` REFUSES UNSAFE_PRODUCTION even with
  `TENANT_AWARE_JOBS_ENABLED=true` (proven by harness case 7).
- `runForTenantBatch` failure of one tenant does NOT abort other
  tenants' execution.
- Retry payloads carry the SAME `tenantId` and `idempotencyKey`
  (proven by harness case 8).
- Idempotency keys are stable within a minute bucket (proven by
  case 9).

These properties are the contract a queue runner can rely on; they
are unit-tested by `saas:phase2-job-context-harness` (11/11 PASS today).

## 10. Daily monitoring checklist

- [ ] `tenant_jobs_total{ok=true}` rate matches expected per-tenant
      cron cadence × tenant count.
- [ ] `tenant_jobs_failures_total` rate < 1% of `tenant_jobs_total`.
- [ ] No `MissingSafeEnvError` log lines in any environment.
- [ ] `tenant_jobs_skipped_total{reason="invalid-tenant-id"}` is
      zero.
- [ ] `tenant_jobs_skipped_total{reason="duplicate-id"}` is zero.
- [ ] `tenant_jobs_retries_total{attempt=maxAttempts}` is zero (or
      paired with explicit dead-letter handling).
