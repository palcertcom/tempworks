-- Fixture mirroring the REAL Tempworks pre-migration schema, so the
-- Phase 1 preflight scripts can be exercised against something realistic.
-- Tables follow the @@map names in schema.prisma.
--
-- This fixture is for the audit-scripts' demo run. It is NOT applied to
-- production; production runs the scripts against an actual prod replica.

SET client_min_messages = WARNING;

-- ---- Roles & Permissions (global today) ----
CREATE TABLE "Role" (
  id   UUID PRIMARY KEY,
  name TEXT UNIQUE NOT NULL,
  "isSystem" BOOLEAN NOT NULL DEFAULT false
);
CREATE TABLE "Permission" (
  id      UUID PRIMARY KEY,
  name    TEXT UNIQUE NOT NULL,
  module  TEXT NOT NULL,
  action  TEXT NOT NULL
);
CREATE TABLE "RolePermission" (
  "roleId"       UUID REFERENCES "Role"(id),
  "permissionId" UUID REFERENCES "Permission"(id),
  PRIMARY KEY ("roleId","permissionId")
);

-- ---- Agencies (today: implicit tenant + sub-org) ----
CREATE TABLE agencies (
  id            UUID PRIMARY KEY,
  name          TEXT NOT NULL,
  country       TEXT,
  email         TEXT,
  phone         TEXT,
  status        TEXT NOT NULL DEFAULT 'ACTIVE',
  "isSystem"    BOOLEAN NOT NULL DEFAULT false,
  "managerId"   UUID,
  "createdAt"   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---- Users (User.email global UNIQUE today) ----
CREATE TABLE users (
  id           UUID PRIMARY KEY,
  email        TEXT UNIQUE NOT NULL,
  "firstName"  TEXT,
  "lastName"   TEXT,
  status       TEXT NOT NULL DEFAULT 'ACTIVE',
  "approvalStatus" TEXT NOT NULL DEFAULT 'APPROVED',
  "agencyId"   UUID REFERENCES agencies(id),
  "roleId"     UUID REFERENCES "Role"(id),
  "deletedAt"  TIMESTAMPTZ,
  "createdAt"  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---- Domain models (sample subset) ----
CREATE TABLE applicants (
  id           UUID PRIMARY KEY,
  "agencyId"   UUID REFERENCES agencies(id),
  email        TEXT,
  "fullName"   TEXT,
  status       TEXT,
  "createdAt"  TIMESTAMPTZ NOT NULL DEFAULT now(),
  "deletedAt"  TIMESTAMPTZ
);
CREATE TABLE employees (
  id             UUID PRIMARY KEY,
  "agencyId"     UUID REFERENCES agencies(id),
  email          TEXT UNIQUE,            -- Employee.email globally UNIQUE
  "employeeCode" TEXT,
  "fullName"     TEXT,
  status         TEXT,
  "createdAt"    TIMESTAMPTZ NOT NULL DEFAULT now(),
  "deletedAt"    TIMESTAMPTZ
);
CREATE TABLE documents (
  id           UUID PRIMARY KEY,
  "docId"      TEXT UNIQUE,           -- Document.docId globally UNIQUE
  "entityType" TEXT NOT NULL,
  "entityId"   UUID NOT NULL,
  "storageKey" TEXT,
  "storageUrl" TEXT,
  "createdAt"  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE job_ads (
  id        UUID PRIMARY KEY,
  slug      TEXT UNIQUE NOT NULL,    -- JobAd.slug globally UNIQUE
  title     TEXT NOT NULL,
  status    TEXT NOT NULL DEFAULT 'PUBLISHED',
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE attendance_records (
  id           UUID PRIMARY KEY,
  "employeeId" UUID REFERENCES employees(id),
  date         DATE NOT NULL,
  hours        NUMERIC(6,2),
  "createdAt"  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE ("employeeId", date)
);
CREATE TABLE attendance_locked_periods (
  id    UUID PRIMARY KEY,
  year  INT NOT NULL,
  month INT NOT NULL,
  "lockedAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (year, month)               -- locks all tenants today
);
CREATE TABLE financial_records (
  id          UUID PRIMARY KEY,
  "entityType" TEXT NOT NULL,
  "entityId"  UUID NOT NULL,
  amount      NUMERIC(18,4),
  currency    CHAR(3) NOT NULL DEFAULT 'EUR',
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE workflows (
  id        UUID PRIMARY KEY,
  name      TEXT NOT NULL,
  "isPublic" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE reports (
  id   UUID PRIMARY KEY,
  name TEXT UNIQUE NOT NULL,         -- Report.name globally UNIQUE
  "createdById" UUID REFERENCES users(id),
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE notifications (
  id        UUID PRIMARY KEY,
  "userId"  UUID REFERENCES users(id),
  kind      TEXT NOT NULL,
  payload   JSONB,
  "readAt"  TIMESTAMPTZ,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE vehicles (
  id          UUID PRIMARY KEY,
  "agencyId"  UUID REFERENCES agencies(id),
  plate       TEXT,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE workshops (
  id    UUID PRIMARY KEY,
  name  TEXT NOT NULL,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE identifier_sequences (
  id     UUID PRIMARY KEY,
  prefix TEXT NOT NULL,
  year   INT NOT NULL,
  month  INT NOT NULL,
  value  INT NOT NULL DEFAULT 0,
  UNIQUE (prefix, year, month)       -- not yet tenant-scoped
);
CREATE TABLE audit_logs (
  id      BIGSERIAL PRIMARY KEY,
  "userId" UUID,
  action  TEXT NOT NULL,
  target  JSONB,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE employee_agency_access (
  "employeeId" UUID REFERENCES employees(id),
  "agencyId"   UUID REFERENCES agencies(id),
  scope        TEXT NOT NULL DEFAULT 'FULL',
  PRIMARY KEY ("employeeId","agencyId")
);
CREATE TABLE agency_user_permission (
  "userId"       UUID REFERENCES users(id),
  "permissionId" UUID REFERENCES "Permission"(id),
  PRIMARY KEY ("userId","permissionId")
);
CREATE TABLE agency_permission_overrides (
  id         UUID PRIMARY KEY,
  "agencyId" UUID REFERENCES agencies(id),
  permission TEXT NOT NULL,
  effect     BOOLEAN NOT NULL DEFAULT true,
  UNIQUE ("agencyId", permission)
);

-- ---- Seed (intentionally messy to exercise the audits) ----
INSERT INTO "Role" VALUES
  ('00000000-0000-0000-0000-000000000001', 'System Admin',     true ),
  ('00000000-0000-0000-0000-000000000002', 'HR Manager',       false),
  ('00000000-0000-0000-0000-000000000003', 'Recruiter',        false),
  ('00000000-0000-0000-0000-000000000004', 'Compliance Officer', false),
  ('00000000-0000-0000-0000-000000000005', 'Read Only',        false);

INSERT INTO "Permission"(id, name, module, action) VALUES
  (gen_random_uuid(),'candidates:read','candidates','read'),
  (gen_random_uuid(),'candidates:write','candidates','write'),
  (gen_random_uuid(),'employees:read','employees','read'),
  (gen_random_uuid(),'documents:read','documents','read'),
  (gen_random_uuid(),'reports:run','reports','run');

INSERT INTO agencies(id, name, country, email, "isSystem") VALUES
  ('00000000-0000-0000-0000-0000000000aa', 'Tempworks',  'NL', 'ops@tempworks.test', true ),
  ('11111111-1111-1111-1111-111111111111', 'Acme HR',    'NL', 'hr@acme.test',       false),
  ('22222222-2222-2222-2222-222222222222', 'Globex Co.', 'DE', 'hr@globex.test',     false),
  ('33333333-3333-3333-3333-333333333333', 'Initech',    'IT', 'hr@initech.test',    false),
  -- "edge case" agency — has zero users/employees
  ('44444444-4444-4444-4444-444444444444', 'Empty Co',   'FR', NULL,                 false);

-- 2 Tempworks staff (system) + 5 Acme + 5 Globex + 0 Initech (edge case)
INSERT INTO users(id, email, "firstName", "lastName", status, "agencyId", "roleId") VALUES
  (gen_random_uuid(), 'admin1@tempworks.test', 'Alice','TW', 'ACTIVE',
   '00000000-0000-0000-0000-0000000000aa','00000000-0000-0000-0000-000000000001'),
  (gen_random_uuid(), 'admin2@tempworks.test', 'Bob',  'TW', 'ACTIVE',
   '00000000-0000-0000-0000-0000000000aa','00000000-0000-0000-0000-000000000001');

INSERT INTO users(id, email, "firstName", "lastName", status, "agencyId", "roleId")
SELECT gen_random_uuid(), 'acme'||g||'@acme.test','User'||g,'A','ACTIVE',
       '11111111-1111-1111-1111-111111111111','00000000-0000-0000-0000-000000000003'
FROM generate_series(1,5) g;

INSERT INTO users(id, email, "firstName", "lastName", status, "agencyId", "roleId")
SELECT gen_random_uuid(), 'globex'||g||'@globex.test','User'||g,'G','ACTIVE',
       '22222222-2222-2222-2222-222222222222','00000000-0000-0000-0000-000000000002'
FROM generate_series(1,5) g;

-- An orphan: NULL agencyId
INSERT INTO users(id, email, "firstName", "lastName", status, "agencyId", "roleId") VALUES
  (gen_random_uuid(), 'orphan@nowhere.test', 'Orph','an', 'ACTIVE', NULL,
   '00000000-0000-0000-0000-000000000005');

-- A soft-deleted user
INSERT INTO users(id, email, "firstName", "lastName", status, "agencyId", "roleId", "deletedAt") VALUES
  (gen_random_uuid(), 'deleted@acme.test','Del','User','INACTIVE',
   '11111111-1111-1111-1111-111111111111','00000000-0000-0000-0000-000000000005', now()-interval '30 days');

-- Domain rows
INSERT INTO applicants(id, "agencyId", email, "fullName", status)
SELECT gen_random_uuid(), '11111111-1111-1111-1111-111111111111',
       'app'||g||'@acme.test', 'Acme App '||g, 'NEW'
FROM generate_series(1,40) g;

INSERT INTO applicants(id, "agencyId", email, "fullName", status)
SELECT gen_random_uuid(), '22222222-2222-2222-2222-222222222222',
       'app'||g||'@globex.test', 'Globex App '||g, 'NEW'
FROM generate_series(1,30) g;

-- Same applicant email used in two agencies (allowed today; multi-tenant: also fine)
INSERT INTO applicants(id, "agencyId", email, "fullName", status) VALUES
  (gen_random_uuid(), '11111111-1111-1111-1111-111111111111', 'shared@example.test', 'Shared A', 'NEW'),
  (gen_random_uuid(), '22222222-2222-2222-2222-222222222222', 'shared@example.test', 'Shared B', 'NEW');

-- Employees: simulate the global-email-unique constraint and tenant-shape risk
INSERT INTO employees(id, "agencyId", email, "employeeCode", "fullName", status)
SELECT gen_random_uuid(), '11111111-1111-1111-1111-111111111111',
       'emp'||g||'@acme.test', 'A-EMP-'||g, 'Acme Emp '||g, 'ACTIVE'
FROM generate_series(1,15) g;

INSERT INTO employees(id, "agencyId", email, "employeeCode", "fullName", status)
SELECT gen_random_uuid(), '22222222-2222-2222-2222-222222222222',
       'emp'||g||'@globex.test', 'G-EMP-'||g, 'Globex Emp '||g, 'ACTIVE'
FROM generate_series(1,12) g;

-- Employee codes that COLLIDE across tenants (will become collision after backfill if not normalised)
INSERT INTO employees(id, "agencyId", email, "employeeCode", "fullName", status) VALUES
  (gen_random_uuid(), '11111111-1111-1111-1111-111111111111', 'shared.code1@acme.test',  'COMMON-001', 'Acme Common', 'ACTIVE'),
  (gen_random_uuid(), '22222222-2222-2222-2222-222222222222', 'shared.code1@globex.test','COMMON-001', 'Globex Common','ACTIVE');

-- Documents (entity-keyed; no agencyId field)
INSERT INTO documents(id, "docId", "entityType", "entityId", "storageKey", "storageUrl")
SELECT gen_random_uuid(), 'D-2025-'||lpad(g::text,5,'0'), 'EMPLOYEE',
       (SELECT id FROM employees ORDER BY id LIMIT 1 OFFSET (g % 27)),
       NULL,
       'https://nyc3.digitaloceanspaces.com/files/documents/EMPLOYEE/'||g||'.pdf'
FROM generate_series(1,50) g;

-- A document with a LOCAL upload path (legacy)
INSERT INTO documents(id, "docId", "entityType", "entityId", "storageKey", "storageUrl") VALUES
  (gen_random_uuid(), 'D-2025-LEGACY-1', 'EMPLOYEE',
   (SELECT id FROM employees LIMIT 1), NULL,
   '/uploads/documents/legacy.pdf');

-- A document with NO storage info at all
INSERT INTO documents(id, "docId", "entityType", "entityId") VALUES
  (gen_random_uuid(), 'D-2025-MISSING-1', 'EMPLOYEE', (SELECT id FROM employees LIMIT 1));

-- Job ads — globally unique slug today
INSERT INTO job_ads(id, slug, title) VALUES
  (gen_random_uuid(), 'senior-recruiter',  'Senior Recruiter — Acme'),
  (gen_random_uuid(), 'compliance-officer','Compliance Officer — Globex'),
  (gen_random_uuid(), 'sales-rep',         'Sales Rep — Initech');

-- Reports — globally unique name today (will collide once split per tenant)
INSERT INTO reports(id, name, "createdById") VALUES
  (gen_random_uuid(), 'Monthly KPI', (SELECT id FROM users WHERE email LIKE 'admin1%')),
  (gen_random_uuid(), 'Compliance Expiry', (SELECT id FROM users WHERE email LIKE 'admin1%'));

-- Attendance lock — global today
INSERT INTO attendance_locked_periods(id, year, month) VALUES
  (gen_random_uuid(), 2025, 1),
  (gen_random_uuid(), 2025, 2);

-- Identifier sequences — global today
INSERT INTO identifier_sequences(id, prefix, year, month, value) VALUES
  (gen_random_uuid(), 'A', 2025, 1, 250),
  (gen_random_uuid(), 'E', 2025, 1, 87);

-- Notifications + workflows
INSERT INTO notifications(id, "userId", kind, payload)
SELECT gen_random_uuid(), id, 'compliance.expiry', '{}'::jsonb
FROM users WHERE "agencyId" IS NOT NULL LIMIT 5;

INSERT INTO workflows(id, name, "isPublic") VALUES
  (gen_random_uuid(), 'Default Onboarding', true),
  (gen_random_uuid(), 'Acme Custom',        true),
  (gen_random_uuid(), 'Globex Compliance',  false);

-- Cross-tenant access (legitimate within-tenant grant, but pre-migration is unscoped)
INSERT INTO employee_agency_access("employeeId","agencyId", scope)
SELECT id, '22222222-2222-2222-2222-222222222222', 'READ_ONLY'
FROM employees
WHERE "agencyId" = '11111111-1111-1111-1111-111111111111'
LIMIT 2;

-- Vehicle + workshop
INSERT INTO vehicles(id, "agencyId", plate) VALUES
  (gen_random_uuid(), '11111111-1111-1111-1111-111111111111', 'NL-001-AC'),
  (gen_random_uuid(), '22222222-2222-2222-2222-222222222222', 'DE-002-GX'),
  (gen_random_uuid(), NULL,                                   'XX-???-??');  -- orphan

INSERT INTO workshops(id, name) VALUES
  (gen_random_uuid(), 'Tempworks Central Workshop');

-- Financial record with no direct ownership
INSERT INTO financial_records(id, "entityType", "entityId", amount) VALUES
  (gen_random_uuid(), 'EMPLOYEE', (SELECT id FROM employees LIMIT 1), 1500.00);

-- Audit logs
INSERT INTO audit_logs("userId", action, target) VALUES
  ((SELECT id FROM users WHERE email LIKE 'admin1%'), 'employee.create', '{"id":"abc"}'::jsonb);

-- Final sanity
SELECT 'agencies' AS t, count(*) FROM agencies
UNION ALL SELECT 'users',      count(*) FROM users
UNION ALL SELECT 'applicants', count(*) FROM applicants
UNION ALL SELECT 'employees',  count(*) FROM employees
UNION ALL SELECT 'documents',  count(*) FROM documents;
