# SaaS Auth & RBAC Redesign

**Current state (codebase reality):**

- `User` has a single `roleId` and a single `agencyId`. There is no membership concept.
- JWT (`backend/src/auth/strategies/jwt.strategy.ts:47-59`) carries `{ id, email, role, roleId, agencyId, agencyIsSystem }`.
- Authorization is a mix of `@Roles('System Admin', ...)` (string match on `Role.name`) and `@RequirePermission('module:action')`.
- "See everything" is implemented via `agencyIsSystem` — a bypass with **no audit trail and no step-up auth**.
- Login (`auth.service.ts`) takes `{email, password, agencyId?}` and is global-by-email.

**Target state:**

```
User (global, by email)
  └── TenantMembership (status, joinedAt)
         ├── MembershipRole[] → Role (system or tenant-defined)
         └── AgencyMembership[] → Agency (sub-org scope inside tenant)
```

Plus a separate `PlatformAdmin` table for super-admin access, and `PlatformAuditLog` for every action taken via the bypass path.

---

## 1. Schema Changes (additive in Phase 1; subtractive in Phase 3)

```prisma
model User {
  id            String   @id @default(uuid())
  email         String   @unique          // GLOBAL — login key
  emailVerified Boolean  @default(false)
  passwordHash  String
  mfaEnabled    Boolean  @default(false)
  status        UserStatus @default(ACTIVE)
  // legacy (kept until Phase 3 contract):
  roleId        String?  @deprecated
  agencyId      String?  @deprecated
  memberships   TenantMembership[]
}

model Tenant {
  id            String   @id @default(uuid())
  slug          String   @unique
  name          String
  status        TenantStatus @default(ACTIVE)
  planId        String?
  region        String   @default("eu")
  customDomain  String?  @unique
  branding      Json?
  createdAt     DateTime @default(now())
  memberships   TenantMembership[]
  agencies      Agency[]
}

model TenantMembership {
  id         String   @id @default(uuid())
  userId     String
  tenantId   String
  status     MembershipStatus @default(ACTIVE)
  invitedBy  String?
  invitedAt  DateTime?
  joinedAt   DateTime?
  user       User     @relation(fields: [userId], references: [id])
  tenant     Tenant   @relation(fields: [tenantId], references: [id])
  roles      MembershipRole[]
  agencies   AgencyMembership[]
  @@unique([userId, tenantId])
  @@index([tenantId, status])
}

model Role {
  id          String   @id @default(uuid())
  tenantId    String?  // null = system role template
  key         String   // e.g. "tenant.admin"
  name        String
  isSystem    Boolean  @default(false)
  permissions RolePermission[]
  @@unique([tenantId, key])
  @@unique([tenantId, name])
}

model MembershipRole {
  membershipId String
  roleId       String
  membership   TenantMembership @relation(fields:[membershipId], references:[id], onDelete: Cascade)
  role         Role             @relation(fields:[roleId], references:[id])
  @@id([membershipId, roleId])
}

model AgencyMembership {
  id            String @id @default(uuid())
  membershipId  String
  agencyId      String
  scope         AgencyScope @default(FULL) // FULL | READ_ONLY | RECRUITER_ONLY
  @@unique([membershipId, agencyId])
}

model PlatformAdmin {
  id        String @id @default(uuid())
  userId    String @unique
  level     PlatformAdminLevel  // SUPPORT | OPERATOR | SUPER
  grantedBy String?
  grantedAt DateTime @default(now())
}

model PlatformAuditLog {
  id        BigInt   @id @default(autoincrement())
  actorId   String
  tenantId  String?  // when an action targets a tenant
  action    String
  reason    String   // human-required justification
  target    Json
  ip        String?
  userAgent String?
  createdAt DateTime @default(now())
  @@index([actorId, createdAt])
  @@index([tenantId, createdAt])
}
```

---

## 2. JWT Redesign

**Access token** (15 min):

```json
{
  "sub":  "<userId>",
  "typ":  "access",
  "tid":  "<tenantId>",          // active tenant
  "mid":  "<membershipId>",
  "scp":  ["candidates:read","candidates:write","payroll:approve"],
  "agy":  ["<agencyId-1>","<agencyId-2>"],     // optional; empty = full-tenant scope
  "pa":   false,                  // platform admin flag (rarely true)
  "iat":  ..., "exp": ..., "jti": "..."
}
```

**Refresh token** (30 d), tenant-agnostic:

```json
{ "sub": "<userId>", "typ": "refresh", "sid": "<sessionId>", "exp": ... }
```

**Tenant-selection token** (5 min, only after login when N memberships):

```json
{ "sub": "<userId>", "typ": "tenant_select", "exp": ... }
```

The current claim `agencyIsSystem` **disappears**. Platform admins authenticate normally and switch into a special "platform" workspace whose UI is served from a separate route prefix (`/_platform`).

---

## 3. Login Flow Changes

### Before (today)
```
POST /auth/login { email, password, agencyId? }
  → finds user by email (+ optional agency match)
  → returns access (with agencyId, agencyIsSystem) + refresh
```

### After
```
POST /auth/login { email, password }
  → IdentityService.authenticate(email, password) → User
  → MfaService.requireIfNeeded(user) → may return 2FA challenge
  → MembershipService.listActive(userId)
     ├── 0 memberships  → 403 NO_WORKSPACE (unless platformAdmin)
     ├── 1 membership   → mint access(tid=that one) + refresh
     └── N memberships  → mint refresh + tenant_select; client navigates to /select-workspace
POST /auth/switch-tenant { tenantId }     // requires refresh or tenant_select
  → MembershipService.assertActive(userId, tenantId)
  → mint new access(tid=tenantId) + new refresh
POST /auth/logout
  → revoke session by sid
```

Login can also be initiated via **tenant SAML/OIDC** (Phase 4): host-resolved tenant → its IdP → SAML response → JIT-create user + membership.

---

## 4. Active Tenant Selection & Switching

| Trigger | Mechanism | Notes |
|---|---|---|
| First login (1 membership) | mint access for that tenant | redirect to tenant subdomain |
| First login (N memberships) | tenant-selection screen | client posts `/auth/switch-tenant` |
| Workspace switcher in UI | `POST /auth/switch-tenant` | flush React Query cache (`queryClient.clear()`); `window.location` to new subdomain (preferred) |
| Direct deep-link to tenant subdomain | host-based tenant context + JWT `tid` mismatch | server returns 401 with `WWW-Authenticate: switch-tenant`; client auto-switches if membership exists |
| API key (machine-to-machine) | API key has fixed tenant binding | no switching |

**Critical**: switching is **token rotation**, not session reset. Refresh token persists; only access changes.

---

## 5. Tenant-Scoped RBAC

Permissions remain `module:action` strings (existing `Permission` table). The shift is **where** they are attached:

- **Today**: `User.roleId → Role.permissions[]`.
- **After**: `TenantMembership.roles → Role.permissions[]`. Each tenant can clone system roles into tenant-owned roles for renaming/customization.

Effective permission set on each request:

```ts
// PermissionGuard (Phase 1)
const perms = new Set<string>();
for (const r of membership.roles) for (const p of r.role.permissions) perms.add(p.permission.name);
return required.every(p => perms.has(p));
```

Cached at `perms:{membershipId}:v{n}` in Redis. Bumped on role/permission change.

---

## 6. Agency-Scoped Permissions (sub-tenant scope)

`AgencyMembership` constrains a membership to one or more agencies. Every list/read endpoint must apply both:

1. `tenant_id = ctx.tenantId` (auto via `TenantPrismaService`)
2. `agency_id IN (ctx.agencyIds)` **only if** the membership has `AgencyMembership` rows

Helper:

```ts
@Injectable()
export class AgencyScopeGuard implements CanActivate {
  canActivate(ctx) {
    const u = UserContext.current();
    if (!u.agencyIds?.length) return true;          // full-tenant scope
    const req = ctx.switchToHttp().getRequest();
    req.tenantScope = { agencyIds: u.agencyIds };   // services use this
    return true;
  }
}
```

`EmployeeAgencyAccess` (existing model) becomes the **cross-agency view grant** mechanism inside a tenant — preserved as-is, plus `tenantId`.

---

## 7. Guards & Decorators (Refactor Map)

| Existing | Replacement | Notes |
|---|---|---|
| `JwtAuthGuard` | `JwtAuthGuard` (rewritten) | runs **after** `TenantMiddleware`; verifies `claims.tid === ctx.tenantId`; loads & caches membership |
| `RolesGuard` (`@Roles('System Admin', ...)`) | `PermissionGuard` (`@RequirePermission(...)`) — already partially used | Phase out string-role guards; convert all `@Roles()` usages to permission-based |
| `@Public()` | `@Public()` (kept) | bypass auth; **must NOT** bypass tenant resolution |
| `@CurrentUser()` | `@CurrentUser()` (kept) | now returns `{ id, membershipId, perms, agencyIds }` |
| (none) | `@CurrentTenant()` | returns the resolved tenant from ALS |
| (none) | `@RequirePlatformAdmin('SUPPORT')` | for platform-admin endpoints; logs to `PlatformAuditLog` |
| (none) | `@Audit('candidates.delete')` | wraps mutation; writes `audit_logs` row |
| (none) | `@AgencyScoped()` | applies `AgencyScopeGuard` for agency filtering |

---

## 8. Tenant Middleware (Tenant Resolution)

```ts
@Injectable()
export class TenantMiddleware implements NestMiddleware {
  constructor(
    private tenants: TenantService,
    private als: AsyncLocalStorage<RequestContext>,
  ) {}
  async use(req, res, next) {
    if (PUBLIC_ROUTES_NO_TENANT.has(req.path)) return next();
    const host = req.hostname.toLowerCase();
    const tenant = await this.tenants.resolveByHost(host); // Redis-cached
    if (!tenant || tenant.status !== 'ACTIVE') throw new NotFoundException();
    this.als.run({ tenant, user: null }, () => next());
  }
}
```

`resolveByHost` order:
1. Match `tenant.customDomain == host`.
2. Else parse subdomain `<slug>.app.tempworks.com` and match `slug`.
3. Else 404.

Health/ready/login (when no host info) routes are excluded.

---

## 9. PlatformAdmin Bypass (replaces `agencyIsSystem`)

- `PlatformPrismaService` is a separate singleton bound to a Postgres role with RLS bypass policy.
- Only injectable into modules under `modules/platform-admin/`.
- Every method on `PlatformPrismaService` requires a `reason: string` parameter and writes to `PlatformAuditLog`.
- Step-up MFA required to enter platform-admin mode (a second short-lived "platform_admin" claim set in the access token after re-MFA).
- Platform-admin code is served from `/_platform` route, behind a separate Cloudflare access policy in production.

Migration of existing `agencyIsSystem` usages (search backend/src for `agencyIsSystem`):
- Each occurrence is rewritten as one of:
  - **Drop** (request was implicitly multi-tenant; no longer needed).
  - **Move** to platform-admin module behind `RequirePlatformAdmin`.
  - **Replace** with explicit per-tenant query for the impersonated tenant.

---

## 10. Membership Lifecycle

```
INVITED  ── accept token ─▶  ACTIVE
ACTIVE   ── admin action ─▶  SUSPENDED
ACTIVE   ── user leaves  ─▶  REMOVED (soft, retained 90 days, then hard delete)
```

Invite endpoints:

- `POST /tenant/invitations` — admin invites email with role(s) and agency scope.
- `POST /invitations/:token/accept` — public route (no tenant middleware), creates user if needed, attaches membership.
- Resending tokens uses idempotent invite IDs.

---

## 11. Frontend Changes (auth surface)

| File | Change |
|---|---|
| `src/app/contexts/AuthContext.tsx` | Replace `AuthUser.agencyId / agencyIsSystem` with `AuthUser.activeTenantId / memberships[]`. Add `switchTenant(tenantId)`. |
| `src/app/services/api.ts` | Tokens: `access_token` in memory only; `refresh_token` in `localStorage` (per origin). On 401 with `switch-tenant`, call `/auth/switch-tenant`. |
| (new) `src/app/contexts/TenantContext.tsx` | Bootstrap response `{ tenant, branding, featureFlags, locale }`. |
| (new) `src/app/components/WorkspaceSwitcher.tsx` | dropdown with memberships; on select → `/auth/switch-tenant` then `window.location` to new host. |
| `src/app/routes.ts` | Route guards switch from role-name match to permission match (`hasPermission('candidates:read')`). |

---

## 12. Migration Order (Auth-Specific)

1. **Phase 0** — Add new tables (`Tenant`, `TenantMembership`, `MembershipRole`, `AgencyMembership`, `PlatformAdmin`, `PlatformAuditLog`) **without** removing legacy columns.
2. **Phase 1** — `IdentityService`, `MembershipService`, `TenantService` introduced. New JWT issued (carries both old and new claims for one release).
3. **Phase 1.5** — Backfill: each existing customer `Agency` becomes a `Tenant` (tenant.slug derived); each existing `User` (non-system) gets one `TenantMembership` to that tenant; `User.roleId` cloned into a `MembershipRole`. Tempworks `isSystem=true` agency users become `PlatformAdmin` rows.
4. **Phase 2** — Switch login flow to issue `tid`/`mid`/`scp`. Old claims retained as legacy for clients still on cached tokens.
5. **Phase 3** — Remove `agencyIsSystem` from JWT. Remove all `agencyIsSystem` branches in services. Drop `User.roleId`, `User.agencyId` (or keep nullable if any reports rely on them).
6. **Phase 4** — SSO/SAML, SCIM, MFA enforcement policies per tenant.

---

## 13. Risks Specific to Auth Migration

| Risk | Mitigation |
|---|---|
| Active sessions invalidated by JWT shape change | Issue tokens that contain **both** legacy and new claims for one release; flip when refresh tokens have rolled |
| User has multiple agency rows with same email (current schema doesn't strictly prevent) | De-dupe at backfill: keep oldest `User`, attach memberships from each agency |
| Tempworks staff lose access during cutover | Provision PlatformAdmin rows **before** dropping `agencyIsSystem` |
| Forgotten guard at a route | CI check enumerates routes and asserts each has either `@Public()` or both `@AuthGuard` + `@RequirePermission`/`@RequirePlatformAdmin` |
| JWT secret rotation during cutover | Use key-id (`kid`) header and run two keys live; rotate one per cycle |
