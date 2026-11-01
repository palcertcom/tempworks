# Tenant System — End-to-End Guide

This guide walks through how the multi-tenant system works in this app, both
conceptually and operationally. Read top-to-bottom on your first pass; use the
section list to come back later when you have a specific question.

> **Scope:** how to use the tenant system from the dashboard UI and what
> happens behind the scenes when you do. Not a deployment guide.

---

## 1. The mental model

There are four entities to keep straight:

| Entity | What it is | Example |
|---|---|---|
| **Tenant** | A top-level customer organization. Every other record (employees, applicants, documents…) is scoped to exactly one tenant. | "TempWorks s.r.o", "RINT Solutions", "TFS&L GmbH" |
| **Agency** | A unit *inside* a tenant. Most tenants have one, but a large tenant can have several. Drives the agency-access grants on employees. | "TempWorks", "TempWorks Bratislava Branch" |
| **User** | A person who logs in. Belongs primarily to one Agency, which gives them their default tenant. | "Abdalkarim Aladawi" |
| **TenantMembership** | An optional second link from a User to a Tenant. Lets the same human appear in two tenants without two accounts. | Raed Rasheed → member of both *TempWorks* and *RINT Solutions* |

Relationships:

```
Tenant ──┬── Agency(ies) ──┬── User(s)            (primary attribution)
         │                 │
         └── TenantMembership(s) ──── User(s)     (cross-tenant access)
```

A user's "active tenant" at any moment is whichever one their current JWT is
bound to. Switching tenants mints a new JWT (next section).

### Pilot mode vs. legacy mode

Two operating modes exist for the back end:

* **Legacy mode** (`MULTI_TENANT_ENABLED=false`, today's default): the database
  is implicitly single-tenant. `tenantId` columns may be `null`. The tenant
  switcher and the per-tenant Members tab still work, but Prisma-level tenant
  filters are no-ops — agency assignment is the only real isolation boundary.
* **Pilot mode** (`MULTI_TENANT_ENABLED=true`, only allowed on staging/clones):
  every read goes through `scope().tenantWhere()` which adds
  `WHERE tenantId = <active tenant>` automatically. New rows are written with
  the active tenant id stamped in.

You don't have to know which mode you're in for day-to-day use. If something
"shows too many rows", you're in legacy mode. If something "shows zero rows"
unexpectedly, you're probably in pilot mode with a mismatched `tenantId`.

---

## 2. Who can do what

Three roles to be aware of, listed from least to most privileged:

### Agency User / Agency Manager (external tenant)
* Sees only their own agency's data.
* Cannot pick another tenant.
* The Tenant Switcher in the topbar does **not** appear for them.
* Permission system applies as normal — `applicants:read`, `employees:read`,
  etc. — but every list is automatically filtered to their agency.

### System Admin / HR Manager / Finance / Recruiter (internal tenant)
* Sees everything inside their active tenant.
* If they have memberships in more than one tenant, the **Tenant Switcher**
  appears in the topbar.
* User Management has a **Tenant filter** dropdown that defaults to the
  active tenant.

### PlatformAdmin SUPER (cross-tenant superuser)
* Bypasses every tenant filter — `caller.agencyIsSystem === true` short-
  circuits the gating code.
* Gets the **/dashboard/tenants** page, where they can create/edit/delete
  tenants and manage their members.
* The User Management Tenant filter shows **All Tenants** plus every tenant
  in the system, not just the user's own memberships.

You become a PlatformAdmin SUPER by having a row in the `PlatformAdmin` table
with `level='SUPER'`. There's no permission or role-name shortcut for this —
it's a separate table.

---

## 3. As a user: switching tenants

Look at the **topbar** (top-right of every page). If you're a member of more
than one tenant, you'll see a small dropdown next to your name showing the
active tenant.

1. Click the dropdown.
2. Pick the target tenant.
3. The frontend calls `POST /tenants/switch { tenantId }`. The backend
   verifies you have an `ACTIVE` membership for that tenant and returns a
   new access/refresh token pair.
4. The frontend stores the new tokens, refreshes the user's identity, and
   reloads the active page.

Everything you see after the switch — Employees, Applicants, Attendance,
Finance, Notifications — is scoped to the new tenant. The URL doesn't
change; the data does.

To list all your memberships in one place, open **Tenant Members** in the
sidebar (icon: people inside a circle). It shows every tenant you have an
active membership in, when you joined, and which is currently active.

---

## 4. As a SUPER admin: creating a new tenant

You need PlatformAdmin SUPER level. Sidebar → **Tenants** opens the
TenantsList page.

1. Click **+ Add Tenant**.
2. Fill in the form:
   - **Name** — human-readable, shown everywhere ("RINT Solutions").
   - **Slug** — URL-safe identifier ("rint-solutions"). Becomes the
     subdomain segment if the deployment uses subdomain routing.
   - **Region** — `eu` is the default; affects where tenant-specific
     storage and email routing land.
   - **Status** — start with `ACTIVE`.
3. Save. You're taken to the tenant detail page.

The tenant detail page has six tabs:

| Tab | What it controls |
|---|---|
| **General** | Name, slug, region, status, plan. Mostly admin metadata. |
| **Branding** | Logo, primary color, sidebar label — what *that tenant's* users see in their own topbar/sidebar. |
| **Access** | Custom domains and reserved subdomains pointing at the tenant. |
| **Members** | Who can log in to this tenant (covered in §5). |
| **Statistics** | Headline counts — users, employees, applicants, etc. — scoped to the tenant. |
| **Feature Flags** | Per-tenant toggles for opt-in features. |

You can **Archive** (soft-delete) or **Delete** (hard-delete after archive)
from the page header. Archived tenants stop accepting logins but keep their
data; deleted tenants cascade their memberships only.

---

## 5. Inviting members to a tenant

There are two ways for someone to belong to a tenant:

### (a) They were created in the tenant from day one

Standard flow: a System Admin in the tenant goes to **Users → + Add User**,
fills in the form, and saves. The new User row gets `agencyId` set to one
of the tenant's agencies, so they're automatically "in" the tenant via the
primary-attribution path (`agency.tenantId === tenant.id`).

The new user receives the standard activation email.

### (b) They have an account in another tenant and you want them here too

This is the **TenantMembership** flow. Used for SUPER admins (e.g., Raed
Rasheed), support staff, or someone who legitimately works across customers.

On the target tenant's detail page → **Members** tab:

1. In the **Grant tenant access to a user** search field, type their name
   or email.
2. Pick them from the autocomplete.
3. A new `TenantMembership` row is created with `status = ACTIVE`,
   `joinedAt = now`.
4. Optionally, in the same tab, set per-membership roles and permission
   overrides.

The user's next login (or their next tenant-switch dropdown refresh) shows
this tenant in their list.

To revoke, click the red ✕ next to their row. The membership becomes
`status = REVOKED` — soft delete. They lose access immediately; existing
sessions are not killed but their next refresh fails.

---

## 6. Inside a tenant: how access really works

Once a user is logged in and has an active tenant, every API call goes
through this gating sequence:

```
JWT verified          → req.user populated with { id, role, agencyId,
                                                  agencyIsSystem, tenantId,
                                                  membershipId }
       │
RolesGuard            → @Roles OR @RequirePermission match against the
                        user's role/permission set. (See RBAC_GUIDE if it
                        exists, or scripts/rbac-check.mjs for the
                        invariants.)
       │
TenantContextMiddleware → ALS frame for tenant id resolved from:
                          1. Custom domain  → tenant_domains.host
                          2. Subdomain     → tenants.slug
                          3. X-Tenant-Id header (staging only)
                          4. Legacy agency.tenantId
       │
Service.findAll(...)  → Composes:
                          • scope().tenantWhere()   — pilot-aware filter
                          • callerTenantWhere()     — Phase 3.18 belt-and-
                                                      braces, no-op when
                                                      pilot is off
                          • isExternalActor() check — pin agencyId for
                                                      Agency Users/Managers
```

The takeaway: **as a user you never set the tenant**. It's derived from
your active session. The dropdown in User Management is a *filter on
top of* that, not a way to escape it.

---

## 7. Cross-tenant operations (SUPER only)

SUPER admins can do three things normal users can't:

### Filter User Management by any tenant
Sidebar → Users → Tenant dropdown shows **All Tenants** plus every tenant.
Picking one narrows the list to users whose primary `agency.tenantId`
matches **or** who have an ACTIVE TenantMembership for that tenant.

### Open the Tenants page
Sidebar → Tenants. Manage every tenant in the system.

### Walk into any tenant's data
Switch into a tenant via the topbar to see its Employees / Applicants /
Finance dashboards. The data scopes correctly; only the SUPER bypass is
what lets you reach it.

---

## 8. Common operations cheat-sheet

| I want to… | How |
|---|---|
| See my available tenants | Topbar dropdown, or sidebar → **Tenant Members** |
| Switch tenants | Topbar dropdown → pick → page reloads scoped to new tenant |
| Filter User Management by tenant | Users → Tenant dropdown |
| Add someone from another tenant to mine | Tenants → my tenant → Members tab → search & grant |
| Remove someone's access to my tenant | Same tab → red ✕ on their row |
| Create a new tenant | Tenants → + Add Tenant (SUPER only) |
| Change a tenant's branding | Tenants → tenant → Branding tab |
| Disable a tenant temporarily | Tenants → tenant → header → Archive |

---

## 9. Troubleshooting

### "No users found" when filtering by a tenant that clearly has members
This usually means a user has SUPER membership in the target tenant but
their primary `agency.tenantId` is a different tenant. The fix is already
in: filtering checks both `agency.tenantId` **and** active
`TenantMembership` rows. If you still see zero, confirm via the tenant's
**Members** tab that the memberships are `ACTIVE` (not `REVOKED`).

### "Failed to load dashboard data" / "Forbidden resource"
Your active tenant doesn't have the permission your role needs. Either
(a) switch to the tenant that does, or (b) ask a System Admin in this
tenant to grant your role the relevant `<module>:<action>` permission
in Roles & Permissions.

### Notifications about people I can't see
Run `npm run tenant:check` (in repo root) to verify the invariants. The
notifications query restricts the entity-related rows (Employee /
Applicant) to ones the user can actually access via
EmployeeAgencyAccess(canView=true) and agency-matching applicants. If
unrelated notifications still show, they're for non-entity events
(system messages) which always pass through.

### "Employee not found" but the row exists
External-tenant users only see employees they hold an `EmployeeAgencyAccess`
canView grant for. On the employee profile → **Agency Access** tab, ask an
admin in your tenant to tick the View box for your agency.

### "Too many database connections" in dev
`PrismaService` now bounds the pg pool (default `max=10`,
`idleTimeoutMillis=30s`). If you've been hot-reloading aggressively,
stop the backend, wait 30s for leaked pools to time out, and restart.
Override with `PG_POOL_MAX` / `PG_POOL_IDLE_MS` env vars if needed.

---

## 10. For developers: where to look in the code

| Concern | File |
|---|---|
| Tenant resolution from request | `backend/src/saas/context/tenant-context.middleware.ts` |
| ALS storage for the resolved tenant | `backend/src/saas/context/als.ts` |
| Pilot-aware filter helper | `backend/src/saas/prisma/tenant-pilot-scope.ts` (`scope().tenantWhere()`, `scope().tenantData()`) |
| Tenant switch endpoint | `backend/src/auth/auth.controller.ts` → `POST /tenants/switch` |
| Tenant model + memberships | `backend/prisma/schema.prisma` (`Tenant`, `TenantMembership`, `TenantDomain`) |
| Platform admin authority | `backend/src/saas/platform-admin/platform-admin-access.service.ts` |
| Frontend tenant switcher | `src/app/components/layout/Topbar.tsx` |
| Tenant Management page | `src/app/pages/tenants/TenantsList.tsx`, `TenantDetail.tsx` |
| User's own memberships | `src/app/pages/tenants/MyTenantMembers.tsx` |

Regression scripts that lock in tenant-related invariants:

* `npm run tenant:check` — server-side tenant/agency ownership on create
* `npm run rbac:check` — permission key consistency frontend ↔ backend ↔ seed
* `npm run ui:error-check` — top-banner / toast position invariants

---

## 11. Glossary

* **Active tenant** — the tenant id stamped into the current JWT. What every
  request scopes by.
* **Primary tenant** — the tenant derived from a user's `agency.tenantId`.
  The user's "home" tenant.
* **Membership** — a row in `TenantMembership`. Lets one user access many
  tenants without duplicate accounts.
* **PlatformAdmin (SUPER)** — cross-tenant superuser. Authority comes from
  the `PlatformAdmin` table, **not** from any role name or permission.
* **External actor** — a user whose `agencyId` is set and `agencyIsSystem`
  is false. Confined to their agency's slice of the tenant.
* **Internal actor** — System Admin / HR Manager / Finance / Recruiter etc.
  inside the system agency. Sees everything in the tenant.
* **Pilot mode** — `MULTI_TENANT_ENABLED=true`. Activates real per-row
  tenant filters in Prisma.
* **Legacy mode** — `MULTI_TENANT_ENABLED=false`. Single-tenant deployment,
  `tenantId` may be null, isolation comes from agency assignment.
