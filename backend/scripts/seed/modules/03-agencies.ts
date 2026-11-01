import { prisma } from '../lib/prisma';
import { detId, faker } from '../lib/rng';
import type { SeededTenant } from './01-tenants';

export interface SeededAgency { id: string; tenantId: string; name: string; }

export async function seedAgencies(tenants: SeededTenant[]): Promise<SeededAgency[]> {
  const out: SeededAgency[] = [];
  for (const t of tenants) {
    const a1: SeededAgency = {
      id: detId('agency', t.slug, 'primary'),
      tenantId: t.id,
      name: `${t.name} HQ`,
    };
    const a2: SeededAgency = {
      id: detId('agency', t.slug, 'branch'),
      tenantId: t.id,
      name: `${t.name} ${faker.location.city()} Branch`,
    };
    for (const a of [a1, a2]) {
      // Agency has no @unique besides id; match an existing agency with
      // the same (tenantId, name) so the seed adopts it instead of
      // creating a duplicate. Updates the deterministic id back into
      // the seed graph so child rows point at the right row.
      const existing = await prisma.agency.findFirst({
        where: { tenantId: t.id, name: a.name },
        select: { id: true },
      });
      if (existing) {
        await prisma.agency.update({
          where: { id: existing.id },
          data: { status: 'ACTIVE', tenantId: t.id },
        });
        out.push({ ...a, id: existing.id });
      } else {
        const row = await prisma.agency.create({
          data: {
            id: a.id, name: a.name, country: 'Germany',
            contactPerson: 'Seed Contact', email: `contact+${a.id.slice(0, 8)}@${t.slug}.example`,
            phone: '+49 30 123 4567', status: 'ACTIVE', tenantId: t.id,
            isDefault: a === a1,
          },
          select: { id: true },
        });
        out.push({ ...a, id: row.id });
      }
    }
  }
  console.log(`  • agencies: ${out.length} upserted`);
  return out;
}
