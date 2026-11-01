import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';
import * as bcrypt from 'bcryptjs';
import * as dotenv from 'dotenv';
dotenv.config();

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter } as any);

async function main() {
  // Permissions
  const modules = ['dashboard','employees','applicants','applications','documents','workflow','agencies','compliance','reports','notifications','settings','users','roles','logs'];
  const actions = ['read','create','update','delete'];
  const permissionData: { name: string; module: string; action: string }[] = [];
  for (const mod of modules) for (const action of actions) permissionData.push({ name: `${mod}:${action}`, module: mod, action });
  permissionData.push({ name: 'documents:verify', module: 'documents', action: 'verify' });
  permissionData.push({ name: 'compliance:resolve', module: 'compliance', action: 'resolve' });
  permissionData.push({ name: 'reports:export', module: 'reports', action: 'export' });
  for (const p of permissionData) await prisma.permission.upsert({ where: { name: p.name }, update: {}, create: p });
  console.log(`Upserted ${permissionData.length} permissions`);

  const allPermissions = await prisma.permission.findMany();

  // System Admin role
  const existingRole = await prisma.role.findFirst({ where: { name: 'System Admin' } });
  const adminRole = existingRole ?? await prisma.role.create({
    data: {
      name: 'System Admin',
      description: 'Full system access',
      isSystem: true,
      permissions: { create: allPermissions.map(p => ({ permissionId: p.id })) },
    },
  });
  console.log(`Role: ${adminRole.name} — ${adminRole.id}`);

  // Owner agency
  let ownerAgency = await prisma.agency.findFirst({ where: { email: 'admin@tempworks.sk' } });
  if (!ownerAgency) {
    ownerAgency = await prisma.agency.create({
      data: {
        name: 'TempWorks',
        country: 'Slovakia',
        email: 'admin@tempworks.sk',
        phone: '+421000000000',
        contactPerson: 'System Admin',
      },
    });
  }
  console.log(`Agency: ${ownerAgency.name} — ${ownerAgency.id}`);

  // Admin user
  const adminEmail = process.env.SEED_ADMIN_EMAIL || 'admin@tempworks.com';
  const adminPassword = process.env.SEED_ADMIN_PASSWORD || 'Admin@123456';
  const passwordHash = await bcrypt.hash(adminPassword, 10);

  const adminUser = await prisma.user.upsert({
    where: { email: adminEmail },
    update: { agencyId: ownerAgency.id },
    create: {
      email: adminEmail,
      passwordHash,
      firstName: 'System',
      lastName: 'Admin',
      roleId: adminRole.id,
      agencyId: ownerAgency.id,
    },
  });
  console.log(`Admin user: ${adminUser.email} — ${adminUser.id}`);
  console.log('Done.');
}

main().catch(e => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
