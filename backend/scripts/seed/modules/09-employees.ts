import { prisma } from '../lib/prisma';
import { detId, faker, pick } from '../lib/rng';
import type { SeededTenant } from './01-tenants';
import type { SeededAgency } from './03-agencies';

const STATUSES = ['ACTIVE', 'PENDING', 'ON_LEAVE'];
const NATIONALITIES = ['Polish', 'German', 'Romanian', 'Italian', 'Spanish', 'Bulgarian'];

export async function seedEmployees(tenants: SeededTenant[], agencies: SeededAgency[]): Promise<number> {
  let count = 0;
  for (const t of tenants) {
    const tenantAgencies = agencies.filter(a => a.tenantId === t.id);
    for (let i = 0; i < 5; i++) {
      const id = detId('employee', t.slug, String(i));
      const firstName = faker.person.firstName();
      const lastName = faker.person.lastName();
      const agency = pick(tenantAgencies);
      const email = `seed-${t.slug}-emp-${i}@employee.example`;
      await prisma.employee.upsert({
        where: { email },
        update: { tenantId: t.id, agencyId: agency.id } as any,
        create: ({
          id,
          firstName, lastName,
          email,
          phone: faker.phone.number({ style: 'international' }),
          nationality: pick(NATIONALITIES),
          status: pick(STATUSES) as any,
          dateOfBirth: faker.date.birthdate({ min: 25, max: 55, mode: 'age' }),
          licenseNumber: i % 2 === 0 ? faker.string.alphanumeric({ length: 10, casing: 'upper' }) : null,
          licenseCategory: i % 2 === 0 ? pick(['B', 'C', 'CE', 'D']) : null,
          agencyId: agency.id,
          tenantId: t.id,
          // Address fields are NOT NULL on Employee — populate with
          // realistic faker values.
          addressLine1: faker.location.streetAddress(),
          city:         faker.location.city(),
          country:      pick(['Germany', 'Poland', 'Italy', 'Romania']),
          postalCode:   faker.location.zipCode(),
          // applicationData mirrors the applicant blob so the same UI
          // can render employee profiles after conversion.
          applicationData: {
            personal: { firstName, lastName },
            passport: { number: faker.string.alphanumeric({ length: 9, casing: 'upper' }) },
          } as any,
        }) as any,
      });
      count++;
    }
  }
  console.log(`  • employees: ${count} upserted`);
  return count;
}
