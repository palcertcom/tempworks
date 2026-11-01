# Phase 2.41 — Compliance Cron Framework

> Wires `@nestjs/schedule` for compliance alert generation. The cron
> handler is the single decorated entry-point and delegates to the
> Phase 2.40 `ComplianceScheduler` — never anything else.

---

## 1. Execution path

```
@Cron('0 */6 * * *')                       <-- src/compliance/compliance.cron.ts
  ComplianceCron.tick()
    -> ComplianceScheduler.runScheduledComplianceAlertGeneration()  <-- Phase 2.40
      -> ComplianceService.dispatchComplianceAlertGenerationForTenants()  <-- Phase 2.39
        -> ComplianceService.generateAlertsForTenant(tenantId)  <-- Phase 2.38
          -> ComplianceService.generateAlerts()  <-- inside an ALS frame
```

Forbidden in `compliance.cron.ts`:
- `dispatchComplianceAlertGenerationForTenants(...)` directly
- `generateAlertsForTenant(...)` directly
- `generateAlerts(...)` directly
- raw Prisma calls

The cron file delegates to `scheduler.runScheduledComplianceAlertGeneration()`
and nothing else. Source-level meta-assertions in the harness enforce
this.

## 2. Wiring

- `@nestjs/schedule@^4.0.0` added as a runtime dependency.
- `ScheduleModule.forRoot()` registered **once** in
  `src/app.module.ts`.
- `ComplianceCron` provider added to `ComplianceModule.providers`.
- Single `@Cron(CRON_EXPRESSION, { name: 'compliance-alert-generation' })`
  decorator on `ComplianceCron.tick()`.

## 3. Cron expression

`CRON_EXPRESSION` is read from `process.env.COMPLIANCE_ALERT_SCHEDULER_CRON`
at module-evaluation time, defaulting to `0 */6 * * *` (every six
hours).

`@Cron` requires a string at decoration time, so the cron expression
is fixed at process start. Changing it requires a restart. **This is
acceptable** — cron schedules are deployment-time controls. Runtime
enable/disable is handled at `COMPLIANCE_ALERT_SCHEDULER_ENABLED`,
which `ComplianceScheduler` honours per tick without restart.

## 4. Flag chain (unchanged from Phase 2.40)

| Layer | Flag | Default | Effect on cron tick |
|---|---|---|---|
| Scheduler | `COMPLIANCE_ALERT_SCHEDULER_ENABLED` | `false` | tick → no-op (skipped) |
| Fan-out | `TENANT_JOB_FANOUT_ENABLED` | `false` | tick → dispatch refuses |
| Pilot | `TENANT_PRISMA_PILOT_ENABLED` + `TENANT_PRISMA_PILOT_MODULES` | off | tick → dispatch refuses |
| Env | `classifyRuntimeEnv() ∈ {SAFE_CLONE, SAFE_STAGING}` | enforced | tick → dispatch refuses |

The cron decorator still fires on schedule, but every layer below is
a no-op until all four flags are explicitly on in a SAFE_CLONE /
SAFE_STAGING env.

## 5. Crash safety

`ComplianceCron.tick()` does not throw. Even if `ComplianceScheduler`
itself were to throw (it shouldn't — it captures dispatch errors as
`{ error }`), the host Nest scheduler would receive the rejection
and continue running on the next tick. The cron handler logs:

- `debug` when skipped
- `log` when dispatch refused
- `warn` when `result.error` is present
- `log` summary on success (`processed=N failed=M`)

## 6. Production safety

With every flag at default `false`:
- `ComplianceCron.tick()` calls
  `scheduler.runScheduledComplianceAlertGeneration()` which returns
  `{ skipped: true, reason: 'COMPLIANCE_ALERT_SCHEDULER_ENABLED=false' }`.
- **Zero queries** run on every tick.
- The `@Cron` decorator does fire on schedule — but the handler is a
  no-op until flags are on.

If the operator wants to fully prevent the decorator from firing,
they can either keep the scheduler flag off (cheap no-op every six
hours) or set `TENANT_PRISMA_PILOT_ENABLED=false` to block at the
dispatch layer.

## 7. Harness — 14/14 PASS

```
[compliance-cron-framework] 14/14 PASS
```

Source-level (1-7):
1. `ComplianceCron` wired into `ComplianceModule.providers`.
2. exactly one `@Cron(...)` entry-point in `compliance.cron.ts`.
3. cron body calls `runScheduledComplianceAlertGeneration()`.
4. cron body never calls `dispatchComplianceAlertGenerationForTenants(...)` directly.
5. cron body never calls `generateAlerts()`.
6. cron body never calls `generateAlertsForTenant(...)`.
7. `ScheduleModule.forRoot()` registered **exactly once** in `app.module.ts`.

Runtime (8-14):
8. scheduler disabled: cron tick is a no-op.
9. scheduler ON + fan-out OFF: dispatch refuses; zero scans.
10. scheduler + fan-out ON + pilot OFF: dispatch refuses.
11-13. happy path: ACTIVE tenants only, no NULL-tenant alerts, no cross-tenant alerts.
14. concurrent ticks remain ALS-isolated.

## 8. Rollback runbook

```sh
COMPLIANCE_ALERT_SCHEDULER_ENABLED=false   # cron tick is a no-op
# OR
TENANT_JOB_FANOUT_ENABLED=false            # dispatch refuses
# OR
TENANT_PRISMA_PILOT_ENABLED=false          # pilot inactive
# OR
TENANT_PRISMA_PILOT_MODULES=               # remove 'compliance'
```

No data, no schema migration introduced. Configuration-only rollback.

## 9. Future work

- **Operator-visible escalation**: emit a structured alert when a
  tick reports `failed > 0` so per-tenant failures don't sit only
  in logs.
- **Per-tenant skip list**: a future flag could pause the scan for
  specific tenants without disabling the whole pipeline.
- **Multi-cron scheduling**: today only one decorated entry-point
  exists. If notifications or other modules need their own cron, they
  follow this same scheduler-helper-dispatch pattern.
