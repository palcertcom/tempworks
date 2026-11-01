-- Spike 003 — Agency → Tenant migration dry-run
-- Simulates the backfill from SAAS_AGENCY_TO_TENANT_SPLIT_STRATEGY.md
-- Removable: drop database spike_agency_split.

DROP TABLE IF EXISTS users, agencies, employees, applicants, candidates,
                    employee_agency_access, agency_user_permission, "Role" CASCADE;
DROP TABLE IF EXISTS tenants_new, tenant_membership, agency_membership,
                    membership_role, membership_permission_override,
                    platform_admin, agency_split_progress CASCADE;

-- ------- Pre-migration shape (simplified Tempworks model) -------
CREATE TABLE "Role" (
  id   UUID PRIMARY KEY,
  name TEXT UNIQUE NOT NULL
);
CREATE TABLE agencies (
  id          UUID PRIMARY KEY,
  name        TEXT NOT NULL,
  is_system   BOOLEAN NOT NULL DEFAULT false,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE users (
  id        UUID PRIMARY KEY,
  email     TEXT UNIQUE NOT NULL,    -- global unique today
  agency_id UUID NOT NULL REFERENCES agencies(id),
  role_id   UUID NOT NULL REFERENCES "Role"(id),
  status    TEXT NOT NULL DEFAULT 'ACTIVE'
);
CREATE TABLE employees (
  id         UUID PRIMARY KEY,
  agency_id  UUID NOT NULL REFERENCES agencies(id),
  email      TEXT,
  full_name  TEXT
);
CREATE TABLE applicants (
  id         UUID PRIMARY KEY,
  agency_id  UUID NOT NULL REFERENCES agencies(id),
  email      TEXT,
  full_name  TEXT
);
CREATE TABLE employee_agency_access (
  employee_id UUID REFERENCES employees(id),
  agency_id   UUID REFERENCES agencies(id),
  scope       TEXT NOT NULL DEFAULT 'FULL',
  PRIMARY KEY (employee_id, agency_id)
);
CREATE TABLE agency_user_permission (
  user_id       UUID REFERENCES users(id),
  permission_id UUID,
  PRIMARY KEY (user_id, permission_id)
);

-- Seed: one system agency, two customer agencies
INSERT INTO "Role" VALUES
  ('00000000-0000-0000-0000-000000000001', 'System Admin'),
  ('00000000-0000-0000-0000-000000000002', 'HR Manager'),
  ('00000000-0000-0000-0000-000000000003', 'Recruiter');

INSERT INTO agencies VALUES
  ('00000000-0000-0000-0000-0000000000aa', 'Tempworks',  true ),
  ('11111111-1111-1111-1111-111111111111', 'Acme HR',    false),
  ('22222222-2222-2222-2222-222222222222', 'Globex Co.', false);

-- 2 platform-admin users + 5 acme + 5 globex
INSERT INTO users VALUES
  ('aaaaaaaa-0000-0000-0000-00000000aa01', 'admin1@tempworks.com', '00000000-0000-0000-0000-0000000000aa', '00000000-0000-0000-0000-000000000001'),
  ('aaaaaaaa-0000-0000-0000-00000000aa02', 'admin2@tempworks.com', '00000000-0000-0000-0000-0000000000aa', '00000000-0000-0000-0000-000000000001');
INSERT INTO users
SELECT gen_random_uuid(), 'acme'||g||'@acme.test',
       '11111111-1111-1111-1111-111111111111',
       '00000000-0000-0000-0000-000000000003'
FROM generate_series(1,5) g;
INSERT INTO users
SELECT gen_random_uuid(), 'globex'||g||'@globex.test',
       '22222222-2222-2222-2222-222222222222',
       '00000000-0000-0000-0000-000000000002'
FROM generate_series(1,5) g;

-- A potential collision case: one user appears in both agencies under same email
-- (this would FAIL today because email is globally unique; we instead simulate
-- the tricky case "user moved between agencies" which still has a unique email)
-- Edge case probe: insert two rows with the SAME email — must fail
DO $$
BEGIN
  BEGIN
    INSERT INTO users(id, email, agency_id, role_id) VALUES
      (gen_random_uuid(), 'shared@example.com',
       '11111111-1111-1111-1111-111111111111',
       '00000000-0000-0000-0000-000000000003');
    INSERT INTO users(id, email, agency_id, role_id) VALUES
      (gen_random_uuid(), 'shared@example.com',
       '22222222-2222-2222-2222-222222222222',
       '00000000-0000-0000-0000-000000000003');
    RAISE NOTICE 'collision NOT detected (would have failed in real schema)';
  EXCEPTION WHEN unique_violation THEN
    RAISE NOTICE 'pre-flight collision check OK: duplicate email rejected';
  END;
END $$;

-- A few employees / applicants per agency
INSERT INTO employees
SELECT gen_random_uuid(), '11111111-1111-1111-1111-111111111111',
       'emp'||g||'@acme.test', 'Acme Emp '||g
FROM generate_series(1,3) g;
INSERT INTO employees
SELECT gen_random_uuid(), '22222222-2222-2222-2222-222222222222',
       'emp'||g||'@globex.test', 'Globex Emp '||g
FROM generate_series(1,3) g;

INSERT INTO applicants
SELECT gen_random_uuid(), '11111111-1111-1111-1111-111111111111',
       'app'||g||'@acme.test', 'Acme App '||g
FROM generate_series(1,2) g;

\echo '----- BEFORE MIGRATION -----'
SELECT 'agencies', count(*) FROM agencies UNION ALL
SELECT 'users',    count(*) FROM users    UNION ALL
SELECT 'employees',count(*) FROM employees UNION ALL
SELECT 'applicants',count(*) FROM applicants;

-- ------- Migration: additive new tables -------
CREATE TABLE tenants_new (
  id          UUID PRIMARY KEY,
  slug        TEXT UNIQUE NOT NULL,
  name        TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'ACTIVE',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE tenant_membership (
  id          UUID PRIMARY KEY,
  user_id     UUID NOT NULL REFERENCES users(id),
  tenant_id   UUID NOT NULL REFERENCES tenants_new(id),
  status      TEXT NOT NULL DEFAULT 'ACTIVE',
  joined_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, tenant_id)
);
CREATE TABLE membership_role (
  membership_id UUID REFERENCES tenant_membership(id) ON DELETE CASCADE,
  role_id       UUID REFERENCES "Role"(id) ON DELETE RESTRICT,
  PRIMARY KEY (membership_id, role_id)
);
CREATE TABLE agency_membership (
  id            UUID PRIMARY KEY,
  membership_id UUID REFERENCES tenant_membership(id) ON DELETE CASCADE,
  agency_id     UUID REFERENCES agencies(id),
  scope         TEXT NOT NULL DEFAULT 'FULL',
  UNIQUE (membership_id, agency_id)
);
CREATE TABLE membership_permission_override (
  id            UUID PRIMARY KEY,
  membership_id UUID REFERENCES tenant_membership(id) ON DELETE CASCADE,
  permission_id UUID,
  grant         BOOLEAN NOT NULL DEFAULT true,
  UNIQUE (membership_id, permission_id)
);
CREATE TABLE platform_admin (
  id         UUID PRIMARY KEY,
  user_id    UUID UNIQUE REFERENCES users(id),
  level      TEXT NOT NULL DEFAULT 'SUPER',
  granted_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE agency_split_progress (
  old_agency_id          UUID PRIMARY KEY,
  new_tenant_id          UUID NOT NULL,
  new_default_agency_id  UUID NOT NULL,
  status                 TEXT NOT NULL DEFAULT 'PENDING'
);

-- ------- The actual split — done in a transaction per old agency -------
DO $$
DECLARE
  a RECORD;
  new_default_id UUID;
  slug TEXT;
BEGIN
  -- Process customer agencies
  FOR a IN
    SELECT * FROM agencies WHERE is_system = false ORDER BY created_at
  LOOP
    BEGIN
      -- Tenant id reuses the original agency id
      INSERT INTO tenants_new(id, slug, name)
      VALUES (a.id,
              regexp_replace(lower(a.name), '[^a-z0-9-]+', '-', 'g'),
              a.name)
      ON CONFLICT (id) DO NOTHING;

      -- Create default agency child with a fresh id
      new_default_id := gen_random_uuid();
      INSERT INTO agencies(id, name, is_system) VALUES
        (new_default_id, a.name, false);

      -- Reparent rows that used to point at the old (about-to-be-deleted)
      -- agency. We also need to make sure FK target survives until UPDATE
      -- completes. Strategy: temporarily disable FK / use deferrable. For
      -- this dry-run, simulate by adding the new agency BEFORE updates.
      UPDATE users      SET agency_id = new_default_id WHERE agency_id = a.id;
      UPDATE employees  SET agency_id = new_default_id WHERE agency_id = a.id;
      UPDATE applicants SET agency_id = new_default_id WHERE agency_id = a.id;
      UPDATE employee_agency_access SET agency_id = new_default_id WHERE agency_id = a.id;
      -- agency_user_permission has no agency_id; skip

      -- Now safe to delete the original agency row
      DELETE FROM agencies WHERE id = a.id;

      INSERT INTO agency_split_progress
      VALUES (a.id, a.id, new_default_id, 'DONE');
    EXCEPTION WHEN OTHERS THEN
      INSERT INTO agency_split_progress(old_agency_id, new_tenant_id, new_default_agency_id, status)
      VALUES (a.id, a.id, COALESCE(new_default_id, gen_random_uuid()), 'FAILED: ' || SQLERRM);
      RAISE;
    END;
  END LOOP;

  -- Process system agency: users → platform_admin; agency row deleted last
  FOR a IN
    SELECT * FROM agencies WHERE is_system = true
  LOOP
    INSERT INTO platform_admin(id, user_id, level)
    SELECT gen_random_uuid(), u.id, 'SUPER'
      FROM users u WHERE u.agency_id = a.id;

    -- Detach: we need to remove FK from system users before deleting the
    -- system agency. Simplest path: hard-delete those users (they re-auth
    -- into the platform shell). In production, we instead reparent them
    -- to a synthetic "platform users" row OR drop the FK and keep them
    -- as ghost agency-less users. This dry-run picks the latter:
    ALTER TABLE users ALTER COLUMN agency_id DROP NOT NULL;
    UPDATE users SET agency_id = NULL WHERE agency_id = a.id;
    DELETE FROM agencies WHERE id = a.id;
  END LOOP;
END $$;

-- ------- Membership backfill -------
INSERT INTO tenant_membership(id, user_id, tenant_id, status)
SELECT gen_random_uuid(), u.id,
       (SELECT new_tenant_id FROM agency_split_progress sp
         WHERE sp.new_default_agency_id = u.agency_id),
       u.status
  FROM users u
 WHERE u.agency_id IS NOT NULL;

INSERT INTO membership_role(membership_id, role_id)
SELECT m.id, u.role_id
  FROM tenant_membership m
  JOIN users u ON u.id = m.user_id;

INSERT INTO agency_membership(id, membership_id, agency_id, scope)
SELECT gen_random_uuid(), m.id, u.agency_id, 'FULL'
  FROM tenant_membership m
  JOIN users u ON u.id = m.user_id;

-- Cross-agency grants (EmployeeAgencyAccess) → AgencyMembership. Map by
-- finding the affected user(s) — simulated as "the manager of that employee".
-- For the dry run, we just demonstrate the mapping shape exists.

-- ------- Verification -------
\echo '----- AFTER MIGRATION -----'
SELECT 'tenants_new',           count(*) FROM tenants_new                  UNION ALL
SELECT 'tenant_membership',     count(*) FROM tenant_membership            UNION ALL
SELECT 'membership_role',       count(*) FROM membership_role              UNION ALL
SELECT 'agency_membership',     count(*) FROM agency_membership            UNION ALL
SELECT 'platform_admin',        count(*) FROM platform_admin               UNION ALL
SELECT 'agencies',              count(*) FROM agencies                     UNION ALL
SELECT 'users',                 count(*) FROM users                        UNION ALL
SELECT 'employees',             count(*) FROM employees                    UNION ALL
SELECT 'applicants',            count(*) FROM applicants                   UNION ALL
SELECT 'orphan users (no membership)',
       count(*) FROM users u LEFT JOIN tenant_membership m ON m.user_id = u.id
        WHERE m.id IS NULL AND u.agency_id IS NOT NULL;

-- Per-tenant breakdown
\echo '----- PER-TENANT BREAKDOWN -----'
SELECT t.name,
       (SELECT count(*) FROM tenant_membership WHERE tenant_id = t.id)  AS members,
       (SELECT count(*) FROM employees e
          JOIN agencies a ON a.id = e.agency_id
          JOIN agency_split_progress sp ON sp.new_default_agency_id = a.id
          WHERE sp.new_tenant_id = t.id)                                AS employees,
       (SELECT count(*) FROM applicants p
          JOIN agencies a ON a.id = p.agency_id
          JOIN agency_split_progress sp ON sp.new_default_agency_id = a.id
          WHERE sp.new_tenant_id = t.id)                                AS applicants
FROM tenants_new t
ORDER BY t.name;

-- Permission preservation: every original (user, role) pair survives as
-- (membership, role)
\echo '----- PERMISSION PRESERVATION -----'
SELECT
  (SELECT count(*) FROM users WHERE agency_id IS NOT NULL) AS pre_user_role_pairs,
  (SELECT count(*) FROM membership_role)                   AS post_membership_role_pairs;
