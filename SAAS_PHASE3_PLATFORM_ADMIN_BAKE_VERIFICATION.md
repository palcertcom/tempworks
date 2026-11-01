# SaaS Phase 3.7B — PlatformAdmin Dual-Read Bake Verification

Phase 3.7B is a verification-only layer that proves Phase 3.7 is
behaving as intended in production-shaped clones before Phase 3.8
runs the destructive drop of `Agency.isSystem`.

## Two read-only scripts

### 1. Signal agreement report
`saas:phase37b-platform-admin-signal-agreement-report`

Compares the legacy `Agency.isSystem` signal with the new
`PlatformAdmin` row across the active user base and surfaces the
go/no-go decision for Phase 3.8.

Counts emitted:
- `totalActiveUsers`
- `legacyTrue` — users on `Agency.isSystem=true`
- `platformRow` — users with a `PlatformAdmin` row
- `agreementBoth` — both signals true
- `legacyOnly` — legacy true, no PlatformAdmin row **(blocker for Phase 3.8)**
- `platformOnly` — PlatformAdmin row, agency not isSystem (intended Phase 3.5 outcome)
- `neither` — every other active user
- `inactivePlatform` — PlatformAdmin rows pointing at deleted/inactive users
- `missingAgencyOnPlatform` — PlatformAdmin users whose `user.agencyId` no longer maps

Go/no-go rules:
- `legacyOnly === 0` (every isSystem user must have a PlatformAdmin
  row before the column can be retired)
- `inactivePlatform === 0` (orphans must be triaged)
- `missingAgencyOnPlatform === 0` (broken FKs must be repaired)
- `totalActiveUsers > 0`

If all four are true, `goPhase38 === true` and the operator can
schedule the Phase 3.8 destructive migration.

### 2. JWT dual-read bake check
`saas:phase37b-platform-admin-jwt-bake-check`

Constructs the real `JwtStrategy` with a counting wrapper of
`PlatformAdminAccessService` and validates:
- the JWT output shape is stable (8 keys exactly: `id`, `email`,
  `firstName`, `lastName`, `role`, `roleId`, `agencyId`,
  `agencyIsSystem`)
- exactly one `PlatformAdminAccessService.isPlatformAdmin` call per
  validate (no double lookups)
- avg / p95 / p99 timings over 50 synthetic validations
  - **fixture run: avg ≈ 3.7ms, p95 ≈ 6.7ms, p99 ≈ 7.3ms**
  - the absolute numbers are **local-only**; a production p95/p99 is
    a separate measurement against real load and is the operator's
    responsibility before Phase 3.8

The bake check also runs the signal agreement report and asserts
its read-only invariants from source (`BEGIN READ ONLY` wrapper,
no `INSERT/UPDATE/DELETE` outside template-literal seed regions).

## Bake checklist (production)

1. Apply Phase 3.5 backfill on the production-shaped staging clone.
2. Confirm `PLATFORM_ADMIN_DUAL_READ_ENABLED=true` (default).
3. Roll Phase 3.7 to production (JWT switch).
4. Run `saas:phase37b-platform-admin-signal-agreement-report`
   against the production-shaped clone.
   - Expect `legacyOnly === 0`. If non-zero, re-run Phase 3.5
     backfill against production before continuing.
5. Monitor auth metrics for 24-48h or one full release:
   - JWT validation latency p95/p99
   - Login error rate
   - 401 rate on platform-admin-only endpoints
6. If anything regresses, set `PLATFORM_ADMIN_DUAL_READ_ENABLED=false`
   to revert without a deploy.
7. Once the bake window completes cleanly, re-run the signal
   agreement report and confirm `goPhase38 === true`.
8. Schedule Phase 3.8 destructive migration.

## Minimum bake window

24-48 hours of normal production traffic, OR one full release cycle,
whichever is longer. Operators should not shorten this even if the
signal agreement report is clean — the bake exists primarily to
catch latency issues from the extra `platform_admins.userId`
lookup, not just correctness.

## Rollback

Configuration-only:
```
PLATFORM_ADMIN_DUAL_READ_ENABLED=false
```
This reverts the JWT stamp to legacy-only semantics. No data or
schema state to undo.

## Harness results

`saas:phase37b-platform-admin-jwt-bake-check`: **14/14 PASS**

Cumulative regression: **973/973 PASS** (959 + 14).

## Production behaviour status

Unchanged from Phase 3.7. The bake scripts are read-only and add no
runtime code paths.

## Recommended next phase

**Phase 3.8 — Retire `Agency.isSystem`.** Only after the bake
checklist has been completed and the signal agreement report
returns `goPhase38: true` against the production-shaped clone.

---

## Phase 3.8 addendum

Phase 3.8 supersedes Phase 3.7 dual-read by default. The bake
verification scripts remain useful but now answer different
questions:
- signal agreement: still drives go/no-go for Phase 3.9 schema drop
  (rather than Phase 3.8 enablement)
- jwt bake check: shape + call-count invariants are unchanged

See SAAS_PHASE3_PLATFORM_ADMIN_RUNTIME_RETIREMENT.md.
