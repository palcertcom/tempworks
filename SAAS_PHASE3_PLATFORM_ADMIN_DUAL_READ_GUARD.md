# SaaS Phase 3.6 — PlatformAdmin Dual-Read Guard

## Purpose

Introduce a central helper that answers "is user X a platform admin?"
by reading **both** the legacy `Agency.isSystem` signal and the new
`PlatformAdmin` row. OR semantics — either signal granting access is
sufficient. Behaviour is unchanged whenever both signals agree (the
common case after Phase 3.5 backfill).

The helper is the substrate for Phase 3.7 (endpoint switch). It is
NOT wired into any guard or controller in this phase; the harness
exercises it directly.

## Legacy signal
`user.agency.isSystem === true`

## New signal
A `PlatformAdmin` row exists for `user.id` and its `level` is one of
`SUPPORT`, `OPERATOR`, or `SUPER`.

## OR semantics
```
isPlatformAdmin(userId) =
     user is ACTIVE and not deleted
  AND ( user.agency.isSystem === true
        OR (PLATFORM_ADMIN_DUAL_READ_ENABLED !== 'false'
            AND PlatformAdmin row exists for user.id) )
```

Inactive/deleted users return `false` regardless of either signal.

## Flag behaviour
`PLATFORM_ADMIN_DUAL_READ_ENABLED` (default `true`):
- `'false'` → legacy-only. `PlatformAdmin` is ignored.
- any other value → dual-read (legacy OR PlatformAdmin).

Default `true` is safe because OR-semantics never **removes** access:
- legacy `isSystem` users keep access exactly as before;
- backfilled `PlatformAdmin` users gain access matching what Phase
  3.5 intentionally granted them.

Operators uncomfortable with the second clause can flip to `false`
to restore the strict legacy path; rollback is configuration-only.

## Implementation

`backend/src/saas/platform-admin/platform-admin-access.service.ts`
- Single method: `isPlatformAdmin(userId): Promise<boolean>`
- Optional helper: `assertPlatformAdmin(userId)`
- Read-only: two Prisma reads (`user.findFirst`, `platformAdmin.findUnique`)
- No data mutation
- No `PlatformAuditLog` write (table absent; deferred)
- Reads `PLATFORM_ADMIN_DUAL_READ_ENABLED` at construction time so the
  result is stable across a request

## Agency.isSystem inventory

The harness walks `backend/src/**/*.ts` and records every line that
references `isSystem` outside comments. Findings are surfaced in
`backend/reports/saas/phase3/platform-admin-dual-read-guard.{json,md}`
so Phase 3.7 can drive the endpoint switch from a known catalog.

Confirmed call-sites in the current code (the harness asserts the
following minimum subset is present):

- `src/auth/strategies/jwt.strategy.ts` — JWT decode sets
  `agencyIsSystem` on `req.user`.
- `src/auth/auth.service.ts` — login response includes `agencyIsSystem`.
- `src/agencies/agencies.service.ts` — multiple actor-scope checks
  (`isExternalActor`, `tenantWherePlusSystem`, `assertAgencyAccess`).
- `src/employees/employees.service.ts`, `src/applicants/applicants.service.ts`,
  `src/users/users.service.ts`, `src/roles/roles.service.ts`,
  `src/recycle-bin/{recycle-bin,hard-delete}.service.ts`,
  `src/saas/jobs/tenant-job-fanout-planner.ts`.

Phase 3.7 will route each of these through
`PlatformAdminAccessService.isPlatformAdmin` (or its synchronous
JWT-claim equivalent stamped at decode time), preserving signatures
and observable behaviour.

## Switched vs deferred paths
- **Switched in this phase:** none. Only the helper is added.
- **Deferred to Phase 3.7:** JWT decode, all service-layer `agencyIsSystem`
  consumers, and the existing `PlatformAdminGuard` (which reads JWT
  claims and will be wired alongside the decode change).

## PlatformAuditLog

Not written. The `platform_audit_log` table is absent in the active
DB. The service contains no `INSERT` SQL or Prisma `create` call
against the audit log model. Documented as deferred until the
migration creating the table lands.

## Harness results

`saas:phase360-platform-admin-dual-read-guard`: **14/14 PASS**

Coverage:
1-5. legacy / new / both / neither / deleted user resolution
6-7. PlatformAdmin and Agency rows unchanged after probing
8. missing user → `false` without throwing
9. flag-off (`PLATFORM_ADMIN_DUAL_READ_ENABLED=false`) falls back to legacy
10. source-level inventory enumerates Agency.isSystem call sites
11. PlatformAuditLog write not attempted (table absent, no error)
12-14. Phase 3.5/3.4 wiring intact, cumulative sentinel outputs present

## Validation

| Check | Result |
|---|---|
| `npx tsc --noEmit` | clean |
| `npx prisma validate` | clean |
| `npm run saas:schema-lint` | 0 issues |
| `npm run saas:scan:annotations` | 0 findings |
| `npm run saas:scan:raw-sql` | baseline unchanged |
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

Cumulative regression: **944/944 PASS** (930 + 14).

## Production behaviour

**Unchanged at runtime.** The helper is not yet consumed by any
guard, controller, or service. Authorization continues to flow
through `Agency.isSystem` exclusively until Phase 3.7 wires the
switch.

## Rollback

- Configuration: `PLATFORM_ADMIN_DUAL_READ_ENABLED=false` reverts the
  helper to legacy-only.
- Code: revert the commit — the helper file, the harness, the npm
  script, the scanner tags. No data or schema state to undo.

## Recommended next phase

**Phase 3.7 — Switch endpoints to PlatformAdminAccessService.** Use
the inventory produced by this phase to route each `agencyIsSystem`
consumer through the new helper, starting with `jwt.strategy.ts`
(which stamps `req.user.agencyIsSystem`) and the `auth.service.ts`
login response. Bake under dual-read for one release before Phase
3.8 retires `Agency.isSystem`.

---

## Phase 3.7 addendum

JwtStrategy now injects PlatformAdminAccessService and stamps
`req.user.agencyIsSystem` with the OR result. Downstream consumers
(`actor.agencyIsSystem`) require no signature change. Harness 15/15
PASS. See SAAS_PHASE3_PLATFORM_ADMIN_JWT_DUAL_READ.md.

---

## Phase 3.7B addendum

Signal agreement report enables operator-side go/no-go for the
upcoming Phase 3.8 destructive migration. See
SAAS_PHASE3_PLATFORM_ADMIN_BAKE_VERIFICATION.md.

---

## Phase 3.8 addendum

The dual-read guard helper has been refactored under Phase 3.8 to
make PlatformAdmin authoritative. The OR semantics this doc describes
remain reachable via `PLATFORM_ADMIN_LEGACY_AGENCY_FALLBACK=true`.
Phase 3.6 harness sets the flag at the top of its module to preserve
its OR-semantics assertions. See SAAS_PHASE3_PLATFORM_ADMIN_RUNTIME_RETIREMENT.md.

---

## Phase 3.10 addendum

Inert flag references removed from runtime source. `platform_audit_logs`
table migration added (matches the existing Prisma `PlatformAuditLog`
model). PlatformAuditLog emission documented as **deferred** — there
is no runtime grant/revoke surface yet. See
SAAS_PHASE3_PLATFORM_ADMIN_CLEANUP_AUDIT_LOG.md.
