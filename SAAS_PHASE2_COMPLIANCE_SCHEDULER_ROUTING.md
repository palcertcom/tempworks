# Phase 2.38 — Compliance Scheduler Routing + Audit Pilot

> Closes the two gaps Phase 2.37 left open: route `updateAlert`
> audit emission through the shared `TenantAuditLogService`, and add
> a gated, per-tenant scheduler-safe entrypoint for
> `generateAlerts()`.

---

## 1. What changed

| Surface | Change |
|---|---|
| `src/compliance/compliance.service.ts` | Constructor injects `TenantAuditLogService`; `updateAlert` audit retagged from `phase28-audit-log` to `phase238-audit-log-pilot`; new `generateAlertsForTenant(tenantId)` entrypoint |
| `src/compliance/compliance.module.ts` | Imports `TenantAuditLogModule` |
| `scripts/scan-annotations.ts` | New tags `phase238-audit-log-pilot`, `phase238-scheduler-routing` (allowed in `src/compliance/`) |
| `scripts/saas/phase2/compliance-{equivalence,isolation}.ts` | Constructor signature update (TenantAuditLogService injected) |
| `scripts/saas/phase2/compliance-audit-and-scheduler.ts` | NEW 9-case harness |
| `package.json` | New script `saas:phase238-compliance-audit-and-scheduler` |

## 2. Audit routing

### 2.1 Before (Phase 2.8)

```ts
await this.legacyPrisma.auditLog.create({  // phase28-audit-log
  data: { userId, action: 'UPDATE_ALERT', entity: 'ComplianceAlert',
          entityId: id, changes: dto },
});
```

### 2.2 After (Phase 2.38)

```ts
// @tenant-reviewed: phase238-audit-log-pilot
await this.tenantAuditLog.write({
  userId, action: 'UPDATE_ALERT', entity: 'ComplianceAlert',
  entityId: id, changes: dto,
});
```

`TenantAuditLogService.write` (Phase 2.30) writes `tenantId` only
when `TENANT_AUDIT_LOG_PILOT_ENABLED=true` AND an ALS tenant frame
is present. With either condition false, the audit row is created
with `tenantId = NULL` — byte-identical to pre-2.38. The helper is
fire-and-forget by contract; failures are logged at warn level and
swallowed so `updateAlert` never fails because of an audit-write
error.

## 3. Scheduler-safe entrypoint

### 3.1 Why

`generateAlerts()` reads ALS for tenant attribution. Calling it from
a background scheduler without first attaching an ALS frame is
unsafe:

- the pilot scope reports inactive ⇒ scan filter is `{}` ⇒ scan
  collects rows from every tenant,
- the create spreads `{}` ⇒ the new alert is NULL-tenant.

### 3.2 What

`generateAlertsForTenant(tenantId: string)` is a gated entrypoint:

1. Refuses to run unless the runtime env classifies as
   SAFE_CLONE / SAFE_STAGING.
2. Refuses to run unless the pilot is active for the `compliance`
   module (`pilot.isPilotActive()`).
3. Wraps the existing `generateAlerts()` call in
   `withRequestContext({ requestId: newRequestId() }, …)` and
   `TenantContext.attach({ id: tenantId, … })`. Concurrent calls run
   in distinct ALS frames.
4. Returns `{ message, total, tenantId }` so the caller can confirm
   which tenant was processed.

### 3.3 What this phase does NOT do

- **No fan-out helper.** A scheduler that wants to scan every tenant
  must enumerate tenant ids (via the `Tenant` table) and call
  `generateAlertsForTenant` per tenant. That decision is product-side
  and out of scope this phase.
- **No scheduler wiring.** No Bull/cron schedule is added. The
  entrypoint is the **contract** for any future scheduler.
- **No cross-tenant batch.** A single call processes exactly one
  tenant.

## 4. Production safety with flags OFF

`generateAlertsForTenant` short-circuits and returns
`{ message: 'refused: …', total: 0 }` whenever the pilot is off or
the env is unsafe. The standard `generateAlerts()` and
`updateAlert` paths are byte-identical to pre-2.38: with flags off
`tenantWhere()` returns `{}`, `tenantData()` returns `{}`, and the
audit helper writes a NULL-tenant row.

## 5. Rollback

```sh
TENANT_PRISMA_PILOT_ENABLED=false
# OR
TENANT_PRISMA_PILOT_MODULES=    # remove 'compliance'
# OR (audit only)
TENANT_AUDIT_LOG_PILOT_ENABLED=false
```

No data, no schema migration introduced. Configuration-only
rollback.

## 6. Future work

- Scheduled invocation: a future phase wires `generateAlertsForTenant`
  to a cron / Bull schedule. The schedule MUST enumerate tenants and
  call this method per tenant. The strict "one tenant per call" shape
  is intentional — it prevents the scheduler from accidentally running
  globally if the ALS frame attach fails.
- Audit emission for additional compliance methods (e.g. when alert
  resolution gains its own audit event) follows the same routing.
- Notification fan-out continues to live in the `notifications`
  module pilot.

## 7. Annotation tag policy

| Tag | Purpose | Allowed paths | Phase |
|---|---|---|---|
| `phase238-audit-log-pilot` | Compliance audit emission delegated to `TenantAuditLogService` | `src/compliance/**` | 2.38 |
| `phase238-scheduler-routing` | Compliance scheduler-safe entrypoint (`generateAlertsForTenant`) | `src/compliance/**` | 2.38 |

---

# Phase 2.39 addendum — tenant-aware job dispatch

Phase 2.39 adds the gated, per-tenant fan-out helper:

```ts
ComplianceService.dispatchComplianceAlertGenerationForTenants()
```

See `SAAS_PHASE2_TENANT_JOB_DISPATCH.md` for the full contract.

Key invariants:
- Default `TENANT_JOB_FANOUT_ENABLED=false` — dispatch refuses.
- Pilot must be active for `compliance` — dispatch refuses otherwise.
- Enumerates only ACTIVE tenants from the `Tenant` table.
- Calls `generateAlertsForTenant(tenantId)` once per tenant. Source-level
  meta-assertion proves the dispatch body never calls raw
  `generateAlerts()`.
- Per-tenant fault isolation: one failure recorded as
  `{ ok: false, error }`; the loop continues.
- **No real scheduler is wired**. Future schedulers MUST call the
  dispatch helper and nothing else.

New harness: `compliance-tenant-job-dispatch` — 9/9 PASS.

---

# Phase 2.40 addendum — real scheduler entry-point

`ComplianceScheduler.runScheduledComplianceAlertGeneration()` is now
the **only** entry-point a future cron / Bull / queue handler is
allowed to call. See `SAAS_PHASE2_COMPLIANCE_REAL_SCHEDULER.md` for
the full contract.

Key invariants:
- Disabled by default (`COMPLIANCE_ALERT_SCHEDULER_ENABLED=false`).
- Calls only `dispatchComplianceAlertGenerationForTenants()`. Source-level
  meta-assertion proves the scheduler body never calls
  `generateAlerts()` or `generateAlertsForTenant()` directly.
- Returns a structured result; never throws. Unexpected dispatch
  failures are captured as `{ error }`.
- Configurable cron via `COMPLIANCE_ALERT_SCHEDULER_CRON` (default
  `0 [slash]6 [star] [star] [star]`). Informational only — no cron
  framework is wired this phase.

New harness: `compliance-real-scheduler` — 11/11 PASS.

---

# Phase 2.41 addendum — cron framework wired

`@nestjs/schedule` is now wired. `ComplianceCron.tick()` is the single
decorated entry-point. It calls only
`ComplianceScheduler.runScheduledComplianceAlertGeneration()`. Source-
level meta-assertions enforce this. See
`SAAS_PHASE2_COMPLIANCE_CRON_FRAMEWORK.md`.

---

# Phase 2.43 addendum — optional notifications coupling

`generateAlertsForTenant` now calls
`maybeNotifyOnAlertGeneration(total)` AFTER `generateAlerts()`
returns, INSIDE the same per-tenant ALS frame. The helper is
default-off (`COMPLIANCE_NOTIFY_ON_ALERT=false`) and respects every
existing fan-out gate. See
`SAAS_PHASE2_COMPLIANCE_NOTIFICATION_COUPLING.md`.
