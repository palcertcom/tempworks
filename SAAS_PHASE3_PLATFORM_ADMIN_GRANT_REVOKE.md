# SaaS Phase 3.11 — PlatformAdmin Grant / Revoke Service + Audit Emission

Phase 3.11 introduces the first runtime surface that creates,
updates, or deletes `PlatformAdmin` rows. Every operation emits a
`PlatformAuditLog` row matching the schema added in Phase 3.10.

The service is module-only at this phase (no HTTP controller wired
into `AppModule`). The harness exercises it directly. A controller
+ `PlatformAdminGuard` wiring is the obvious follow-up; service
behaviour is already locked.

## Service summary

`src/saas/platform-admin/platform-admin.service.ts`

| Method | Signature | Audit action |
|---|---|---|
| `grant` | `(actorUserId, targetUserId, level, reason, ip?, userAgent?) → {action, targetUserId, level}` | `PLATFORM_ADMIN_GRANTED` (new row) / `PLATFORM_ADMIN_LEVEL_CHANGED` (existing row, different level) / `PLATFORM_ADMIN_GRANT_IDEMPOTENT` (existing row, same level) |
| `revoke` | `(actorUserId, targetUserId, reason, ip?, userAgent?) → {action, targetUserId}` | `PLATFORM_ADMIN_REVOKED` |
| `list` | `(actorUserId) → PlatformAdmin[]` | (no audit — read-only) |

## Authority model

- `assertSuperPlatformAdmin(actorUserId)` — internal guard called by
  every mutating method (and `list`):
  - actor must exist, be ACTIVE, not deletedAt
  - actor must have a `PlatformAdmin` row
  - actor's `level` must be `SUPER`
- Failure cases throw `ForbiddenException` with specific codes
  (`PLATFORM_ADMIN.MISSING_ACTOR`, `.ACTOR_INACTIVE`,
  `.ACTOR_NOT_PLATFORM_ADMIN`, `.ACTOR_NOT_SUPER`).
- `SUPPORT` and `OPERATOR` PlatformAdmins cannot grant or revoke.
  They may use other platform read endpoints (out of scope here)
  once the controller layer lands.

## Level semantics

`PlatformAdminLevel` = `SUPPORT | OPERATOR | SUPER`. Levels are
hierarchical for endpoint authorization elsewhere (`PlatformAdminGuard`)
but `grant`/`revoke` requires `SUPER` for any operation.

## Self-grant / self-revoke policy

- **Self-revoke is explicitly forbidden** (`SELF_REVOKE_FORBIDDEN`).
  Prevents an operator locking themselves out by mistake.
- **Self-grant is implicitly impossible** in steady-state: the
  actor must already be `SUPER` to grant, so re-granting themselves
  has no effect (idempotent). A cold-start "first SUPER" is
  bootstrapped by the Phase 3.5 backfill script (operator-run,
  three-gate) and not by this service.

## Duplicate-grant policy (deterministic)

Calling `grant(target, level)` against a target that already has a
PlatformAdmin row:
- **same level** → `PLATFORM_ADMIN_GRANT_IDEMPOTENT`. No DB row
  change. Audit row still written so the call is recorded.
- **different level** → `PLATFORM_ADMIN_LEVEL_CHANGED`. Existing row
  updated with `level`, `grantedBy = actorUserId`, `grantedAt = now()`.
  Audit row captures `previousLevel` and `newLevel`.

## Revoke semantics

`PlatformAdmin` has no soft-delete column. Revoke is a **hard
DELETE** of the row. The audit row is the only persistent record of
the previous grant. Documented as intentional; the audit trail is
authoritative.

## PlatformAuditLog emission schema

Every grant/revoke/idempotent call writes one row to
`platform_audit_logs`:

| field | value |
|---|---|
| `actorId` | `actorUserId` (text; no FK so system actors like `'phase350-backfill'` are admissible) |
| `tenantId` | null (platform-level operation) |
| `action` | one of `PLATFORM_ADMIN_GRANTED`, `PLATFORM_ADMIN_LEVEL_CHANGED`, `PLATFORM_ADMIN_GRANT_IDEMPOTENT`, `PLATFORM_ADMIN_REVOKED` |
| `reason` | caller-supplied; non-empty required |
| `target` | JSON: `{ targetUserId, level }` or `{ targetUserId, previousLevel, newLevel }` |
| `ip` | optional |
| `userAgent` | optional |
| `createdAt` | default `CURRENT_TIMESTAMP` |

## Endpoint suggestion (deferred)

Service is ready; controller wiring is a future increment. Suggested
shape:

```
POST   /_platform/admin/grants           body: { userId, level, reason }
DELETE /_platform/admin/grants/:userId   body: { reason }
GET    /_platform/admin/grants
```

All routes guarded by `PlatformAdminGuard` requiring `pa: true` +
`paLevel === 'SUPER'` + recent step-up MFA (the existing
`platform-admin.guard.ts` already implements this).

## Harness results

`saas:phase311-platform-admin-grant-revoke`: **22/22 PASS**

Coverage:
1-3. SUPER grants SUPPORT / OPERATOR / SUPER successfully.
4-5. OPERATOR / non-PlatformAdmin cannot grant (specific error codes).
6-7. Missing / deleted target rejected.
8. Duplicate-grant deterministic (IDEMPOTENT vs LEVEL_CHANGED).
9. Grant emits PlatformAuditLog (≥3 rows for the target that went
   through GRANT + IDEMPOTENT + LEVEL_CHANGED).
10-12. Revoke success; non-SUPER and non-PlatformAdmin rejected.
13. Self-revoke forbidden.
14. Revoke emits PlatformAuditLog.
15. List returns only PlatformAdmin rows.
16. Audit shape: `actorId`, `action`, `reason`, `target` all present
    and match.
17-18. PlatformAdminAccessService consistent with grant/revoke
    (granted → true; revoked → false).
19. JwtStrategy stamp reflects the latest state (`agencyIsSystem`
    derived from PlatformAdmin).
20-22. Cross-phase wiring + sentinel outputs.

Cumulative regression: **1043/1043 PASS** (1021 + 22).

## Validation

| Check | Result |
|---|---|
| `npx tsc --noEmit` | clean |
| `npx prisma validate` | clean |
| `npm run saas:schema-lint` | 0 issues |
| `npm run saas:scan:annotations` | 0 findings |
| `npm run saas:scan:raw-sql` | baseline unchanged |
| `saas:phase311-platform-admin-grant-revoke` | 22/22 PASS |
| `saas:phase310-platform-admin-cleanup-audit-log` | 18/18 PASS |
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

## Production behaviour status

**No new HTTP endpoint is registered.** The service is wired only
where callers explicitly construct it (today: the Phase 3.11
harness). Until Phase 3.12 lands the controller + module
registration, no operator-facing behaviour changes.

`PlatformAdminAccessService` and `JwtStrategy` continue to reflect
PlatformAdmin authority transparently — any rows the service creates
or deletes are immediately visible to authorization.

## Rollback

- If the service was invoked (manually or by future controller):
  - operator can `DELETE FROM platform_admins WHERE userId = $1`
    to undo a grant, or re-grant to restore.
  - `platform_audit_logs` rows are preserved as audit trail. Purge
    only under explicit operator policy.
- Code rollback: revert this commit. No schema rollback.

## Remaining blockers

- HTTP controller + `PlatformAdminGuard` wiring (Phase 3.12).
- Step-up MFA flow for the controller route.
- `tenantId` enrichment for `platform_audit_logs.tenantId` when an
  operation has a clear tenant context (currently always null).

## Recommended next phase

**Phase 3.12 — Controller + endpoint wiring.** Register a
`PlatformAdminController` exposing the three endpoints behind the
existing `PlatformAdminGuard`. Plug the controller into the (not
yet AppModule-registered) `PlatformAdminModule` and register the
module conditionally so the surface is opt-in per environment.

---

## Phase 3.12 addendum

`PlatformAdminController` exposes `POST/DELETE/GET /_platform/admin/grants`
behind `PlatformAdminGuard` + `PLATFORM_ADMIN_HTTP_ENABLED` feature
flag. Module-only (not yet imported by AppModule). Service-level
SUPER assertion remains as defense-in-depth. See
SAAS_PHASE3_PLATFORM_ADMIN_CONTROLLER.md.
