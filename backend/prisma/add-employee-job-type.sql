-- Add jobTypeId column to employees table and link to job_types
ALTER TABLE "employees"
  ADD COLUMN IF NOT EXISTS "jobTypeId" TEXT;

ALTER TABLE "employees"
  DROP CONSTRAINT IF EXISTS "employees_jobTypeId_fkey";

ALTER TABLE "employees"
  ADD CONSTRAINT "employees_jobTypeId_fkey"
    FOREIGN KEY ("jobTypeId") REFERENCES "job_types"("id") ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS "employees_jobTypeId_idx" ON "employees"("jobTypeId");
