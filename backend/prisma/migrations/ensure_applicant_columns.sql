-- Ensure all Applicant columns exist that match the current Prisma schema.
-- All operations are idempotent (IF NOT EXISTS).
-- Run with: npm run db:migrate:ensure-applicant-columns

-- Core identity
ALTER TABLE applicants ADD COLUMN IF NOT EXISTS "tier"                    TEXT NOT NULL DEFAULT 'LEAD';
ALTER TABLE applicants ADD COLUMN IF NOT EXISTS "middleName"              TEXT;
ALTER TABLE applicants ADD COLUMN IF NOT EXISTS "nationality"             TEXT;
ALTER TABLE applicants ADD COLUMN IF NOT EXISTS "citizenship"             TEXT;
ALTER TABLE applicants ADD COLUMN IF NOT EXISTS "gender"                  TEXT;
ALTER TABLE applicants ADD COLUMN IF NOT EXISTS "dateOfBirth"             TIMESTAMP(3);
ALTER TABLE applicants ADD COLUMN IF NOT EXISTS "countryOfBirth"          TEXT;
ALTER TABLE applicants ADD COLUMN IF NOT EXISTS "cityOfBirth"             TEXT;
ALTER TABLE applicants ADD COLUMN IF NOT EXISTS "photoUrl"                TEXT;
ALTER TABLE applicants ADD COLUMN IF NOT EXISTS "hasDrivingLicense"       BOOLEAN NOT NULL DEFAULT FALSE;

-- Status & assignment
ALTER TABLE applicants ADD COLUMN IF NOT EXISTS "jobTypeId"               TEXT;
ALTER TABLE applicants ADD COLUMN IF NOT EXISTS "agencyId"                TEXT;

-- Legacy flat fields
ALTER TABLE applicants ADD COLUMN IF NOT EXISTS "residencyStatus"         TEXT;
ALTER TABLE applicants ADD COLUMN IF NOT EXISTS "hasNationalInsurance"    BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE applicants ADD COLUMN IF NOT EXISTS "nationalInsuranceNumber" TEXT;
ALTER TABLE applicants ADD COLUMN IF NOT EXISTS "hasWorkAuthorization"    BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE applicants ADD COLUMN IF NOT EXISTS "workAuthorizationType"   TEXT;
ALTER TABLE applicants ADD COLUMN IF NOT EXISTS "workAuthorizationExpiry" TIMESTAMP(3);
ALTER TABLE applicants ADD COLUMN IF NOT EXISTS "preferredStartDate"      TIMESTAMP(3);
ALTER TABLE applicants ADD COLUMN IF NOT EXISTS "availability"            TEXT;
ALTER TABLE applicants ADD COLUMN IF NOT EXISTS "willingToRelocate"       BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE applicants ADD COLUMN IF NOT EXISTS "preferredLocations"      TEXT;
ALTER TABLE applicants ADD COLUMN IF NOT EXISTS "salaryExpectation"       TEXT;
ALTER TABLE applicants ADD COLUMN IF NOT EXISTS "notes"                   TEXT;

-- Lifecycle identifiers
ALTER TABLE applicants ADD COLUMN IF NOT EXISTS "leadNumber"              TEXT;
ALTER TABLE applicants ADD COLUMN IF NOT EXISTS "candidateNumber"         TEXT;
ALTER TABLE applicants ADD COLUMN IF NOT EXISTS "candidateConvertedAt"    TIMESTAMP(3);
ALTER TABLE applicants ADD COLUMN IF NOT EXISTS "employeeConvertedAt"     TIMESTAMP(3);

-- Application data + employee linkage
ALTER TABLE applicants ADD COLUMN IF NOT EXISTS "applicationData"         JSONB;
ALTER TABLE applicants ADD COLUMN IF NOT EXISTS "convertedToEmployeeId"   TEXT;

-- Creation attribution
ALTER TABLE applicants ADD COLUMN IF NOT EXISTS "createdById"             TEXT;
ALTER TABLE applicants ADD COLUMN IF NOT EXISTS "source"                  TEXT NOT NULL DEFAULT 'STAFF_CREATED';

-- Soft delete
ALTER TABLE applicants ADD COLUMN IF NOT EXISTS "deletedAt"               TIMESTAMP(3);
ALTER TABLE applicants ADD COLUMN IF NOT EXISTS "deletedBy"               TEXT;
ALTER TABLE applicants ADD COLUMN IF NOT EXISTS "deletionReason"          TEXT;

-- Workflow
ALTER TABLE applicants ADD COLUMN IF NOT EXISTS "currentWorkflowStageId"  TEXT;

-- Job Ad linkage
ALTER TABLE applicants ADD COLUMN IF NOT EXISTS "jobAdId"                 TEXT;

-- Tempworks-approval gate (agency-submitted applicants)
ALTER TABLE applicants ADD COLUMN IF NOT EXISTS "approvalStatus"          TEXT NOT NULL DEFAULT 'APPROVED';
ALTER TABLE applicants ADD COLUMN IF NOT EXISTS "approvedById"            TEXT;
ALTER TABLE applicants ADD COLUMN IF NOT EXISTS "approvedAt"              TIMESTAMP(3);
ALTER TABLE applicants ADD COLUMN IF NOT EXISTS "rejectionReason"         TEXT;
