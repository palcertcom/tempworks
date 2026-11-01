# Phase 2.8 — Compliance Pilot Results

> Second tenant-scoped pilot. Reuses Phase 2.7's pattern verbatim plus
> the new module allow-list. Proves the architecture is reusable.

---

## 1. Headline

```
build:                                           ✅
prisma validate:                                 ✅
saas:validate (6 suites):                        ✅
saas:schema-lint:                                 ✅
saas:phase2-compliance-equivalence:              12/12 cases PASS
saas:phase2-compliance-isolation:                 7/7  cases PASS
saas:phase2-ewh-equivalence (regression):        12/12 cases PASS
saas:phase2-ewh-isolation (regression):           8/8  cases PASS
saas:phase2-tenantprisma-pilot-equivalence:      13/13 cases PASS
saas:phase2-tenantprisma-pilot-isolation:         9/9  cases PASS
saas:scan:                                       795 unreviewed (down from 817)
saas:scan:raw-sql:                               baseline unchanged
production defaults:                             all OFF
```

## 2. What was tested

### Equivalence (12/12 PASS)

- Module allow-list helper: unset env ⇒ all modules allowed; explicit
  list ⇒ only listed modules allowed; `=nothing` ⇒ scope inactive
  even when the flag is on.
- `getDashboard.summary.totalAlerts`: legacy ≥ pilot, pilot equals
  exactly tenant A's seeded count (3).
- `getAlerts(pagination)`: pilot total < legacy total when there are
  cross-tenant rows; pilot total > 0.
- `getAlerts(status='OPEN')`: status filter respected in both modes.
- `getEmployeeCompliance`: response shape preserved; pilot openAlerts
  ≤ legacy openAlerts.
- `getExpiringDocuments`: pilot result is a subset of legacy result.
- Top-level keys `summary / documents / alertsByStatus / recentAlerts`
  present and correctly typed in both modes.

### Isolation (7/7 PASS)

- Pilot ON, tenant A: `getAlerts()` returns only tenant A rows; tenant
  B and NULL-tenant ids excluded.
- `getDashboard.summary.totalAlerts === 3` (tenant A's seeded count).
- `recentAlerts` contain no tenant B ids.
- `updateAlert(tenantB-id)` raises NotFound; the target row's `status`
  is unchanged (no mutation reaches the DB).
- Concurrent ALS frames: T_A no B-rows, T_B no A-rows.
- Pilot OFF: legacy reads include tenant B + NULL-tenant rows (no
  filter) — confirms legacy path is untouched.
- `TENANT_PRISMA_PILOT_MODULES=nothing` ⇒ compliance scope inactive
  even with flag on, returning legacy union.

## 3. Module allow-list

`TENANT_PRISMA_PILOT_MODULES` env var (added in Phase 2.8):

| Value | Behaviour |
|------|-----------|
| (unset) | every module allowed (Phase 2.7 default) |
| `""` | every module allowed (treated as unset) |
| `compliance` | only `compliance` engages the pilot |
| `employee-work-history,compliance` | both modules engage the pilot |
| `nothing` | no module engages the pilot — fast disable without unsetting `TENANT_PRISMA_PILOT_ENABLED` |

`getPilotScope(pilot, moduleName)` consults the allow-list. If
`moduleName` is provided AND the module isn't in the list, the scope
is inactive with reason `"module \"<name>\" not in TENANT_PRISMA_PILOT_MODULES"`.

The Phase 2.7 EWH service was updated to pass `'employee-work-history'`
to `getPilotScope`, so the new gating applies to both pilots. Phase
2.7 harness still passes 12/12 + 8/8.

## 4. Lessons learned

1. **Allow-list is cheap but valuable.** Operators can disable any
   single pilot module instantly without unsetting the global flag.
   Useful when one module misbehaves on a staging clone — keep the
   flag on for the others, set `TENANT_PRISMA_PILOT_MODULES=` to a
   subset, and redeploy.
2. **Aggregations are the same shape.** `count`, `groupBy`, and
   `findMany` all accept `where: { ...t }` the same way. Spreading is
   uniform across the eight count queries in `getDashboard`.
3. **Pre-check + mutate-by-id keeps error semantics stable.** Legacy
   `updateAlert` raises `P2025` from Prisma when the id is missing;
   pilot mode raises `NotFoundException` when the id is in another
   tenant. Both are 404-equivalents to the controller. The harness
   verified both produce no-mutation behaviour.
4. **Catalog joins (DocumentType) keep working.** The `include` paths
   that join `documentType` need no scope change — DocumentType is
   global and the FK lookup carries no tenant equality.
5. **Audit logs stay legacy.** Same as Phase 2.7 — audit writes use
   `legacyPrisma.auditLog.create` so they never block on pilot context.
6. **Fixture extension is wider than EWH's.** The compliance pilot
   exercises five tables (compliance_alerts, document_types, documents,
   work_permits, visas) plus extra columns on employees. The fixture
   extension is bigger because the staging fixture pre-dates many of
   the schema columns. Production has these already.

## 5. Whether the pattern is reusable: yes

The combination of `PilotPrismaAccessor` + `getPilotScope(pilot, moduleName)`
+ `TENANT_PRISMA_PILOT_MODULES` allow-list is reusable for any future
tenant-scoped module. Each new module:

1. Adds `PilotPrismaAccessor` to its module providers + imports
   `FeatureFlagsModule`.
2. Refactors its service: inject pilot, add `private get prisma()` +
   `private scope()`, spread `scope.tenantWhere()` / `scope.tenantData()`.
3. Adds a per-module equivalence + isolation harness.
4. Annotates each `this.prisma.*` site with
   `// @tenant-reviewed: phaseXX-pilot-scope`.

No new flag. No new accessor. The scope helper is generic.

## 6. Risks before next module

- **`getDashboard` becomes tenant-scoped under pilot.** Operators who
  rely on the dashboard for cross-tenant overviews need a separate
  platform-admin endpoint. Phase 2.8 does NOT add one — flag-off
  behaviour is unchanged. Phase 3 should specify the cross-tenant
  view explicitly (likely via `platformAdminOnly: true` on a future
  platform-admin source).
- **`generateAlerts` background job** must attach a tenant context
  when running in pilot mode. Today no scheduled job is wired up; if
  one is added, it MUST use `withRequestContext` + `TenantContext.attach`
  before calling `generateAlerts`, otherwise the scope will be inactive
  and tenantId will be persisted as NULL.
- **`include: { document: { include: { documentType: true } } }`** uses
  Prisma joins. Those don't (yet) carry a tenant filter on the joined
  side. For now we accept this because:
  - `document.tenantId` is set for any pilot-created row, AND
  - the parent (`complianceAlert`) is tenant-filtered, AND
  - the joined `Document` row's tenant is implied by the FK
    (alert.tenantId = document.tenantId by construction).
  Phase 3 may want to enforce this invariant at the DB level (RLS).

## 7. Next recommended module

`src/job-ads` — single-table CRUD, low mutation rate, no file/storage
interactions. Has its own `tenantId` column (denormalised in Phase 2.3
or to be added). Or split `src/vehicles` reads-first if jobs ads is
already otherwise blocked.

## 8. Production behaviour change status

**Unchanged.** With `TENANT_PRISMA_PILOT_ENABLED=false` (default),
`getPilotScope()` returns inactive and the spreads are no-ops. Every
legacy SQL is byte-for-byte the same as before this PR. Module allow-
list is irrelevant when the global flag is off.

---

## Phase 2.37 reaffirmation

Compliance was the **second** module ever piloted (Phase 2.8). Phase
2.37 is the formal reads-first reaffirmation:

- All 4 read methods (`getDashboard`, `getAlerts`,
  `getEmployeeCompliance`, `getExpiringDocuments`) and the 2 write
  methods (`updateAlert` with parent-gate pre-check, `generateAlerts`
  with `tenantWhere()` scan + `tenantData()` create) were verified
  on the current schema.
- The Phase 2.8 fixture seed was patched: `updatedAt` is now stamped
  on insert so it survives the later NOT NULL migration. The seed
  remains idempotent (`ON CONFLICT (id) DO NOTHING`).

Real-DB results on the patched fixture:
- `compliance-equivalence` — **12/12 PASS**
- `compliance-isolation`   — **7/7 PASS**

Cumulative across modules (post-Phase 2.36): **371/371**. With
compliance fully verified: finance + documents + vehicles + workflow
+ applicants + audit-log + employees + agencies + compliance =
**390/390** on real Postgres 16.

Pattern reusability stands: the compliance pilot is the same shape as
every subsequent reads-first pilot (finance / documents / vehicles /
workflow / applicants / employees / agencies). The eight reads-first
modules now all compose cleanly.

### Lessons

- **`generateAlerts` already covers the cross-module read+write
  cycle.** The scan filters by `tenantWhere()` and the create
  spreads `tenantData()` — proves the pattern works when a single
  method does both the read and the write.
- **Audit routing through `TenantAuditLogService` is a future
  Phase 2.38+ migration** — the existing `phase28-audit-log` tag
  points at the legacy emission path until the audit pilot adopts
  compliance.
- **Background-job ALS frame attach** is the only remaining gap.
  When/if `generateAlerts` is wired to a scheduler, the per-tenant
  frame attach must be explicit.

### Blockers before mutation-write extension

- Audit emission for `updateAlert` not yet routed through the shared
  helper.
- Scheduled background scans need explicit per-tenant ALS frame
  management.
- Bulk remediation flows are not yet defined by product.

---

## Phase 2.38 — audit routing + scheduler-safe entrypoint

Phase 2.38 closes the two gaps Phase 2.37 left open. See
`SAAS_PHASE2_COMPLIANCE_SCHEDULER_ROUTING.md`.

- `updateAlert` audit emission now routes through
  `TenantAuditLogService` (Phase 2.30). Tag retagged from
  `phase28-audit-log` to `phase238-audit-log-pilot`. With audit pilot
  on AND ALS tenant frame in scope, the audit row carries
  `tenantId = active`; with the flag off the row is NULL-tenant
  (byte-identical to pre-2.38).
- New `generateAlertsForTenant(tenantId)` entrypoint. Refuses to run
  unless env is SAFE_CLONE/SAFE_STAGING AND the compliance pilot is
  active. Attaches a fresh ALS frame per call so concurrent
  invocations remain isolated. Tag `phase238-scheduler-routing`.
- No scheduler is wired. The entrypoint is the **contract** for any
  future scheduler. Fan-out across all tenants is explicitly NOT
  provided — callers must enumerate tenant ids.

New harness (real Postgres SAFE_CLONE):
- `compliance-audit-and-scheduler` — 9/9 PASS

Real-DB results: equivalence 12/12 + isolation 7/7 +
audit/scheduler 9/9 = **28/28 compliance**. Cumulative across
modules: **399/399** on real Postgres 16.

Production behaviour with flags off is byte-identical. Rollback is
configuration-only (`TENANT_PRISMA_PILOT_ENABLED=false` or remove
`compliance` from `TENANT_PRISMA_PILOT_MODULES` or
`TENANT_AUDIT_LOG_PILOT_ENABLED=false`).

### Remaining blockers

- **Scheduler wiring**: a real cron / Bull schedule must enumerate
  tenants and call `generateAlertsForTenant` per tenant. Out of
  scope this phase.
- **Notification fan-out**: continues to live in the `notifications`
  module pilot.

---

## Phase 2.39 — tenant-aware job dispatch

`dispatchComplianceAlertGenerationForTenants()` shipped. The dispatch
helper is the only supported execution path for any background
scheduler that needs compliance alert generation across tenants.

- Refuses by default (`TENANT_JOB_FANOUT_ENABLED=false`).
- Refuses when pilot inactive or env not SAFE_CLONE/SAFE_STAGING.
- Enumerates only ACTIVE tenants from the `Tenant` table.
- Calls `generateAlertsForTenant(tenantId)` once per tenant.
- Per-tenant fault isolation: failures recorded; loop continues.
- Source-level meta-assertion: dispatch body never calls raw
  `generateAlerts()`.

New annotation tag: `phase239-tenant-job-dispatch`.

New harness (real Postgres): `compliance-tenant-job-dispatch` —
**9/9 PASS**.

Cumulative compliance: equivalence 12/12 + isolation 7/7 +
audit/scheduler 9/9 + tenant-job-dispatch 9/9 = **37/37**.
Cumulative across modules: **408/408**.

No production behaviour change. No real scheduler is wired. Rollback
is configuration-only.

---

## Phase 2.40 — real scheduler entry-point

`ComplianceScheduler.runScheduledComplianceAlertGeneration()`
shipped — disabled-by-default. Calls only the Phase 2.39 dispatch
helper. New flag `COMPLIANCE_ALERT_SCHEDULER_ENABLED=false`.

New annotation tag: `phase240-compliance-real-scheduler`.

New harness (real Postgres): `compliance-real-scheduler` — **11/11 PASS**.

Cumulative compliance: equivalence 12/12 + isolation 7/7 +
audit/scheduler 9/9 + tenant-job-dispatch 9/9 + real-scheduler 11/11
= **48/48**. Cumulative across modules: **419/419**.

No production behaviour change. No cron framework wired. Rollback is
configuration-only.

---

## Phase 2.41 — cron framework wired

`@nestjs/schedule@^4.0.0` added; `ScheduleModule.forRoot()` registered
once in `app.module.ts`; `ComplianceCron` provider added with one
`@Cron(...)` entry-point that delegates to
`ComplianceScheduler.runScheduledComplianceAlertGeneration()`.

Cron expression read from `COMPLIANCE_ALERT_SCHEDULER_CRON` at
process start (default `0 */6 * * *`). Runtime enable/disable lives
at `COMPLIANCE_ALERT_SCHEDULER_ENABLED` (per-tick gate).

New annotation tag: `phase241-compliance-cron-framework`.

New harness (real Postgres): `compliance-cron-framework` — **14/14 PASS**.

Cumulative compliance: equivalence 12/12 + isolation 7/7 +
audit/scheduler 9/9 + tenant-job-dispatch 9/9 + real-scheduler 11/11
+ cron-framework 14/14 = **62/62**. Cumulative across modules:
**433/433**.

No production behaviour change. Default flags off ⇒ cron tick is a
no-op. Rollback is configuration-only.

---

## Phase 2.43 — compliance → notifications event coupling

Optional, default-off coupling between per-tenant compliance alert
generation and tenant-safe notification fan-out. See
`SAAS_PHASE2_COMPLIANCE_NOTIFICATION_COUPLING.md`.

- New flag `COMPLIANCE_NOTIFY_ON_ALERT=false` (default).
- New helper `ComplianceService.maybeNotifyOnAlertGeneration(total)`
  invoked from `generateAlertsForTenant` INSIDE the per-tenant ALS
  frame, AFTER `generateAlerts()` returns.
- Helper refuses if `TENANT_AWARE_JOBS_ENABLED` or
  `TENANT_JOB_FANOUT_ENABLED` is off; structured `{refused, …}`
  result.
- Notification creation goes through the existing
  `NotificationsService.notifyUsersByRoles(['Compliance Officer',
  'Compliance Manager', 'System Admin'], …)` helper. Recipients
  narrowed by `agency.tenantId`; `Notification.create.data.tenantId`
  stamped from ALS.
- No external provider (email/SMS/WhatsApp) invoked.
- Failures captured as `{ error }`; compliance alert generation is
  not rolled back.

New annotation tags:
- `phase243-compliance-notification-coupling`
- `phase243-compliance-notification-fanout`
- `phase243-compliance-notification-deferred-provider`

New harness (real Postgres): `compliance-notification-coupling` —
**12/12 PASS**.

Cumulative compliance: equivalence 12/12 + isolation 7/7 +
audit/scheduler 9/9 + tenant-job-dispatch 9/9 + real-scheduler 11/11
+ cron-framework 14/14 + notification-coupling 12/12 = **74/74**.
Cumulative across modules: **466/466**.

Production behaviour with default flags is byte-identical: coupling
helper returns `null` and zero notifications are created.

---

## Phase 2.44 — operator-visible scheduler health signal

`ComplianceScheduler.summarizeHealth(result)` shipped — pure
normalizer that folds the existing `ScheduledRunResult` into a
`ScheduledHealthSummary` and emits a `compliance.scheduler.health`
log line once per tick. See
`SAAS_PHASE2_COMPLIANCE_SCHEDULER_HEALTH.md`.

- Status rules: `failed` (scheduler crash), `skipped` (flag off /
  refused), `partial_failure` (`failed > 0` OR `notifyFailed > 0`),
  `ok` otherwise.
- Counts only — no PII / payloads / document titles.
- No external alerting provider invoked. Structured log fingerprint
  is the operator-visible signal for this phase.
- Cron tick unchanged.

New annotation tag: `phase244-compliance-scheduler-health`.

New harness (real Postgres):
`compliance-scheduler-health` — **12/12 PASS**.

Cumulative compliance: equivalence 12/12 + isolation 7/7 +
audit/scheduler 9/9 + tenant-job-dispatch 9/9 + real-scheduler 11/11
+ cron-framework 14/14 + notification-coupling 12/12 +
scheduler-health 12/12 = **86/86**. Cumulative across modules:
**478/478**.

Production behaviour: a single structured log line per tick
(default `status=skipped`). Zero DB writes, zero external calls,
zero behaviour change.
