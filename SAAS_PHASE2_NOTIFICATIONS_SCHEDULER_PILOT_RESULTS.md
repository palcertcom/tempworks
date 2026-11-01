# Phase 2.14 — Notifications Scheduler Pilot Results

> Let the clocktower ring per tenant, but only in the rehearsal hall.
>
> Result of adapting the notifications scheduler / fanout writers to
> the Phase 2.13 job-context framework. Production stays on the legacy
> path; tenant-aware behaviour is gated behind two flags + safe-env
> classifier.

---

## 1. Headline

```
build:                                              ✅
prisma validate:                                    ✅
saas:validate (6 suites):                           ✅
saas:schema-lint:                                    ✅
saas:phase2-notifications-scheduler-harness:        9/9  cases PASS
saas:phase2-notifications-equivalence (regression):11/11 cases PASS
saas:phase2-notifications-isolation   (regression): 8/8  cases PASS
saas:phase2-job-context-harness       (regression):11/11 cases PASS
saas:phase2-pilot-regression          (regression):12/12 cases PASS
saas:scan:                                          576 unreviewed
saas:scan:annotations:                              0 findings
saas:scan:raw-sql:                                  baseline unchanged
production defaults:                                all OFF
```

## 2. What was tested

### Scheduler harness (9/9 PASS)

1. flags OFF → scheduler invokes legacy `runAllChecks`.
2. flags ON in SAFE_CLONE → scheduler invokes
   `runAllChecksTenantAware`.
3. fanout planner: 1 ACTIVE non-system selected; 1 system + 1
   inactive skipped with documented reasons.
4. `runForTenant` smoke: ALS frame carries `tenantId` for the
   per-tenant entry point.
5. (combined into 3 above)
6. tenant-aware ON: `notifyUploaderAndRoles` without ALS tenant
   raises `MissingTenantContextError`.
7. tenant-aware ON: `notifyUsersByRoles` without ALS tenant
   raises `MissingTenantContextError`.
8. flags OFF: `notifyUsersByRoles` does NOT raise the new
   `MissingTenantContextError` (legacy contract preserved).
9. flags ON outside staging: scheduler stays on legacy path
   (env classifier refuses tenant-aware).
10. cron timing constant unchanged (`6 * 60 * 60 * 1000`).

### Regressions (no change)

- Notifications equivalence + isolation: 11/11 + 8/8 PASS. The
  meta-assertion (case 8 in isolation) still confirms the four
  `check*` methods source `legacyPrisma.user.findMany`.
- Pilot regression suite: 12/12 PASS across all six pilot modules.
- Job-context harness: 11/11 PASS.

## 3. Scheduler paths adapted

| Path | Before | After | Annotation |
|------|--------|-------|------------|
| `NotificationsSchedulerService.runOnce` | calls `runAllChecks` | flag-aware: `runAllChecksTenantAware` when both flags on + staging, else `runAllChecks` | (no prisma) |
| `NotificationsService.runAllChecksTenantAware` | did not exist | discovers tenants → planner → batch | `phase214-pilot-scope` |
| `NotificationsService.runAllChecksForTenant(tid)` | did not exist | per-tenant entry inside ALS frame | (no prisma) |
| `notifyUploaderAndRoles` | always created notifications | refuses without ALS tenant in tenant-aware mode | unchanged (legacy path on legacyPrisma) |
| `notifyUsersByRoles` | same | same | unchanged |

## 4. Paths still excluded

The four `check*` methods (`checkExpiringCompliance`, `checkServiceDue`,
`checkOverdue`, `checkScheduledMaintenance`) are STILL on
`legacyPrisma` and still iterate `User` across all tenants. They're
called inside the per-tenant ALS frame by `runAllChecksForTenant`,
but their internal scans haven't been narrowed. Annotations remain
`phase210-excluded-background` until Phase 2.14.1.

The legacy `runAllChecks` is intentionally preserved as the fallback
path. It is the active code path in production.

## 5. Fanout contract changes

`assertTenantForFanout(method)` enforces:

- When `TENANT_AWARE_JOBS_ENABLED && TENANT_JOB_FANOUT_ENABLED &&
  staging`: `notifyUploaderAndRoles` and `notifyUsersByRoles` REQUIRE
  a tenant in ALS. Calling them without raises
  `MissingTenantContextError(<method>)`.
- When any of those conditions is false: behaviour is byte-identical
  to pre-Phase-2.14. The new guard short-circuits before doing
  anything observable.

Caller contract update:

- HTTP handlers that call these writers must have the request
  middleware attached (already true in production).
- Background callers (e.g. document upload notifying compliance
  officers via cron) MUST run inside `runForTenant` before invoking
  the writer. Phase 2.14 doesn't change any such caller because no
  current background path calls these writers.

## 6. Scanner delta

- `saas:scan` unchanged at 576 unreviewed.
  - +1 new annotated site (`phase214-pilot-scope` on tenant-catalog
    findMany).
  - 0 change to existing pilot annotations.
- `saas:scan:annotations` 0 findings — every annotation policy-
  compliant after adding `phase214-pilot-scope` to `KNOWN_REASONS`
  and `SAAS_PHASE2_SCANNER_ANNOTATION_POLICY.md`.
- `saas:scan:raw-sql` baseline unchanged.

## 7. Validation results

| Check | Result |
|---|---|
| `nest build` | ✅ |
| `npx prisma validate` | ✅ |
| `npm run saas:validate` | ✅ (6/6) |
| `npm run saas:schema-lint` | ✅ (0) |
| `npm run saas:phase2-notifications-scheduler-harness` | ✅ (9/9) |
| `npm run saas:phase2-notifications-equivalence` | ✅ (11/11) |
| `npm run saas:phase2-notifications-isolation` | ✅ (8/8) |
| `npm run saas:phase2-job-context-harness` | ✅ (11/11) |
| `npm run saas:phase2-pilot-regression` | ✅ (12/12) |
| `npm run saas:scan` | ✅ (576) |
| `npm run saas:scan:annotations` | ✅ (0 findings) |
| `npm run saas:scan:raw-sql` | ✅ (baseline) |

## 8. Production behaviour change status

**Unchanged.** With `TENANT_AWARE_JOBS_ENABLED=false` (default) AND
`TENANT_JOB_FANOUT_ENABLED=false` (default), the scheduler picks the
legacy `runAllChecks` path on every cron tick. Fanout writers behave
byte-identically. Cron timing is the same. The only new code path
that runs in production is the dispatcher's flag check, which short-
circuits to legacy in three lines.

## 9. Rollback behaviour

```sh
# To halt tenant-aware fanout entirely:
export TENANT_JOB_FANOUT_ENABLED=false
# Existing ALS frames mid-execution will finish their tick. The next
# cron tick (within 6h) reverts to legacy `runAllChecks`.

# To halt the framework entirely:
export TENANT_AWARE_JOBS_ENABLED=false
# Ditto. Plus, any other module that adopts `runForTenant` later
# refuses to engage.
```

The framework introduces no DB state; rollback is purely
configuration. The harness's case 9 verifies that flipping the env
classifier (NODE_ENV=production override) immediately routes the
scheduler back to legacy, even with both flags on.

## 10. Lessons learned

1. **Wrapping is cheap; narrowing is expensive.** Phase 2.14 ships
   the orchestrator + ALS adapter without rewriting the four `check*`
   methods. That's a deliberate split: the framework lands first,
   the per-method narrowing lands in 2.14.1 once we've watched a
   tick or two in staging.
2. **Optional flag injection beats new providers.** Adding `flags?:
   FeatureFlagsService` as an optional 3rd constructor param keeps
   the existing harnesses (which build the service with two args) on
   their original signature. No harness regressed.
3. **Source-level meta-assertions stay green.** The Phase 2.10
   isolation harness's case 8 reads
   `notifications.service.ts` to confirm the `check*` methods still
   source `legacyPrisma.user.findMany`. Phase 2.14 added
   `runAllChecksTenantAware` BETWEEN those methods without touching
   them — meta-assertion still passes, proving the scope split holds.
4. **Env classifier is the strongest gate.** The harness's case 9
   simulates a production deploy with both flags ON. The dispatcher
   stays on the legacy path because the env classifier refuses. This
   is the same belt-and-braces guard `runForTenant` provides at the
   framework level — it now also lives at the orchestrator level for
   defence in depth.

## 11. Phase 2.14.1 update — per-method narrowing shipped

Phase 2.14.1 (this PR) completed the adapter. The four `check*`
methods now consult `narrowingTenantId()` at the top of their bodies
and spread `tenantId` into:

- `User.findMany.where` (via `agency: { tenantId: tid }`).
- the inner `Vehicle.findMany` / `MaintenanceRecord.findMany.where`.
- the dedupe `Notification.findFirst.where`.
- the `Notification.create.data` payload.

When `tid === null` (legacy / production), every spread is `{}` and
the methods behave byte-identically to pre-2.14.1.

Annotations: every `check*` site moved from
`phase210-excluded-background` to `phase214-pilot-scope` (16 sites
across the four methods, plus the original tenant-catalog discovery
site from 2.14).

Harness extended from 9 → 19 cases:
- 9 original Phase 2.14 cases (dispatch, fanout, guards, env refusal,
  cron timing).
- 4 new cases (12–15): each `check*` calls `narrowingTenantId()`.
- 1 new case (16): all check methods narrow User scan via
  `agency.tenantId`.
- 1 new case (17): notification creates spread `tenantId` (≥ 4 sites).
- 1 new case (18): dedupe queries scope by `tenantId` (≥ 4 sites).
- 3 new runtime cases (19, 20, 21): `narrowingTenantId()` returns
  null in legacy mode; returns the active tenant inside ALS in
  tenant-aware mode; returns null when ALS is empty even with flags
  on.

Result: 19/19 PASS. No regression in equivalence (11/11), isolation
(8/8), job-context (11/11), or pilot-regression (12/12).

## 12. Dedupe key decision

**Include `tenantId` in the dedupe `findFirst` query when tenant-
aware mode is active.** Documented in
`SAAS_PHASE2_NOTIFICATIONS_DEDUPE_KEY_REVIEW.md`. When the helper
returns `tid !== null`, the dedupe matches only notifications
belonging to the active tenant. When `tid === null`, the dedupe
behaves identically to pre-2.14.1 (global match).

## 13. Phase 2.15 update — fanout writers narrowed

Phase 2.15 completed the notifications background tenant-safety arc:

- `notifyUploaderAndRoles` and `notifyUsersByRoles` both call
  `narrowingTenantId()` once at the top.
- User scans spread `agency: { tenantId: tid }` when active.
- `notifyUploaderAndRoles` adds an uploader-tenant probe via
  `legacyPrisma.user.findFirst({ where: { id: uploaderId, agency: { tenantId: tid } } })`
  before adding the uploader to the recipient set. Cross-tenant
  uploaders are silently dropped (matches existing role-filter
  semantics).
- `notification.create.data` spreads `tenantId: tid` so the persisted
  row carries the active tenant.
- Three writer-internal sites annotated `phase215-pilot-scope`. The
  scheduler harness extended 19 → 28 cases (+9 source-level + runtime
  fanout cases). Notifications isolation harness extended 8 → 10
  cases (+2 cross-tenant fanout assertions).

Caller contract: no signature change; HTTP callers automatically
work via existing request middleware; background callers must run
inside `runForTenant`. See
`SAAS_PHASE2_NOTIFICATIONS_FANOUT_CALLER_CONTRACT.md`.

Production behaviour unchanged: legacy mode bypasses all narrowing.

## 14. Next phase

- **`src/finance` reads-first split** — no scheduler involvement;
  follows the established pilot template.
- **Phase 3 prep** — `TenantPrismaService.client` `$extends`
  implementation so the wrapper-level enforcement replaces the
  per-service spread.
- **`Notification.tenantId` backfill** for legacy NULL-tenant rows
  (operational task, not a code change).
- **Email/SMS delivery worker tenant routing** — out of scope for
  Phase 2; Phase 3 picks it up.

## 12. Unresolved blockers

- **`check*` per-method narrowing** (deferred to 2.14.1).
- **Notification dedupe key** still global; should include `tenantId`
  in 2.14.1.
- **BullMQ integration** (Phase 3): the existing
  `TenantAwareJobProcessor` is unrelated to the Phase 2.14 adapter.
  Production probably wants real queue runners with dead-letter
  handling, not the inline `runForTenantBatch` used here.
- **Per-tenant metrics cardinality** flagged in the observability
  doc; deferred to Phase 3.
- **`TenantPrismaService.client` `$extends` shim** still throws when
  `TENANT_PRISMA_ENFORCEMENT=true` AND the registry is non-empty.
  Six pilots filter at the service layer; Phase 3 still owes wrapper-
  level enforcement.
