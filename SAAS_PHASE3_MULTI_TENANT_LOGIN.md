# SaaS Phase 3.17 — Multi-tenant login via TenantMembership

Lets a single `User` row (one human, one email) belong to multiple
tenants. `/auth/login-v2` now resolves the user × tenant pair via the
existing `tenant_memberships` join table, and the active session
carries the tenant on the JWT so downstream code can authorise without
a second DB hop.

## Why

Before 3.17, login resolved the user via the agency-tenant join
(`agency.tenantId`). Because `User.email` is globally unique and each
`User` row points to exactly one `Agency`, the same person could only
ever log in to one tenant. To work in two tenants you needed two
separate accounts.

3.17 keeps the email globally unique (one User per human) and uses
the many-to-many `TenantMembership(userId, tenantId)` table — already
present in the schema since Phase 1 — as the authority for "can this
user reach this tenant".

## What changed

### Backend

* `backend/src/auth/auth.service.ts`
  * `loginV2` now:
    * resolves the tenant from `company` (slug → customDomain) — unchanged.
    * looks up the User by email globally.
    * requires an `ACTIVE` `TenantMembership(userId, tenantId)`.
    * **legacy backfill**: if no membership exists but the user's
      primary `agency.tenantId === tenant.id`, create the membership
      row on the fly so subsequent logins go through the membership
      path. No data migration needed — existing users heal on first
      login.
    * stamps `tenantId` + `membershipId` into the JWT via
      `generateTokens` so tenant-aware routes can authorise from the
      token.
  * New `switchTenant(userId, tenantId)` — re-issues a JWT bound to a
    different tenant the user has an `ACTIVE` membership in. Rejects
    with `AUTH.TENANT_MEMBERSHIP_REQUIRED` otherwise.
  * `getMe` now returns a `memberships: [...]` array listing every
    `ACTIVE` membership the user has, so the topbar can offer a
    tenant picker without an extra call.
  * `finalizeLogin` accepts an optional `session: { tenantId,
    membershipId }` so the regular legacy `/auth/login` flow can
    propagate tenant context too when the caller has it.

* `backend/src/auth/strategies/jwt.strategy.ts` — surfaces
  `tenantId` and `membershipId` on `req.user`.

* `backend/src/auth/auth.controller.ts` — new
  `POST /auth/switch-tenant { tenantId }`.

* `backend/src/tenants/tenants.controller.ts` +
  `backend/src/tenants/tenants.service.ts` — new endpoints under
  the existing PlatformAdmin-gated `/tenants` surface:
  * `GET    /tenants/:id/memberships` (SUPPORT+)
  * `POST   /tenants/:id/memberships { userId }` (SUPER) — grant
  * `DELETE /tenants/:id/memberships/:userId` (SUPER) — revoke
    (refuses self-revoke so the actor can't lock themselves out).

### Frontend

No required changes for this phase. The existing login page works
unchanged — when the user enters `company`, the backend now consults
the membership table. `/auth/me` returns a `memberships` array; the
topbar can render a tenant picker that calls
`POST /auth/switch-tenant` when the user has more than one row.

### Schema

`TenantMembership` exists since Phase 1, including the
`@@unique([userId, tenantId])` constraint, so no migration is needed.
The drift-heal at boot already keeps the join table column-shape
aligned with the Prisma client.

## Flow

```
+---------+   /auth/login-v2 (company, email, password)
| Client  | --------------------------------------------> +------------+
+---------+                                               |  Backend   |
                                                          +------------+
                                                                |
                                                 resolveTenant(company)
                                                                |
                                                 findUser(email globally)
                                                                |
                       findMembership(userId, tenantId, ACTIVE) ┘
                                                                |
                       no row?  →  if user.agency.tenantId == tenant.id
                                       create membership row (legacy backfill)
                                       continue
                                   else  →  401 generic
                                                                |
                                                 bcrypt verify password
                                                                |
                                                 issue JWT { sub, tenantId,
                                                             membershipId, ... }
                                                                |
                                                 return tokens
```

Tenant switching:

```
POST /auth/switch-tenant { tenantId }
  Authorization: Bearer <current-session>

→ verify membership(userId, tenantId, ACTIVE)
→ issue fresh JWT pinned to new tenantId + membershipId
→ return tokens
```

## RBAC

| Endpoint                                | Required level         |
|----------------------------------------|------------------------|
| `POST /auth/login-v2`                  | public                 |
| `POST /auth/switch-tenant`             | authenticated user     |
| `GET  /tenants/:id/memberships`        | PlatformAdmin SUPPORT+ |
| `POST /tenants/:id/memberships`        | PlatformAdmin SUPER    |
| `DELETE /tenants/:id/memberships/:userId` | PlatformAdmin SUPER |

Self-revoke is forbidden (`TENANT.SELF_REVOKE_FORBIDDEN`).

## Audit events

* `LOGIN`                  — same as before, now with `tenantId` context.
* `TENANT_SWITCH`          — actor switched the active tenant.
* `TENANT_MEMBERSHIP_GRANTED`
* `TENANT_MEMBERSHIP_REACTIVATED`
* `TENANT_MEMBERSHIP_GRANT_IDEMPOTENT`
* `TENANT_MEMBERSHIP_REVOKED`

All membership audit rows land in `platform_audit_logs` with the
target tenantId + userId.

## Operator runbook: grant a user access to another tenant

1. Find the user's UUID in the Users list (or via SQL).
2. Find the target tenant's UUID (Tenants list).
3. As a SUPER PlatformAdmin, call:
   ```
   POST /tenants/<tenantId>/memberships
   { "userId": "<userId>" }
   ```
4. The user can now log in to that tenant via `/auth/login-v2`
   using the tenant's slug (or customDomain) as `company`.

To revoke:
```
DELETE /tenants/<tenantId>/memberships/<userId>
```

## Rollback

* Revert the loginV2 patch — the membership lookup is the only
  Phase 3.17 line on the critical login path. Legacy memberships
  the auto-backfill created are harmless and can stay; or run
  `DELETE FROM tenant_memberships WHERE …` to clean them.
* Drop the new `/auth/switch-tenant` route.
* Drop the three `/tenants/:id/memberships*` routes. No data is
  rewritten — every change is gated by an explicit API call.

## Harness

`backend/scripts/saas/phase3/multi-tenant-login.ts`,
`npm run saas:phase317-multi-tenant-login`.

14 cases covering happy paths (login A + B), generic 401 leaks,
JWT shape, /auth/me memberships, switchTenant + grant/revoke,
legacy backfill, scan-annotations policy, regression chain.

## Validation

| Check | Result |
|---|---|
| `npx tsc --noEmit` (backend) | clean |
| `npm run saas:scan:annotations` | 0 findings |
| `npm run saas:phase317-multi-tenant-login` | 14/14 PASS (run locally) |
| Existing Phase 3 harnesses | unchanged |
