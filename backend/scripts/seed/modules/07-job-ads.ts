import { prisma } from '../lib/prisma';
import { detId, faker, pick } from '../lib/rng';
import type { SeededTenant } from './01-tenants';
import type { SeededUser } from './04-users';

export async function seedJobAds(
  tenants: SeededTenant[],
  categories: string[],
  perTenantUsers: SeededUser[],
): Promise<number> {
  const contractTypes = ['Full-time', 'Part-time', 'Contract', 'Temporary'];
  const countries = ['United Kingdom', 'Germany', 'Poland', 'Netherlands', 'France'];
  let count = 0;

  for (const t of tenants) {
    const creator = perTenantUsers.find(u => u.tenantId === t.id && u.role === 'System Admin');
    for (let i = 0; i < 5; i++) {
      const category = pick(categories);
      const title = `${category} – ${faker.location.city()}`;
      const slug = `seed-${t.slug}-${category.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${i + 1}`;
      const id = detId('jobad', t.slug, String(i));
      const status = i === 4 ? 'DRAFT' : 'PUBLISHED'; // 4 published, 1 draft per tenant
      const min = faker.number.int({ min: 2000, max: 3500 });
      const max = min + faker.number.int({ min: 500, max: 1500 });
      const publishedAt = status === 'PUBLISHED'
        ? faker.date.recent({ days: 30 })
        : null;
      await prisma.jobAd.upsert({
        where: { slug },
        update: { status, title, publishedAt, tenantId: t.id },
        create: {
          id, slug, title, category,
          description: faker.lorem.paragraphs(2, '\n\n'),
          city: faker.location.city(), country: pick(countries),
          contractType: pick(contractTypes),
          salaryMin: min, salaryMax: max, currency: 'EUR',
          status, publishedAt,
          requiredDocuments: JSON.stringify(['Passport', 'CV', 'Driving License']),
          createdById: creator?.id ?? null,
          tenantId: t.id,
        },
      });
      count++;
    }
  }
  console.log(`  • job ads:  ${count} upserted across ${tenants.length} tenants`);
  return count;
}
