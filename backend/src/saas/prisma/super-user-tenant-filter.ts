import { BadRequestException } from '@nestjs/common';

/**
 * SUPER USER tenant filter for list endpoints (Applicants / Candidates /
 * Employees / Users-style screens).
 *
 * Security contract — the backend is the final authority:
 *   • Only platform admins (caller.agencyIsSystem === true) may scope a
 *     list to an arbitrary tenant. For every other caller the requested
 *     tenantId is IGNORED and their existing agency/tenant scoping stands.
 *   • A platform admin with NO tenantId gets the unscoped (all-tenants)
 *     view — that is the "All Tenants" selection.
 *   • A platform admin with a tenantId gets only that tenant's records.
 *
 * Attribution: records are matched by their own `tenantId` column OR by
 * their `agency.tenantId` relation. With the tenant pilot off, a record's
 * own tenantId may be null while its agency still resolves the tenant —
 * so both paths are ORed (the same approach the User Management filter
 * uses via agency.tenantId).
 *
 * Returns a Prisma predicate to push onto `where.AND`, or null when no
 * tenant scoping should be applied (non-platform caller, or platform
 * caller asking for all tenants).
 */
/** True when the caller is allowed to scope a list to an arbitrary
 *  tenant: either a PlatformAdmin (agencyIsSystem === true) OR a user
 *  whose role is 'System Admin'. The latter covers cross-tenant admin
 *  accounts that aren't stamped with an explicit PlatformAdmin row.
 *  Centralised so every helper below agrees on the definition. */
export function isPlatformAuthority(
  caller: { agencyIsSystem?: boolean; role?: string } | undefined,
): boolean {
  if (!caller) return false;
  if (caller.agencyIsSystem === true) return true;
  const role = (caller.role ?? '').toString().trim().toLowerCase();
  return role === 'system admin';
}

export function buildSuperUserTenantWhere(
  caller: { agencyIsSystem?: boolean; role?: string } | undefined,
  requestedTenantId: string | undefined | null,
): { OR: Array<Record<string, unknown>> } | null {
  if (!isPlatformAuthority(caller)) return null; // non-platform: ignore entirely
  const tenantId = (requestedTenantId ?? '').trim();
  if (!tenantId) return null; // all-tenants view
  return { OR: [{ tenantId }, { agency: { tenantId } }] };
}

/**
 * Direct-only variant for models that DO NOT have an `agency` relation
 * (Document, FinancialRecord, Report, …). Emits just `{ tenantId: ... }`
 * with no agency OR. Same SUPER + non-empty gating as the OR-form.
 *
 * Phase F2 (SPIKE-010). Use this in services where Prisma rejects the
 * OR-form with "Unknown argument `agency`".
 */
export function buildSuperUserTenantWhereDirect(
  caller: { agencyIsSystem?: boolean; role?: string } | undefined,
  requestedTenantId: string | undefined | null,
): { tenantId: string } | null {
  if (!isPlatformAuthority(caller)) return null;
  const tenantId = (requestedTenantId ?? '').trim();
  if (!tenantId) return null;
  return { tenantId };
}

/**
 * Validate that a SUPER USER-supplied tenantId refers to a real tenant.
 * No-op for non-platform callers (their tenantId is ignored anyway) and
 * when no tenantId was supplied. Throws a clear 400 otherwise.
 *
 * `tenantDelegate` is `prisma.tenant` (the global, non-pilot client).
 */
export async function assertRequestedTenantExists(
  caller: { agencyIsSystem?: boolean; role?: string } | undefined,
  requestedTenantId: string | undefined | null,
  tenantDelegate: { findUnique: (args: any) => Promise<any> },
): Promise<void> {
  if (!isPlatformAuthority(caller)) return;
  const tenantId = (requestedTenantId ?? '').trim();
  if (!tenantId) return;
  const found = await tenantDelegate.findUnique({ where: { id: tenantId }, select: { id: true } });
  if (!found) {
    throw new BadRequestException({
      code: 'TENANT.NOT_FOUND',
      message: 'Selected tenant does not exist.',
      params: { tenantId },
    });
  }
}
