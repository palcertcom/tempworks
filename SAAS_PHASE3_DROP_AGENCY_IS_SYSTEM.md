# SaaS Phase 3.9 — Destructive Drop of Agency.isSystem

Phase 3.9 completes the retirement of the legacy `Agency.isSystem`
column. Platform-admin authority is now sourced **exclusively** from
`PlatformAdmin` rows.

## Migration

`backend/prisma/migrations/saas_phase39_drop_agency_is_system/`
- `migration.sql` — `ALTER TABLE "agencies" DROP COLUMN IF EXISTS "isSystem"`
- `migration.down.sql` — re-adds the column as `boolean NOT NULL DEFAULT false`. **Cannot restore original `isSystem=true` values** without a pre-migration DB backup or full-row snapshot.

The migration is destructive but tightly scoped — only the named
column is dropped; no other columns, indexes, constraints, or rows
are affected.

## Runtime authority summary

After Phase 3.9:

- `PlatformAdminAccessService.isPlatformAdmin(userId)` reads only
  `platform_admins.userId`. The legacy fallback branches are removed
  entirely.
- `PLATFORM_ADMIN_DUAL_READ_ENABLED` and `PLATFORM_ADMIN_LEGACY_AGENCY_FALLBACK`
  are **inert** — there is no column to read. They are accepted as
  no-ops for one release to keep older configuration files valid.
- `JwtStrategy.validate()` no longer selects `agency.isSystem`. The
  `agencyIsSystem` field on `req.user` is preserved (downstream
  compatibility) and now means "user has a PlatformAdmin row".
- `auth.service.ts` login response keeps `agencyIsSystem` and the
  nested `agency.isSystem` field, both derived from `PlatformAdmin`.
- `agencies.service.ts` no longer `OR isSystem: true` into queries;
  `'isSystem' in dto` payloads are silently dropped at create/update.
- `CreateAgencyDto` no longer declares the field.

## Runtime inventory

`backend/reports/saas/phase3/drop-agency-is-system.json` walks
`backend/src/**/*.ts` and confirms **0 non-comment `agency.isSystem`
authorization reads** outside the allow-list
(`src/saas/platform-admin/`, `src/agencies/`, `src/auth/auth.service*`).
The `recycle-bin` and `roles` references that mention "isSystem" are
for the unrelated `Role.isSystem` field and `CandidateTenant.isSystem`
interface, both intact.

## Updated harnesses

Phase 3.5/3.6/3.7/3.7B/3.8 harnesses were updated to reflect the
new defaults:

| Harness | Update |
|---|---|
| Phase 3.5 (`platform-admin-backfill-harness`) | Case 2 + 6: legacy criterion unreachable; backfill always reports 0 eligible. Case 11: agency row check by id (column dropped). |
| Phase 3.6 (`platform-admin-dual-read-guard`) | Case 1: legacy user without PlatformAdmin → false. Case 7: agency row check by id. Case 9: flag inert. Case 10: inventory expects 2 files (jwt.strategy.ts no longer matches). |
| Phase 3.7 (`platform-admin-jwt-dual-read`) | Case 1: legacy user stamps false. Case 5: flag inert. Case 8: `isExternalActor(uLegacy)=true` (now external). Case 11: agency row by id. |
| Phase 3.7B (`platform-admin-jwt-bake-check`) | Unchanged (shape + call-count only; values not asserted). |
| Phase 3.8 (`platform-admin-runtime-retirement`) | Case 3: fallback flag inert. Case 8: service has 0 `agency.isSystem` reads. Case 10: schema field REMOVED. |

Backfill / readiness / signal-agreement scripts have their SQL
`a."isSystem" = true` predicates replaced with `false` and
`COALESCE(a."isSystem", false) = false` with `true`, tagged
`phase390-agency-is-system-removed`. These scripts continue to run
read-only and report zeros for the legacy criterion.

## Harness results

`saas:phase390-drop-agency-is-system`: **14/14 PASS**

Cumulative regression: **1003/1003 PASS** (989 + 14).

## Validation

| Check | Result |
|---|---|
| `npx tsc --noEmit` | clean |
| `npx prisma validate` | clean |
| `npm run saas:schema-lint` | 0 issues |
| `npm run saas:scan:annotations` | 0 findings |
| `npm run saas:scan:raw-sql` | baseline unchanged |
| `saas:phase390-drop-agency-is-system` | 14/14 PASS |
| `saas:phase380-platform-admin-runtime-retirement` | 16/16 PASS |
| `saas:phase37b-platform-admin-jwt-bake-check` | 14/14 PASS |
| `saas:phase370-platform-admin-jwt-dual-read` | 15/15 PASS |
| `saas:phase360-platform-admin-dual-read-guard` | 14/14 PASS |
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

## Production behaviour

`PLATFORM_ADMIN_LEGACY_AGENCY_FALLBACK` becomes inert. Operators who
have been running with `=true` will now see legacy-only users lose
authority unless they have a `PlatformAdmin` row. **This is the
point of Phase 3.5/3.7B**: if the signal agreement report returned
`goPhase38: true` against the production-shaped clone (and the same
holds in production), every legacy user has a corresponding
`PlatformAdmin` row and the cutover is transparent.

`req.user.agencyIsSystem` is preserved at the JWT payload boundary;
no service-layer signature changes.

## Rollback

1. Run `migration.down.sql` to re-add the column with default false.
2. **CRITICAL DATA RECOVERY:** to restore which agencies had
   `isSystem=true`, either:
   - restore from the pre-Phase-3.9 DB backup, or
   - apply a saved full-row snapshot to flip the flag back on the
     affected agencies.
3. Revert the application code (Phase 3.9 commit) so service reads
   restart consuming the column.

Configuration-only rollback is **not** available. Operators must
either restore the column data or accept that the legacy fallback
is permanently inert.

## Remaining blockers

- The Phase 3.8 escape-hatch flag (`PLATFORM_ADMIN_LEGACY_AGENCY_FALLBACK`)
  should be removed in a follow-up cleanup after one release.
- `platform_audit_log` table is still absent; PlatformAdmin grants /
  revokes are not yet audited at runtime.

## Recommended next phase

**Phase 3.10 — Cleanup pass.** Remove inert flag references
(`PLATFORM_ADMIN_DUAL_READ_ENABLED`, `PLATFORM_ADMIN_LEGACY_AGENCY_FALLBACK`)
from source, scripts, and docs after the bake window completes. Add
the `platform_audit_log` table migration and wire `PlatformAdmin`
grants/revokes to emit audit rows.

---

## Phase 3.10 addendum

Inert flag references removed from runtime source. `platform_audit_logs`
table migration added (matches the existing Prisma `PlatformAuditLog`
model). PlatformAuditLog emission documented as **deferred** — there
is no runtime grant/revoke surface yet. See
SAAS_PHASE3_PLATFORM_ADMIN_CLEANUP_AUDIT_LOG.md.

---

## Phase 3.11 addendum

`PlatformAdminService` (grant / revoke / list) lands at
`src/saas/platform-admin/platform-admin.service.ts`. SUPER-only
authority gate; PlatformAuditLog emission for every operation. No
HTTP controller registered yet — service is module-only. See
SAAS_PHASE3_PLATFORM_ADMIN_GRANT_REVOKE.md.
