import { prisma } from '../lib/prisma';
import { detId, faker, pick } from '../lib/rng';

export interface SeededWorkshop { id: string; name: string; }

const WORKSHOPS: { key: string; name: string; city: string; country: string; specs: string[] }[] = [
  { key: 'munich-hgv-care',       name: 'Munich HGV Care',       city: 'München',  country: 'Germany',     specs: ['HGV', 'Tachograph', 'Brakes'] },
  { key: 'warsaw-truck-service',  name: 'Warsaw Truck Service',  city: 'Warszawa', country: 'Poland',      specs: ['Engine', 'Tyres', 'Electrical'] },
  { key: 'milan-fleet-garage',    name: 'Milan Fleet Garage',    city: 'Milano',   country: 'Italy',       specs: ['Body', 'AC', 'Diagnostics'] },
  { key: 'london-vehicle-works',  name: 'London Vehicle Works',  city: 'London',   country: 'United Kingdom', specs: ['MOT', 'Servicing', 'EV'] },
];

/**
 * Workshops are tenant-less global service providers (the `Workshop`
 * model has no tenantId column). Each tenant's fleet may book any of
 * them via MaintenanceRecord rows.
 */
export async function seedWorkshops(): Promise<SeededWorkshop[]> {
  const out: SeededWorkshop[] = [];
  for (const w of WORKSHOPS) {
    const id = detId('workshop', w.key);
    const existing = await prisma.workshop.findFirst({ where: { name: w.name }, select: { id: true } });
    const row = existing
      ? await prisma.workshop.update({
          where: { id: existing.id },
          data: { status: 'ACTIVE', isActive: true, city: w.city, country: w.country },
          select: { id: true },
        })
      : await prisma.workshop.create({
          data: {
            id, name: w.name, companyName: w.name,
            phone: '+49 30 100 000', telephone: '+49 30 100 000',
            email: `info@${w.key}.example`,
            address: `${faker.location.streetAddress()}, ${w.city}`,
            city: w.city, country: w.country,
            vatNumber: faker.string.alphanumeric({ length: 11, casing: 'upper' }),
            businessRegistrationNumber: faker.string.alphanumeric({ length: 8, casing: 'upper' }),
            contactName: faker.person.fullName(),
            contactPersonEmail: `contact@${w.key}.example`,
            contactPersonPhone: '+49 30 200 000',
            bankName: 'Deutsche Bank', iban: `DE${faker.string.numeric(20)}`,
            establishmentYear: faker.number.int({ min: 1995, max: 2020 }),
            specializations: w.specs,
            status: 'ACTIVE', isActive: true,
          },
          select: { id: true },
        });
    out.push({ id: row.id, name: w.name });
  }
  console.log(`  • workshops: ${out.length} upserted`);
  return out;
}

export interface SeededMaintenanceType { id: string; name: string; }

const MAINT_TYPES: { key: string; name: string; intervalDays?: number; intervalKm?: number }[] = [
  { key: 'oil',         name: 'Oil Change',           intervalKm: 20000 },
  { key: 'tyres',       name: 'Tyre Replacement',     intervalKm: 60000 },
  { key: 'mot',         name: 'MOT / Inspection',     intervalDays: 365 },
  { key: 'tacho',       name: 'Tachograph Calibration', intervalDays: 730 },
  { key: 'brakes',      name: 'Brake Service',        intervalKm: 80000 },
  { key: 'general',     name: 'General Service',      intervalKm: 30000 },
];

/**
 * Add the IntervalMode enum + `intervalMode` column to maintenance_types
 * if the local DB predates that migration. Idempotent (uses DO blocks +
 * IF NOT EXISTS) so safe to run on a fully-migrated DB too.
 */
async function ensureIntervalModeColumn(): Promise<void> {
  try {
    await prisma.$executeRawUnsafe(`
      DO $$ BEGIN
        CREATE TYPE "IntervalMode" AS ENUM ('DAYS', 'KM', 'BOTH');
      EXCEPTION WHEN duplicate_object THEN NULL;
      END $$;
    `);
    await prisma.$executeRawUnsafe(
      `ALTER TABLE "maintenance_types" ADD COLUMN IF NOT EXISTS "intervalMode" "IntervalMode" DEFAULT 'KM';`,
    );
  } catch {
    // Best effort — if the heal fails the subsequent insert will surface a clearer error.
  }
}

export async function seedMaintenanceTypes(): Promise<SeededMaintenanceType[]> {
  await ensureIntervalModeColumn();
  const out: SeededMaintenanceType[] = [];
  for (const m of MAINT_TYPES) {
    const id = detId('maint-type', m.key);
    const existing = await prisma.maintenanceType.findFirst({ where: { name: m.name }, select: { id: true } });
    const row = existing
      ? await prisma.maintenanceType.update({
          where: { id: existing.id },
          data: { isActive: true, defaultIntervalDays: m.intervalDays ?? null, defaultIntervalKm: m.intervalKm ?? null },
          select: { id: true },
        })
      : await prisma.maintenanceType.create({
          // `intervalMode` deliberately omitted — the column is optional
          // with a KM default, and some dev DBs predate the enum
          // migration. The schema's default applies when present and
          // the field is simply skipped when not.
          data: {
            id, name: m.name, description: `${m.name} service`,
            defaultIntervalDays: m.intervalDays ?? null,
            defaultIntervalKm: m.intervalKm ?? null,
            isActive: true,
          } as any,
          select: { id: true },
        });
    out.push({ id: row.id, name: m.name });
  }
  console.log(`  • maintenance types: ${out.length} upserted`);
  return out;
}

const STATUSES = ['SCHEDULED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED'];

export async function seedMaintenanceRecords(
  workshops: SeededWorkshop[],
  types: SeededMaintenanceType[],
): Promise<number> {
  // Two maintenance records per seeded vehicle, mixing scheduled +
  // completed so the Maintenance Records page renders both tabs.
  const vehicles = await prisma.vehicle.findMany({
    where: { id: { in: [] } }, // overridden below — list all seeded vehicles
    select: { id: true, tenantId: true, currentMileage: true },
  }).catch(() => [] as any[]);

  // Re-run a broader fetch since the empty `in` short-circuits.
  const all = await prisma.vehicle.findMany({
    select: { id: true, tenantId: true, currentMileage: true },
  });
  const vehs = all;

  let count = 0;
  for (const v of vehs) {
    for (let i = 0; i < 2; i++) {
      const id = detId('maint', v.id, String(i));
      const type = pick(types);
      const ws   = pick(workshops);
      const status = pick(STATUSES);
      const scheduledDate = faker.date.recent({ days: 90 });
      const completedDate = status === 'COMPLETED'
        ? faker.date.between({ from: scheduledDate, to: new Date() })
        : null;
      const mileage = v.currentMileage ?? 0;
      await prisma.maintenanceRecord.upsert({
        where: { id },
        update: { status: status as any },
        create: ({
          id,
          vehicleId: v.id,
          maintenanceTypeId: type.id,
          workshopId: ws.id,
          status: status as any,
          scheduledDate, completedDate,
          mileageAtService: mileage + faker.number.int({ min: 0, max: 5000 }),
          nextServiceDate:  faker.date.future({ years: 1 }),
          nextServiceMileage: mileage + 20000,
          cost: faker.number.float({ min: 80, max: 2500, fractionDigits: 2 }),
          laborCost: faker.number.float({ min: 40, max: 1200, fractionDigits: 2 }),
          partsCost: faker.number.float({ min: 20, max: 1300, fractionDigits: 2 }),
          description: `${type.name} at ${ws.name}`,
          technicianName: faker.person.fullName(),
          invoiceNumber: `INV-${faker.string.alphanumeric({ length: 8, casing: 'upper' })}`,
          tenantId: v.tenantId,
        }) as any,
      });
      count++;
    }
  }
  // Touch the unused stub so TS doesn't complain when the empty initial fetch is removed in future.
  void vehicles;
  console.log(`  • maintenance records: ${count} upserted (2 per vehicle)`);
  return count;
}
