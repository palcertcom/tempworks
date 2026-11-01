-- Migration: Add missing applicant columns
-- Adds columns present in Prisma schema but not yet in the database.
-- All operations are idempotent (IF NOT EXISTS).

ALTER TABLE applicants ADD COLUMN IF NOT EXISTS "willingToRelocate"    BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE applicants ADD COLUMN IF NOT EXISTS "preferredLocations"   TEXT;
ALTER TABLE applicants ADD COLUMN IF NOT EXISTS "salaryExpectation"    TEXT;
ALTER TABLE applicants ADD COLUMN IF NOT EXISTS "agencyId"             TEXT;
ALTER TABLE applicants ADD COLUMN IF NOT EXISTS "currentWorkflowStageId" TEXT;
