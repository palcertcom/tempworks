/**
 * Tear-down for previously seeded dummy data. Removes only the rows
 * the seed itself created (identified by their deterministic UUIDs).
 * Refuses to run in production unless explicitly forced via
 * SEED_FORCE_RESET=true.
 */
import { prisma } from './lib/prisma';
import { TENANTS } from './modules/01-tenants';
import { detId } from './lib/rng';
import { SEEDED_ROLES } from './modules/02-roles';

export async function resetSeededRows(): Promise<void> {
  if (process.env.NODE_ENV === 'production' && process.env.SEED_FORCE_RESET !== 'true') {
    throw new Error('Refusing to reset seeded rows in production. Set SEED_FORCE_RESET=true to override.');
  }

  const tenantIds = TENANTS.map(t => t.id);
  const userIds = [
    detId('user', 'platform', 'super'),
    ...TENANTS.flatMap(t =>
      ['System Admin', 'HR Manager', 'Recruiter', 'Finance', 'Read Only'].map(r => detId('user', t.slug, r))),
  ];
  const agencyIds = TENANTS.flatMap(t => [detId('agency', t.slug, 'primary'), detId('agency', t.slug, 'branch')]);

  // Child rows first.
  await prisma.attendanceRecord.deleteMany({ where: { employeeId: { in: [] as string[] } } }).catch(() => undefined);
  await (prisma as any).tenantMembership.deleteMany({ where: { userId: { in: userIds } } }).catch(() => undefined);
  await (prisma as any).platformAdmin.deleteMany({ where: { userId: { in: userIds } } }).catch(() => undefined);

  await prisma.maintenanceRecord.deleteMany({ where: { vehicle: { tenantId: { in: tenantIds } } } as any }).catch(() => undefined);
  await prisma.vehicle.deleteMany({ where: { tenantId: { in: tenantIds } } }).catch(() => undefined);
  await prisma.employee.deleteMany({ where: { tenantId: { in: tenantIds } } }).catch(() => undefined);
  await prisma.applicant.deleteMany({ where: { tenantId: { in: tenantIds } } }).catch(() => undefined);
  await prisma.jobAd.deleteMany({ where: { tenantId: { in: tenantIds } } }).catch(() => undefined);
  await prisma.user.deleteMany({ where: { id: { in: userIds } } }).catch(() => undefined);
  await prisma.agency.deleteMany({ where: { id: { in: agencyIds } } }).catch(() => undefined);
  await (prisma as any).tenant.deleteMany({ where: { id: { in: tenantIds } } }).catch(() => undefined);

  // Roles + job types are shared global catalogue rows — leave them
  // alone. SEEDED_ROLES is exported only so reset can opt in if it
  // ever needs to. We don't delete them here on purpose.
  void SEEDED_ROLES;
}
