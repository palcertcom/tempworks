-- ============================================================
-- Migration: add_job_ads
-- Purpose:   Create the job_ads table for managing job
--            advertisements, and add job_ad_id FK to applicants
--            so applicants who apply from a listing are linked.
-- ============================================================

-- 1. Create job_ads table
CREATE TABLE IF NOT EXISTS "job_ads" (
  "id"           TEXT          NOT NULL DEFAULT gen_random_uuid()::text,
  "title"        TEXT          NOT NULL,
  "slug"         TEXT          NOT NULL,
  "category"     TEXT          NOT NULL,
  "description"  TEXT          NOT NULL,
  "city"         TEXT          NOT NULL,
  "country"      TEXT          NOT NULL,
  "contractType" TEXT          NOT NULL DEFAULT 'Full-time',
  "salaryMin"    NUMERIC(10,2),
  "salaryMax"    NUMERIC(10,2),
  "currency"     TEXT          NOT NULL DEFAULT 'GBP',
  "status"       TEXT          NOT NULL DEFAULT 'DRAFT',
  "publishedAt"  TIMESTAMP(3),
  "createdById"  TEXT,
  "createdAt"    TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"    TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "deletedAt"    TIMESTAMP(3),

  CONSTRAINT "job_ads_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "job_ads_slug_key" UNIQUE ("slug"),
  CONSTRAINT "job_ads_createdById_fkey"
    FOREIGN KEY ("createdById") REFERENCES "users"("id")
    ON DELETE SET NULL ON UPDATE CASCADE
);

-- 2. Indexes on job_ads
CREATE INDEX IF NOT EXISTS "job_ads_status_idx"    ON "job_ads"("status");
CREATE INDEX IF NOT EXISTS "job_ads_country_idx"   ON "job_ads"("country");
CREATE INDEX IF NOT EXISTS "job_ads_category_idx"  ON "job_ads"("category");

-- 3. Add job_ad_id FK column to applicants (nullable — survives lifecycle)
ALTER TABLE "applicants"
  ADD COLUMN IF NOT EXISTS "jobAdId" TEXT;

-- 4. Add FK constraint (separate step so it can be re-run safely)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'applicants_jobAdId_fkey'
      AND table_name = 'applicants'
  ) THEN
    ALTER TABLE "applicants"
      ADD CONSTRAINT "applicants_jobAdId_fkey"
      FOREIGN KEY ("jobAdId") REFERENCES "job_ads"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

-- 5. Index on the FK
CREATE INDEX IF NOT EXISTS "applicants_jobAdId_idx" ON "applicants"("jobAdId");
