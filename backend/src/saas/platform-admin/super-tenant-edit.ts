import { BadRequestException } from '@nestjs/common';

/**
 * True iff the user holds a SUPER PlatformAdmin grant. SUPER is the only
 * level allowed to reassign a record's tenant from an edit screen.
 * `prisma` must expose `.platformAdmin` (the global client).
 */
export async function isSuperPlatformAdmin(prisma: any, userId: string | null | undefined): Promise<boolean> {
  if (!userId) return false;
  try {
    const row = await prisma.platformAdmin.findUnique({ where: { userId }, select: { level: true } });
    return row?.level === 'SUPER';
  } catch {
    return false; // table missing on a fresh env → treat as not-SUPER
  }
}

/**
 * SUPER-only tenant reassignment for an update/edit `data` object.
 *
 * Security contract — the backend is the final authority:
 *   • `tenantId` is ALWAYS removed from the update first, so a non-SUPER
 *     caller can never write it (spoof guard) even if it slips past the
 *     DTO whitelist.
 *   • Only a SUPER PlatformAdmin may set it. The target tenant must exist.
 *   • A blank/empty value is treated as "no change" — we never null an
 *     existing tenant (that would re-orphan the record).
 *
 * Agency consistency: when the tenant actually changes, the record's
 * agency must belong to the NEW tenant. A foreign agency (one whose
 * tenantId is set and differs) cannot follow the person across tenants,
 * so it is dropped (agencyId → null). The SUPER can then assign an agency
 * that lives in the new tenant. Agencies with no tenant of their own are
 * left untouched (we can't prove a mismatch).
 *
 * Mutates `updateData` in place. `prisma` must expose `.platformAdmin`,
 * `.tenant`, and `.agency` (the global, non-pilot client).
 */
export async function applySuperTenantReassignment(
  prisma: any,
  actorId: string | undefined,
  updateData: Record<string, any>,
  existingAgencyId?: string | null,
): Promise<void> {
  if (!('tenantId' in updateData)) return;
  const requested = updateData.tenantId;
  delete updateData.tenantId; // never trust a non-SUPER tenant write

  if (requested === undefined) return;
  if (!(await isSuperPlatformAdmin(prisma, actorId))) return; // silently ignored for non-SUPER

  const tenantId = String(requested ?? '').trim();
  if (!tenantId) return; // blank → leave the existing tenant unchanged

  const exists = await prisma.tenant.findUnique({ where: { id: tenantId }, select: { id: true } });
  if (!exists) {
    throw new BadRequestException({
      code: 'TENANT.NOT_FOUND',
      message: 'Selected tenant does not exist.',
      params: { tenantId },
    });
  }
  updateData.tenantId = tenantId;

  // Enforce agency ↔ tenant consistency on the move. Use the agency the
  // update is setting if present, otherwise the record's current one.
  const effectiveAgencyId = ('agencyId' in updateData) ? updateData.agencyId : (existingAgencyId ?? null);
  if (effectiveAgencyId) {
    const agency = await prisma.agency.findUnique({ where: { id: effectiveAgencyId }, select: { tenantId: true } });
    if (agency?.tenantId && agency.tenantId !== tenantId) {
      // Foreign agency — it belongs to a different tenant and cannot
      // follow the person into the new tenant. Drop it.
      updateData.agencyId = null;
    }
  }
}
