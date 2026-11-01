/**
 * Run once to drop the conflicting polymorphic FK constraints that share a single
 * entityId column across Employee and Applicant tables.
 *
 * Usage: npx ts-node prisma/drop-polymorphic-fks.ts
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  const constraints = [
    { table: 'documents', name: 'document_employee_fk' },
    { table: 'documents', name: 'document_applicant_fk' },
    { table: 'visas', name: 'visa_employee_fk' },
    { table: 'visas', name: 'visa_applicant_fk' },
    { table: 'compliance_alerts', name: 'alert_employee_fk' },
    { table: 'compliance_alerts', name: 'alert_applicant_fk' },
  ];

  for (const { table, name } of constraints) {
    try {
      await prisma.$executeRawUnsafe(
        `ALTER TABLE "${table}" DROP CONSTRAINT IF EXISTS "${name}"`,
      );
      console.log(`✓ Dropped ${name}`);
    } catch (err) {
      console.error(`✗ Failed to drop ${name}:`, err);
    }
  }

  console.log('\nDone. Re-run the app — document uploads should now work.');
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
