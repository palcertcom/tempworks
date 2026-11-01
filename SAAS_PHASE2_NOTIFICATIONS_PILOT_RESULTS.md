# Phase 2.10 — Notifications Pilot Results

> Fourth tenant-scoped pilot. First to deliberately split a single
> service into "in scope" (read paths) and "explicitly excluded"
> (scheduler / fanout). Proves the pattern handles partial refactors
> cleanly.

---

## 1. Headline

```
build:                                            ✅
prisma validate:                                  ✅
saas:validate (6 suites):                         ✅
saas:schema-lint:                                  ✅
saas:phase2-notifications-equivalence:            11/11 cases PASS
saas:phase2-notifications-isolation:               8/8  cases PASS
saas:phase2-job-ads-equivalence (regression):     13/13 cases PASS
saas:phase2-job-ads-isolation   (regression):      9/9  cases PASS
saas:phase2-compliance-equivalence (regression):  12/12 cases PASS
saas:phase2-compliance-isolation  (regression):    7/7  cases PASS
saas:phase2-ewh-equivalence       (regression):   12/12 cases PASS
saas:phase2-ewh-isolation         (regression):    8/8  cases PASS
saas:scan:                                        759 unreviewed (down from 786)
saas:scan:raw-sql:                                baseline unchanged
production defaults:                              all OFF
```

## 2. What was tested

### Equivalence (11/11 PASS)

- Pilot active state under flag combinations.
- `getUserNotifications`: pilot total ≤ legacy; pilot excludes the
  NULL-tenant legacy row; legacy includes it.
- `getUnreadCount`: pilot ≤ legacy.
- `wasHighBalanceAlertRecentlySent`: legacy and pilot both find a
  recent alert (each in its own scope).
- `markAsRead(missing-id)`: pilot raises `NotFoundException`; legacy
  raises Prisma error — both reject as expected.
- `getOrCreatePreferences`: returns identical preferences id in both
  modes (per-user global record kept on legacyPrisma).
- `markAllAsRead` pilot ON: tenant A unread → 0; tenant B unread
  unchanged.
- Response shape preserved (`{ data, total }`).

### Isolation (8/8 PASS)

- Pilot ON tenant A: `getUserNotifications` returns ONLY tenant A.
- `getUnreadCount` excludes tenant B + NULL-tenant rows.
- `markAsRead(B-id)` rejected; `isRead` unchanged.
- `markAllAsRead` does NOT mutate tenant B rows (count before == count after).
- Concurrent ALS frames: T_A no B-rows, T_B no A-rows.
- Pilot OFF: legacy includes NULL-tenant legacy row.
- `TENANT_PRISMA_PILOT_MODULES=nothing` ⇒ legacy union (notifications opt-out).
- **Meta-assertion (case 8):** all four scheduler `check*` methods
  source `legacyPrisma.user.findMany` — proving the scheduler/
  background paths are untouched by Phase 2.10.

## 3. Lessons learned

1. **Partial refactors are explicit.** Annotating background sites
   with `phase210-excluded-background` and routing them via
   `legacyPrisma` makes the scope split self-documenting in code as
   well as in the docs. The scanner's strict mode can later target the
   `phase211-pilot-scope` annotation specifically.
2. **Public-facing read endpoints follow the same shape.** Just like
   the job-ads public listing, the notifications endpoints work
   identically with no ALS tenant — the spread is `{}` and the path
   stays legacy. There's a small footprint in pilot mode for users
   that DO have a tenant.
3. **Per-user global records are a third class.** `NotificationPreference`
   has neither tenantId nor a meaningful tenant-equivalent ownership
   chain. The right call was to keep it on `legacyPrisma` (annotated
   `phase210-global`) — adding a tenant filter would silently break
   existing per-user preferences.
4. **Source-level meta-assertions catch refactor drift.** The
   isolation harness's case 8 reads the service file and asserts
   the scheduler methods still use `legacyPrisma`. A future PR that
   accidentally moves them to `this.prisma` (which would silently
   tenant-scope a global iteration) fails this assertion immediately.
5. **markAsRead was a contract bug pre-pilot.** It accepted any id
   without checking ownership. The pilot's tenant-scoped pre-check
   closes the cross-tenant hole; legacy mode preserves the Prisma
   P2025 path so observable behaviour with the flag off is unchanged.

## 4. Background-job warnings

The scheduler / notification-creation paths intentionally remain
global. Operators should know:

- Cron-driven `check*` methods iterate `User` across all tenants.
  Adding a tenant to ALS at the cron caller without also updating
  these methods would mean a single cron tick services only one
  tenant.
- `notifyUploaderAndRoles` / `notifyUsersByRoles` look up users by
  role across all tenants. Until Phase 2.11+ adds caller-side tenant
  passing, these will fanout cross-tenant if a multi-tenant role
  mapping exists.
- `Notification.tenantId` is set to NULL by these creators today (the
  pilot does not change them). Phase 2.11+ will populate it from the
  job context.

## 5. Whether the pattern remains reusable

**Yes.** The Phase 2.7/2.8/2.9 pattern (`PilotPrismaAccessor` +
`getPilotScope(pilot, moduleName)` + spreads) handles a partial-scope
module without modification. New ingredients in Phase 2.10 are:

- `phase210-excluded-background` annotation (precedent for future
  partial refactors).
- Source-level meta-assertion in the isolation harness (cheap,
  refactor-robust).
- `legacyPrisma`-routed per-user global model (precedent for
  user-scoped catalogs / preferences).

## 6. Next recommended module

`src/recycle-bin` — small, read-mostly, tenant-scoped, no scheduler
involvement. Good for the fifth pilot.

Backups:
- Splitting `src/vehicles` into reads-first.
- `src/finance` read paths only (writes / reconciliation deferred).

## 7. Blockers before scheduler refactor

1. **Job-context framework:** background workers need a way to
   attach a tenant to ALS at cron-tick time. Today there's none.
   Phase 2.11 must ship this primitive first.
2. **Per-tenant cron sequencer:** the cron orchestrator must iterate
   tenants and run `runAllChecks` per tenant. Without this, moving
   `check*` to the pilot is unsafe.
3. **Caller-side tenant passing for `notify*`:** every caller of
   `notifyUploaderAndRoles` / `notifyUsersByRoles` must pass the
   originating tenant explicitly. That's a wide audit (documents,
   finance, applicants, workflow, …).
4. **Telemetry:** before flipping the scheduler to pilot mode,
   per-tenant per-tick metrics need to be in place to debug missed
   notifications.

## 8. Production behaviour change status

**Unchanged.** With `TENANT_PRISMA_PILOT_ENABLED=false` (default),
`getPilotScope()` returns inactive, the read-path spreads are no-ops,
and the explicitly-excluded background paths continue to use
`legacyPrisma` directly. Every legacy SQL is byte-for-byte identical
to before this PR. The scheduler runs unchanged.

---

## Phase 2.42 reaffirmation

Notifications was the **fourth** module piloted (Phase 2.10 reads +
Phase 2.14/2.15 scheduler+fan-out). Phase 2.42 is the formal
reads-first audit + harness reaffirmation:

- Re-applied the notifications fixture extension: seeded a Recruiter
  role + a tenant-A Recruiter user + a tenant-B Recruiter user +
  per-user `NotificationPreference` rows. Without these, the fan-out
  case in `notifications-isolation` could not exercise a real
  cross-tenant recipient query.
- Added Phase 2.42 npm aliases:
  - `saas:phase242-notifications-equivalence` →
    `notifications-equivalence.ts`
  - `saas:phase242-notifications-isolation` →
    `notifications-isolation.ts`
- Reserved scanner tags
  `phase242-notifications-pilot-scope`,
  `phase242-notifications-fanout-deferred`,
  `phase242-notifications-audit-log`.

### Real-DB results

- `notifications-equivalence` — **11/11 PASS**
- `notifications-isolation` — **10/10 PASS** (including the
  cross-tenant fan-out case proving tenant-A `notifyUsersByRoles`
  creates only tenant-A notifications and tenant-B count is
  unchanged)

### Fan-out status

**Implemented and gated.** `notifyUsersByRoles` and
`notifyUploaderAndRoles` already narrow recipients by
`agency.tenantId` and stamp `Notification.create.data.tenantId`
from the active ALS frame, behind `TENANT_AWARE_JOBS_ENABLED` +
`TENANT_JOB_FANOUT_ENABLED`. Phase 2.42 confirms this still holds.

### Cumulative

Notifications: equivalence 11/11 + isolation 10/10 = **21/21**.
Cumulative across modules: **454/454** on real Postgres 16.

### Production behaviour change status

**None.** All required flags remain default `false`.

### Rollback

Configuration-only:
```sh
TENANT_PRISMA_PILOT_ENABLED=false
# OR
TENANT_PRISMA_PILOT_MODULES=    # remove 'notifications'
# OR
TENANT_AWARE_JOBS_ENABLED=false
TENANT_JOB_FANOUT_ENABLED=false
```

### Remaining blockers

- **Per-tenant `NotificationPreference`** — Phase 3 product question;
  schema migration + backfill required before tenant-scoped prefs
  can land.
- **Real email/SMS provider sending** — out of scope; not exercised
  by any harness.
- **Compliance ⇄ notifications direct coupling** — the compliance
  cron (Phase 2.41) does not call notifications fan-out today. If
  product wants cron-driven notifications for compliance events,
  that is a follow-up phase that still must call only
  `notifyUsersByRoles` per tenant inside the existing fan-out gate.

---

## Phase 2.43 — coupling consumer (no notifications-side change)

Phase 2.43 introduces a default-off opt-in
(`COMPLIANCE_NOTIFY_ON_ALERT=false`) that lets compliance call the
existing `notifyUsersByRoles` helper after a per-tenant alert tick.

- **No notifications-side code change.** The helper, recipient
  narrowing, and tenantId stamping are all unchanged from
  Phase 2.15.
- **No external provider invocation.** The coupling is in-app only.
- **No fan-out widening.** The existing fan-out gates
  (`TENANT_AWARE_JOBS_ENABLED` + `TENANT_JOB_FANOUT_ENABLED`) still
  govern whether `notifyUsersByRoles` writes anything.

The Phase 2.43 harness asserts source-level invariants on the
compliance side: raw `generateAlerts()` does not call notification
fan-out; `ComplianceCron` does not call notification helpers
directly; `ComplianceScheduler` does not call notification helpers
directly.

Notifications equivalence + isolation harnesses remain 11/11 + 10/10
PASS.

---

## Phase 2.45 — per-recipient notification dedup

Optional, default-off helper inside `NotificationsService` that
suppresses identical fan-out notifications for the same
`(tenantId, userId, type, relatedEntity, relatedEntityId)` within a
configurable window. See `SAAS_PHASE2_NOTIFICATIONS_DEDUP.md`.

- New flag: `NOTIFICATION_DEDUP_ENABLED=false` (default).
- New optional config: `NOTIFICATION_DEDUP_WINDOW_MINUTES=360` (default 6h).
- New private helper `createInAppWithDedup(data, tid)` used by both
  `notifyUsersByRoles` and `notifyUploaderAndRoles`. Compliance code
  unchanged — dedup gate lives entirely inside notifications.
- Both fan-out methods now return `{ created, deduped }`. Backward-
  compatible at the await site.
- `relatedEntityId` is required for dedup; without it the helper
  falls through to a plain create (type-only dedup is too coarse).

New annotation tag: `phase245-notifications-dedup` (allowed in both
`src/notifications/` and `src/compliance/` for the small relatedEntityId
helper site).

New harness: `notifications-dedup` — **12/12 PASS**.

Notifications harnesses still green:
- `notifications-equivalence` — 11/11
- `notifications-isolation` — 10/10

---

## Phase 2.46 — internal scan dedup

The four internal scheduled scans
(`checkExpiringCompliance` / `checkServiceDue` / `checkOverdue` /
`checkScheduledMaintenance`) now route their `notification.create`
through the Phase 2.45 `createInAppWithDedup` helper. No identity
change; existing `(relatedEntity='Vehicle'|'MaintenanceRecord',
relatedEntityId=<entity.id>, type=<NotificationType>)` is reused as
the dedup identity. See
`SAAS_PHASE2_NOTIFICATIONS_INTERNAL_SCAN_DEDUP.md`.

- Default-off via `NOTIFICATION_DEDUP_ENABLED=false`.
- Pre-existing 24h per-method probe inside each scan is unchanged;
  the new helper layer is additive.

New tag: `phase246-notifications-internal-scan-dedup`.

New harness: `notifications-internal-scan-dedup` — 13/13 PASS.

Cumulative notifications: equivalence 11/11 + isolation 10/10 +
dedup 12/12 + internal-scan-dedup 13/13 = **46/46**. Cumulative
across modules: **503/503**.

No production behaviour change with default flags.
