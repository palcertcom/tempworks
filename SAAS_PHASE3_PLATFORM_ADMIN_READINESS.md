# SaaS Phase 3.1 — PlatformAdmin Readiness

## Purpose
Inventory the population that would become a `PlatformAdmin` row
during the Phase 3.5 backfill, and surface conflicts that need
manual triage before any insert is gated.

## Environment safety
- SAFE_CLONE / SAFE_STAGING only.
- `BEGIN READ ONLY` wrapper.
- Source contains zero `INSERT/UPDATE/DELETE`.

## How to run
```
DATABASE_URL=postgres://… \
  npm run saas:phase310-platform-admin-readiness-report
```
Outputs:
- `backend/reports/saas/phase3/platform-admin-readiness-report.json`
- `backend/reports/saas/phase3/platform-admin-readiness-report.md`

## Report shape
- `modelExists` / `tableExists` — confirms the
  `platform_admins` table is in place.
- Counts:
  - users attached to `Agency.isSystem=true`
  - existing `PlatformAdmin` rows
  - users that would gain `level: SUPER` on backfill
- Conflicts:
  - already PlatformAdmin
  - inactive or deleted users
  - users linked to multiple isSystem agencies (anomaly)
  - PlatformAdmin rows whose userId no longer maps (orphan)

## Fixture run summary
- usersOnSystemAgency: 0 (fixture has no isSystem agency).
- existingPlatformAdmins: 0.
- wouldBackfill: 0.
- All conflict counts: 0.

## Go / no-go for Phase 3.5 backfill
- `wouldBackfill > 0` is the trigger.
- `multiAgency > 0` or `missingUser > 0` requires manual triage
  before the backfill apply step is enabled.
- The backfill itself remains gated behind a future
  `PLATFORM_ADMIN_BACKFILL_APPLY=true` + SAFE classification flag,
  added in Phase 3.5.

## Rollback
No data or schema changes. Revert script + docs only.

---

## Phase 3.5 addendum

Backfill script now exists (see SAAS_PHASE3_PLATFORM_ADMIN_BACKFILL.md).
Apply requires `PLATFORM_ADMIN_BACKFILL_ENABLED=true` + `_APPLY=true`
+ SAFE classification. Rollback:
`DELETE FROM platform_admins WHERE "grantedBy" = 'phase350-backfill'`.

---

## Phase 3.6 addendum

Dual-read helper added. Readiness report remains the right place to
identify pre-backfill conflicts before applying Phase 3.5 in
production; once Phase 3.5 has run, Phase 3.6 controls how runtime
access is resolved.
