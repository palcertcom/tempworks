# Phase 2.15 — Notifications Fanout Caller Contract

> A bell sent to one tenant must not echo in another hallway.
>
> Defines what callers of `notifyUploaderAndRoles` and `notifyUsersByRoles`
> can rely on, and what they must provide, in legacy vs. tenant-aware
> mode.

---

## 1. Signatures (unchanged)

```ts
notifyUploaderAndRoles(
  uploaderId: string,
  roles: string[],
  eventKey: NotifEventKey,
  title: string, message: string,
  relatedEntity?: string, relatedEntityId?: string,
  i18n?: { titleKey?, messageKey?, params? },
): Promise<void>

notifyUsersByRoles(
  roles: string[],
  eventKey: NotifEventKey,
  title: string, message: string,
  relatedEntity?: string, relatedEntityId?: string,
  i18n?: { titleKey?, messageKey?, params? },
): Promise<void>
```

The signatures are byte-identical to pre-Phase-2.15. Callers do NOT
need to start passing `tenantId` — the writers read it from the ALS
frame.

## 2. Legacy caller behaviour (production default)

When `TENANT_AWARE_JOBS_ENABLED=false` OR `TENANT_JOB_FANOUT_ENABLED=false`
OR env is not SAFE_CLONE/SAFE_STAGING:

- Writers iterate `User.findMany({ role: { name: { in: roles } } })`
  globally.
- Notifications are created with `tenantId = NULL`.
- Uploader id is added without validation.
- `assertTenantForFanout` is a no-op (returns immediately).
- ALS is NOT required.

This matches every release prior to Phase 2.15. Legacy callers (HTTP
handlers, scheduled tasks, manual triggers) need no changes.

## 3. Tenant-aware caller requirements (staging only)

When all three are true:
- `TENANT_AWARE_JOBS_ENABLED=true`,
- `TENANT_JOB_FANOUT_ENABLED=true`,
- env classifies as SAFE_CLONE / SAFE_STAGING,

then the writers REQUIRE a tenant in the active ALS frame. Callers
fall into three categories:

### 3.1 HTTP request handlers

Already wrapped by the request middleware (`TenantContextMiddleware`).
The middleware resolves the tenant from the `X-Tenant-Id` header /
host / membership and attaches it via `TenantContext.attach(...)`.
**No caller-side change needed.**

### 3.2 Background jobs (Phase 2.13 framework users)

A background job that wants to emit a notification fanout must run
its body inside `runForTenant(tenantId, fn)` from
`@/saas/jobs`. Inside the frame, `TenantContext.optional()` returns
the tenant; the writers read from there.

```ts
// Inside a queue runner / cron orchestrator:
await runForTenant(payload.tenantId, async () => {
  await notificationsService.notifyUsersByRoles(['Compliance Officer'],
    'document.expired', title, message, 'Document', docId);
});
```

### 3.3 Direct internal callers

Code that crosses HTTP and background contexts (rare) should use
`withRequestContext({ requestId })` + `TenantContext.attach(...)`
explicitly. The Phase 2.13 framework's `runForTenant` is the
preferred entry point.

## 4. What happens with no tenant context

In **tenant-aware mode**:

```ts
await notificationsService.notifyUsersByRoles(['HR Manager'], ...);
// Throws MissingTenantContextError('notifications.notifyUsersByRoles')
```

`assertTenantForFanout('notifyUsersByRoles')` raises before any DB
query. The exception bubbles up to the caller — the queue runner /
HTTP middleware logs it and the operation aborts. No partial fanout.

In **legacy mode**: identical behaviour to pre-Phase-2.15. No new
error path engages.

## 5. How future modules should call fanout writers

If your module emits notifications:

1. **Always run inside an ALS frame** — either via the HTTP request
   middleware or `runForTenant` for background work.
2. **Never pass a `uploaderId` from another tenant.** The writer
   silently drops cross-tenant uploaders in tenant-aware mode (legacy
   mode keeps the row).
3. **Don't mix HTTP and background callers** in the same code path
   without making the tenant context explicit.
4. **Use `eventKey` from the registry.** Falls back to `'INFO'` for
   unknown keys; the writer never throws on bad event keys.

## 6. How background jobs should call fanout writers

The job-context framework (Phase 2.13) is the canonical path:

```ts
import { runForTenant, TenantJobFanoutPlanner } from '@/saas/jobs';

const planner = new TenantJobFanoutPlanner();
const plan = planner.plan('module.event', candidates, () => ({}));

for (const t of plan.tenants) {
  await runForTenant(t.tenantId, async () => {
    await notificationsService.notifyUsersByRoles(...);
  });
}
```

For batch fanouts, prefer `runForTenantBatch(...)` which provides
bounded concurrency, per-tenant timeouts, and structured failure
isolation (one tenant's error does not abort others).

## 7. How direct HTTP requests should call fanout writers

No change. The request middleware already attaches a tenant. The
writer reads from ALS automatically.

```ts
// Inside a controller/service called from an HTTP handler:
await notificationsService.notifyUploaderAndRoles(
  req.user.id, ['Compliance Officer'], 'document.expired',
  title, message, 'Document', docId);
// Tenant comes from middleware-attached ALS.
```

## 8. Error handling expectations

| Scenario | Mode | Behaviour |
|---|---|---|
| Caller in HTTP middleware, tenant present | tenant-aware | normal fanout, scoped to tenant |
| Caller in HTTP middleware, tenant present | legacy | normal fanout, global |
| Caller without ALS tenant | tenant-aware | `MissingTenantContextError` |
| Caller without ALS tenant | legacy | normal global fanout |
| `uploaderId` from another tenant | tenant-aware | silently dropped from recipient list |
| `uploaderId` from another tenant | legacy | included in recipient list |
| Empty `roles[]` | both | only the uploader (if any) receives |
| Unknown `eventKey` | both | falls back to `'INFO'` type |
| DB error during fanout | both | exception bubbles up (no retry, no partial completion guarantees) |
| Per-recipient `notification.create` fails | both | exception bubbles up; recipients prior to the failure already have rows |

The writer is NOT idempotent and does NOT guard against partial
fanout failure mid-loop. This matches pre-2.15 semantics. A future
phase may add per-recipient try/catch + dead-letter handling.

## 9. Operator runbook (rollback)

```sh
# To halt new tenant-aware fanouts:
export TENANT_JOB_FANOUT_ENABLED=false
# Existing in-flight fanouts complete; new ones use legacy iteration.

# To halt the framework entirely:
export TENANT_AWARE_JOBS_ENABLED=false
# `narrowingTenantId()` returns null everywhere; spreads collapse to
# `{}`; writers behave identically to pre-2.15.
```

No DB state introduced; rollback is purely configuration. The Phase
2.15 fanout-writer narrowing is a **same-process** change — there is
no queue, no migration, nothing to clean up.
