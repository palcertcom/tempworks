/**
 * Dummy-data seeder for testing every module.
 *
 * Idempotent: every row uses a deterministic UUID derived from a
 * single SEED_BASE, so re-running this script upserts in place and
 * never duplicates. Add or remove modules from the orchestrator below
 * to scope what gets touched.
 *
 * Usage:
 *   npm run seed:dummy                 # seed every module
 *   npm run seed:dummy -- --modules tenants,users   # subset
 *   npm run seed:dummy -- --reset      # tear down seeded rows first
 *   SEED_BASE=foo npm run seed:dummy   # different deterministic graph
 *
 * Refuses to run with --reset against a NODE_ENV=production database.
 */
import { prisma } from './lib/prisma';
import { SEED_PASSWORD } from './lib/passwords';
import { seedTenants } from './modules/01-tenants';
import { seedRoles } from './modules/02-roles';
import { seedAgencies } from './modules/03-agencies';
import { seedUsers } from './modules/04-users';
import { seedTenantMemberships } from './modules/05-tenant-memberships';
import { seedJobTypes } from './modules/06-job-types';
import { seedJobAds } from './modules/07-job-ads';
import { seedApplicants } from './modules/08-applicants';
import { seedEmployees } from './modules/09-employees';
import { seedVehicles } from './modules/10-vehicles';
import { seedWorkshops, seedMaintenanceTypes, seedMaintenanceRecords } from './modules/11-workshops-maintenance';
import { resetSeededRows } from './reset';

interface Args {
  modules: string[] | null;
  reset: boolean;
}

function parseArgs(): Args {
  const a = process.argv.slice(2);
  const out: Args = { modules: null, reset: false };
  for (let i = 0; i < a.length; i++) {
    if (a[i] === '--reset') out.reset = true;
    else if (a[i] === '--modules' && a[i + 1]) { out.modules = a[i + 1].split(','); i++; }
  }
  return out;
}

const STEPS = [
  'tenants', 'roles', 'agencies', 'users', 'memberships',
  'job-types', 'job-ads', 'applicants', 'employees', 'vehicles',
  'workshops', 'maintenance-types', 'maintenance-records',
] as const;

async function main(): Promise<void> {
  const args = parseArgs();
  const wanted = args.modules ? new Set(args.modules) : new Set<string>(STEPS);

  if (args.reset) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('--reset refused in NODE_ENV=production');
    }
    console.log('• resetting previously seeded rows…');
    await resetSeededRows();
  }

  console.log(`seeding (modules: ${[...wanted].join(', ') || 'none'})…`);

  // Step dependencies are linear; the orchestrator just skips when the
  // step isn't requested but still passes the prior results forward.
  const tenants     = wanted.has('tenants')     ? await seedTenants()                                : [];
  const roleByName  = wanted.has('roles')       ? await seedRoles()                                  : new Map();
  const agencies    = wanted.has('agencies')    ? await seedAgencies(tenants)                        : [];
  const users       = wanted.has('users')       ? await seedUsers(tenants, agencies, roleByName)     : { super: null as any, perTenant: [] };
  if (wanted.has('memberships') && users.super) await seedTenantMemberships(tenants, users);
  const categories  = wanted.has('job-types')   ? await seedJobTypes()                               : [];
  if (wanted.has('job-ads')    && tenants.length) await seedJobAds(tenants, categories, users.perTenant);
  if (wanted.has('applicants') && tenants.length) await seedApplicants(tenants, agencies);
  if (wanted.has('employees')  && tenants.length) await seedEmployees(tenants, agencies);
  if (wanted.has('vehicles')   && tenants.length) await seedVehicles(tenants, agencies);
  const workshops   = wanted.has('workshops')          ? await seedWorkshops()          : [];
  const maintTypes  = wanted.has('maintenance-types')  ? await seedMaintenanceTypes()   : [];
  if (wanted.has('maintenance-records') && workshops.length && maintTypes.length) {
    await seedMaintenanceRecords(workshops, maintTypes);
  }

  console.log('');
  console.log('seed complete. Sign in with any of:');
  for (const u of users.perTenant) {
    console.log(`  ${u.email.padEnd(45)}  password=${SEED_PASSWORD}   company=${tenants.find(t => t.id === u.tenantId)?.slug ?? '?'}`);
  }
  if (users.super) {
    console.log(`  ${users.super.email.padEnd(45)}  password=${SEED_PASSWORD}   SUPER PlatformAdmin (any tenant)`);
  }
}

main()
  .catch((err) => { console.error(err); process.exit(1); })
  .finally(async () => { await prisma.$disconnect(); });
