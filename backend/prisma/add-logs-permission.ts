/**
 * One-time migration: grant logs:read to every role that is missing it.
 * Run with:  npx ts-node backend/prisma/add-logs-permission.ts
 */
import { PrismaClient } from '@prisma/client';
import { Pool } from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';
import * as dotenv from 'dotenv';
import { resolvePoolSsl } from './pg-ssl';

dotenv.config();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: resolvePoolSsl(process.env.DATABASE_URL),
});
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

async function main() {
  const permission = await prisma.permission.findUnique({ where: { name: 'logs:read' } });
  if (!permission) {
    console.error('logs:read permission not found – run the full seed first.');
    process.exit(1);
  }

  const roles = await prisma.role.findMany({ select: { id: true, name: true } });

  let added = 0;
  for (const role of roles) {
    const existing = await prisma.rolePermission.findFirst({
      where: { roleId: role.id, permissionId: permission.id },
    });
    if (!existing) {
      await prisma.rolePermission.create({
        data: { roleId: role.id, permissionId: permission.id },
      });
      console.log(`  ✓ Added logs:read to "${role.name}"`);
      added++;
    } else {
      console.log(`  – "${role.name}" already has logs:read`);
    }
  }

  console.log(`\nDone. Added logs:read to ${added} role(s).`);
}

main()
  .catch(e => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
