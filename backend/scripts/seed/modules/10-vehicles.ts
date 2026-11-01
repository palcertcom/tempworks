import { prisma } from '../lib/prisma';
import { detId, faker, pick } from '../lib/rng';
import type { SeededTenant } from './01-tenants';
import type { SeededAgency } from './03-agencies';

const TYPES   = ['Truck', 'Van', 'Trailer', 'Forklift'];
const MAKES   = ['Mercedes-Benz', 'MAN', 'Volvo', 'Scania', 'DAF', 'Iveco'];
const MODELS: Record<string, string[]> = {
  'Mercedes-Benz': ['Actros', 'Atego', 'Sprinter'],
  'MAN':           ['TGX',    'TGS',   'TGE'],
  'Volvo':         ['FH',     'FM',    'FE'],
  'Scania':        ['R 500',  'S 730', 'P 280'],
  'DAF':           ['XF',     'CF',    'LF'],
  'Iveco':         ['Stralis','Eurocargo','Daily'],
};
const FUEL    = ['Diesel', 'Electric', 'Hybrid'];
const COLORS  = ['White', 'Blue', 'Red', 'Silver', 'Black'];
const STATUSES = ['ACTIVE', 'IN_MAINTENANCE', 'Rented'];

export async function seedVehicles(tenants: SeededTenant[], agencies: SeededAgency[]): Promise<number> {
  let count = 0;
  for (const t of tenants) {
    const tenantAgencies = agencies.filter(a => a.tenantId === t.id);
    for (let i = 0; i < 6; i++) {
      const id = detId('vehicle', t.slug, String(i));
      const make = pick(MAKES);
      const model = pick(MODELS[make]);
      const year = faker.number.int({ min: 2015, max: 2025 });
      // Registration mirrors UK/EU style; stable per (tenant, index).
      const reg = `${t.slug.slice(0, 2).toUpperCase()}${String(i + 1).padStart(2, '0')}-${faker.string.alpha({ length: 3, casing: 'upper' })}`;
      const vin = faker.vehicle.vin();
      const agency = pick(tenantAgencies);
      const type = pick(TYPES);
      const status = pick(STATUSES);

      await prisma.vehicle.upsert({
        where: { registrationNumber: reg },
        update: { tenantId: t.id, agencyId: agency.id, status } as any,
        create: ({
          id,
          registrationNumber: reg, vin,
          type, status, make, model, year,
          color: pick(COLORS),
          licensePlate: reg,
          fuelType: pick(FUEL),
          fuelCapacity: faker.number.float({ min: 50, max: 600, fractionDigits: 1 }),
          currentMileage: faker.number.int({ min: 5_000, max: 600_000 }),
          motExpiryDate:          faker.date.future({ years: 1 }),
          taxExpiryDate:          faker.date.future({ years: 1 }),
          insuranceExpiryDate:    faker.date.future({ years: 1 }),
          registrationExpiryDate: faker.date.future({ years: 2 }),
          purchaseDate: faker.date.past({ years: 5 }),
          purchaseCost: faker.number.float({ min: 15_000, max: 180_000, fractionDigits: 2 }),
          vendorName: faker.company.name(),
          insurancePolicyNumber: `POL-${faker.string.alphanumeric({ length: 8, casing: 'upper' })}`,
          insuranceCompany: faker.company.name() + ' Insurance',
          insuranceType: 'Comprehensive',
          insuranceStartDate: faker.date.past({ years: 1 }),
          grossWeight: type === 'Truck' || type === 'Trailer' ? faker.number.int({ min: 18_000, max: 44_000 }) : null,
          payloadCapacity: type === 'Truck' ? faker.number.int({ min: 8_000, max: 24_000 }) : null,
          numberOfAxles: type === 'Truck' ? faker.number.int({ min: 2, max: 4 }) : null,
          tareWeight: type === 'Truck' ? faker.number.int({ min: 7_000, max: 12_000 }) : null,
          bodyType: type === 'Truck' ? pick(['Box', 'Curtainsider', 'Tipper', 'Flatbed']) : null,
          euroEmissionClass: pick(['Euro 5', 'Euro 6', 'Euro 6d']),
          seatingCapacity: type === 'Van' ? faker.number.int({ min: 2, max: 9 }) : null,
          agencyId: agency.id,
          tenantId: t.id,
        }) as any,
      });
      count++;
    }
  }
  console.log(`  • vehicles: ${count} upserted (6 per tenant)`);
  return count;
}
