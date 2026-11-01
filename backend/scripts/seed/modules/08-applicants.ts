import { prisma } from '../lib/prisma';
import { detId, faker, pick } from '../lib/rng';
import type { SeededTenant } from './01-tenants';
import type { SeededAgency } from './03-agencies';

const STATUSES = ['NEW', 'SCREENING', 'INTERVIEW', 'OFFER', 'ACCEPTED', 'REJECTED', 'ONBOARDING'];
const NATIONALITIES = ['Polish', 'German', 'Romanian', 'Italian', 'Spanish', 'Bulgarian', 'Ukrainian'];

export async function seedApplicants(tenants: SeededTenant[], agencies: SeededAgency[]): Promise<number> {
  let count = 0;
  for (const t of tenants) {
    const tenantAgencies = agencies.filter(a => a.tenantId === t.id);
    for (let i = 0; i < 12; i++) {
      const id = detId('applicant', t.slug, String(i));
      const tier: 'LEAD' | 'CANDIDATE' = i < 8 ? 'LEAD' : 'CANDIDATE';
      const firstName = faker.person.firstName();
      const lastName = faker.person.lastName();
      const agency = pick(tenantAgencies);
      const applicationData = {
        personal: { firstName, lastName, citizenship: pick(NATIONALITIES) },
        addresses: {
          permanent: {
            line1: faker.location.streetAddress(),
            city:  faker.location.city(),
            country: pick(['Germany', 'Poland', 'Italy', 'Romania']),
            zip:   faker.location.zipCode(),
          },
        },
        passport: {
          number: faker.string.alphanumeric({ length: 9, casing: 'upper' }),
          issueDate:  faker.date.past({ years: 5 }).toISOString().slice(0, 10),
          expiryDate: faker.date.future({ years: 6 }).toISOString().slice(0, 10),
          country:    pick(NATIONALITIES),
        },
        hasDrivingLicense: i % 2 === 0 ? 'yes' : 'no',
        education: [{
          level: pick(['High School', 'Bachelor', 'Master', 'Diploma']),
          institution: faker.company.name() + ' University',
          fieldOfStudy: pick(['Logistics', 'Business', 'Engineering', 'Computer Science']),
          startDate: '2015-09-01', endDate: '2019-06-30',
        }],
        workHistory: [{
          employer: faker.company.name(),
          position: 'Driver',
          startDate: '2020-01-01', endDate: '2023-12-31', current: false,
          country: pick(['Germany', 'UK', 'Italy']),
        }],
      };
      // Applicants lost the global email-unique constraint in Phase 3.x.
      // Match on the seeded UUID; if a previous run created one with a
      // different id under the same email + tenant, just create a new
      // dummy row — collisions are harmless.
      const found = await prisma.applicant.findUnique({ where: { id }, select: { id: true } });
      if (found) {
        await prisma.applicant.update({
          where: { id },
          data: { tier, agencyId: agency.id, tenantId: t.id } as any,
        });
        count++;
        continue;
      }
      await prisma.applicant.create({
        data: ({
          id, tier,
          firstName, lastName,
          email: `seed-${t.slug}-${i}@applicant.example`,
          phone: faker.phone.number({ style: 'international' }),
          nationality: pick(NATIONALITIES),
          citizenship: pick(NATIONALITIES),
          status: pick(STATUSES) as any,
          jobTypeId: null,
          agencyId: agency.id,
          tenantId: t.id,
          applicationData: applicationData as any,
          source: i % 3 === 0 ? 'SELF_APPLIED' : 'STAFF_CREATED',
          dateOfBirth: faker.date.birthdate({ min: 22, max: 55, mode: 'age' }),
          hasDrivingLicense: applicationData.hasDrivingLicense === 'yes',
        }) as any,
      });
      count++;
    }
  }
  console.log(`  • applicants: ${count} upserted (12 per tenant; ~8 LEAD + 4 CANDIDATE)`);
  return count;
}
