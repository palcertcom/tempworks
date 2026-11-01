-- =============================================================================
-- Phase 2.4 fixture extension — additive only.
-- =============================================================================
-- Adds the tables / columns the Phase 2.4 joined-source harnesses need
-- which the original `saas_phase1_fixture` seed did not materialise:
--   - documents.deletedAt
--   - documents.documentTypeId
--   - agencies.deletedAt
--   - work_permits, visas, compliance_alerts, document_types
--
-- Seeds at least two tenants' worth of rows for every multi-table source,
-- including:
--   - same-shape rows in two tenants (cross-tenant collision check)
--   - orphan rows (parent in tenant A, child rows for that parent in
--     tenant A — never tenant B, by construction)
--   - nullable joined rows (employees with no documents)
--
-- Idempotent. Safe to re-run.
-- =============================================================================

BEGIN;

-- ── Schema additions ──
ALTER TABLE documents ADD COLUMN IF NOT EXISTS "deletedAt" timestamptz;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS "documentTypeId" uuid;
ALTER TABLE agencies  ADD COLUMN IF NOT EXISTS "deletedAt" timestamptz;

CREATE TABLE IF NOT EXISTS document_types (
  id uuid PRIMARY KEY,
  name text NOT NULL,
  category text NOT NULL,
  required boolean NOT NULL DEFAULT false,
  "trackExpiry" boolean NOT NULL DEFAULT true,
  "renewalPeriodDays" int,
  "isActive" boolean NOT NULL DEFAULT true,
  "createdAt" timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS work_permits (
  id uuid PRIMARY KEY,
  "employeeId" uuid NOT NULL,
  "tenantId" text,
  "permitType" text,
  status text,
  "permitNumber" text,
  "applicationDate" date,
  "approvalDate" date,
  "expiryDate" date,
  "createdAt" timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS work_permits_tenantId_idx ON work_permits("tenantId");

CREATE TABLE IF NOT EXISTS visas (
  id uuid PRIMARY KEY,
  "entityType" text NOT NULL,
  "entityId" uuid NOT NULL,
  "tenantId" text,
  "visaType" text,
  status text,
  "visaNumber" text,
  "applicationDate" date,
  "appointmentDate" date,
  "approvalDate" date,
  "expiryDate" date,
  embassy text,
  "createdAt" timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS visas_tenantId_idx ON visas("tenantId");

CREATE TABLE IF NOT EXISTS compliance_alerts (
  id uuid PRIMARY KEY,
  "entityType" text NOT NULL,
  "entityId" uuid NOT NULL,
  "tenantId" text,
  "alertType" text,
  severity text,
  message text,
  status text,
  "dueDate" date,
  "createdAt" timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS compliance_alerts_tenantId_idx ON compliance_alerts("tenantId");

-- ── Seed catalog (global) ──
INSERT INTO document_types (id, name, category, required, "trackExpiry", "renewalPeriodDays", "isActive")
VALUES
  ('00000000-0000-0000-0000-000000000d01', 'Passport',     'identity',   true,  true,  3650, true),
  ('00000000-0000-0000-0000-000000000d02', 'Work Permit',  'employment', true,  true,   730, true),
  ('00000000-0000-0000-0000-000000000d03', 'Tax ID',       'finance',    false, false, NULL, true)
ON CONFLICT (id) DO NOTHING;

-- Patch documents to point at a catalog row so documents_with_type returns matched.
UPDATE documents
   SET "documentTypeId" = '00000000-0000-0000-0000-000000000d01'
 WHERE "documentTypeId" IS NULL;

-- ── Helper: pick the first two tenants alphabetically.
DO $do$
DECLARE
  ta uuid;
  tb uuid;
  emp_a uuid;
  emp_b uuid;
  app_a uuid;
  app_b uuid;
BEGIN
  SELECT id INTO ta FROM tenants ORDER BY name OFFSET 0 LIMIT 1;
  SELECT id INTO tb FROM tenants ORDER BY name OFFSET 1 LIMIT 1;
  IF ta IS NULL OR tb IS NULL THEN
    RAISE NOTICE '[phase24-extension] need at least 2 tenants; skipping seed';
    RETURN;
  END IF;

  SELECT id INTO emp_a FROM employees WHERE "tenantId" = ta::text LIMIT 1;
  SELECT id INTO emp_b FROM employees WHERE "tenantId" = tb::text LIMIT 1;
  SELECT id INTO app_a FROM applicants WHERE "tenantId" = ta::text LIMIT 1;
  SELECT id INTO app_b FROM applicants WHERE "tenantId" = tb::text LIMIT 1;

  -- ── work_permits: same-shape rows in both tenants
  IF emp_a IS NOT NULL THEN
    INSERT INTO work_permits(id, "employeeId", "tenantId", "permitType", status, "permitNumber",
                             "applicationDate", "approvalDate", "expiryDate")
    VALUES ('00000000-0000-0000-0000-00000000a001', emp_a, ta::text, 'H1B', 'APPROVED', 'WP-A-1',
            DATE '2025-01-01', DATE '2025-02-01', DATE '2027-02-01')
    ON CONFLICT (id) DO NOTHING;
  END IF;
  IF emp_b IS NOT NULL THEN
    INSERT INTO work_permits(id, "employeeId", "tenantId", "permitType", status, "permitNumber",
                             "applicationDate", "approvalDate", "expiryDate")
    VALUES ('00000000-0000-0000-0000-00000000b001', emp_b, tb::text, 'H1B', 'APPROVED', 'WP-B-1',
            DATE '2025-01-01', DATE '2025-02-01', DATE '2027-02-01')
    ON CONFLICT (id) DO NOTHING;
  END IF;

  -- ── visas: employees and applicants for both tenants
  IF emp_a IS NOT NULL THEN
    INSERT INTO visas(id, "entityType", "entityId", "tenantId", "visaType", status, "visaNumber",
                      "applicationDate", "expiryDate", embassy)
    VALUES ('00000000-0000-0000-0000-00000000a002', 'EMPLOYEE', emp_a, ta::text, 'B1', 'APPROVED',
            'VS-A-1', DATE '2025-01-01', DATE '2027-01-01', 'A-Embassy')
    ON CONFLICT (id) DO NOTHING;
  END IF;
  IF emp_b IS NOT NULL THEN
    INSERT INTO visas(id, "entityType", "entityId", "tenantId", "visaType", status, "visaNumber",
                      "applicationDate", "expiryDate", embassy)
    VALUES ('00000000-0000-0000-0000-00000000b002', 'EMPLOYEE', emp_b, tb::text, 'B1', 'APPROVED',
            'VS-B-1', DATE '2025-01-01', DATE '2027-01-01', 'B-Embassy')
    ON CONFLICT (id) DO NOTHING;
  END IF;
  IF app_a IS NOT NULL THEN
    INSERT INTO visas(id, "entityType", "entityId", "tenantId", "visaType", status, "visaNumber",
                      "applicationDate", "expiryDate", embassy)
    VALUES ('00000000-0000-0000-0000-00000000a003', 'APPLICANT', app_a, ta::text, 'B2', 'PENDING',
            'VS-A-2', DATE '2025-03-01', NULL, 'A-Embassy')
    ON CONFLICT (id) DO NOTHING;
  END IF;
  IF app_b IS NOT NULL THEN
    INSERT INTO visas(id, "entityType", "entityId", "tenantId", "visaType", status, "visaNumber",
                      "applicationDate", "expiryDate", embassy)
    VALUES ('00000000-0000-0000-0000-00000000b003', 'APPLICANT', app_b, tb::text, 'B2', 'PENDING',
            'VS-B-2', DATE '2025-03-01', NULL, 'B-Embassy')
    ON CONFLICT (id) DO NOTHING;
  END IF;

  -- ── compliance_alerts: matching alerts on both tenants
  IF emp_a IS NOT NULL THEN
    INSERT INTO compliance_alerts(id, "entityType", "entityId", "tenantId", "alertType", severity,
                                  message, status, "dueDate")
    VALUES ('00000000-0000-0000-0000-00000000a004', 'EMPLOYEE', emp_a, ta::text, 'doc.expiry', 'HIGH',
            'A: doc expires soon', 'OPEN', DATE '2026-06-01')
    ON CONFLICT (id) DO NOTHING;
  END IF;
  IF emp_b IS NOT NULL THEN
    INSERT INTO compliance_alerts(id, "entityType", "entityId", "tenantId", "alertType", severity,
                                  message, status, "dueDate")
    VALUES ('00000000-0000-0000-0000-00000000b004', 'EMPLOYEE', emp_b, tb::text, 'doc.expiry', 'HIGH',
            'B: doc expires soon', 'OPEN', DATE '2026-06-01')
    ON CONFLICT (id) DO NOTHING;
  END IF;
  IF app_a IS NOT NULL THEN
    INSERT INTO compliance_alerts(id, "entityType", "entityId", "tenantId", "alertType", severity,
                                  message, status, "dueDate")
    VALUES ('00000000-0000-0000-0000-00000000a005', 'APPLICANT', app_a, ta::text, 'visa.pending', 'MEDIUM',
            'A: visa pending review', 'OPEN', DATE '2026-08-01')
    ON CONFLICT (id) DO NOTHING;
  END IF;
END $do$;

COMMIT;
