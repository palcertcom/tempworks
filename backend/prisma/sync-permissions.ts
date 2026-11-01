/**
 * Permissions & system-role sync.
 *
 * Adds/updates permission rows and refreshes the permission lists on every
 * system role, without touching any other seeded data (users, agencies,
 * sample employees, document types, etc.). Safe to run repeatedly.
 *
 * Run once after deploying changes that introduce new permissions:
 *   npm run db:sync-permissions
 *
 * Uses pg.Pool directly rather than Prisma Client so it works under Prisma
 * 7's new "client" engine type (which requires a driver adapter or
 * Accelerate URL). This script only needs straightforward INSERT ... ON
 * CONFLICT statements on three tables, so raw SQL is the simplest fix.
 */
import { Pool } from 'pg';
import { randomUUID } from 'crypto';
import { join } from 'path';
import * as dotenv from 'dotenv';
import { resolvePoolSsl } from './pg-ssl';

dotenv.config({ path: join(__dirname, '../.env') });

const modules = [
  'dashboard',
  'employees', 'applicants', 'applications', 'documents',
  'workflow', 'agencies', 'compliance', 'reports',
  'notifications', 'settings', 'users', 'roles', 'logs',
  'vehicles', 'finance', 'attendance', 'job-ads', 'recycle-bin',
];
const actions = ['read', 'create', 'update', 'delete'];

const specialPermissions: { name: string; module: string; action: string }[] = [
  { name: 'documents:verify',      module: 'documents',   action: 'verify' },
  { name: 'compliance:resolve',    module: 'compliance',  action: 'resolve' },
  { name: 'reports:export',        module: 'reports',     action: 'export' },
  { name: 'applicants:export',     module: 'applicants',  action: 'export' },
  { name: 'employees:export',      module: 'employees',   action: 'export' },
  { name: 'vehicles:export',       module: 'vehicles',    action: 'export' },
  { name: 'finance:export',        module: 'finance',     action: 'export' },
  { name: 'attendance:export',     module: 'attendance',  action: 'export' },
  { name: 'applicants:approve',    module: 'applicants',  action: 'approve' },
  { name: 'applicants:convert',    module: 'applicants',  action: 'convert' },
  { name: 'applicants:bulk-action',module: 'applicants',  action: 'bulk-action' },
  { name: 'users:approve',         module: 'users',       action: 'approve' },
  { name: 'users:override',        module: 'users',       action: 'override' },
  { name: 'agencies:manage-permissions',    module: 'agencies',  action: 'manage-permissions' },
  { name: 'employees:manage-agency-access', module: 'employees', action: 'manage-agency-access' },
  { name: 'finance:status',        module: 'finance',     action: 'status' },
  { name: 'recycle-bin:restore',   module: 'recycle-bin', action: 'restore' },
  { name: 'job-ads:publish',       module: 'job-ads',     action: 'publish' },
];

/**
 * System role → permission names. System Admin always gets every row so its
 * list is resolved dynamically. Agency roles intentionally have no finance /
 * lead / internal-only permissions — those gates must remain Tempworks only.
 */
const rolePermissionSets: Record<string, string[]> = {
  'HR Manager': [
    'dashboard:read',
    'employees:read','employees:create','employees:update','employees:export',
    'employees:manage-agency-access',
    'applicants:read','applicants:create','applicants:update','applicants:export',
    'applicants:approve','applicants:convert','applicants:bulk-action',
    'applications:read','applications:create','applications:update',
    'documents:read','documents:create','documents:update','documents:verify',
    'workflow:read','workflow:update',
    'agencies:read','agencies:update',
    'compliance:read','compliance:resolve',
    'reports:read','reports:export',
    'notifications:read','notifications:create',
    'users:read','users:create','users:update','users:approve','users:override',
    'logs:read',
    'vehicles:read',
    'attendance:read','attendance:export',
    'job-ads:read','job-ads:create','job-ads:update','job-ads:publish',
    'recycle-bin:read',
  ],
  'Compliance Officer': [
    'dashboard:read',
    'employees:read','applicants:read','applications:read',
    'documents:read','documents:create','documents:update','documents:verify',
    'workflow:read','workflow:update',
    'compliance:read','compliance:resolve',
    'reports:read','reports:export',
    'notifications:read','notifications:create',
    'logs:read',
    'vehicles:read',
    'attendance:read',
    'recycle-bin:read',
  ],
  'Recruiter': [
    'dashboard:read',
    'employees:read',
    'applicants:read','applicants:create','applicants:update','applicants:export',
    'applicants:convert','applicants:bulk-action',
    'applications:read','applications:create','applications:update',
    'documents:read','documents:create',
    'workflow:read',
    'agencies:read',
    'compliance:read',
    'reports:read',
    'notifications:read',
    'logs:read',
    'job-ads:read','job-ads:create','job-ads:update',
    'attendance:read',
  ],
  // Agency-side roles are scoped to their own agency. Tenancy filters
  // in each service enforce "own-agency only" — the permissions below
  // cover the three allowed surfaces: candidates, agency profile, and
  // agency user management (Manager only). Tempworks internals
  // (workflow, reports, documents, employees, compliance, finance,
  // logs, notifications, roles, settings, recycle bin, etc.) are
  // intentionally absent and must be granted explicitly later.
  'Agency Manager': [
    'applicants:read','applicants:create','applicants:update',
    'applicants:export','applicants:bulk-action',
    'employees:read','employees:update',
    'agencies:read','agencies:update',
    'users:read','users:create','users:update','users:delete',
  ],
  'Agency User': [
    'applicants:read','applicants:create','applicants:update',
    'employees:read','employees:update',
    'agencies:read',
  ],
  'Finance': [
    'dashboard:read',
    'employees:read','applicants:read','applications:read',
    'agencies:read',
    'reports:read','reports:export',
    'notifications:read',
    'logs:read',
    'finance:read','finance:create','finance:update','finance:delete',
    'finance:export','finance:status',
    'attendance:read','attendance:export',
  ],
};

async function main() {
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: resolvePoolSsl(process.env.DATABASE_URL),
  });

  try {
    const permissionData: { name: string; module: string; action: string }[] = [];
    for (const mod of modules) {
      for (const action of actions) {
        permissionData.push({ name: `${mod}:${action}`, module: mod, action });
      }
    }
    permissionData.push(...specialPermissions);

    // Upsert permission rows. Prisma-generated `permissions.id` is a text
    // column populated by Prisma with a uuid; when inserting directly we
    // supply our own uuid and only on a fresh insert — conflicts update the
    // module/action but leave the id alone.
    for (const p of permissionData) {
      await pool.query(
        `INSERT INTO permissions (id, name, module, action, "createdAt")
         VALUES ($1, $2, $3, $4, NOW())
         ON CONFLICT (name) DO UPDATE SET module = EXCLUDED.module, action = EXCLUDED.action`,
        [randomUUID(), p.name, p.module, p.action],
      );
    }
    console.log(`Upserted ${permissionData.length} permissions`);

    const { rows: allPermissions } = await pool.query<{ id: string; name: string; action: string }>(
      `SELECT id, name, action FROM permissions`,
    );
    const pMap = new Map(allPermissions.map(p => [p.name, p.id]));
    const resolve = (names: string[]) =>
      names.filter(n => pMap.has(n)).map(n => pMap.get(n)!);

    // System Admin — always all permissions.
    const adminNames = allPermissions.map(p => p.name);

    const rolesToSync: Record<string, string[]> = {
      'System Admin': adminNames,
      ...rolePermissionSets,
      // Read Only picks up every `:read` permission, including new modules.
      'Read Only': allPermissions.filter(p => p.action === 'read').map(p => p.name),
    };

    for (const [roleName, names] of Object.entries(rolesToSync)) {
      const { rows: roleRows } = await pool.query<{ id: string }>(
        `SELECT id FROM roles WHERE name = $1 LIMIT 1`,
        [roleName],
      );
      if (roleRows.length === 0) {
        console.warn(`  · Role "${roleName}" not found — skipping`);
        continue;
      }
      const roleId = roleRows[0].id;
      const permissionIds = resolve(names);

      await pool.query(`DELETE FROM role_permissions WHERE "roleId" = $1`, [roleId]);
      if (permissionIds.length) {
        // Bulk insert via unnest so we can send all rows in one round-trip.
        await pool.query(
          `INSERT INTO role_permissions ("roleId", "permissionId")
           SELECT $1, pid FROM UNNEST($2::text[]) AS pid
           ON CONFLICT DO NOTHING`,
          [roleId, permissionIds],
        );
      }
      console.log(`  · ${roleName}: ${permissionIds.length} permissions`);
    }

    console.log('Permissions sync complete.');
  } finally {
    await pool.end();
  }
}

main().catch(err => {
  console.error('Sync failed:', err);
  process.exit(1);
});
