# SaaS Phase 3.7 — JWT Platform-Admin Stamp Switched to Dual-Read

## Why `jwt.strategy.ts` is the switch point

The entire backend service layer reads platform-admin authority off
a single derived field: `req.user.agencyIsSystem`. Every consumer
(`agencies.service.ts`, `employees.service.ts`,
`applicants.service.ts`, `users.service.ts`,
`recycle-bin/*.service.ts`, `saas/jobs/tenant-job-fanout-planner.ts`,
etc.) reads this field and never queries `Agency.isSystem` directly.

Switching the **stamp** in `jwt.strategy.ts` therefore propagates the
new dual-read meaning to every consumer in one place, with no
signature changes downstream. This is the smallest viable switch.

## Old vs new `agencyIsSystem` semantics

| | Before Phase 3.7 | After Phase 3.7 |
|---|---|---|
| Source | `user.agency.isSystem` (single column read) | `PlatformAdminAccessService.isPlatformAdmin(user.id)` |
| Meaning | "user is on a Tempworks-root agency" | "user is a platform admin via legacy `Agency.isSystem` OR backfilled `PlatformAdmin` row" |
| Behaviour for legacy isSystem users | true | true (unchanged) |
| Behaviour for PlatformAdmin-only users (post Phase 3.5 backfill) | false | **true** |
| Behaviour for users with neither signal | false | false (unchanged) |

OR semantics never **removes** legacy access; it only **adds**
access for `PlatformAdmin` rows that were intentionally created in
Phase 3.5. Operators who want to revert to the strict legacy path
can flip the flag (see below).

## Flag behaviour

`PLATFORM_ADMIN_DUAL_READ_ENABLED` (default `true`):
- `'false'` → `PlatformAdminAccessService` ignores `PlatformAdmin`
  rows; the JWT stamp is identical to pre-Phase-3.7 behaviour.
- any other value → dual-read OR semantics.

The flag is captured at `PlatformAdminAccessService` construction
time, which matches the rest of the codebase's feature-flag
discipline (snapshot at boot for stable behaviour).

## Implementation

`backend/src/auth/strategies/jwt.strategy.ts`:
- New constructor parameter: `private platformAdminAccess: PlatformAdminAccessService`.
- `validate(payload)` flow unchanged for user lookup and
  inactive-status rejection.
- `agencyIsSystem` is now the result of
  `await this.platformAdminAccess.isPlatformAdmin(user.id)` instead
  of `user.agency?.isSystem ?? false`.
- Output shape preserved exactly: `{ id, email, firstName, lastName,
  role, roleId, agencyId, agencyIsSystem }`.

`backend/src/auth/auth.module.ts`:
- `PlatformAdminAccessService` added to `providers`. No new module
  imports needed (the service depends only on the global `PrismaService`).

## Downstream compatibility

Zero call-site changes. Every existing service-layer check
(`actor.agencyIsSystem !== true` in `isExternalActor`, etc.)
continues to work. The harness exercises one representative
downstream check (`isExternalActor`) against synthetic seeds and
confirms identical truth values for legacy / PlatformAdmin-only /
neither cohorts.

## Performance

One extra Prisma read per JWT validation when `PlatformAdmin` is
queried (legacy path short-circuits via `agency.isSystem === true`).
For `isSystem=true` users no extra query is made; for everyone else
this adds one indexed `findUnique` on `platform_admins.userId`
(the `@unique` index on userId makes this O(1)).

Caching is intentionally out of scope this phase. A future
Phase 3.7B may add a per-request cache or a JWT claim if metrics
show contention.

## PlatformAuditLog

Not written. `platform_audit_log` table absent. JwtStrategy
contains no `INSERT` SQL or `create` against the audit log model.
Documented as deferred until the additive table migration lands.

## Harness results

`saas:phase370-platform-admin-jwt-dual-read`: **15/15 PASS**

Coverage:
1-4. legacy / PlatformAdmin-only / both / neither user resolution
5. flag-off restores legacy-only stamping
6. inactive user → existing `UnauthorizedException` preserved
7. JWT output shape unchanged (8 keys exactly)
8. downstream `isExternalActor(actor)` produces identical results
9. `PlatformAdminAccessService` invoked exactly once per `validate`
10. `PlatformAuditLog` not written (table absent, no error)
11-12. `Agency.isSystem` and `PlatformAdmin` rows unchanged after stamping
13-15. Phase 3.6/3.5 wiring intact, sentinel outputs present

## Validation

| Check | Result |
|---|---|
| `npx tsc --noEmit` | clean |
| `npx prisma validate` | clean |
| `npm run saas:schema-lint` | 0 issues |
| `npm run saas:scan:annotations` | 0 findings |
| `npm run saas:scan:raw-sql` | baseline unchanged |
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

Cumulative regression: **959/959 PASS** (944 + 15).

## Production behaviour

**Effective change:** users with a `PlatformAdmin` row but whose
agency is no longer `isSystem=true` will now read as platform admins
in every service that consumes `actor.agencyIsSystem`. With
`PLATFORM_ADMIN_DUAL_READ_ENABLED=false`, behaviour is byte-identical
to pre-Phase-3.7.

If Phase 3.5 backfill has not yet been applied to production, this
phase is a no-op at runtime (no `PlatformAdmin` rows exist for
non-isSystem users).

## Rollback

- Configuration: `PLATFORM_ADMIN_DUAL_READ_ENABLED=false` reverts the
  JWT stamp to legacy-only without redeploying.
- Code: revert the JwtStrategy injection + the AuthModule provider
  addition (commit `<phase 3.7 hash>`).
- No data or schema state to undo.

## Recommended next phase

**Phase 3.8 — Retire `Agency.isSystem`.** Destructive migration to
drop the `Agency.isSystem` column after a release of Phase 3.7
under dual-read. Requires:
- Phase 3.5 PlatformAdmin backfill applied to production
- Phase 3.7 baked ≥1 release under dual-read
- Operator sign-off + DB backup
- Service-layer usages of `actor.agencyIsSystem` continue to work
  unchanged (the field is now derived from `PlatformAdmin` only).

---

## Phase 3.7B addendum

Bake verification layer added: read-only signal agreement report
(`saas:phase37b-platform-admin-signal-agreement-report`) with
explicit `goPhase38` field, plus JWT bake check
(`saas:phase37b-platform-admin-jwt-bake-check`) with shape +
exactly-one-extra-lookup invariants and local timing probe. Phase
3.8 must wait until the bake checklist completes against a
production-shaped clone. See SAAS_PHASE3_PLATFORM_ADMIN_BAKE_VERIFICATION.md.

---

## Phase 3.8 addendum

Phase 3.8 supersedes the default semantics described above. As of
Phase 3.8 default:
- PlatformAdmin row is the SOLE source of authority.
- `Agency.isSystem` is read only when
  `PLATFORM_ADMIN_LEGACY_AGENCY_FALLBACK=true`.

The Phase 3.7 OR semantics this doc describes are now reachable via
the fallback flag. The Phase 3.7 harness sets the flag at the top
of its module to keep its OR-semantics assertions valid; this is
explicit, not silent. See SAAS_PHASE3_PLATFORM_ADMIN_RUNTIME_RETIREMENT.md.

---

## Phase 3.10 addendum

Inert flag references removed from runtime source. `platform_audit_logs`
table migration added (matches the existing Prisma `PlatformAuditLog`
model). PlatformAuditLog emission documented as **deferred** — there
is no runtime grant/revoke surface yet. See
SAAS_PHASE3_PLATFORM_ADMIN_CLEANUP_AUDIT_LOG.md.
