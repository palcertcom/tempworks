# Phase 2.40 — Compliance Real Scheduler

> Wires a real, **disabled-by-default** schedule entry-point for the
> Phase 2.39 fan-out helper.

---

## 1. Contract

```ts
ComplianceScheduler.runScheduledComplianceAlertGeneration(): Promise<{
  skipped: boolean;
  reason?: string;          // when skipped=true
  refused?: string;         // forwarded from dispatch
  processed: number;
  results: Array<{ tenantId; ok; total?; message?; error? }>;
  cron?: string;            // configured COMPLIANCE_ALERT_SCHEDULER_CRON
  error?: string;           // unexpected dispatch failure
}>
```

The scheduler entrypoint is **the only path** any future cron / Bull /
queue handler is allowed to call. The scheduler body itself only ever
calls `dispatchComplianceAlertGenerationForTenants()` — proved by a
source-level meta-assertion in the harness.

## 2. Flag chain

| Layer | Flag | Default | Effect when off |
|---|---|---|---|
| Scheduler | `COMPLIANCE_ALERT_SCHEDULER_ENABLED` | `false` | Returns `{skipped: true, reason: 'COMPLIANCE_ALERT_SCHEDULER_ENABLED=false'}`. Zero dispatch calls. |
| Fan-out | `TENANT_JOB_FANOUT_ENABLED` | `false` | Dispatch helper refuses. Zero tenant scans. |
| Pilot | `TENANT_PRISMA_PILOT_ENABLED` + `TENANT_PRISMA_PILOT_MODULES` | off / unset | Dispatch refuses (pilot inactive). |
| Env | `classifyRuntimeEnv() ∈ {SAFE_CLONE, SAFE_STAGING}` | enforced at runtime | Dispatch refuses. |

**Turning on `COMPLIANCE_ALERT_SCHEDULER_ENABLED` alone is not enough
to scan any tenant.** All four layers must be on.

`COMPLIANCE_ALERT_SCHEDULER_CRON` (default `0 [slash]6 [star] [star]
[star]`) is read by `ComplianceScheduler.cron()` and returned in the
result for any future scheduler that needs to know what schedule it
was supposed to run on. **No cron framework is wired in this phase.**

## 3. Scheduler design choice

The project has no `@nestjs/schedule` dependency. Adding one for a
disabled-by-default endpoint is unjustified, so Phase 2.40 ships a
**lightweight provider** (`ComplianceScheduler`) with a single
explicitly callable handler:

```ts
runScheduledComplianceAlertGeneration()
```

A future cron framework only needs to register a single decorated
method that delegates to this handler — no other compliance code
needs to change.

## 4. Source-level invariants (enforced by the harness)

After stripping JSDoc/comments, the executable body of
`compliance.scheduler.ts` matches:

- `\.dispatchComplianceAlertGenerationForTenants\(\)` — present.
- `\.generateAlerts\(\)` — **NOT** present.
- `\.generateAlertsForTenant\(` — **NOT** present.

## 5. Production safety

With every flag at default `false`:
- `runScheduledComplianceAlertGeneration()` returns
  `{skipped: true, reason: 'COMPLIANCE_ALERT_SCHEDULER_ENABLED=false', processed: 0, results: []}`.
- **Zero queries** run.

Even if `COMPLIANCE_ALERT_SCHEDULER_ENABLED=true` is flipped:
- The dispatch helper still refuses unless `TENANT_JOB_FANOUT_ENABLED=true`.
- The dispatch helper still refuses unless the compliance pilot is
  active in a SAFE_CLONE / SAFE_STAGING env.

## 6. Rollback runbook

```sh
COMPLIANCE_ALERT_SCHEDULER_ENABLED=false
# OR
TENANT_JOB_FANOUT_ENABLED=false
# OR
TENANT_PRISMA_PILOT_ENABLED=false
# OR
TENANT_PRISMA_PILOT_MODULES=    # remove 'compliance'
```

No data, no schema migration introduced. Configuration-only rollback.

## 7. Harness — 11/11 PASS

```
[compliance-real-scheduler] 11/11 PASS
```

1. scheduler disabled: skipped result, **zero** dispatch calls
2. scheduler ON + fan-out OFF: dispatch refuses
3. scheduler + fan-out ON + pilot OFF: dispatch refuses
4. scheduler + fan-out + pilot active: processes ACTIVE tenants only
5. scheduler creates no NULL-tenant alerts
6. scheduler creates no cross-tenant alerts
7. **source-level**: scheduler body never calls raw `generateAlerts()`
8. **source-level**: scheduler body never calls `generateAlertsForTenant()` directly
9. exactly one dispatch call per tick
10. concurrent ticks remain ALS-isolated
11. unexpected dispatch failure captured (no crash)

## 8. Future work

- **Wire a real cron framework**: when `@nestjs/schedule` is added,
  register exactly one `@Cron(scheduler.cron())` method that calls
  `await scheduler.runScheduledComplianceAlertGeneration()`. No
  other compliance code should change.
- **Operator-visible failure escalation**: per-tenant failures inside
  `result.results` are not yet alerted. A future phase should emit
  a structured signal when any per-tenant scan fails.
- **Platform / system-tenant filter**: when system tenants are
  introduced, the dispatch helper's `tenant.findMany` filter must
  exclude them.

---

# Phase 2.41 addendum — cron framework wired

Phase 2.41 wires `@nestjs/schedule` and adds a single decorated
entry-point at `src/compliance/compliance.cron.ts`. The decorator
delegates to `ComplianceScheduler.runScheduledComplianceAlertGeneration()`
and nothing else. See `SAAS_PHASE2_COMPLIANCE_CRON_FRAMEWORK.md`.

Source-level invariants:
- exactly one `@Cron(...)` decorator in compliance code
- cron body never calls `generateAlerts()`,
  `generateAlertsForTenant()`, or
  `dispatchComplianceAlertGenerationForTenants()` directly
- `ScheduleModule.forRoot()` registered exactly once in `app.module.ts`

New harness: `compliance-cron-framework` — 14/14 PASS.

---

# Phase 2.44 addendum — health summary attached to ScheduledRunResult

Phase 2.44 adds a `health: ScheduledHealthSummary` field to
`ScheduledRunResult`. The summary is computed by
`ComplianceScheduler.summarizeHealth(result)` and emitted once per
tick as a structured `compliance.scheduler.health` log line.
See `SAAS_PHASE2_COMPLIANCE_SCHEDULER_HEALTH.md`.

`ComplianceCron.tick()` is unchanged. The cron handler still calls
only `scheduler.runScheduledComplianceAlertGeneration()`.
