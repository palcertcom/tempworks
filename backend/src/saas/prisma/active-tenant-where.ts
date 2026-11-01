/**
 * Active-tenant predicate used to enforce "the data you see follows the
 * tenant you have selected" on every tenant-scoped read.
 *
 * Phase 2 / #5 — the topbar tenant switcher updates `caller.tenantId`
 * (via /auth/login-v2 or /auth/switch-tenant). Every list / detail
 * endpoint that respects tenant ownership should spread the result of
 * this helper into its Prisma `where` so the active tenant is applied
 * even when the read-pilot scope is inactive (which is the case in the
 * legacy / pilot-off environments where the original tenant filter
 * silently devolved to `{}` and let SUPER see across every tenant).
 *
 * Rules:
 *   • caller without a tenantId → `{}` (no change; covers public
 *     endpoints, scripts, and tests that don't carry a JWT).
 *   • caller with a tenantId → `{ tenantId: caller.tenantId }` for
 *     BOTH SUPER admins and tenant users alike. SUPER's "All Tenants"
 *     mode is opt-in — when an endpoint supports it the controller
 *     should pass `null` here.
 *
 * Records with `tenantId = NULL` become invisible under this filter
 * by design — they need to be backfilled by the audit scripts in
 * backend/scripts/saas/.
 */
export function activeTenantWhere(
  caller: { tenantId?: string | null; agencyIsSystem?: boolean } | undefined | null,
): Record<string, any> {
  const id = (caller?.tenantId ?? '').toString().trim();
  return id ? { tenantId: id } : {};
}
