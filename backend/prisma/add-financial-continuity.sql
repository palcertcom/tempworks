-- ============================================================
-- Financial Continuity Migration
-- ============================================================
-- Ensures financial records remain connected to the same real
-- person across lifecycle conversions: Lead → Candidate → Employee.
--
-- CHANGES:
--   1. financial_records:
--        - applicantId TEXT  — stable reference to the originating
--                              applicant (survives conversion)
--        - stageAtCreation TEXT — lifecycle stage at record creation
--                                 ('LEAD' | 'CANDIDATE' | 'EMPLOYEE')
--   2. applicant_financial_profiles:
--        - employeeId TEXT UNIQUE — links the banking/salary profile
--                                   to the converted employee record
--
-- BACKFILL STRATEGY:
--   - Existing APPLICANT financial records: applicantId = entityId
--   - Existing EMPLOYEE financial records: resolve applicantId via
--     applicants.convertedToEmployeeId reverse lookup
--   - stageAtCreation: inferred from entityType for existing rows
--   - applicant_financial_profiles.employeeId: resolved via
--     applicants.convertedToEmployeeId for already-converted records
-- ============================================================

-- 1. Add applicantId to financial_records
ALTER TABLE financial_records
  ADD COLUMN IF NOT EXISTS "applicantId" TEXT;

-- 2. Add stageAtCreation to financial_records
ALTER TABLE financial_records
  ADD COLUMN IF NOT EXISTS "stageAtCreation" TEXT;

-- 3. Backfill applicantId for APPLICANT-type records
--    (entityId is already the applicant UUID)
UPDATE financial_records
SET "applicantId" = "entityId"
WHERE "entityType" = 'APPLICANT'
  AND "applicantId" IS NULL;

-- 4. Backfill applicantId for EMPLOYEE-type records
--    Find the original applicant that was converted to this employee
UPDATE financial_records fr
SET "applicantId" = a.id
FROM applicants a
WHERE fr."entityType" = 'EMPLOYEE'
  AND fr."entityId" = a."convertedToEmployeeId"
  AND fr."applicantId" IS NULL
  AND a."convertedToEmployeeId" IS NOT NULL;

-- 5. Backfill stageAtCreation from entityType for existing rows
--    APPLICANT records default to CANDIDATE (most financial records
--    are created at candidate stage; LEAD is set at creation time going forward)
UPDATE financial_records
SET "stageAtCreation" = CASE
  WHEN "entityType" = 'EMPLOYEE' THEN 'EMPLOYEE'
  ELSE 'CANDIDATE'
END
WHERE "stageAtCreation" IS NULL;

-- 6. Add indexes for performance
CREATE INDEX IF NOT EXISTS "financial_records_applicantId_idx"
  ON financial_records("applicantId");

CREATE INDEX IF NOT EXISTS "financial_records_stageAtCreation_idx"
  ON financial_records("stageAtCreation");

-- 7. Add employeeId to applicant_financial_profiles
ALTER TABLE applicant_financial_profiles
  ADD COLUMN IF NOT EXISTS "employeeId" TEXT UNIQUE;

-- 8. Backfill employeeId for profiles whose applicant was already converted
UPDATE applicant_financial_profiles afp
SET "employeeId" = a."convertedToEmployeeId"
FROM applicants a
WHERE afp."applicantId" = a.id
  AND a."convertedToEmployeeId" IS NOT NULL
  AND afp."employeeId" IS NULL;

-- 9. Add index for employeeId lookup
CREATE INDEX IF NOT EXISTS "applicant_financial_profiles_employeeId_idx"
  ON applicant_financial_profiles("employeeId");
