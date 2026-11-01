# Phase 2.10 — Notifications Scope Split

> What ships in Phase 2.10 vs. what waits for Phase 2.11+.
> A guard-rail document so no one accidentally rewires the
> notification-creation paths in this PR.

---

## 1. Scope summary

| Area | Phase | This PR? |
|------|------|----------|
| Read-path tenant scoping (`getUserNotifications`, `getUnreadCount`, `markAsRead`, `markAllAsRead`, `wasHighBalanceAlertRecentlySent`) | **2.10** | **YES** |
| Per-user preferences (`getOrCreatePreferences`, `updatePreferences` — global model) | 2.10 | yes (kept on legacyPrisma; annotated `phase210-global`) |
| Vehicle/compliance scheduler probes (`check*`, `runAllChecks`) | 2.11+ | NO |
| Notification-creation fanout (`notifyUploaderAndRoles`, `notifyUsersByRoles`) | 2.11+ | NO |
| Cron orchestration (`NotificationsSchedulerService`) | 2.11+ | NO |
| Email/SMS delivery workers | 3.x | NO |
| Per-tenant rule/template configuration | 3.x | NO |
| Notification creation tenant fanout (one alert → one notification per recipient per tenant) | 3.x | NO |

## 2. Phase 2.10 — Read path refactor (THIS PR)

What lands:

- `NotificationsService` constructor injects `PilotPrismaAccessor`.
- `private get prisma()` returns `pilot.client()`.
- `private scope()` returns `getPilotScope(this.pilot, 'notifications')`.
- 7 read sites spread `scope.tenantWhere()` into the `where` clause.
- `markAsRead` adds a tenant-scoped pre-check in pilot mode; legacy
  preserves Prisma's P2025 path.
- 19 background sites are annotated
  `// @tenant-reviewed: phase210-excluded-background` and routed
  through `this.legacyPrisma` so the scanner shows them as
  intentionally excluded.

What does NOT land:

- No cron / scheduler change.
- No notification creation change.
- No new flag.
- No schema change (`Notification.tenantId` was added in Phase 2.3).

## 3. Phase 2.11+ — Scheduler / job-context refactor (FUTURE)

The four `check*` methods iterate "all fleet managers" via
`prisma.user.findMany({ where: { role: { name: { contains: 'Fleet Manager' } } } })`.
That cross-tenant scan is intentional — a single cron tick services
every tenant's vehicles.

To safely tenant-scope this, Phase 2.11 needs:

1. A **job-context framework** that wraps cron callbacks in a
   `withJobContext({ tenantId })` ALS frame, run once per tenant.
2. A **per-tenant cron sequencer** that iterates `tenants`, attaches
   the tenant to ALS, then invokes the existing `check*` methods. The
   existing `check*` body can then drop its global `findMany` in favour
   of the tenant-scoped one.
3. **Telemetry** showing which tenants ran, succeeded, or failed per
   tick.

None of these exist today. Doing the read-path refactor first lets
us prove the access pattern on the easy half of the module, while
deliberately deferring the harder half.

## 4. Phase 2.11+ — Delivery worker refactor (FUTURE)

`notifyUploaderAndRoles` and `notifyUsersByRoles` are write-fanout
methods invoked from other services (documents, finance, applicants,
…). They:

- Look up users by role across all tenants.
- Insert one `Notification` row per recipient.

To safely tenant-scope these:

1. Each caller must pass the tenant of the originating event.
2. The fanout must filter recipients to the same tenant (or a
   platform-admin user explicitly).
3. The created `Notification.tenantId` must be set to the tenant of
   the originating event.

This is a wide change touching every caller. Out of scope for Phase
2.10.

## 5. Phase 3.x — Notification creation tenant fanout (FUTURE)

When a single underlying alert (e.g. a document expires) triggers
notifications for users in multiple tenants (rare but possible —
e.g. shared documents), the fanout strategy needs explicit product
decisions:

- One notification per (user, tenant) pair?
- Mark with the originating tenant or the recipient's tenant?
- How do platform admins see cross-tenant notifications?

Phase 3 will document and implement; Phase 2.10 ignores.

## 6. Guard-rails enforced by this PR

- The isolation harness's case 8 reads the service source and asserts
  that all four `check*` methods source `legacyPrisma.user.findMany`,
  not `this.prisma.user.findMany`. If a future PR moves them to
  `this.prisma`, the harness fails and blocks the merge.
- Every `legacyPrisma.*` site in the background paths carries the
  `phase210-excluded-background` annotation. The scanner's eventual
  strict mode can target this annotation specifically when the
  scheduler refactor lands in Phase 2.11.
- The Phase 2.10 fixture extension adds rows that exercise the read
  paths only — no scheduler-trigger conditions.

## 6.1 Phase 2.13 update — framework now exists

Phase 2.13 shipped the `runForTenant` / `runForTenantBatch` /
`TenantJobFanoutPlanner` infrastructure (dormant by default; see
`SAAS_PHASE2_JOB_CONTEXT_ARCHITECTURE.md`). The notifications
scheduler refactor outlined in §3 is now unblocked at the framework
level — it becomes a Phase 2.14 deliverable per
`SAAS_PHASE2_NOTIFICATIONS_SCHEDULER_ADAPTER_PLAN.md`.

## 6.2 Phase 2.14 update — adapter shipped (partial)

Phase 2.14 shipped the orchestrator + ALS adapter:

- `NotificationsSchedulerService.runOnce` is now a flag-aware
  dispatcher. Default OFF → legacy `runAllChecks`. Both flags on +
  staging → `runAllChecksTenantAware`.
- `NotificationsService.runAllChecksTenantAware` discovers active
  tenants via `legacyPrisma.tenant.findMany`, plans per-tenant
  fanout via `TenantJobFanoutPlanner`, and runs each tenant inside
  `runForTenant`.
- `NotificationsService.runAllChecksForTenant(tenantId)` is the
  per-tenant entry point.
- `notifyUploaderAndRoles` and `notifyUsersByRoles` now refuse
  without an ALS tenant when the tenant-aware path is active. Legacy
  behaviour unchanged when flags are off.

## 6.3 Phase 2.14.1 update — per-method narrowing shipped

Phase 2.14.1 completed the adapter. Every `phase210-excluded-background`
annotation on a `check*`-method prisma site moved to
`phase214-pilot-scope` and the bodies now spread `tenantId: tid` /
`agency: { tenantId: tid }` into their where clauses + create data.

Helper: `private narrowingTenantId(): string | null` returns the
active tenant id when tenant-aware mode is engaged AND ALS has a
tenant; `null` everywhere else. Spreads are no-ops when `null`, so
legacy mode stays byte-identical.

Dedupe key now includes `tenantId` in tenant-aware mode — see
`SAAS_PHASE2_NOTIFICATIONS_DEDUPE_KEY_REVIEW.md` for rationale +
transition risks.

## 6.4 Phase 2.15 update — fanout writers narrowed

Phase 2.15 narrowed the two fanout writers. `notifyUploaderAndRoles`
and `notifyUsersByRoles` now:

- read `narrowingTenantId()` once at the top.
- spread `agency: { tenantId: tid }` into the role `User.findMany`.
- spread `tenantId: tid` into the `notification.create.data`.
- (uploader-only) probe the uploader's tenant via `findFirst({ id, agency: { tenantId: tid } })`
  before adding to the recipient set. Cross-tenant uploaders are
  silently dropped.

Three writer-internal sites annotated `phase215-pilot-scope` (new tag
added to `KNOWN_REASONS` + scanner policy). The Phase 2.14
`assertTenantForFanout` guard remains in place (refuses without ALS
when tenant-aware mode is active).

**No remaining `phase210-excluded-background` annotations in
`src/notifications`.** The notifications module's background paths
are now either tenant-narrowed (`phase214-pilot-scope` /
`phase215-pilot-scope`) or per-user-global by design
(`phase210-global` on NotificationPreference upsert/update).

The legacy `runAllChecks` path remains the production default and
rollback target. Caller contract documented in
`SAAS_PHASE2_NOTIFICATIONS_FANOUT_CALLER_CONTRACT.md`.

## 7. Operator checklist for Phase 2.11

When Phase 2.11 starts, the operator should:

- [ ] Read this scope-split document.
- [ ] Confirm the job-context framework exists (or land it first).
- [ ] Re-run `saas:phase2-notifications-equivalence` and
      `saas:phase2-notifications-isolation` against the same staging
      DB to prove the read paths still pass after the scheduler
      change.
- [ ] Add a new harness `saas:phase2-notifications-scheduler-equivalence`
      that asserts each tenant gets the right notifications when the
      cron tick fires N times.
- [ ] Update the `phase210-excluded-background` annotations to
      `phase211-pilot-scope` once the scheduler engages the pilot.
