import { prisma } from '../lib/prisma';
import { detId, faker } from '../lib/rng';
import { seedPasswordHash, SEED_PASSWORD } from '../lib/passwords';
import type { SeededTenant } from './01-tenants';
import type { SeededAgency } from './03-agencies';
import type { SeededRoleName } from './02-roles';

export interface SeededUser {
  id: string; email: string; role: SeededRoleName;
  tenantId: string; agencyId: string;
}

/**
 * Five users per tenant — one of each common role — plus one SUPER
 * PlatformAdmin global user. All share the same password
 * (process.env.SEED_PASSWORD || 'Seed!2026Dev').
 */
export async function seedUsers(
  tenants: SeededTenant[],
  agencies: SeededAgency[],
  roleByName: Map<SeededRoleName, string>,
): Promise<{ super: SeededUser; perTenant: SeededUser[] }> {
  const passwordHash = await seedPasswordHash();
  const userRoles: SeededRoleName[] = ['System Admin', 'HR Manager', 'Recruiter', 'Finance', 'Read Only'];

  const perTenant: SeededUser[] = [];
  for (const t of tenants) {
    const primary = agencies.find(a => a.tenantId === t.id)!;
    for (const role of userRoles) {
      const local = role.toLowerCase().replace(/\s+/g, '-');
      const u: SeededUser = {
        id: detId('user', t.slug, role),
        email: `${local}@${t.slug}.example`,
        role,
        tenantId: t.id,
        agencyId: primary.id,
      };
      const existing = await prisma.user.findUnique({ where: { email: u.email }, select: { id: true } });
      const row = await prisma.user.upsert({
        where: { email: u.email },
        // Always reset the password + clear any lockout state so a
        // re-seed restores a known-good login regardless of what the
        // row looked like before. status:ACTIVE bypasses any
        // INACTIVE/SUSPENDED/PENDING that an earlier flow may have set.
        update: {
          agencyId: primary.id, status: 'ACTIVE', roleId: roleByName.get(role)!,
          passwordHash, failedLoginAttempts: 0, lockedAt: null,
          passwordExpiresAt: null, deletedAt: null, deletedBy: null,
        },
        create: {
          id: u.id, email: u.email,
          firstName: faker.person.firstName(), lastName: faker.person.lastName(),
          passwordHash, roleId: roleByName.get(role)!, agencyId: primary.id,
          status: 'ACTIVE', jobTitle: role, department: 'Operations',
          phone: faker.phone.number({ style: 'international' }),
          preferredLanguage: 'en', timeZone: 'Europe/Berlin',
        },
        select: { id: true },
      });
      // Keep the in-memory id aligned with whatever the DB actually has.
      u.id = existing?.id ?? row.id;
      perTenant.push(u);
    }
  }

  // Global SUPER PlatformAdmin — pinned to the first tenant's HQ agency
  // so the User row is valid, but level=SUPER overrides any per-tenant
  // scope.
  const platformTenant = tenants[0];
  const platformAgency = agencies.find(a => a.tenantId === platformTenant.id)!;
  const superUser: SeededUser = {
    id: detId('user', 'platform', 'super'),
    email: 'super@platform.example',
    role: 'System Admin',
    tenantId: platformTenant.id,
    agencyId: platformAgency.id,
  };
  const superExisting = await prisma.user.findUnique({ where: { email: superUser.email }, select: { id: true } });
  const superRow = await prisma.user.upsert({
    where: { email: superUser.email },
    update: {
      status: 'ACTIVE', passwordHash, failedLoginAttempts: 0, lockedAt: null,
      passwordExpiresAt: null, deletedAt: null, deletedBy: null,
    },
    create: {
      id: superUser.id, email: superUser.email,
      firstName: 'Super', lastName: 'Admin',
      passwordHash, roleId: roleByName.get('System Admin')!, agencyId: platformAgency.id,
      status: 'ACTIVE', jobTitle: 'Platform Owner', department: 'Platform',
      phone: '+49 30 000 0000', preferredLanguage: 'en', timeZone: 'Europe/Berlin',
    },
    select: { id: true },
  });
  superUser.id = superExisting?.id ?? superRow.id;

  // SUPER PlatformAdmin row.
  await (prisma as any).platformAdmin.upsert({
    where: { userId: superUser.id },
    update: { level: 'SUPER' },
    create: { userId: superUser.id, level: 'SUPER' },
  });

  console.log(`  • users:    ${perTenant.length + 1} upserted (password: ${SEED_PASSWORD})`);
  return { super: superUser, perTenant };
}
