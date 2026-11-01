import { prisma } from '../lib/prisma';

/**
 * Lightweight role upsert. The existing prisma/seed.ts already creates
 * permissions + the role matrix; this just makes sure the roles we
 * need to attach users to exist by name. It deliberately does NOT
 * touch RolePermission rows — leave those to the main seed.
 */
export const SEEDED_ROLES = [
  'System Admin',
  'HR Manager',
  'Compliance Officer',
  'Recruiter',
  'Agency Manager',
  'Agency User',
  'Finance',
  'Read Only',
] as const;

export type SeededRoleName = typeof SEEDED_ROLES[number];

export async function seedRoles(): Promise<Map<SeededRoleName, string>> {
  const byName = new Map<SeededRoleName, string>();
  for (const name of SEEDED_ROLES) {
    const row = await prisma.role.upsert({
      where: { name },
      update: {},
      create: { name, description: `${name} role (seed)`, isSystem: name === 'System Admin' },
      select: { id: true },
    });
    byName.set(name, row.id);
  }
  console.log(`  • roles:   ${byName.size} present`);
  return byName;
}
