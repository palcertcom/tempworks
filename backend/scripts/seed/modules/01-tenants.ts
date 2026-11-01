import { prisma } from '../lib/prisma';
import { detId } from '../lib/rng';

export interface SeededTenant {
  id: string;
  slug: string;
  name: string;
}

export const TENANTS: SeededTenant[] = [
  { id: detId('tenant', 'tempworks-europe'), slug: 'tempworks-europe', name: 'TempWorks Europe' },
  { id: detId('tenant', 'rint'),             slug: 'rint',             name: 'RINT Solutions'   },
  { id: detId('tenant', 'acme'),             slug: 'acme',             name: 'Acme Staffing'    },
];

export async function seedTenants(): Promise<SeededTenant[]> {
  const out: SeededTenant[] = [];
  for (const t of TENANTS) {
    // Adopt an existing row that already has the same slug — re-key
    // the seed's deterministic id off that row so child references
    // (agencies, memberships, …) line up.
    const row = await (prisma as any).tenant.upsert({
      where: { slug: t.slug },
      update: { name: t.name, status: 'ACTIVE' },
      create: {
        id: t.id, slug: t.slug, name: t.name, status: 'ACTIVE', region: 'eu',
        branding: {
          tagline:      `${t.name} — Professional Recruitment Solutions`,
          primaryColor: '#2563eb',
          locale:       'en',
          timezone:     'Europe/Berlin',
        },
      },
      select: { id: true, slug: true, name: true },
    });
    out.push({ id: row.id, slug: row.slug, name: row.name });
  }
  console.log(`  • tenants: ${out.length} upserted`);
  return out;
}
