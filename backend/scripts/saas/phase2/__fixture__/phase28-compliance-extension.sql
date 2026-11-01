-- =============================================================================
-- Phase 2.8 fixture extension — additive only.
-- =============================================================================
-- Seeds compliance_alerts rows for the second tenant that has at least
-- one employee, so the isolation harness can run cross-tenant collision
-- checks. Adds one NULL-tenant legacy row for the same exclusion proof
-- pattern used in Phase 2.7.
--
-- Idempotent. Safe to re-run. Production already has rows; this only
-- touches the staging fixture.
-- =============================================================================

BEGIN;

-- Postgres enums Prisma 7.5 expects on compliance_alerts. Created if
-- absent. The fixture's existing rows used text, so we cast columns
-- after creating the types.
DO $enums$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'AlertStatus') THEN
    CREATE TYPE "AlertStatus" AS ENUM ('OPEN','ACKNOWLEDGED','RESOLVED','DISMISSED');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'AlertSeverity') THEN
    CREATE TYPE "AlertSeverity" AS ENUM ('LOW','MEDIUM','HIGH','CRITICAL');
  END IF;
END $enums$;

-- Cast columns to the enum types if they're still text.
DO $cast$
DECLARE
  status_type text;
  severity_type text;
BEGIN
  SELECT data_type INTO status_type FROM information_schema.columns
   WHERE table_name='compliance_alerts' AND column_name='status';
  SELECT data_type INTO severity_type FROM information_schema.columns
   WHERE table_name='compliance_alerts' AND column_name='severity';

  IF status_type = 'text' THEN
    ALTER TABLE compliance_alerts
      ALTER COLUMN status DROP DEFAULT,
      ALTER COLUMN status TYPE "AlertStatus" USING status::"AlertStatus",
      ALTER COLUMN status SET DEFAULT 'OPEN'::"AlertStatus";
  END IF;
  IF severity_type = 'text' THEN
    ALTER TABLE compliance_alerts
      ALTER COLUMN severity DROP DEFAULT,
      ALTER COLUMN severity TYPE "AlertSeverity" USING severity::"AlertSeverity",
      ALTER COLUMN severity SET DEFAULT 'MEDIUM'::"AlertSeverity";
  END IF;
END $cast$;

-- EntityType enum (used by compliance_alerts.entityType + others).
DO $entity_enum$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'EntityType') THEN
    CREATE TYPE "EntityType" AS ENUM ('EMPLOYEE','APPLICANT','AGENCY','VEHICLE');
  END IF;
END $entity_enum$;

-- Add the columns Prisma's ComplianceAlert model expects but the
-- fixture's narrow table didn't materialise.
ALTER TABLE compliance_alerts ADD COLUMN IF NOT EXISTS "documentId"   uuid;
ALTER TABLE compliance_alerts ADD COLUMN IF NOT EXISTS "resolvedAt"   timestamptz;
ALTER TABLE compliance_alerts ADD COLUMN IF NOT EXISTS "resolvedById" uuid;
ALTER TABLE compliance_alerts ADD COLUMN IF NOT EXISTS notes          text;
ALTER TABLE compliance_alerts ADD COLUMN IF NOT EXISTS "updatedAt"    timestamptz NOT NULL DEFAULT now();

-- Type fixes.
DO $coltypes$
DECLARE
  et text;
  dd text;
BEGIN
  SELECT data_type INTO et FROM information_schema.columns
   WHERE table_name='compliance_alerts' AND column_name='entityType';
  IF et = 'text' THEN
    ALTER TABLE compliance_alerts
      ALTER COLUMN "entityType" TYPE "EntityType" USING "entityType"::"EntityType";
  END IF;
  SELECT data_type INTO dd FROM information_schema.columns
   WHERE table_name='compliance_alerts' AND column_name='dueDate';
  IF dd = 'date' THEN
    ALTER TABLE compliance_alerts
      ALTER COLUMN "dueDate" TYPE timestamptz USING "dueDate"::timestamptz;
  END IF;
END $coltypes$;

-- document_types needs the columns Prisma's DocumentType model expects.
ALTER TABLE document_types ADD COLUMN IF NOT EXISTS code            text;
ALTER TABLE document_types ADD COLUMN IF NOT EXISTS description     text;
ALTER TABLE document_types ADD COLUMN IF NOT EXISTS translations    jsonb;
ALTER TABLE document_types ADD COLUMN IF NOT EXISTS "updatedAt"     timestamptz NOT NULL DEFAULT now();
ALTER TABLE document_types ADD COLUMN IF NOT EXISTS "deletedAt"     timestamptz;
ALTER TABLE document_types ADD COLUMN IF NOT EXISTS "deletedBy"     uuid;
ALTER TABLE document_types ADD COLUMN IF NOT EXISTS "deletionReason" text;

-- documents needs the columns Prisma's Document model expects.
DO $doc_status$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'DocumentStatus') THEN
    CREATE TYPE "DocumentStatus" AS ENUM ('PENDING','VERIFIED','REJECTED','EXPIRED','EXPIRING_SOON');
  END IF;
END $doc_status$;

ALTER TABLE documents ADD COLUMN IF NOT EXISTS name              text NOT NULL DEFAULT 'fixture-doc';
ALTER TABLE documents ADD COLUMN IF NOT EXISTS "fileUrl"         text NOT NULL DEFAULT 'fixture://stub';
ALTER TABLE documents ADD COLUMN IF NOT EXISTS "mimeType"        text NOT NULL DEFAULT 'application/pdf';
ALTER TABLE documents ADD COLUMN IF NOT EXISTS "fileSize"        int  NOT NULL DEFAULT 0;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS status            "DocumentStatus" NOT NULL DEFAULT 'PENDING';
ALTER TABLE documents ADD COLUMN IF NOT EXISTS "issueDate"       timestamptz;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS "expiryDate"      timestamptz;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS "issueCountry"    text;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS issuer            text;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS "documentNumber"  text;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS notes             text;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS "rejectionReason" text;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS "uploadedById"    uuid;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS "verifiedById"    uuid;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS "verifiedAt"      timestamptz;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS "renewedFromId"   uuid;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS "updatedAt"       timestamptz NOT NULL DEFAULT now();
ALTER TABLE documents ADD COLUMN IF NOT EXISTS "deletedBy"       uuid;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS "deletionReason"  text;

-- employees needs the firstName/lastName columns the compliance service selects.
ALTER TABLE employees ADD COLUMN IF NOT EXISTS "firstName" text NOT NULL DEFAULT 'Fixture';
ALTER TABLE employees ADD COLUMN IF NOT EXISTS "lastName"  text NOT NULL DEFAULT 'Employee';

-- work_permits + visas need extra columns + enum casts to satisfy Prisma.
DO $wp_visa_enums$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'WorkPermitStatus') THEN
    CREATE TYPE "WorkPermitStatus" AS ENUM ('PENDING','APPLIED','APPROVED','REJECTED','EXPIRED','CANCELLED');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'VisaStatus') THEN
    CREATE TYPE "VisaStatus" AS ENUM ('PENDING','APPLIED','APPOINTMENT_SCHEDULED','APPROVED','REJECTED','EXPIRED','CANCELLED');
  END IF;
END $wp_visa_enums$;

ALTER TABLE work_permits ADD COLUMN IF NOT EXISTS "issuingAuthority" text;
ALTER TABLE work_permits ADD COLUMN IF NOT EXISTS notes              text;
ALTER TABLE work_permits ADD COLUMN IF NOT EXISTS "updatedAt"        timestamptz NOT NULL DEFAULT now();

ALTER TABLE visas ADD COLUMN IF NOT EXISTS notes       text;
ALTER TABLE visas ADD COLUMN IF NOT EXISTS "updatedAt" timestamptz NOT NULL DEFAULT now();

DO $wp_visa_types$
DECLARE
  st text;
BEGIN
  SELECT data_type INTO st FROM information_schema.columns
   WHERE table_name='work_permits' AND column_name='status';
  IF st = 'text' THEN
    ALTER TABLE work_permits
      ALTER COLUMN status DROP DEFAULT,
      ALTER COLUMN status TYPE "WorkPermitStatus" USING (
        CASE WHEN status IS NULL OR status='' THEN 'PENDING'::"WorkPermitStatus"
             ELSE status::"WorkPermitStatus" END),
      ALTER COLUMN status SET NOT NULL,
      ALTER COLUMN status SET DEFAULT 'PENDING'::"WorkPermitStatus";
  END IF;

  SELECT data_type INTO st FROM information_schema.columns
   WHERE table_name='visas' AND column_name='status';
  IF st = 'text' THEN
    ALTER TABLE visas
      ALTER COLUMN status DROP DEFAULT,
      ALTER COLUMN status TYPE "VisaStatus" USING (
        CASE WHEN status IS NULL OR status='' THEN 'PENDING'::"VisaStatus"
             ELSE status::"VisaStatus" END),
      ALTER COLUMN status SET NOT NULL,
      ALTER COLUMN status SET DEFAULT 'PENDING'::"VisaStatus";
  END IF;

  -- visas.entityType: text → EntityType.
  SELECT data_type INTO st FROM information_schema.columns
   WHERE table_name='visas' AND column_name='entityType';
  IF st = 'text' THEN
    ALTER TABLE visas
      ALTER COLUMN "entityType" TYPE "EntityType" USING "entityType"::"EntityType";
  END IF;
END $wp_visa_types$;

-- date → timestamptz where Prisma expects DateTime
ALTER TABLE work_permits ALTER COLUMN "applicationDate" TYPE timestamptz
  USING "applicationDate"::timestamptz;
ALTER TABLE work_permits ALTER COLUMN "approvalDate"    TYPE timestamptz
  USING "approvalDate"::timestamptz;
ALTER TABLE work_permits ALTER COLUMN "expiryDate"      TYPE timestamptz
  USING "expiryDate"::timestamptz;
UPDATE work_permits SET "applicationDate" = COALESCE("applicationDate", now()) WHERE "applicationDate" IS NULL;
UPDATE work_permits SET "expiryDate"      = COALESCE("expiryDate", now())      WHERE "expiryDate" IS NULL;
ALTER TABLE work_permits ALTER COLUMN "applicationDate" SET NOT NULL;
ALTER TABLE work_permits ALTER COLUMN "expiryDate"      SET NOT NULL;

ALTER TABLE visas ALTER COLUMN "applicationDate" TYPE timestamptz USING "applicationDate"::timestamptz;
ALTER TABLE visas ALTER COLUMN "appointmentDate" TYPE timestamptz USING "appointmentDate"::timestamptz;
ALTER TABLE visas ALTER COLUMN "approvalDate"    TYPE timestamptz USING "approvalDate"::timestamptz;
ALTER TABLE visas ALTER COLUMN "expiryDate"      TYPE timestamptz USING "expiryDate"::timestamptz;
UPDATE visas SET "applicationDate" = COALESCE("applicationDate", now()) WHERE "applicationDate" IS NULL;
ALTER TABLE visas ALTER COLUMN "applicationDate" SET NOT NULL;

-- documents may also need entityType cast for joinability.
DO $doc_entity$
DECLARE
  et text;
BEGIN
  SELECT data_type INTO et FROM information_schema.columns
   WHERE table_name='documents' AND column_name='entityType';
  IF et = 'text' THEN
    BEGIN
      ALTER TABLE documents
        ALTER COLUMN "entityType" TYPE "EntityType" USING "entityType"::"EntityType";
    EXCEPTION WHEN others THEN
      RAISE NOTICE '[phase28] could not cast documents.entityType: %', SQLERRM;
    END;
  END IF;
END $doc_entity$;

DO $do$
DECLARE
  ta uuid;
  tb uuid;
  emp_a uuid;
  emp_b uuid;
  doc_a uuid;
  doc_b uuid;
BEGIN
  SELECT t.id INTO ta
    FROM tenants t
   WHERE EXISTS (SELECT 1 FROM employees e WHERE e."tenantId" = t.id::text)
   ORDER BY t.name OFFSET 0 LIMIT 1;
  SELECT t.id INTO tb
    FROM tenants t
   WHERE EXISTS (SELECT 1 FROM employees e WHERE e."tenantId" = t.id::text)
     AND t.id::text <> ta::text
   ORDER BY t.name OFFSET 0 LIMIT 1;
  IF ta IS NULL OR tb IS NULL THEN RETURN; END IF;

  SELECT id INTO emp_a FROM employees WHERE "tenantId" = ta::text LIMIT 1;
  SELECT id INTO emp_b FROM employees WHERE "tenantId" = tb::text LIMIT 1;
  SELECT id INTO doc_a FROM documents WHERE "tenantId" = ta::text LIMIT 1;
  SELECT id INTO doc_b FROM documents WHERE "tenantId" = tb::text LIMIT 1;

  -- Same-shape rows on both tenants (cross-tenant collision check).
  -- updatedAt is NOT NULL after the schema migration; explicitly stamp it.
  INSERT INTO compliance_alerts(id, "entityType", "entityId", "tenantId",
                                "alertType", severity, message, status, "dueDate", "updatedAt")
  VALUES
    -- Tenant A — keep the existing rows from phase24; add one extra
    -- for the count comparison.
    ('00000000-0000-0000-0000-00000000c001', 'EMPLOYEE', emp_a, ta::text,
     'doc.expiry', 'CRITICAL', 'A: critical doc expires soon', 'OPEN', DATE '2026-06-01', now()),
    ('00000000-0000-0000-0000-00000000c002', 'EMPLOYEE', emp_a, ta::text,
     'doc.missing', 'MEDIUM',  'A: medium', 'OPEN', DATE '2026-06-15', now()),
    ('00000000-0000-0000-0000-00000000c003', 'EMPLOYEE', emp_a, ta::text,
     'doc.expiry', 'LOW',      'A: resolved alert', 'RESOLVED', DATE '2026-04-01', now()),
    -- Tenant B — fresh rows.
    ('00000000-0000-0000-0000-00000000c101', 'EMPLOYEE', emp_b, tb::text,
     'doc.expiry', 'HIGH',     'B: doc expires soon',       'OPEN', DATE '2026-06-01', now()),
    ('00000000-0000-0000-0000-00000000c102', 'EMPLOYEE', emp_b, tb::text,
     'doc.expiry', 'CRITICAL', 'B: critical doc expires soon', 'OPEN', DATE '2026-06-01', now()),
    ('00000000-0000-0000-0000-00000000c103', 'EMPLOYEE', emp_b, tb::text,
     'doc.missing', 'MEDIUM',  'B: missing required doc',    'RESOLVED', DATE '2026-05-01', now()),
    -- Legacy NULL-tenant row to prove the pilot filter excludes NULL tenants.
    ('00000000-0000-0000-0000-00000000c999', 'EMPLOYEE', emp_a, NULL,
     'doc.expiry', 'LOW',      'legacy NULL-tenant alert',  'OPEN', DATE '2026-07-01', now())
  ON CONFLICT (id) DO NOTHING;
END $do$;

COMMIT;
