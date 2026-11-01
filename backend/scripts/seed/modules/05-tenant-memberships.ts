import { prisma } from '../lib/prisma';
import { detId } from '../lib/rng';
import type { SeededUser } from './04-users';
import type { SeededTenant } from './01-tenants';

/**
 * Wire each seeded user to a TenantMembership in their primary tenant.
 * Additionally, give the SUPER user a membership in every tenant so
 * the topbar switcher demo works out of the box.
 */
export async function seedTenantMemberships(
  tenants: SeededTenant[],
  users: { super: SeededUser; perTenant: SeededUser[] },
): Promise<number> {
  let count = 0;
  const all = [users.super, ...users.perTenant];
  for (const u of all) {
    await (prisma as any).tenantMembership.upsert({
      where: { userId_tenantId: { userId: u.id, tenantId: u.tenantId } },
      update: { status: 'ACTIVE' },
      create: {
        id: detId('membership', u.id, u.tenantId),
        userId: u.id, tenantId: u.tenantId,
        status: 'ACTIVE', joinedAt: new Date(),
      },
    });
    count++;
  }
  for (const t of tenants) {
    if (t.id === users.super.tenantId) continue;
    await (prisma as any).tenantMembership.upsert({
      where: { userId_tenantId: { userId: users.super.id, tenantId: t.id } },
      update: { status: 'ACTIVE' },
      create: {
        id: detId('membership', users.super.id, t.id),
        userId: users.super.id, tenantId: t.id,
        status: 'ACTIVE', joinedAt: new Date(),
      },
    });
    count++;
  }
  console.log(`  • memberships: ${count} upserted (SUPER is a member of every tenant)`);
  return count;
}
