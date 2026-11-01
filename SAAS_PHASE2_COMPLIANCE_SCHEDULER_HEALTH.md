# Phase 2.44 — Compliance Scheduler Health Signal

> Operator-visible structured log fingerprint emitted exactly once per
> scheduler tick. No external alerting provider invoked.

---

## 1. Where it lives

`ComplianceScheduler.summarizeHealth(result)` is a pure normalizer that
folds the existing `ScheduledRunResult` into a stable
`ScheduledHealthSummary` shape. The summary is attached to the result
(`result.health`) and emitted as a structured log line **inside**
`runScheduledComplianceAlertGeneration` immediately before return.

`ComplianceCron.tick()` is unchanged. It still calls only
`scheduler.runScheduledComplianceAlertGeneration()`. Source-level
meta-assertions in the harness keep it that way.

## 2. Health summary schema

```ts
interface ScheduledHealthSummary {
  job: 'compliance-alert-generation';
  status: 'skipped' | 'ok' | 'partial_failure' | 'failed';
  skipped: boolean;
  refused?: string;
  processed: number;
  succeeded: number;
  failed: number;
  alertsCreated: number;
  notifySucceeded: number;
  notifySkipped: number;
  notifyFailed: number;
  error?: string;
  cron: string;
  timestamp: string;     // ISO-8601
}
```

### Status rules

| Condition | `status` |
|---|---|
| scheduler-level synthetic error (`result.error` set) | `failed` |
| scheduler flag off OR upstream refusal (`skipped` OR `refused`) | `skipped` |
| `failed > 0` OR `notifyFailed > 0` | `partial_failure` |
| otherwise | `ok` |

`refused` is preserved on the summary. We deliberately collapse
"disabled" and "refused" into a single `skipped` status so external
log filters can match a single field for "this tick did no work".

## 3. Log fingerprint

The scheduler emits one log line per tick with the prefix
`compliance.scheduler.health` followed by a JSON-serialized summary:

```
compliance.scheduler.health {"job":"compliance-alert-generation","status":"ok",
  "skipped":false,"processed":2,"succeeded":2,"failed":0,
  "alertsCreated":2,"notifySucceeded":0,"notifySkipped":0,"notifyFailed":0,
  "cron":"0 */6 * * *","timestamp":"2026-05-10T15:25:19.899Z"}
```

External log aggregators (Loki / ELK / CloudWatch / Datadog) can match
on the prefix and parse the JSON tail. Suggested alert rules:

| Alert | Match |
|---|---|
| Compliance scheduler crashed | `status=failed` |
| Per-tenant scan failure | `failed > 0` |
| Notification fan-out failure | `notifyFailed > 0` |
| Any per-tick failure | `status=partial_failure OR status=failed` |

## 4. Sensitive-data policy

The summary contains **counts only** — no document/user names, no email
addresses, no payload data. The Phase 2.44 harness asserts the
emitted line does not contain any of:

`@x.test`, `@tempworks.test`, `firstName`, `email`, `PASSPORT`,
`document expires`.

This explicit allow-list is enforced because per-tenant `notify.error`
strings could in principle contain payload details. Today they do
not, but the harness check is a tripwire if a future phase changes
that.

## 5. Failure-path behavior

- **Per-tenant scan throws** → captured by the existing dispatch-loop
  try/catch; counted into `failed`. `status='partial_failure'` if any
  tenant succeeded; otherwise `'partial_failure'` with `succeeded=0`.
- **Notification fan-out throws** → captured by Phase 2.43's
  `maybeNotifyOnAlertGeneration` try/catch; counted into `notifyFailed`.
- **Dispatch helper throws** (synthetic / future refactor) → captured
  by `runScheduledComplianceAlertGeneration`'s try/catch; surfaces as
  `status='failed'` with `error` populated.
- **Health-emit throws** (logger-level) → swallowed; the cron tick
  never crashes because of health-signal emission.

## 6. Production safety

With every flag at default `false`:
- `runScheduledComplianceAlertGeneration` returns `{skipped: true}`.
- The summary is computed and a single
  `compliance.scheduler.health … status=skipped …` log line is emitted
  per tick.
- **Zero queries** run, **zero alerts** created, **zero notifications**
  fired.

The health log line itself is the only behavioural change vs. Phase
2.43. It carries no PII and has a stable prefix; it is safe to filter
out at log-shipping time if not desired.

## 7. Harness — 12/12 PASS

```
[compliance-scheduler-health] 12/12 PASS
```

1. scheduler disabled → `status='skipped'`, `processed=0`, `failed=0`
2. fan-out OFF → `status='skipped'` with `refused`
3. pilot inactive → `status='skipped'` with `refused`
4. happy path → `status='ok'`, `processed === active tenant count`
5. one tenant scan failure → `status='partial_failure'`, `failed=1`, no throw
6. notify fan-out error → `status='partial_failure'`, `notifyFailed=1`
7. scheduler-level synthetic error → `status='failed'`, no throw
8. health fingerprint emitted EXACTLY ONCE per tick
9. health log does NOT include sensitive payloads
10. ComplianceCron.tick still calls only `runScheduledComplianceAlertGeneration()`
11. ComplianceCron.tick does not call dispatch directly
12. ComplianceCron.tick does not call notification helpers

## 8. Rollback runbook

```sh
COMPLIANCE_ALERT_SCHEDULER_ENABLED=false   # cron tick is a no-op (status=skipped)
# OR
TENANT_JOB_FANOUT_ENABLED=false            # dispatch refuses
# OR
TENANT_PRISMA_PILOT_ENABLED=false          # pilot inactive
# OR
TENANT_PRISMA_PILOT_MODULES=               # remove 'compliance'
```

Even with all flags on, rolling back the health signal itself is a
log-filter change at the aggregator (drop `compliance.scheduler.health`
lines). The signal is non-destructive: no DB writes, no external
calls.

## 9. Future work

- **Per-tenant counts in the summary** — today the summary is
  whole-tenant aggregates. A future phase could add a
  `worstTenant` field (worst-failing tenant id) when
  `partial_failure` fires, with explicit PII-policy review.
- **Prometheus / metrics abstraction** — when the project adopts a
  metrics abstraction, `summarizeHealth` is the single place to add
  a counter (`scheduler.compliance.tenants_failed_total{status}`).
- **Alert rule templates** — codify the suggested log queries in a
  runbook once the operator's preferred aggregator is decided.

---

# Phase 2.45 addendum — `notifyDeduped` counter

The scheduler health summary now includes a `notifyDeduped` counter
that aggregates per-tenant `notify.deduped` values. A tick that
suppresses a duplicate notification reports `status='ok'` (no
failure) with `notifyDeduped > 0`. Operators can alert on
`notifyDeduped > 0` independently if dedup observability is desired.
See `SAAS_PHASE2_NOTIFICATIONS_DEDUP.md`.

---

# Phase 2.46 addendum — internal scans contribute to scheduler health when fan-out coupling is active

Internal `check*` scans are independent of the Phase 2.43 compliance
coupling — their dedup outcomes do NOT flow into the
`compliance.scheduler.health` log line because they are not invoked
from `generateAlertsForTenant`. The existing health summary already
covers the compliance pipeline correctly. No change to the schema.

If a future phase wires the internal scans behind the same
scheduler/cron, the dedup outcomes can flow into the health line
identically to the Phase 2.45 path.
