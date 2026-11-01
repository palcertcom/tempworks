# ADR-005 — Platform Admin Access Model

- **Status:** Accepted
- **Date:** 2026-05-09
- **Related:** ADR-002 (identity), ADR-003 (Agency split), ADR-004 (Prisma enforcement)

## Context

Tempworks staff need cross-tenant access for support, operations, and incident response. Today this is implemented as an `Agency.isSystem = true` row plus an `agencyIsSystem` JWT claim — an unaudited, untested bypass exposed to every service that branches on it.

In the SaaS architecture, every cross-tenant action must be:

- Distinguished from tenant authorization (a separate code path).
- Audited with reason strings.
- Step-up MFA-protected.
- Network-isolated where feasible.

## Decision

A separate **Platform Admin** access model with explicit, audited bypass:

### Identity

- **`PlatformAdmin`** table: `(id, userId @unique, level, grantedBy, grantedAt)`.
- Levels: `SUPPORT` (read-only across tenants), `OPERATOR` (write within scoped operations: tenant suspension, password reset assistance), `SUPER` (full read/write; rare).
- Grants are reviewed quarterly; `grantedBy` is required.

### Authorization

- Membership in `PlatformAdmin` does **not** grant any tenant-scoped permissions automatically.
- Platform admin status is signaled in JWT via a dedicated `pa: true` claim, set only after step-up MFA on the current session and only when issuing tokens for the platform-admin route prefix.
- A separate decorator + guard `@RequirePlatformAdmin('SUPPORT'|'OPERATOR'|'SUPER')` checks claim presence, `PlatformAdmin.level >= required`, and recent step-up (`pa_mfa_at` claim within 30 minutes).

### Code path isolation

- All platform-admin features live under `backend/src/modules/platform-admin/` and are mounted at the `/_platform` route prefix.
- Frontend is a separate route shell (`/_platform/*`) with its own sidebar; deep links from tenant UIs are not allowed.
- Network: in production, ingress for `/_platform` requires Cloudflare Access (or equivalent) before the request reaches the API.

### Data access

- The platform-admin module imports `PlatformPrismaService` instead of `TenantPrismaService` (ADR-004).
- The Postgres role `platform_admin` has policy-level RLS bypass on tenant tables (`TO platform_admin USING (true) WITH CHECK (true)` policies are added per table during RLS rollout).
- Every public method on `PlatformPrismaService` requires a `reason: string` argument and writes a `PlatformAuditLog` row before returning. Rows are append-only; admins cannot delete their own audit rows.
- Reads are also audited (especially for sensitive endpoints like document download and PII export).

### Session controls

- Session length: 30 minutes idle, 4 hours absolute.
- Step-up MFA on entry (TOTP or WebAuthn).
- Concurrent session limit: 2 per platform admin.

### Migration path from `agencyIsSystem`

1. Provision `PlatformAdmin` rows for every existing `Agency.isSystem = true` user (default `SUPER`; ops can downgrade later).
2. JWT issuer emits `pa: true` for those users alongside legacy `agencyIsSystem` (`DUAL_CLAIM_JWT` window).
3. Service-side checks become `isPlatformAdmin = claims.pa || claims.agencyIsSystem` during the dual-honor period.
4. After ≥ 30 days, `agencyIsSystem` is dropped; only `pa` is honored.
5. `Agency.isSystem` flag is removed in Phase 3.

## Consequences

**Positive**
- Cross-tenant access is observable, reviewable, and revocable independently of tenant memberships.
- Tenant authorization code paths no longer carry "is super-admin?" branches; they just trust the tenant filter.
- Platform admins can be revoked instantly without affecting any tenant memberships they may also hold (a user can be both a platform admin and a tenant member; both contexts are explicit).

**Negative**
- A user who was previously "super admin in their own customer agency" sees a UX shift: tenant access is via membership; cross-tenant operations require switching into the `/_platform` shell with step-up MFA.
- Audit-log volume for platform-admin reads can be significant; partitioned and retained per retention policy.

## Alternatives Considered

- **Keep `agencyIsSystem` as the bypass, just audit it.** Rejected: every service still branches on the flag, leak risk persists, no clean way to require step-up MFA per action.
- **Tenant-scoped "Platform Admin" role.** Rejected: blurs the line between tenant authorization and cross-tenant operations.
- **Use database superuser for platform-admin paths.** Rejected: blast radius too large; loss of RLS bypass per-policy granularity.

## Implementation Notes

- `RequirePlatformAdmin` decorator stamps metadata on the route; the guard reads it.
- The guard requires both `claims.pa === true` and a fresh `claims.pa_mfa_at`. The login flow sets `pa_mfa_at` after a successful step-up, refreshable via `/auth/platform/step-up`.
- The audit row schema includes `actorId`, `tenantId?` (when targeted), `action`, `reason`, `target` (json), `ip`, `ua`, `createdAt`. Append-only; even platform admins cannot delete.
- `PlatformPrismaService.findManyTenantWide(...)` and similar high-power methods log a special `level: 'CROSS_TENANT_READ'` audit row.
- The platform-admin route shell on the frontend is bundled separately and only loaded when the URL begins with `/_platform`.

## Risks

- **Phishing / session hijack on platform-admin sessions.** Mitigation: WebAuthn preferred; session-length controls; IP binding optional for SUPER level.
- **Audit log volume / cost.** Mitigation: per-action retention policy; cold storage for older entries.
- **Lockout if MFA device lost.** Mitigation: ops runbook with break-glass procedure (two SUPER admins required; written justification; audited).
- **Platform-admin grants drift over time.** Mitigation: quarterly access review; auto-expiry of `OPERATOR`/`SUPER` levels after 90 days unless renewed.

## Rollback Considerations

- During the `DUAL_CLAIM_JWT` window, removing the `pa` claim emission falls back to legacy `agencyIsSystem` honoring.
- `PlatformPrismaService` and its consumers are zero-touched in Phase 0; rollback is removing the service file.
- `PlatformAdmin` rows are additive; if abandoned, they are inert without `pa` claim emission.

---

## Addendum (Phase 1 preflight findings)

Added 2026-05-09.

- **Default level on Phase 1 backfill is `SUPER`**, not `SUPPORT`. Rationale: every existing `agencyIsSystem=true` user already has cross-tenant access today; downgrading without explicit security review would lock people out. Security reviews and downgrades to `SUPPORT`/`OPERATOR` happen post-cutover (TKT-P1-09 +30 days). Recorded in the reconciliation queue so the diff is visible.
- **Bypass policies are still NOT created in Phase 1.** The `platform_admin` Postgres role exists (Phase 0 migration), but per-table `TO platform_admin USING (true) WITH CHECK (true)` policies are added in **Phase 3**, alongside RLS `FORCE` per table. Phase 1 cannot enable any cross-tenant read path.
- **`agencyIsSystem` retirement:** stays in Phase 3. The dual-honour period is at least 30 days post-Phase-2 dual-claim JWT cutover.
