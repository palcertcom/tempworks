# SaaS Phase 3.12 — PlatformAdmin Controller + Endpoint Wiring

Phase 3.12 exposes `PlatformAdminService` through three guarded HTTP
endpoints under `/_platform/admin/grants`. The surface is feature-
flagged off by default and module-only (no `AppModule` registration
in this phase) so production traffic is unaffected until an operator
opts in.

## Endpoints

| Method | Path | Required `paLevel` | Body |
|---|---|---|---|
| POST | `/_platform/admin/grants` | `SUPER` | `{ userId, level, reason }` |
| DELETE | `/_platform/admin/grants/:userId` | `SUPER` | `{ reason }` |
| GET | `/_platform/admin/grants` | `SUPPORT` | — |

`level ∈ { SUPPORT, OPERATOR, SUPER }`. Body validated by
`GrantPlatformAdminDto` / `RevokePlatformAdminDto` (`class-validator`).

## Security model

Three layers, each closes independently of the others:

1. **Feature flag** — `PLATFORM_ADMIN_HTTP_ENABLED=true` is required.
   When unset / `false`, every handler throws
   `NotFoundException({ code: 'PLATFORM_ADMIN.HTTP_DISABLED' })`
   (404 rather than 403 so the surface is indistinguishable from
   "no such route").

2. **`PlatformAdminGuard`** (existing) — applied via
   `@UseGuards(PlatformAdminGuard)` on the controller. The guard
   requires JWT claims:
   - `pa: true`
   - `paLevel` ≥ the level declared by `@RequirePlatformAdmin(...)`
     on the handler (SUPER for grant/revoke, SUPPORT for list)
   - `paMfaAt` within 30 minutes (step-up MFA freshness)

3. **Service-level `assertSuperPlatformAdmin`** (defense-in-depth) —
   even if the guard is misconfigured, `PlatformAdminService.grant`
   and `.revoke` independently verify the actor is `SUPER`. The
   harness exercises this layer directly by calling the controller
   methods (which bypass the decorator-applied guard in unit context).

Additional invariants:
- Self-revoke is rejected by the service with
  `SELF_REVOKE_FORBIDDEN`.
- Reason is required (non-empty) for grant and revoke.
- Target user must be ACTIVE and not soft-deleted for grant.
- Duplicate-grant policy is deterministic (Phase 3.11):
  same level → `PLATFORM_ADMIN_GRANT_IDEMPOTENT`, different level →
  `PLATFORM_ADMIN_LEVEL_CHANGED`.

## Why not registered in AppModule yet

Two reasons:
- `PlatformAdminGuard` requires step-up MFA, which requires a paired
  challenge endpoint that is not yet implemented.
- The endpoint shape may need product-side review (rate limits,
  audit log download surface, list pagination).

`PlatformAdminModule` already declares the controller + service; the
module is simply not imported by `AppModule`. Operators opt in by
adding the import + setting `PLATFORM_ADMIN_HTTP_ENABLED=true`.

## Harness results

`saas:phase312-platform-admin-controller`: **16/16 PASS**

Coverage:
1. Flag off → all three routes throw `HTTP_DISABLED`.
2-4. SUPER actor can grant SUPPORT / OPERATOR / SUPER.
5-7. SUPPORT, OPERATOR, non-PlatformAdmin all rejected at the
service layer (defense-in-depth).
8. SUPER can revoke another PlatformAdmin row.
9. Self-revoke rejected (`SELF_REVOKE_FORBIDDEN`).
10. List returns PlatformAdmin rows.
11-12. Grant / revoke each emit a `PlatformAuditLog` row.
13. Duplicate-grant deterministic (idempotent vs level-change).
14. Source-level: controller contains no direct Prisma reads;
delegates only to `PlatformAdminService`.
15-16. Phase 3.11 wiring + cumulative sentinel outputs intact.

Cumulative regression: **1059/1059 PASS** (1043 + 16).

## Validation

| Check | Result |
|---|---|
| `npx tsc --noEmit` | clean |
| `npx prisma validate` | clean |
| `npm run saas:schema-lint` | 0 issues |
| `npm run saas:scan:annotations` | 0 findings |
| `npm run saas:scan:raw-sql` | baseline unchanged |
| `saas:phase312-platform-admin-controller` | 16/16 PASS |
| `saas:phase311-platform-admin-grant-revoke` | 22/22 PASS |
| `saas:phase310-platform-admin-cleanup-audit-log` | 18/18 PASS |
| `saas:phase390-drop-agency-is-system` | 14/14 PASS |
| `saas:phase380-platform-admin-runtime-retirement` | 16/16 PASS |
| `saas:phase263-workflow-config-isolation` | 19/19 PASS |
| `saas:phase262-pipeline-mutation-isolation` | 17/17 PASS |
| `saas:phase261-pipeline-isolation` | 12/12 PASS |
| `saas:phase261-pipeline-equivalence` | 12/12 PASS |

## Production behaviour status

**No new HTTP surface is reachable** because:
- `PLATFORM_ADMIN_HTTP_ENABLED` is unset (default), so every handler
  short-circuits with 404.
- `PlatformAdminModule` is not yet wired into `AppModule`.

Either of those gates is sufficient on its own. Both must be flipped
for the surface to go live.

## Rollback

- Configuration: leave `PLATFORM_ADMIN_HTTP_ENABLED` unset or `false`.
- Code: revert this commit (`db8dd15..`). The controller, DTOs, and
  harness disappear; service from Phase 3.11 remains and is reachable
  only via direct service invocation (its existing harness).

No data or schema state to undo.

## Recommended next phase

**Phase 3.13 — Module registration + step-up MFA wiring.** Register
`PlatformAdminModule` in `AppModule` (still flag-gated). Wire the
step-up MFA challenge endpoint that `PlatformAdminGuard` expects via
`paMfaAt`. After that, an operator can enable the surface by setting
`PLATFORM_ADMIN_HTTP_ENABLED=true` and `PLATFORM_ADMIN_ENABLED=true`.
