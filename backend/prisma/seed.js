'use strict';
// Plain JavaScript seed — no Prisma, no TypeScript, no WASM.
// Run with: node prisma/seed.js
// Requires: pg, bcrypt, dotenv  (all already in package.json)

require('dotenv').config();
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const { randomUUID } = require('crypto');
const { resolvePoolSsl } = require('./pg-ssl');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: resolvePoolSsl(process.env.DATABASE_URL),
});

async function q(sql, params = []) {
  const { rows } = await pool.query(sql, params);
  return rows;
}

// ── Upsert helpers ────────────────────────────────────────────────────────────
async function upsertPermission(name, module_, action) {
  const existing = await q('SELECT id FROM permissions WHERE name = $1', [name]);
  if (existing.length) return existing[0].id;
  const id = randomUUID();
  await q(
    'INSERT INTO permissions (id, name, module, action, "createdAt") VALUES ($1,$2,$3,$4,NOW())',
    [id, name, module_, action],
  );
  return id;
}

async function upsertRole(name, description, isSystem) {
  const existing = await q('SELECT id FROM roles WHERE name = $1', [name]);
  if (existing.length) {
    await q('UPDATE roles SET description=$1, "updatedAt"=NOW() WHERE id=$2', [description, existing[0].id]);
    return existing[0].id;
  }
  const id = randomUUID();
    await q(
    'INSERT INTO roles (id, name, description, "isSystem", "createdAt", "updatedAt") VALUES ($1,$2,$3,$4,NOW(),NOW())',
    [id, name, description, isSystem],
  );
  return id;
}

async function setRolePermissions(roleId, permIds) {
  await q('DELETE FROM role_permissions WHERE "roleId" = $1', [roleId]);
  for (const permId of permIds) {
    await q(
      'INSERT INTO role_permissions ("roleId", "permissionId") VALUES ($1,$2) ON CONFLICT DO NOTHING',
      [roleId, permId],
    );
  }
}

async function upsertAgency(email, data) {
  const existing = await q('SELECT id FROM agencies WHERE email = $1', [email]);
  if (existing.length) return existing[0].id;
  const id = randomUUID();
  await q(
    `INSERT INTO agencies (id, name, country, "contactPerson", email, phone, status, notes, "maxUsersPerAgency", "createdAt", "updatedAt")
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,10,NOW(),NOW())`,
    [id, data.name, data.country, data.contactPerson, email, data.phone, data.status, data.notes || null],
  );
  return id;
}

async function upsertUser(email, data) {
  const existing = await q('SELECT id FROM users WHERE email = $1', [email]);
  if (existing.length) {
    await q('UPDATE users SET "agencyId"=$1, "updatedAt"=NOW() WHERE id=$2', [data.agencyId, existing[0].id]);
    return existing[0].id;
  }
  const id = randomUUID();
  await q(
    `INSERT INTO users (id, email, "passwordHash", "firstName", "lastName", phone, "roleId", "agencyId", status, "createdAt", "updatedAt")
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,NOW(),NOW())`,
    [id, email, data.passwordHash, data.firstName, data.lastName, data.phone, data.roleId, data.agencyId, data.status],
  );
  return id;
}

async function upsertWorkflowStage(name, data) {
  const existing = await q('SELECT id FROM workflow_stages WHERE name = $1', [name]);
  if (existing.length) return existing[0].id;
  const id = randomUUID();
  await q(
    `INSERT INTO workflow_stages (id, name, "order", description, color, category, "isActive", "requirementsDocuments", "requirementsActions", "requirementsApprovals", "createdAt", "updatedAt")
     VALUES ($1,$2,$3,$4,'#2563EB',$5,true,'{}','{}','{}',NOW(),NOW())`,
    [id, name, data.order, data.description, data.category],
  );
  return id;
}

async function upsertDocumentType(name, data) {
  const existing = await q('SELECT id FROM document_types WHERE name = $1', [name]);
  if (existing.length) return existing[0].id;
  const id = randomUUID();
  await q(
    `INSERT INTO document_types (id, name, description, category, required, "trackExpiry", "renewalPeriodDays", "isActive", "createdAt", "updatedAt")
     VALUES ($1,$2,$3,$4,$5,$6,$7,true,NOW(),NOW())`,
    [id, name, data.description, data.category, data.required, data.trackExpiry, data.renewalPeriodDays || null],
  );
  return id;
}

async function upsertJobType(name, description) {
  const existing = await q('SELECT id FROM job_types WHERE name = $1', [name]);
  if (existing.length) return existing[0].id;
  const id = randomUUID();
  await q(
    `INSERT INTO job_types (id, name, description, "isActive", "requiredDocuments", "createdAt", "updatedAt")
     VALUES ($1,$2,$3,true,'{}',NOW(),NOW())`,
    [id, name, description],
  );
  return id;
}

async function upsertSetting(key, data, updatedById) {
  const existing = await q('SELECT id FROM system_settings WHERE key = $1', [key]);
  if (existing.length) return;
  const id = randomUUID();
  await q(
    `INSERT INTO system_settings (id, key, value, description, category, "isPublic", "updatedAt", "updatedById")
     VALUES ($1,$2,$3,$4,$5,$6,NOW(),$7)`,
    [id, key, data.value, data.description, data.category, data.isPublic, updatedById || null],
  );
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  console.log('Starting database seed (plain SQL)...');

  // ── Permissions ─────────────────────────────────────────────────────────────
  const modules = [
    'dashboard',
    'employees', 'applicants', 'applications', 'documents',
    'workflow', 'agencies', 'compliance', 'reports',
    'notifications', 'settings', 'users', 'roles', 'logs',
  ];
  const actions = ['read', 'create', 'update', 'delete'];

  const permMap = new Map(); // name → id
  for (const mod of modules) {
    for (const action of actions) {
      const name = `${mod}:${action}`;
      permMap.set(name, await upsertPermission(name, mod, action));
    }
  }
  for (const [name, mod, action] of [
    ['documents:verify',              'documents',   'verify'],
    ['compliance:resolve',            'compliance',  'resolve'],
    ['reports:export',                'reports',     'export'],
    ['applicants:convert_lead',       'applicants',  'convert_lead'],
    ['applicants:reassign_agency',    'applicants',  'reassign_agency'],
    ['applicants:view_financial',     'applicants',  'view_financial'],
    ['applicants:manage_financial',   'applicants',  'manage_financial'],
    ['applicants:export',             'applicants',  'export'],
    ['applicants:bulk_status',        'applicants',  'bulk_status'],
  ]) {
    permMap.set(name, await upsertPermission(name, mod, action));
  }
  console.log(`Upserted ${permMap.size} permissions`);

  const allPermNames = [...permMap.keys()];

  // ── Roles ────────────────────────────────────────────────────────────────────
  const rolesData = [
    { name: 'System Admin',       description: 'Full system access',                             isSystem: true,  perms: allPermNames },
    { name: 'HR Manager',         description: 'Manages HR processes and employees',              isSystem: true,  perms: ['dashboard:read','employees:read','employees:create','employees:update','applicants:read','applicants:create','applicants:update','applicants:convert_lead','applicants:reassign_agency','applicants:view_financial','applicants:manage_financial','applicants:export','applicants:bulk_status','applications:read','applications:create','applications:update','documents:read','documents:create','documents:update','documents:verify','workflow:read','workflow:update','compliance:read','compliance:resolve','reports:read','reports:export','notifications:read','notifications:create','users:read','logs:read'] },
    { name: 'Compliance Officer', description: 'Manages compliance and document verification',   isSystem: true,  perms: ['dashboard:read','employees:read','applicants:read','applicants:view_financial','applications:read','documents:read','documents:create','documents:update','documents:verify','workflow:read','workflow:update','compliance:read','compliance:resolve','reports:read','reports:export','notifications:read','notifications:create','logs:read'] },
    { name: 'Recruiter',          description: 'Handles recruitment and applications',            isSystem: true,  perms: ['dashboard:read','employees:read','applicants:read','applicants:create','applicants:update','applicants:convert_lead','applicants:reassign_agency','applicants:view_financial','applicants:export','applicants:bulk_status','applications:read','applications:create','applications:update','documents:read','documents:create','workflow:read','compliance:read','reports:read','notifications:read','logs:read'] },
    { name: 'Agency Manager',     description: 'Manages agency-specific employees and data',     isSystem: true,  perms: ['dashboard:read','employees:read','employees:create','employees:update','applicants:read','applicants:create','applicants:update','applications:read','documents:read','documents:create','workflow:read','compliance:read','reports:read','notifications:read','users:read','logs:read'] },
    { name: 'Agency User',        description: 'Basic agency-level read/create access',          isSystem: true,  perms: ['dashboard:read','employees:read','applicants:read','applications:read','documents:read','documents:create','workflow:read','notifications:read','logs:read'] },
    { name: 'Finance',            description: 'Financial reporting and read access',             isSystem: true,  perms: ['dashboard:read','employees:read','applicants:read','applicants:view_financial','applications:read','reports:read','reports:export','applicants:export','notifications:read','logs:read'] },
    { name: 'Read Only',          description: 'Read-only access across the system',             isSystem: true,  perms: modules.map(m => `${m}:read`) },
  ];

  const roleMap = new Map(); // name → id
  for (const r of rolesData) {
    const roleId = await upsertRole(r.name, r.description, r.isSystem);
    roleMap.set(r.name, roleId);
    const permIds = r.perms.filter(p => permMap.has(p)).map(p => permMap.get(p));
    await setRolePermissions(roleId, permIds);
  }
  console.log(`Upserted ${rolesData.length} roles with permissions`);

  // ── Owner Agency ─────────────────────────────────────────────────────────────
  const ownerAgencyId = await upsertAgency('admin@tempworks.sk', {
    name: 'TempWorks', country: 'Slovakia', contactPerson: 'System Owner',
    phone: '+421 2 0000 0000', status: 'ACTIVE',
    notes: 'System owner agency — headquartered in Slovakia',
  });
  console.log(`Owner agency: TempWorks (Slovakia) — ${ownerAgencyId}`);

  // ── Admin User ────────────────────────────────────────────────────────────────
  const adminEmail    = process.env.SEED_ADMIN_EMAIL    || 'admin@tempworks.com';
  const adminPassword = process.env.SEED_ADMIN_PASSWORD || 'Admin@123456';
  const passwordHash  = await bcrypt.hash(adminPassword, 12);
  const adminUserId   = await upsertUser(adminEmail, {
    passwordHash, firstName: 'System', lastName: 'Admin',
    phone: '+421 2 0000 0001', roleId: roleMap.get('System Admin'),
    agencyId: ownerAgencyId, status: 'ACTIVE',
  });
  console.log(`Admin user: ${adminEmail}`);

  // ── Sample Agencies ───────────────────────────────────────────────────────────
  const agencyMap = new Map();
  agencyMap.set('TempWorks', ownerAgencyId);
  const agenciesData = [
    { email: 'contact@tempworks.co.uk', name: 'TempWorks UK Ltd',    country: 'United Kingdom', contactPerson: 'John Smith',    phone: '+44 20 1234 5678', status: 'ACTIVE' },
    { email: 'info@eurodrivers.de',     name: 'EuroDrivers GmbH',    country: 'Germany',        contactPerson: 'Hans Mueller',  phone: '+49 30 9876 5432', status: 'ACTIVE' },
    { email: 'recruiter@nordiclogistics.no', name: 'Nordic Logistics AS', country: 'Norway', contactPerson: 'Ingrid Hansen', phone: '+47 22 333 444', status: 'ACTIVE' },
  ];
  for (const a of agenciesData) {
    agencyMap.set(a.name, await upsertAgency(a.email, a));
  }
  console.log(`Upserted ${agenciesData.length + 1} agencies`);

  // ── Workflow Stages ───────────────────────────────────────────────────────────
  const workflowStagesData = [
    { name: 'Application Received',    order: 1,  category: 'INITIAL',        description: 'Initial application submitted and received' },
    { name: 'Document Collection',     order: 2,  category: 'DOCUMENTATION',  description: 'Collecting required identity and qualification documents' },
    { name: 'Document Verification',   order: 3,  category: 'DOCUMENTATION',  description: 'Verifying authenticity of submitted documents' },
    { name: 'Background Check',        order: 4,  category: 'COMPLIANCE',     description: 'Criminal record and employment history background check' },
    { name: 'Medical Assessment',      order: 5,  category: 'COMPLIANCE',     description: 'Medical fitness assessment for driving duties' },
    { name: 'License Verification',    order: 6,  category: 'COMPLIANCE',     description: 'Driving license verification and category validation' },
    { name: 'Work Permit Application', order: 7,  category: 'COMPLIANCE',     description: 'Applying for work permit if required' },
    { name: 'Visa Processing',         order: 8,  category: 'COMPLIANCE',     description: 'Visa application and processing' },
    { name: 'Induction Training',      order: 9,  category: 'TRAINING',       description: 'Company induction and onboarding training' },
    { name: 'Safety Training',         order: 10, category: 'TRAINING',       description: 'Health & safety and compliance training' },
    { name: 'Vehicle Familiarization', order: 11, category: 'TRAINING',       description: 'Training on specific vehicle types' },
    { name: 'Contract Signing',        order: 12, category: 'ADMINISTRATIVE', description: 'Employment contract signing and HR paperwork' },
    { name: 'Payroll Setup',           order: 13, category: 'ADMINISTRATIVE', description: 'Payroll and banking details setup' },
    { name: 'Deployment Ready',        order: 14, category: 'DEPLOYMENT',     description: 'Employee cleared and ready for deployment' },
  ];
  const stageIdsByOrder = [];
  for (const s of workflowStagesData) {
    stageIdsByOrder.push(await upsertWorkflowStage(s.name, s));
  }
  console.log(`Upserted ${workflowStagesData.length} workflow stages`);

  // ── Document Types ────────────────────────────────────────────────────────────
  const documentTypesData = [
    { name: 'Passport',                   description: 'Valid national passport',                           category: 'Identity',       required: true,  trackExpiry: true,  renewalPeriodDays: 90 },
    { name: 'National ID Card',           description: 'National identity card',                            category: 'Identity',       required: false, trackExpiry: true,  renewalPeriodDays: 90 },
    { name: 'Driving License',            description: 'Valid driving license',                             category: 'Qualification',  required: true,  trackExpiry: true,  renewalPeriodDays: 90 },
    { name: 'Work Permit',                description: 'Authorisation to work in the country',              category: 'Legal',          required: true,  trackExpiry: true,  renewalPeriodDays: 60 },
    { name: 'Visa',                       description: 'Entry and residence visa',                          category: 'Legal',          required: false, trackExpiry: true,  renewalPeriodDays: 60 },
    { name: 'Medical Certificate',        description: 'Fitness to work medical certificate',               category: 'Medical',        required: true,  trackExpiry: true,  renewalPeriodDays: 30 },
    { name: 'CPC Certificate',            description: 'Certificate of Professional Competence',            category: 'Qualification',  required: true,  trackExpiry: true,  renewalPeriodDays: 60 },
    { name: 'Tachograph Card',            description: 'Digital tachograph driver card',                    category: 'Qualification',  required: true,  trackExpiry: true,  renewalPeriodDays: 30 },
    { name: 'DBS Check',                  description: 'Disclosure and Barring Service check',              category: 'Background',     required: true,  trackExpiry: true,  renewalPeriodDays: 30 },
    { name: 'Proof of Address',           description: 'Recent utility bill or bank statement',             category: 'Identity',       required: true,  trackExpiry: false },
    { name: 'National Insurance Letter',  description: 'National Insurance number confirmation',            category: 'Legal',          required: false, trackExpiry: false },
    { name: 'Employment Contract',        description: 'Signed employment contract',                        category: 'Administrative', required: true,  trackExpiry: false },
    { name: 'Reference Letter',           description: 'Professional reference from previous employer',     category: 'Background',     required: false, trackExpiry: false },
    { name: 'Training Certificate',       description: 'Evidence of completed training',                   category: 'Training',       required: false, trackExpiry: true,  renewalPeriodDays: 365 },
    { name: 'DVLA Check',                 description: 'DVLA licence check result',                        category: 'Qualification',  required: true,  trackExpiry: true,  renewalPeriodDays: 365 },
  ];
  for (const dt of documentTypesData) await upsertDocumentType(dt.name, dt);
  console.log(`Upserted ${documentTypesData.length} document types`);

  // ── Job Types ─────────────────────────────────────────────────────────────────
  const jobTypesData = [
    { name: 'HGV Driver Class 1',   description: 'Heavy Goods Vehicle driver with Class 1 (CE) licence' },
    { name: 'HGV Driver Class 2',   description: 'Heavy Goods Vehicle driver with Class 2 (C) licence' },
    { name: 'LGV Driver',           description: 'Light Goods Vehicle driver' },
    { name: 'Van Driver',           description: 'Van delivery driver' },
    { name: 'Multi-Drop Driver',    description: 'Multi-drop parcel and goods delivery' },
    { name: 'Tanker Driver',        description: 'Tanker vehicle driver' },
    { name: 'Flatbed Driver',       description: 'Flatbed truck driver' },
    { name: 'Warehouse Operative',  description: 'Warehouse pick, pack, and dispatch' },
    { name: 'Forklift Operator',    description: 'Certified forklift operator' },
    { name: 'Transport Manager',    description: 'Fleet and transport management' },
  ];
  const jobTypeIds = {};
  for (const jt of jobTypesData) jobTypeIds[jt.name] = await upsertJobType(jt.name, jt.description);
  console.log(`Upserted ${jobTypesData.length} job types`);

  // ── System Settings ───────────────────────────────────────────────────────────
  const settingsData = [
    { key: 'app.name',                       value: 'TempWorks Compliance',           description: 'Application display name',                                   category: 'general',       isPublic: true  },
    { key: 'app.timezone',                   value: 'Europe/London',                  description: 'Default timezone',                                            category: 'general',       isPublic: true  },
    { key: 'app.dateFormat',                 value: 'DD/MM/YYYY',                     description: 'Default date format',                                         category: 'general',       isPublic: true  },
    { key: 'compliance.expiryWarningDays',   value: '30',                             description: 'Days before expiry to trigger warning',                       category: 'compliance',    isPublic: false },
    { key: 'compliance.criticalExpiryDays',  value: '7',                              description: 'Days before expiry for critical alert',                       category: 'compliance',    isPublic: false },
    { key: 'email.enabled',                  value: 'false',                          description: 'Enable email notifications',                                   category: 'notifications', isPublic: false },
    { key: 'upload.maxSizeMb',               value: '10',                             description: 'Maximum upload file size in MB',                              category: 'files',         isPublic: false },
    { key: 'upload.allowedTypes',            value: 'pdf,jpg,jpeg,png,doc,docx',      description: 'Allowed file MIME types',                                     category: 'files',         isPublic: false },
    { key: 'auth.sessionTimeoutMin',         value: '15',                             description: 'Access token expiry in minutes',                              category: 'security',      isPublic: false },
    { key: 'auth.maxLoginAttempts',          value: '5',                              description: 'Maximum failed login attempts',                                category: 'security',      isPublic: false },
    { key: 'agency.maxUsersPerAgency',               value: '5',            description: 'Maximum users an Agency Manager can add',                             category: 'agency',        isPublic: false },
    { key: 'applicants.defaultHoldingAgencyId',       value: '',             description: 'Agency ID that receives Leads when converted to Candidates (leave empty to keep existing agency)', category: 'applicants', isPublic: false },
    { key: 'applicants.leadVisibleToAgencyUsers',     value: 'false',        description: 'If true, Agency Users can see Leads (not recommended)',                 category: 'applicants',    isPublic: false },
    // Form v2 configurable lists
    { key: 'form.visaTypes',           value: JSON.stringify(['Tourist','Business','Work','Student','Transit','Family Reunification','Schengen','Long-stay','Other']),                                               description: 'Visa type options in the application form',                 category: 'form', isPublic: true  },
    { key: 'form.familyRelations',     value: JSON.stringify(['Spouse','Partner','Parent','Child','Sibling','Friend','Colleague','Other']),                                                                         description: 'Emergency contact relation options',                        category: 'form', isPublic: true  },
    { key: 'form.drivingQualifications', value: JSON.stringify(['Tachograph Card','C95 / CPC Card','ADR Certificate','Medical Certificate','DVLA Check','Transport Manager CPC']),                                  description: 'Driving qualification types in application form',            category: 'form', isPublic: true  },
    { key: 'form.gpsSystemTypes',      value: JSON.stringify(['TomTom','Garmin','Webfleet','Sygic','HERE','Google Maps','Other']),                                                                                   description: 'GPS/Navigation system options',                              category: 'form', isPublic: true  },
    { key: 'form.howDidYouHear',       value: JSON.stringify(['Facebook','LinkedIn','Job Portal','Friend / Referral','Recruitment Agency','Google Search','Company Website','Other']),                              description: '"How did you hear about us" options',                        category: 'form', isPublic: true  },
    { key: 'form.educationLevels',     value: JSON.stringify(['Primary School','Secondary School','High School / A-Levels','Vocational Training','Associate Degree',"Bachelor's Degree","Master's Degree","Doctoral Degree","Professional Certification","Other"]), description: 'Education level options', category: 'form', isPublic: true  },
    { key: 'form.declarationText',     value: 'I declare that the information provided in this application is true, complete and accurate to the best of my knowledge. I understand that providing false or misleading information may result in my application being rejected or employment being terminated.',
                                                               description: 'Applicant declaration on the Review step',                       category: 'form', isPublic: true  },
  ];
  for (const s of settingsData) await upsertSetting(s.key, s, adminUserId);
  console.log(`Upserted ${settingsData.length} system settings`);

  // ── Sample Employees ──────────────────────────────────────────────────────────
  const firstAgencyId  = agencyMap.get('TempWorks UK Ltd');
  const secondAgencyId = agencyMap.get('EuroDrivers GmbH');
  const sampleEmployees = [
    { firstName: 'James',  lastName: 'Wilson',   email: 'james.wilson@example.com',   phone: '+44 7700 900001', nationality: 'British', status: 'ACTIVE',     dateOfBirth: '1985-03-15', licenseNumber: 'WILSO853156JA9GV', licenseCategory: 'CE', yearsExperience: 12, agencyId: firstAgencyId,  addressLine1: '12 Oak Street',    city: 'Manchester',  country: 'United Kingdom', postalCode: 'M1 1AA' },
    { firstName: 'Maria',  lastName: 'Kowalski', email: 'maria.kowalski@example.com',  phone: '+44 7700 900002', nationality: 'Polish',  status: 'ONBOARDING', dateOfBirth: '1990-07-22', licenseNumber: 'KOWAL907229MA9GV', licenseCategory: 'C',  yearsExperience:  5, agencyId: firstAgencyId,  addressLine1: '45 Birch Avenue',  city: 'Birmingham',  country: 'United Kingdom', postalCode: 'B1 1BB' },
    { firstName: 'Stefan', lastName: 'Bauer',    email: 'stefan.bauer@example.com',   phone: '+49 1511 0000001', nationality: 'German',  status: 'PENDING',    dateOfBirth: '1988-11-08', licenseNumber: 'BAU88110843CE',    licenseCategory: 'CE', yearsExperience:  8, agencyId: secondAgencyId, addressLine1: 'Hauptstraße 15',   city: 'Berlin',      country: 'Germany',        postalCode: '10115' },
  ];
  for (const emp of sampleEmployees) {
    const existing = await q('SELECT id FROM employees WHERE email = $1', [emp.email]);
    if (existing.length) continue;
    const id = randomUUID();
    await q(
      `INSERT INTO employees (id, "firstName", "lastName", email, phone, nationality, status, "dateOfBirth", "licenseNumber", "licenseCategory", "yearsExperience", "agencyId", "addressLine1", city, country, "postalCode", "createdAt", "updatedAt")
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,NOW(),NOW())`,
      [id, emp.firstName, emp.lastName, emp.email, emp.phone, emp.nationality, emp.status, emp.dateOfBirth, emp.licenseNumber || null, emp.licenseCategory || null, emp.yearsExperience, emp.agencyId, emp.addressLine1, emp.city, emp.country, emp.postalCode],
    );
    if (emp.status !== 'PENDING') {
      for (let i = 0; i < Math.min(5, stageIdsByOrder.length); i++) {
        const stageId = stageIdsByOrder[i];
        const order = i + 1;
        const stageStatus = order <= 3 ? 'COMPLETED' : 'IN_PROGRESS';
        await q(
          `INSERT INTO employee_workflow_stages (id, "employeeId", "stageId", status, "startedAt", "completedAt", "createdAt", "updatedAt")
           VALUES ($1,$2,$3,$4,NOW(),$5,NOW(),NOW())`,
          [randomUUID(), id, stageId, stageStatus, order <= 3 ? new Date() : null],
        );
      }
    }
  }
  console.log(`Created ${sampleEmployees.length} sample employees`);

  // ── Sample Applicants ─────────────────────────────────────────────────────────
  const hgvJobTypeId = jobTypeIds['HGV Driver Class 1'];
  const sampleApplicants = [
    { firstName: 'David', lastName: 'Chen',   email: 'david.chen@example.com',  phone: '+44 7700 900010', nationality: 'British Chinese', dateOfBirth: '1992-04-18', status: 'SCREENING', jobTypeId: hgvJobTypeId, residencyStatus: 'UK Citizen',     hasNationalInsurance: true,  nationalInsuranceNumber: 'AB123456C', hasWorkAuthorization: true,  workAuthorizationType: 'British Citizen', availability: 'Immediate',        willingToRelocate: false },
    { firstName: 'Amara', lastName: 'Okafor', email: 'amara.okafor@example.com', phone: '+44 7700 900011', nationality: 'Nigerian',        dateOfBirth: '1987-09-30', status: 'NEW',       jobTypeId: hgvJobTypeId, residencyStatus: 'Settled Status', hasNationalInsurance: true,  nationalInsuranceNumber: 'CD789012E', hasWorkAuthorization: true,  workAuthorizationType: 'Settled Status',  availability: '2 weeks notice',   willingToRelocate: true,  preferredLocations: 'London, Birmingham' },
  ];
  for (const app of sampleApplicants) {
    const existing = await q('SELECT id FROM applicants WHERE email = $1', [app.email]);
    if (existing.length) continue;
    const id = randomUUID();
    await q(
      `INSERT INTO applicants (id, "firstName", "lastName", email, phone, nationality, "dateOfBirth", status, "jobTypeId", "residencyStatus", "hasNationalInsurance", "nationalInsuranceNumber", "hasWorkAuthorization", "workAuthorizationType", availability, "willingToRelocate", "preferredLocations", "createdAt", "updatedAt")
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,NOW(),NOW())`,
      [id, app.firstName, app.lastName, app.email, app.phone, app.nationality, app.dateOfBirth, app.status, app.jobTypeId || null, app.residencyStatus, app.hasNationalInsurance, app.nationalInsuranceNumber || null, app.hasWorkAuthorization, app.workAuthorizationType || null, app.availability, app.willingToRelocate, app.preferredLocations || null],
    );
  }
  console.log(`Created ${sampleApplicants.length} sample applicants`);

  console.log('\nSeed completed successfully!');
  console.log(`\nAdmin login:\n  Email:    ${adminEmail}\n  Password: ${process.env.SEED_ADMIN_PASSWORD || 'Admin@123456'}`);
}

main()
  .catch(e => { console.error('Seed failed:', e.message || e); process.exit(1); })
  .finally(() => pool.end());
