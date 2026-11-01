# ADR-002 — Global Identity with Multi-Tenant Membership

- **Status:** Accepted
- **Date:** 2026-05-09
- **Related:** ADR-001 (shared schema), ADR-003 (Agency split), ADR-005 (Platform admin)

## Context

The current `User` model is bound to a single `Agency` via `User.agencyId` and carries a single `roleId`. This embeds tenancy into identity. The SaaS target requires:

- One person can belong to multiple tenants (e.g., a recruiter consulting for several customers).
- Authentication is global; authorization is tenant-scoped.
- Tenant switching is a token rotation, not a re-login.
- Platform staff (Tempworks employees) must access tenants via an audited bypass, not via a "tenant" role.

Reference patterns: Slack workspaces, Notion workspaces, GitHub organizations, Atlassian organization switching.

## Decision

Identity is **global**. Authorization is **tenant-scoped via memberships**.

### Core tables

```
User { id, email @unique, passwordHash, mfaEnabled, status }
Tenant { id, slug @unique, name, status, region, customDomain @unique?, branding }
TenantMembership { id, userId, tenantId, status, joinedAt; @@unique([userId, tenantId]) }
Role { id, tenantId?, key, name, isSystem; @@unique([tenantId, key]); @@unique([tenantId, name]) }
MembershipRole { membershipId, roleId; onDelete on Role: Restrict }
AgencyMembership { id, membershipId, agencyId, scope; @@unique([membershipId, agencyId]) }
MembershipPermissionOverride { id, membershipId, permissionId, grant; @@unique([membershipId, permissionId]) }
PlatformAdmin { id, userId @unique, level, grantedBy, grantedAt }
PlatformAuditLog { id, actorId, tenantId?, action, reason, target, ip, ua, createdAt }
TenantDomain { id, tenantId, host @unique, verifiedAt }
```

### JWT shape

Two-token model:

- **Access** (15 min): `{ sub, typ:'access', tid, mid, scp[], agy[]?, pa, iat, exp, jti }`
- **Refresh** (30 d): `{ sub, typ:'refresh', sid, exp }` — tenant-agnostic
- **Tenant-select** (5 min, only when N memberships): `{ sub, typ:'tenant_select', exp }`

`agy[]` is optional; empty means full-tenant scope. `pa` is true only when the user is a `PlatformAdmin` and step-up MFA has been performed within the session.

### Login & switching

- `/auth/login` → 1 membership: mint access; N memberships: mint refresh + tenant-select.
- `/auth/switch-tenant { tenantId }` → mint new access for that tenant. Refresh persists.
- Existing claims `agencyId`, `agencyIsSystem` are emitted in parallel for one release cycle (`DUAL_CLAIM_JWT=true`); verifier prefers new claims; legacy claims retired in Phase 3.

### Permission resolution

`effective_permissions(membership) = union(role.permissions for role in membership.roles) ± membershipPermissionOverrides`. Cached in Redis at `perms:{membershipId}:v{version}`; bumped on role/permission/membership change.

`AgencyMembership` constrains list/read endpoints. The guard exposes `agencyIds`; services apply `applyAgencyScope(where, field, ctx)` per ADR-004.

### Decisions resolved during architect review

- **Legacy columns:** `User.roleId` and `User.agencyId` are kept nullable through Phase 4 to ease report-engine and frontend transition; dropped in Phase 5.
- **`AgencyUserPermission`:** retained, **renamed to `MembershipPermissionOverride`**, columns repointed to `membershipId`, plus `tenantId` for RLS.
- **`MembershipRole.role` cascade:** `onDelete: Restrict` — deletes require explicit unassign.
- **JWT key rotation:** JWKS exposes both keys for ≥ 30 days (one refresh-token TTL); new tokens minted with new key; verifier accepts both.

## Consequences

**Positive**
- One user → many workspaces.
- Removing a user from a tenant cannot accidentally lock them out of other tenants.
- Authentication remains a single, hardenable surface.
- Per-tenant role customization without forking the schema.

**Negative**
- Two-step login UX when a user has multiple memberships.
- More indirection: every authorization check goes through membership.
- Permission cache invalidation discipline becomes critical.

## Alternatives Considered

- **One user per tenant (clone on each invite).** Rejected: emails diverge, password resets fragment, accounts duplicate.
- **Single role per user.** Rejected: enterprises need composite roles.
- **Permissions stored on User directly.** Rejected: permissions are tenant-context-dependent.

## Implementation Notes

- `IdentityService` is the only module allowed to read `User` directly (ESLint allowlist).
- `MembershipService` mediates all tenant-scoped permission lookups.
- Invite flow: `POST /tenant/invitations` → token with HMAC; `/invitations/:token/accept` (public) creates user if needed and attaches membership.
- SSO/SAML/SCIM (Phase 4) writes via the same `IdentityService` and `MembershipService` paths.

## Risks

- **Token shape change.** Mitigation: dual-claim emission for ≥ 30 days; `kid` rotation pre-wired.
- **Multi-membership edge cases** (user invited to a tenant where their email was previously deleted). Mitigation: invite flow attaches to existing user only when email is verified.
- **Permission cache staleness.** Mitigation: per-membership version counter bumped on any change; cache key includes the version.

## Rollback Considerations

- Through Phase 0–1, the legacy login path remains the source of truth. Disabling the feature flags reverts behavior.
- Once memberships are backfilled and clients hold new-claim refresh tokens, rollback requires reverting issuer + verifier and accepting that all sessions force re-login.
- `MembershipPermissionOverride` (renamed from `AgencyUserPermission`) is a new table; the old table remains until cutover, providing a fallback during Phase 1.

---

## Addendum (Phase 1 preflight findings)

Added 2026-05-09.

- **D-5 reaffirmed:** `User.agencyId` and `User.roleId` remain nullable through Phase 4. SPIKE-003 F-6 + Phase 1 preflight confirmed `agencyId` MUST become nullable to detach system-agency users without dropping FKs.
- **Membership row creation:** the Phase 1 backfill creates exactly one `TenantMembership` per non-system user (the user's home agency becomes its tenant). Multi-tenant memberships (a user belonging to two tenants) are **not** auto-detected from existing data; that capability is exercised only via the Phase 4 invite flow.
- **Backfill suspension policy:** users with `status != 'ACTIVE'` get `MembershipStatus = 'SUSPENDED'` rather than skipped. This preserves audit trail and allows ops to re-activate without re-invite.
- **Permission preservation invariant** (`pre_user_role_pairs == post_membership_role_pairs`) is verified by `verify-backfill.ts` after every run.
