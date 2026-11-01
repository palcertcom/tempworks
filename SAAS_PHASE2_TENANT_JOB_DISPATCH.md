# Phase 2.39 — Tenant-Aware Job Dispatch (Compliance)

> The only supported path for any background scheduler to invoke
> compliance alert generation across multiple tenants.

---

## 1. Contract

```ts
ComplianceService.dispatchComplianceAlertGenerationForTenants(): Promise<{
  refused?: string;
  processed: number;
  results: Array<{
    tenantId: string;
    ok: boolean;
    total?: number;
    message?: string;
    error?: string;
  }>;
}>
```

- **One tenant per scan**, enforced internally by calling
  `generateAlertsForTenant(tenantId)` once per tenant.
- Schedulers MUST NOT call `generateAlerts()` directly. The Phase 2.39
  isolation harness performs a source-level meta-assertion that the
  dispatch body does not contain `this.generateAlerts(`.

## 2. Refusal contract

The dispatch refuses (returns `{refused, processed: 0, results: []}`)
when ANY of the following is true:

| Condition | `refused` value |
|---|---|
| `TENANT_JOB_FANOUT_ENABLED=false` (default) | `'TENANT_JOB_FANOUT_ENABLED=false'` |
| Pilot inactive (flag off OR env not SAFE_CLONE/SAFE_STAGING) | `'pilot inactive: <reason>'` |
| Env not SAFE_CLONE/SAFE_STAGING | `'env is not SAFE_CLONE/SAFE_STAGING'` |

When the dispatch refuses, **zero tenant scans run** and **zero
alerts are created**.

## 3. Tenant enumeration

```ts
this.legacyPrisma.tenant.findMany({
  where:   { status: 'ACTIVE' },
  select:  { id: true },
  orderBy: { slug: 'asc' },
});
```

- ACTIVE tenants only. Suspended / inactive tenants are skipped.
- The `Tenant` table is global-scope; the legacy client is the right
  surface here. The `tenantId` is then attached to each per-tenant
  scan via `generateAlertsForTenant`.
- No platform / system-tenant exclusion is applied yet — the
  fixture has no system tenants. A future phase that introduces
  platform-only tenants must extend the `where` clause.

## 4. Per-tenant fault isolation

```ts
for (const t of tenants) {
  try {
    const r = await this.generateAlertsForTenant(t.id);
    results.push({ tenantId: t.id, ok: true, total: r.total, message: r.message });
  } catch (e: any) {
    this.logger.warn(`[fan-out] tenant=${t.id} failed: ${e?.message ?? e}`);
    results.push({ tenantId: t.id, ok: false, error: String(e?.message ?? e) });
  }
}
```

One tenant's failure is captured as `{ ok: false, error }`. The loop
continues so the remaining tenants are still processed. ALS isolation
is provided by `generateAlertsForTenant` itself — every call wraps
`withRequestContext({ requestId: newRequestId() })`.

## 5. No fan-out helper for "all tenants ignoring filters"

Phase 2.39 deliberately does NOT provide a "scan everything regardless
of tenant" helper. The shape is:

- enumerate ACTIVE tenants,
- call `generateAlertsForTenant(tenantId)` per tenant.

Any future requirement to scan a wider or narrower set must be
encoded via the tenant `status` filter, not via a new bypass entry
point.

## 6. No real scheduler is wired

Phase 2.39 ships the tenant fan-out helper and proves it via the
harness. **No cron / Bull / queue is wired**.

When a future phase wires a real scheduler:

1. The schedule MUST call only `dispatchComplianceAlertGenerationForTenants()`.
2. The schedule MUST NOT call `generateAlerts()` or `generateAlertsForTenant()`
   directly.
3. The schedule MUST be disabled by default (`TENANT_JOB_FANOUT_ENABLED=false`)
   and require explicit operator flip to engage.

## 7. Harness — 9/9 PASS

```
[compliance-tenant-job-dispatch] 9/9 PASS
```

1. fan-out refused when `TENANT_JOB_FANOUT_ENABLED=false`
2. fan-out refused when `TENANT_PRISMA_PILOT_ENABLED=false`
3. compliance not in allow-list: dispatch is safe (no new alerts)
4. fan-out enumerates only ACTIVE tenants
5. each per-tenant scan ran inside its own ALS frame
6. dispatch creates no NULL-tenant or cross-tenant alerts
7. one tenant's failure does not abort loop or leak (synthetic-fail injection)
8. **source-level**: dispatch body never calls raw `generateAlerts()`
9. concurrent dispatches remain ALS-isolated

## 8. Production safety

With every flag at its default `false`:
- `TENANT_JOB_FANOUT_ENABLED=false` → dispatch refuses immediately.
- `TENANT_PRISMA_PILOT_ENABLED=false` → dispatch refuses immediately.

No tenant scan, no alert creation, no DB write. Production behaviour
is byte-identical to Phase 2.38.

## 9. Rollback runbook

```sh
TENANT_JOB_FANOUT_ENABLED=false
# OR
TENANT_PRISMA_PILOT_ENABLED=false
# OR
TENANT_PRISMA_PILOT_MODULES=    # remove 'compliance'
```

No data, no schema migration introduced. Configuration-only
rollback.

## 10. Remaining blockers

- **Scheduler wiring**: a Bull / cron schedule must be wired in a
  future phase. The strict contract (only call the dispatch helper)
  is documented above.
- **System / platform tenants**: when these are introduced, the
  tenant enumeration must filter them out.
- **Failure escalation**: one-tenant failures are recorded but not
  alerted. A future phase may emit an operator-visible signal when
  any per-tenant scan fails.

---

## Phase 2.40 update — scheduler wired

`ComplianceScheduler.runScheduledComplianceAlertGeneration()` now
provides the disabled-by-default scheduler entry-point. It calls only
`dispatchComplianceAlertGenerationForTenants()`. See
`SAAS_PHASE2_COMPLIANCE_REAL_SCHEDULER.md`.

---

## Phase 2.41 update — cron framework wired

`@nestjs/schedule` is now wired. The cron entrypoint calls only
`ComplianceScheduler.runScheduledComplianceAlertGeneration()`. The
dispatch helper continues to be the only path that enumerates
tenants. See `SAAS_PHASE2_COMPLIANCE_CRON_FRAMEWORK.md`.

---

## Phase 2.43 update — optional notifications coupling consumer

The per-tenant `generateAlertsForTenant` path now optionally invokes
`NotificationsService.notifyUsersByRoles` AFTER the scan completes,
INSIDE the same ALS frame. Default off
(`COMPLIANCE_NOTIFY_ON_ALERT=false`). Dispatch helper unchanged.
See `SAAS_PHASE2_COMPLIANCE_NOTIFICATION_COUPLING.md`.

---

## Phase 2.44 update — per-tenant notify forwarded into dispatch result

The dispatch result type now optionally includes a per-tenant
`notify` field forwarded from `generateAlertsForTenant`. The
scheduler's `summarizeHealth(result)` folds these into
`notifySucceeded` / `notifySkipped` / `notifyFailed` counters in the
operator-visible health log. See
`SAAS_PHASE2_COMPLIANCE_SCHEDULER_HEALTH.md`.
