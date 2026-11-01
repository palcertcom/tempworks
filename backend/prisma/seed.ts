import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';
import * as bcrypt from 'bcryptjs';
import * as dotenv from 'dotenv';
import { join } from 'path';
import { resolvePoolSsl } from './pg-ssl';

dotenv.config({ path: join(__dirname, '../.env') });

// Prisma 7's default "client" engine requires either a driver adapter or
// Accelerate — matching how src/prisma/prisma.service.ts initialises the
// runtime client.
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: resolvePoolSsl(process.env.DATABASE_URL),
});
const prisma = new PrismaClient({ adapter: new PrismaPg(pool as any) });

async function main() {
  console.log('Starting database seed...');

  // ── Permissions ──────────────────────────────────────────────────────────
  // Core CRUD modules. Every permission row is `<module>:<action>`.
  const modules = [
    'dashboard',
    'employees', 'applicants', 'applications', 'documents',
    'workflow', 'agencies', 'compliance', 'reports',
    'notifications', 'settings', 'users', 'roles', 'logs',
    // Modules added in later releases — enumerated so the Roles matrix
    // shows them and @Roles guards can be replaced over time.
    'vehicles', 'finance', 'attendance', 'job-ads', 'recycle-bin',
  ];
  const actions = ['read', 'create', 'update', 'delete'];

  const permissionData: { name: string; module: string; action: string }[] = [];
  for (const mod of modules) {
    for (const action of actions) {
      permissionData.push({ name: `${mod}:${action}`, module: mod, action });
    }
  }
  // Special (non-CRUD) permissions. Keep as a single authoritative list.
  const specialPermissions: { name: string; module: string; action: string }[] = [
    // Documents / compliance flows
    { name: 'documents:verify',    module: 'documents',    action: 'verify' },
    { name: 'compliance:resolve',  module: 'compliance',   action: 'resolve' },
    // Reports + module-level exports
    { name: 'reports:export',      module: 'reports',      action: 'export' },
    { name: 'applicants:export',   module: 'applicants',   action: 'export' },
    { name: 'employees:export',    module: 'employees',    action: 'export' },
    { name: 'vehicles:export',     module: 'vehicles',     action: 'export' },
    { name: 'finance:export',      module: 'finance',      action: 'export' },
    { name: 'attendance:export',   module: 'attendance',   action: 'export' },
    // Agency-submitted candidate approval gate
    { name: 'applicants:approve',     module: 'applicants', action: 'approve' },
    { name: 'applicants:convert',     module: 'applicants', action: 'convert' },
    { name: 'applicants:bulk-action', module: 'applicants', action: 'bulk-action' },
    // Agency user lifecycle + per-user manager-override grants
    { name: 'users:approve',  module: 'users', action: 'approve' },
    { name: 'users:override', module: 'users', action: 'override' },
    // Agency tenancy admin controls
    { name: 'agencies:manage-permissions', module: 'agencies', action: 'manage-permissions' },
    { name: 'employees:manage-agency-access', module: 'employees', action: 'manage-agency-access' },
    // Finance state transition (PENDING → DEDUCTED)
    { name: 'finance:status',   module: 'finance',   action: 'status' },
    // Recycle bin restore
    { name: 'recycle-bin:restore', module: 'recycle-bin', action: 'restore' },
    // Job ads publish
    { name: 'job-ads:publish', module: 'job-ads', action: 'publish' },
  ];
  permissionData.push(...specialPermissions);

  for (const p of permissionData) {
    await prisma.permission.upsert({
      where: { name: p.name },
      update: { module: p.module, action: p.action },
      create: p,
    });
  }
  console.log(`Upserted ${permissionData.length} permissions`);

  const allPermissions = await prisma.permission.findMany();
  const pMap = new Map(allPermissions.map(p => [p.name, p.id]));

  const getPerms = (...names: string[]) =>
    names.filter(n => pMap.has(n)).map(n => ({ permissionId: pMap.get(n)! }));

  // ── Roles ─────────────────────────────────────────────────────────────────
  const rolesData = [
    {
      name: 'System Admin',
      description: 'Full system access',
      isSystem: true,
      perms: allPermissions.map(p => p.name),
    },
    {
      name: 'HR Manager',
      description: 'Manages HR processes and employees',
      isSystem: true,
      perms: [
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
    },
    {
      name: 'Compliance Officer',
      description: 'Manages compliance and document verification',
      isSystem: true,
      perms: [
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
    },
    {
      name: 'Recruiter',
      description: 'Handles recruitment and applications',
      isSystem: true,
      perms: [
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
    },
    // Agency-side roles are scoped to their own agency only — tenancy
    // filters in each service enforce the "own agency only" rule.
    // Permissions cover: candidates, agency profile, and agency user
    // management (Manager only). Tempworks internals (workflow,
    // reports, documents, employees, compliance, finance, logs,
    // notifications, roles, settings, recycle-bin, etc.) are
    // intentionally absent.
    {
      name: 'Agency Manager',
      description: 'Manages own agency: candidates, profile, agency users, and attendance (Tempworks approval for new candidates)',
      isSystem: true,
      perms: [
        'applicants:read','applicants:create','applicants:update',
        'applicants:export','applicants:bulk-action',
        'employees:read','employees:update',
        'agencies:read','agencies:update',
        'users:read','users:create','users:update','users:delete',
        // Phase 2B (#36) — Agency Managers may manage attendance for
        // employees in their own tenant + agency. Backend re-enforces
        // tenant/agency match, period-unlock, and the permission.
        'attendance:read','attendance:create','attendance:update','attendance:delete','attendance:export',
      ],
    },
    {
      name: 'Agency User',
      description: 'Submits and edits own-agency candidates; views own agency profile',
      isSystem: true,
      perms: [
        'applicants:read','applicants:create','applicants:update',
        'employees:read','employees:update',
        'agencies:read',
      ],
    },
    {
      name: 'Finance',
      description: 'Financial reporting and read access',
      isSystem: true,
      perms: [
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
    },
    {
      name: 'Read Only',
      description: 'Read-only access across the system',
      isSystem: true,
      perms: modules.map(m => `${m}:read`),
    },
  ];

  const roleMap = new Map<string, string>();
  for (const r of rolesData) {
    const role = await prisma.role.upsert({
      where: { name: r.name },
      update: { description: r.description },
      create: { name: r.name, description: r.description, isSystem: r.isSystem },
    });
    roleMap.set(r.name, role.id);

    // set permissions
    await prisma.rolePermission.deleteMany({ where: { roleId: role.id } });
    const rolePerms = getPerms(...r.perms);
    if (rolePerms.length > 0) {
      await prisma.rolePermission.createMany({
        data: rolePerms.map(rp => ({ roleId: role.id, permissionId: rp.permissionId })),
        skipDuplicates: true,
      });
    }
  }
  console.log(`Upserted ${rolesData.length} roles with permissions`);

  // ── TempWorks Owner Agency (must exist before creating admin user) ─────────
  let ownerAgency = await prisma.agency.findFirst({ where: { email: 'admin@tempworks.sk' } });
  if (!ownerAgency) {
    ownerAgency = await prisma.agency.create({
      data: {
        name: 'TempWorks',
        country: 'Slovakia',
        contactPerson: 'System Owner',
        email: 'admin@tempworks.sk',
        phone: '+421 2 0000 0000',
        status: 'ACTIVE',
        notes: 'System owner agency — headquartered in Slovakia',
      },
    });
  }
  // Phase 3.9 dropped Agency.isSystem — platform authority now comes from a
  // PlatformAdmin row (granted to the admin user below). See
  // SAAS_PHASE3_DROP_AGENCY_IS_SYSTEM.md.
  const ownerAgencyId = ownerAgency.id;

  // Owner tenant. The UI signs in through the tenant-aware /auth/login-v2,
  // which requires a tenant slug ("Company" field). Follow the Phase 1
  // convention (Tenant.id = owner Agency.id) so a FRESH install's admin can
  // log in with company "tempworks" — previously only backfilled databases had
  // an owner tenant.
  await (prisma as any).tenant.upsert({
    where: { id: ownerAgencyId },
    update: {},
    create: { id: ownerAgencyId, slug: process.env.SEED_OWNER_TENANT_SLUG || 'tempworks', name: 'TempWorks' },
  });
  await prisma.agency.update({ where: { id: ownerAgencyId }, data: { tenantId: ownerAgencyId } as any });
  console.log(`Owner agency: TempWorks (Slovakia) — ${ownerAgencyId}`);

  // ── Admin User ────────────────────────────────────────────────────────────
  const adminEmail = process.env.SEED_ADMIN_EMAIL || 'admin@tempworks.com';
  const adminPassword = process.env.SEED_ADMIN_PASSWORD || 'Admin@123456';
  const adminRoleId = roleMap.get('System Admin')!;
  const passwordHash = await bcrypt.hash(adminPassword, 12);

  const seededAdmin = await prisma.user.upsert({
    where: { email: adminEmail },
    update: { agencyId: ownerAgencyId },
    create: {
      email: adminEmail,
      passwordHash,
      firstName: 'System',
      lastName: 'Admin',
      phone: '+421 2 0000 0001',
      roleId: adminRoleId,
      agencyId: ownerAgencyId,
      status: 'ACTIVE',
    },
  });
  // Platform authority (replaces the dropped Agency.isSystem flag).
  await prisma.platformAdmin.upsert({
    where: { userId: seededAdmin.id },
    update: { level: 'SUPER' },
    create: { userId: seededAdmin.id, level: 'SUPER', grantedBy: 'seed' },
  });
  console.log(`Admin user: ${adminEmail} → TempWorks (Slovakia), platform level SUPER`);

  // ── Agencies ──────────────────────────────────────────────────────────────
  const agenciesData = [
    {
      name: 'TempWorks UK Ltd',
      country: 'United Kingdom',
      contactPerson: 'John Smith',
      email: 'contact@tempworks.co.uk',
      phone: '+44 20 1234 5678',
      status: 'ACTIVE' as const,
    },
    {
      name: 'EuroDrivers GmbH',
      country: 'Germany',
      contactPerson: 'Hans Mueller',
      email: 'info@eurodrivers.de',
      phone: '+49 30 9876 5432',
      status: 'ACTIVE' as const,
    },
    {
      name: 'Nordic Logistics AS',
      country: 'Norway',
      contactPerson: 'Ingrid Hansen',
      email: 'recruiter@nordiclogistics.no',
      phone: '+47 22 333 444',
      status: 'ACTIVE' as const,
    },
  ];

  const agencyMap = new Map<string, string>();
  agencyMap.set('TempWorks', ownerAgencyId); // owner agency already created

  for (const a of agenciesData) {
    const found = await prisma.agency.findFirst({ where: { email: a.email } });
    if (found) {
      agencyMap.set(a.name, found.id);
    } else {
      const agency = await prisma.agency.create({ data: a });
      agencyMap.set(a.name, agency.id);
    }
  }
  console.log(`Upserted ${agenciesData.length + 1} agencies (including TempWorks Slovakia)`);

  // Workflow stages are now created per-tenant via the UI (each Workflow
  // owns its own stages). No global seed data.

  // ── Document Types ────────────────────────────────────────────────────────
  const documentTypes = [
    { name: 'Passport', description: 'Valid national passport', category: 'Identity', required: true, trackExpiry: true, renewalPeriodDays: 90 },
    { name: 'National ID Card', description: 'National identity card', category: 'Identity', required: false, trackExpiry: true, renewalPeriodDays: 90 },
    { name: 'Driving License', description: 'Valid driving license', category: 'Qualification', required: true, trackExpiry: true, renewalPeriodDays: 90 },
    { name: 'Work Permit', description: 'Authorisation to work in the country', category: 'Legal', required: true, trackExpiry: true, renewalPeriodDays: 60 },
    { name: 'Visa', description: 'Entry and residence visa', category: 'Legal', required: false, trackExpiry: true, renewalPeriodDays: 60 },
    { name: 'Medical Certificate', description: 'Fitness to work medical certificate', category: 'Medical', required: true, trackExpiry: true, renewalPeriodDays: 30 },
    { name: 'CPC Certificate', description: 'Certificate of Professional Competence', category: 'Qualification', required: true, trackExpiry: true, renewalPeriodDays: 60 },
    { name: 'Tachograph Card', description: 'Digital tachograph driver card', category: 'Qualification', required: true, trackExpiry: true, renewalPeriodDays: 30 },
    { name: 'DBS Check', description: 'Disclosure and Barring Service check', category: 'Background', required: true, trackExpiry: true, renewalPeriodDays: 30 },
    { name: 'Proof of Address', description: 'Recent utility bill or bank statement', category: 'Identity', required: true, trackExpiry: false },
    { name: 'National Insurance Letter', description: 'National Insurance number confirmation', category: 'Legal', required: false, trackExpiry: false },
    { name: 'Employment Contract', description: 'Signed employment contract', category: 'Administrative', required: true, trackExpiry: false },
    { name: 'Reference Letter', description: 'Professional reference from previous employer', category: 'Background', required: false, trackExpiry: false },
    { name: 'Training Certificate', description: 'Evidence of completed training', category: 'Training', required: false, trackExpiry: true, renewalPeriodDays: 365 },
    { name: 'DVLA Check', description: 'DVLA licence check result', category: 'Qualification', required: true, trackExpiry: true, renewalPeriodDays: 365 },
  ];

  for (const dt of documentTypes) {
    await prisma.documentType.upsert({
      where: { name: dt.name },
      update: {},
      create: { ...dt, isActive: true },
    });
  }
  console.log(`Upserted ${documentTypes.length} document types`);

  // ── Job Types ─────────────────────────────────────────────────────────────
  const jobTypes = [
    { name: 'HGV Driver Class 1', description: 'Heavy Goods Vehicle driver with Class 1 (CE) licence' },
    { name: 'HGV Driver Class 2', description: 'Heavy Goods Vehicle driver with Class 2 (C) licence' },
    { name: 'LGV Driver', description: 'Light Goods Vehicle driver' },
    { name: 'Van Driver', description: 'Van delivery driver' },
    { name: 'Multi-Drop Driver', description: 'Multi-drop parcel and goods delivery' },
    { name: 'Tanker Driver', description: 'Tanker vehicle driver' },
    { name: 'Flatbed Driver', description: 'Flatbed truck driver' },
    { name: 'Warehouse Operative', description: 'Warehouse pick, pack, and dispatch' },
    { name: 'Forklift Operator', description: 'Certified forklift operator' },
    { name: 'Transport Manager', description: 'Fleet and transport management' },
  ];

  for (const jt of jobTypes) {
    await prisma.jobType.upsert({
      where: { name: jt.name },
      update: {},
      create: { ...jt, isActive: true },
    });
  }
  console.log(`Upserted ${jobTypes.length} job types`);

  // ── System Settings ───────────────────────────────────────────────────────
  const adminUser = await prisma.user.findUnique({ where: { email: adminEmail } });
  const settings = [
    { key: 'app.name', value: 'TempWorks Compliance', description: 'Application display name', category: 'general', isPublic: true },
    { key: 'app.timezone', value: 'Europe/London', description: 'Default timezone', category: 'general', isPublic: true },
    { key: 'app.dateFormat', value: 'DD/MM/YYYY', description: 'Default date format', category: 'general', isPublic: true },
    { key: 'compliance.expiryWarningDays', value: '30', description: 'Days before expiry to trigger warning', category: 'compliance', isPublic: false },
    { key: 'compliance.criticalExpiryDays', value: '7', description: 'Days before expiry for critical alert', category: 'compliance', isPublic: false },
    { key: 'email.enabled', value: 'false', description: 'Enable email notifications', category: 'notifications', isPublic: false },
    { key: 'upload.maxSizeMb', value: '10', description: 'Maximum upload file size in MB', category: 'files', isPublic: false },
    { key: 'upload.allowedTypes', value: 'pdf,jpg,jpeg,png,doc,docx', description: 'Allowed file MIME types', category: 'files', isPublic: false },
    { key: 'auth.sessionTimeoutMin', value: '15', description: 'Access token expiry in minutes', category: 'security', isPublic: false },
    { key: 'auth.maxLoginAttempts', value: '5', description: 'Maximum failed login attempts', category: 'security', isPublic: false },
    { key: 'agency.maxUsersPerAgency', value: '5', description: 'Maximum number of users an Agency Manager can add to their agency', category: 'agency', isPublic: false },
  ];

  for (const s of settings) {
    await prisma.systemSetting.upsert({
      where: { key: s.key },
      update: {},
      create: { ...s, updatedById: adminUser?.id },
    });
  }
  console.log(`Upserted ${settings.length} system settings`);

  // ── Notification Rules ────────────────────────────────────────────────────
  const notificationRules = [
    {
      name: 'Passport Expiry Warning',
      trigger: 'DOCUMENT_EXPIRY',
      entityType: 'EMPLOYEE',
      daysBeforeExpiry: 30,
      channels: ['IN_APP', 'EMAIL'],
      recipientRoles: ['Compliance Officer', 'HR Manager'],
      isActive: true,
    },
    {
      name: 'Work Permit Expiry Critical',
      trigger: 'DOCUMENT_EXPIRY',
      entityType: 'EMPLOYEE',
      daysBeforeExpiry: 7,
      channels: ['IN_APP', 'EMAIL'],
      recipientRoles: ['Compliance Officer', 'HR Manager', 'System Admin'],
      isActive: true,
    },
    {
      name: 'Driving License Expiry',
      trigger: 'DOCUMENT_EXPIRY',
      entityType: 'EMPLOYEE',
      daysBeforeExpiry: 30,
      channels: ['IN_APP'],
      recipientRoles: ['Compliance Officer'],
      isActive: true,
    },
    {
      name: 'New Application Received',
      trigger: 'APPLICATION_SUBMITTED',
      entityType: 'APPLICATION',
      channels: ['IN_APP'],
      recipientRoles: ['Recruiter', 'HR Manager'],
      isActive: true,
    },
  ];

  for (const nr of notificationRules) {
    await prisma.notificationRule.upsert({
      where: { id: nr.name } as any,
      update: {},
      create: nr,
    }).catch(() =>
      prisma.notificationRule.create({ data: nr })
    );
  }
  console.log(`Created notification rules`);

  // ── Sample Employees ──────────────────────────────────────────────────────
  const firstAgencyId = agencyMap.get('TempWorks UK Ltd');
  const secondAgencyId = agencyMap.get('EuroDrivers GmbH');

  const sampleEmployees = [
    {
      firstName: 'James',
      lastName: 'Wilson',
      email: 'james.wilson@example.com',
      phone: '+44 7700 900001',
      nationality: 'British',
      status: 'ACTIVE' as const,
      dateOfBirth: new Date('1985-03-15'),
      licenseNumber: 'WILSO853156JA9GV',
      licenseCategory: 'CE',
      yearsExperience: 12,
      agencyId: firstAgencyId!,
      addressLine1: '12 Oak Street',
      city: 'Manchester',
      country: 'United Kingdom',
      postalCode: 'M1 1AA',
    },
    {
      firstName: 'Maria',
      lastName: 'Kowalski',
      email: 'maria.kowalski@example.com',
      phone: '+44 7700 900002',
      nationality: 'Polish',
      status: 'ONBOARDING' as const,
      dateOfBirth: new Date('1990-07-22'),
      licenseNumber: 'KOWAL907229MA9GV',
      licenseCategory: 'C',
      yearsExperience: 5,
      agencyId: firstAgencyId!,
      addressLine1: '45 Birch Avenue',
      city: 'Birmingham',
      country: 'United Kingdom',
      postalCode: 'B1 1BB',
    },
    {
      firstName: 'Stefan',
      lastName: 'Bauer',
      email: 'stefan.bauer@example.com',
      phone: '+49 1511 0000001',
      nationality: 'German',
      status: 'PENDING' as const,
      dateOfBirth: new Date('1988-11-08'),
      licenseNumber: 'BAU88110843CE',
      licenseCategory: 'CE',
      yearsExperience: 8,
      agencyId: secondAgencyId!,
      addressLine1: 'Hauptstraße 15',
      city: 'Berlin',
      country: 'Germany',
      postalCode: '10115',
    },
  ];

  for (const emp of sampleEmployees) {
    const existing = await prisma.employee.findUnique({ where: { email: emp.email } });
    if (!existing) {
      await prisma.employee.create({ data: emp });
    }
  }
  console.log(`Created ${sampleEmployees.length} sample employees`);

  // ── Sample Applicants ─────────────────────────────────────────────────────
  const jobTypeHGV = await prisma.jobType.findFirst({ where: { name: 'HGV Driver Class 1' } });
  const sampleApplicants = [
    {
      firstName: 'David',
      lastName: 'Chen',
      email: 'david.chen@example.com',
      phone: '+44 7700 900010',
      nationality: 'British Chinese',
      dateOfBirth: new Date('1992-04-18'),
      status: 'SCREENING' as const,
      jobTypeId: jobTypeHGV?.id,
      residencyStatus: 'UK Citizen',
      hasNationalInsurance: true,
      nationalInsuranceNumber: 'AB123456C',
      hasWorkAuthorization: true,
      workAuthorizationType: 'British Citizen',
      availability: 'Immediate',
      willingToRelocate: false,
    },
    {
      firstName: 'Amara',
      lastName: 'Okafor',
      email: 'amara.okafor@example.com',
      phone: '+44 7700 900011',
      nationality: 'Nigerian',
      dateOfBirth: new Date('1987-09-30'),
      status: 'NEW' as const,
      jobTypeId: jobTypeHGV?.id,
      residencyStatus: 'Settled Status',
      hasNationalInsurance: true,
      nationalInsuranceNumber: 'CD789012E',
      hasWorkAuthorization: true,
      workAuthorizationType: 'Settled Status',
      availability: '2 weeks notice',
      willingToRelocate: true,
      preferredLocations: 'London, Birmingham',
    },
  ];

  for (const app of sampleApplicants) {
    const existing = await prisma.applicant.findFirst({ where: { email: app.email } });
    if (!existing) {
      await prisma.applicant.create({ data: app });
    }
  }
  console.log(`Created ${sampleApplicants.length} sample applicants`);

  console.log('Seed completed successfully!');
}

main()
  .catch(e => {
    console.error('Seed failed:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
    await pool.end();
  });
