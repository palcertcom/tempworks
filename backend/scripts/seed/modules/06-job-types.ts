import { prisma } from '../lib/prisma';
import { detId } from '../lib/rng';

const CATEGORIES = [
  'Truck Driver', 'Forklift Operator', 'Warehouse Operative', 'Van Driver',
  'HGV Driver Class 1', 'HGV Driver Class 2', 'Tanker Driver', 'Multi-Drop Driver',
  'Transport Manager', 'LGV Driver', 'Flatbed Driver',
];

export async function seedJobTypes(): Promise<string[]> {
  for (const name of CATEGORIES) {
    await prisma.jobType.upsert({
      where: { name },
      update: { isActive: true },
      create: {
        id: detId('jobtype', name), name, isActive: true,
        description: `${name} role`,
        requiredDocuments: ['Passport', 'Driving License', 'CV'],
      },
    });
  }
  console.log(`  • job types: ${CATEGORIES.length} upserted`);
  return CATEGORIES;
}
