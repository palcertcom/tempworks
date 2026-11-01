-- Migration: Add ApplicantTier enum, tier field, financial profile, agency history, employee number
-- Run with: psql $DATABASE_URL -f this_file.sql
-- Or integrate into Prisma migrations.

-- 1. Enum for applicant tier
DO $$ BEGIN
  CREATE TYPE "ApplicantTier" AS ENUM ('LEAD', 'CANDIDATE');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- 2. Add tier + convertedToEmployeeId columns to applicants
ALTER TABLE applicants ADD COLUMN IF NOT EXISTS tier "ApplicantTier" NOT NULL DEFAULT 'LEAD';
ALTER TABLE applicants ADD COLUMN IF NOT EXISTS "convertedToEmployeeId" TEXT;

-- 3. Add employeeNumber to employees
ALTER TABLE employees ADD COLUMN IF NOT EXISTS "employeeNumber" TEXT UNIQUE;

-- 4. Financial profiles table
CREATE TABLE IF NOT EXISTS applicant_financial_profiles (
  id               TEXT        NOT NULL PRIMARY KEY,
  "applicantId"    TEXT        NOT NULL UNIQUE,
  "bankName"       TEXT,
  "accountHolder"  TEXT,
  "accountNumber"  TEXT,
  "sortCode"       TEXT,
  iban             TEXT,
  "bankAddress"    TEXT,
  "taxCode"        TEXT,
  "niNumber"       TEXT,
  "paymentMethod"  TEXT,
  "salaryAgreed"   NUMERIC(10,2),
  currency         TEXT        NOT NULL DEFAULT 'GBP',
  notes            TEXT,
  "createdAt"      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updatedAt"      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT fk_financial_applicant FOREIGN KEY ("applicantId") REFERENCES applicants(id) ON DELETE CASCADE
);

-- 5. Agency history table
CREATE TABLE IF NOT EXISTS applicant_agency_history (
  id              TEXT        NOT NULL PRIMARY KEY,
  "applicantId"   TEXT        NOT NULL,
  "agencyId"      TEXT,
  "agencyName"    TEXT        NOT NULL,
  "assignedAt"    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "removedAt"     TIMESTAMPTZ,
  "assignedById"  TEXT,
  reason          TEXT,
  notes           TEXT,
  CONSTRAINT fk_history_applicant FOREIGN KEY ("applicantId") REFERENCES applicants(id) ON DELETE CASCADE
);

-- 6. New permissions (idempotent)
INSERT INTO permissions (id, name, module, action, "createdAt")
SELECT gen_random_uuid()::text, name, module, action, NOW()
FROM (VALUES
  ('applicants:convert_lead',    'applicants', 'convert_lead'),
  ('applicants:reassign_agency', 'applicants', 'reassign_agency'),
  ('applicants:view_financial',  'applicants', 'view_financial'),
  ('applicants:manage_financial','applicants', 'manage_financial'),
  ('applicants:export',          'applicants', 'export'),
  ('applicants:bulk_status',     'applicants', 'bulk_status')
) AS t(name, module, action)
WHERE NOT EXISTS (SELECT 1 FROM permissions p WHERE p.name = t.name);
