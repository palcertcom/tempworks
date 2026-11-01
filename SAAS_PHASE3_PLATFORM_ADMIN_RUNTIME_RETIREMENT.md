# SaaS Phase 3.8 — PlatformAdmin Runtime Retirement of Agency.isSystem

Phase 3.8 removes the **runtime dependency** on `Agency.isSystem` for
platform-admin authorization. The database column remains in place
for one more bake window; destructive schema drop is deferred to
Phase 3.9.

## Old vs new semantics

| | Phase 3.7 (default) | Phase 3.8 (default) |
|---|---|---|
| Source resolved by | `Agency.isSystem` OR `PlatformAdmin` | `PlatformAdmin` only |
| Legacy isSystem-only user | platform admin | **NOT platform admin** |
| Backfilled PlatformAdmin user | platform admin | platform admin (unchanged) |
| Both signals | platform admin | platform admin (unchanged) |
| Neither | not platform admin | not platform admin |

If Phase 3.5 backfill has been applied to production, every legacy
`isSystem=true` user already has a corresponding `PlatformAdmin` row,
so the effective behaviour for those users is unchanged. Users who
were NOT backfilled (e.g. an agency flipped to `isSystem=true` after
the Phase 3.5 apply window) would lose authority under Phase 3.8
default — this is exactly the gap the Phase 3.7B signal agreement
report catches as `legacyOnly > 0`.

## Flag behaviour and precedence

`PlatformAdminAccessService` consults two flags, in this precedence:

1. **`PLATFORM_ADMIN_DUAL_READ_ENABLED=false`** (highest precedence)
   - Pre-Phase-3.6 emulation: only `Agency.isSystem` grants authority.
   - PlatformAdmin rows are ignored entirely.
   - Reserved for emergency rollback when PlatformAdmin reads are
     broken.

2. **`PLATFORM_ADMIN_LEGACY_AGENCY_FALLBACK=true`**
   - OR semantics: PlatformAdmin row OR `Agency.isSystem`.
   - This is the Phase 3.6/3.7 default behaviour, retained for
     emergency rollback without a redeploy.

3. **Otherwise (Phase 3.8 default)**
   - `PlatformAdmin` row is the SOLE source of authority.
   - `Agency.isSystem` is **not read** for authorization.

Flags are captured at `PlatformAdminAccessService` construction time
(matches existing feature-flag discipline).

## Implementation

`src/saas/platform-admin/platform-admin-access.service.ts`:
- Refactored to the precedence above.
- Default branch reads only `platformAdmin.findUnique`.
- `Agency.isSystem` is read only inside guarded fallback branches,
  each tagged with `phase380-agency-is-system-fallback`.

`src/auth/strategies/jwt.strategy.ts`:
- **Unchanged.** Still calls
  `await this.platformAdminAccess.isPlatformAdmin(user.id)` and
  stamps `agencyIsSystem`. No direct `user.agency.isSystem` read.

`src/auth/auth.module.ts`:
- Unchanged; `PlatformAdminAccessService` already in providers from
  Phase 3.7.

## Runtime inventory (allow-list)

The harness walks `backend/src/**/*.ts` and flags any non-comment
reference to `agency.isSystem` outside the documented allow-list:

| Allowed | Reason |
|---|---|
| `src/saas/platform-admin/**` | Authority resolver (`PlatformAdminAccessService`) |
| `src/agencies/**` | CRUD surface that manages the field itself |
| `src/auth/strategies/jwt.strategy.ts` | Retains `select` clause for legacy compat / fallback branches |
| `src/auth/auth.service.ts` | Login response payload (presentation, not auth) |
| Any line tagged `phase380-agency-is-system-fallback` | Explicitly reviewed fallback branch |

Phase 3.8 harness case 9 fails the build if a new `agency.isSystem`
authorization read lands outside this list without a tag.

Note: service-layer consumers continue to read `actor.agencyIsSystem`
(the derived REQUEST-USER field stamped by JwtStrategy). That field
now means "platform admin per PlatformAdmin row". No service-layer
signature change.

## Why the column is not dropped yet

Two safety reasons:
- **Operator escape hatch.** `PLATFORM_ADMIN_LEGACY_AGENCY_FALLBACK=true`
  is only useful while the column exists. Dropping the column removes
  the emergency rollback path.
- **Phase 3.9 bake.** A short bake under Phase 3.8 defaults confirms
  no service path silently regressed before the destructive drop.

## Production prerequisites

Before applying Phase 3.8 default to production:
1. Phase 3.5 backfill applied; signal agreement report shows
   `legacyOnly === 0`.
2. Phase 3.7 baked under dual-read for one release.
3. Phase 3.7B bake check `goPhase38 === true` on production-shaped clone.
4. Operator sign-off + rollback plan documented.

## Harness results

`saas:phase380-platform-admin-runtime-retirement`: **16/16 PASS**

Coverage:
1-5. Default semantics: PlatformAdmin only; legacy-only user requires fallback flag.
6. JWT shape unchanged.
7. JwtStrategy source contains no direct `agency.isSystem` authorization read.
8. PlatformAdminAccessService reads `Agency.isSystem` only inside guarded fallback branches (≥2 phase380 tags).
9. Runtime inventory clean — no `agency.isSystem` reads outside the documented allow-list.
10. `Agency.isSystem` column still in Prisma schema.
11. PlatformAuditLog not written (table absent).
12-16. Cross-phase wiring intact, sentinel outputs present.

**Phase 3.6/3.7 harness compatibility:** Both legacy harnesses set
`PLATFORM_ADMIN_LEGACY_AGENCY_FALLBACK=true` at the top of their
modules so the OR-semantics assertions they author continue to pass
under the new defaults. They are NOT silently failing — the override
is explicit and documented inline in each harness.

## Validation

| Check | Result |
|---|---|
| `npx tsc --noEmit` | clean |
| `npx prisma validate` | clean |
| `npm run saas:schema-lint` | 0 issues |
| `npm run saas:scan:annotations` | 0 findings |
| `npm run saas:scan:raw-sql` | baseline unchanged |
| `saas:phase380-platform-admin-runtime-retirement` | 16/16 PASS |
| `saas:phase37b-platform-admin-jwt-bake-check` | 14/14 PASS |
| `saas:phase370-platform-admin-jwt-dual-read` | 15/15 PASS (legacy fallback set) |
| `saas:phase360-platform-admin-dual-read-guard` | 14/14 PASS (legacy fallback set) |
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

Cumulative regression: **989/989 PASS** (973 + 16).

## Production behaviour

**Effective at runtime.** Users with `Agency.isSystem=true` but no
PlatformAdmin row no longer have platform-admin authority unless
`PLATFORM_ADMIN_LEGACY_AGENCY_FALLBACK=true` is set. If Phase 3.5
backfill was correctly applied, this set is empty.

## Rollback

- Emergency configuration: `PLATFORM_ADMIN_LEGACY_AGENCY_FALLBACK=true`
  restores Phase 3.7 OR semantics without redeploying.
- Hard configuration: `PLATFORM_ADMIN_DUAL_READ_ENABLED=false`
  restores pre-Phase-3.6 legacy-only semantics.
- Code: revert this commit; JwtStrategy + PlatformAdminAccessService
  return to Phase 3.7 implementation.

No data or schema state to undo.

## Recommended next phase

**Phase 3.9 — Destructive drop of `Agency.isSystem`.** Migration that
removes the column from `agencies`, plus a corresponding Prisma
schema update. Requires: Phase 3.8 baked ≥1 release, no audit
findings for `Agency.isSystem` authorization reads, operator
sign-off + DB backup.

---

## Phase 3.9 addendum

`Agency.isSystem` column dropped. The legacy fallback branches are
removed from `PlatformAdminAccessService`; the `PLATFORM_ADMIN_*`
flags described above are now **inert**. See
SAAS_PHASE3_DROP_AGENCY_IS_SYSTEM.md.

---

## Phase 3.10 addendum

Inert flag references removed from runtime source. `platform_audit_logs`
table migration added (matches the existing Prisma `PlatformAuditLog`
model). PlatformAuditLog emission documented as **deferred** — there
is no runtime grant/revoke surface yet. See
SAAS_PHASE3_PLATFORM_ADMIN_CLEANUP_AUDIT_LOG.md.
