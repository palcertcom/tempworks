# SaaS Phase 3.5 — PlatformAdmin Backfill

## Purpose

Promote every active user currently attached to an `Agency.isSystem=true`
agency to a `PlatformAdmin{level: SUPER, grantedBy: 'phase350-backfill'}`
row. This populates the `platform_admins` table that Phase 3.0 surfaced
but did not yet wire to runtime — readying the dual-read guard work in
Phase 3.6.

## Legacy source

`Agency.isSystem` boolean. Users whose `User.agencyId` points to an
`isSystem=true` agency historically bypass tenant scoping and see
global data. This binary flag is overloaded; Phase 3.5 separates the
"platform admin authority" concern out of it.

## Target

`PlatformAdmin { id, userId, level, grantedBy, grantedAt }`
- `userId` is `@unique` — natural idempotency.
- `level = SUPER` for backfilled rows.
- `grantedBy = 'phase350-backfill'` so rollback is exact.

## Eligibility rules

A user is **eligible** when ALL apply:
- attached to an Agency with `isSystem = true`
- `User.deletedAt IS NULL`
- `User.status = 'ACTIVE'`
- no existing `PlatformAdmin` row for that `userId`

## Skipped / conflict buckets

| Bucket | Meaning | Treatment |
|---|---|---|
| `alreadyPlatformAdmin` | user already has a PlatformAdmin row | skipped — row not modified |
| `deletedOrInactiveUser` | `deletedAt IS NOT NULL` or `status <> 'ACTIVE'` | skipped |
| `missingUser` | orphan PlatformAdmin row (its userId no longer maps) | reported; not auto-fixed |
| `nonSystemAgency` | user not attached to an isSystem agency | not considered (eligibility filter) |
| `multipleSystemAgencies` | user appears in ≥2 isSystem agencies | reported; with current schema (`User.agencyId` single FK) this is always 0 |
| `ambiguousMembership` | unclear which platform-admin level applies | reserved; currently 0 |

## Dry-run / apply gates

Dry-run is the default. Apply requires **all three** to be true:
1. `PLATFORM_ADMIN_BACKFILL_ENABLED=true`
2. `PLATFORM_ADMIN_BACKFILL_APPLY=true`
3. `classifyRuntimeEnv() ∈ { SAFE_CLONE, SAFE_STAGING }`

If any apply gate is closed, the script writes a refusal report
**without opening the DB connection** (so a misconfigured host cannot
hang the operator's terminal).

## Idempotency

The apply runs a single `INSERT … ON CONFLICT ("userId") DO NOTHING`
per eligible user. Reruns insert 0 rows.

## PlatformAuditLog

**Deferred.** The Prisma schema declares a `PlatformAuditLog` model,
but no migration creates the `platform_audit_log` table. The backfill
script does NOT attempt to write to it. Each PlatformAdmin insert
carries `grantedBy='phase350-backfill'` instead, which is sufficient
for rollback. A future phase will add the migration + a runtime
emitter for the audit log.

## Rollback

If apply has not been run: revert commit only.

If apply has been run:
```sql
DELETE FROM platform_admins WHERE "grantedBy" = 'phase350-backfill';
```
This restores the pre-Phase-3.5 PlatformAdmin row set exactly. Other
PlatformAdmin rows (`grantedBy <> 'phase350-backfill'`) are untouched.
`Agency.isSystem` remains in place, so the legacy authorization path
continues to work even after rollback.

## Future phases

- **Phase 3.6 — Dual-read guard.** Wire a new `IsPlatformAdminGuard`
  that consults BOTH `PlatformAdmin` and `Agency.isSystem`, OR-ed
  together. Bakes the new signal for a release without changing
  effective behaviour.
- **Phase 3.7 — Switch endpoints.** Replace `Agency.isSystem` reads
  in admin-only endpoints with `PlatformAdmin` lookups (the dual-read
  guard provides the fallback).
- **Phase 3.8 — Retire `Agency.isSystem`.** Destructive migration to
  drop the column after a release of dual-read.

## Harness results

`saas:phase350-platform-admin-backfill-harness`: **16/16 PASS**

Coverage:
1. dry-run inserts zero rows
2. dry-run reports eligible system-agency user
3-5. apply refused for each closed gate (ENABLED=false, APPLY=false, UNSAFE classification)
6. apply inserts PlatformAdmin SUPER with the right `grantedBy`
7. existing PlatformAdmin row not modified (level/grantedBy preserved)
8. deleted/inactive users skipped
9. non-system agency users not promoted
10. multi-agency conflict count surfaced (deterministic — 0 with current schema)
11. `Agency.isSystem` unchanged after apply
12. rerun apply is idempotent (second run inserts 0)
13. PlatformAuditLog status documented (deferred)
14-16. cross-phase wiring intact + sentinel outputs present

## Validation

| Check | Result |
|---|---|
| `npx tsc --noEmit` | clean |
| `npx prisma validate` | clean |
| `npm run saas:schema-lint` | 0 issues |
| `npm run saas:scan:annotations` | 0 findings |
| `npm run saas:scan:raw-sql` | baseline unchanged |
| `saas:phase350-platform-admin-backfill-harness` | 16/16 PASS |
| `saas:phase340-drop-employee-global-uniques` | 20/20 PASS |
| `saas:phase330-per-tenant-unique-constraints` | 19/19 PASS |
| `saas:phase320-duplicate-cleanup-harness` | 22/22 PASS |
| `saas:phase310-readiness-check` | 16/16 PASS |
| `saas:phase300-product-migration-readiness` | 13/13 PASS |
| `saas:phase263-workflow-config-isolation` | 19/19 PASS |
| `saas:phase262-pipeline-mutation-isolation` | 17/17 PASS |
| `saas:phase261-pipeline-isolation` | 12/12 PASS |
| `saas:phase261-pipeline-equivalence` | 12/12 PASS |

Cumulative regression: **930/930 PASS** (914 + 16).

## Production behaviour change status

**None at runtime.** PlatformAdmin rows are now populated for the
isSystem-agency cohort, but no auth/guard/endpoint reads
`PlatformAdmin` yet. Authorization continues to flow through
`Agency.isSystem` until Phase 3.6 wires the dual-read guard.

## Recommended next phase

**Phase 3.6 — PlatformAdmin dual-read guard.** Wire a new
`IsPlatformAdminGuard` (or extend the existing tenant guard) that
checks BOTH `Agency.isSystem` and `PlatformAdmin` (OR-ed). No
behaviour change while both signals agree; sets up Phase 3.7/3.8
endpoint switch + flag retirement.

---

## Phase 3.6 addendum

Dual-read helper landed at `src/saas/platform-admin/platform-admin-access.service.ts`.
`isPlatformAdmin(userId)` OR-combines `Agency.isSystem` with
`PlatformAdmin`. Helper not yet wired into any guard/endpoint;
Phase 3.7 will switch JWT decode + service-layer consumers.

---

## Phase 3.7 addendum

PlatformAdmin rows now influence runtime authorization through the
JWT stamp. Backfilled rows (`grantedBy='phase350-backfill'`) grant
platform-admin access in every service that consumes
`actor.agencyIsSystem`. Flip `PLATFORM_ADMIN_DUAL_READ_ENABLED=false`
to revert.

---

## Phase 3.7B addendum

Operators must re-run the signal agreement report after applying
Phase 3.5 backfill in production to confirm `legacyOnly === 0`
before Phase 3.8 destructive migration. See
SAAS_PHASE3_PLATFORM_ADMIN_BAKE_VERIFICATION.md.

---

## Phase 3.8 addendum

PlatformAdmin row now grants platform authority on its own (Phase
3.8 default). Backfilled rows tagged `grantedBy='phase350-backfill'`
are the substrate for runtime authority. The Phase 3.5 backfill is
now strictly required before Phase 3.8 rollout in production to
avoid `legacyOnly > 0` users losing access.

---

## Phase 3.10 addendum

Inert flag references removed from runtime source. `platform_audit_logs`
table migration added (matches the existing Prisma `PlatformAuditLog`
model). PlatformAuditLog emission documented as **deferred** — there
is no runtime grant/revoke surface yet. See
SAAS_PHASE3_PLATFORM_ADMIN_CLEANUP_AUDIT_LOG.md.
