-- ============================================================
-- Migration: add_lifecycle_identifiers
-- Purpose:   Introduce lifecycle identifiers for Applicant records:
--              A[YYYY][MM][SSSSS] for Leads
--              C[YYYY][MM][SSSSS] for Candidates
--              E[YYYY][MM][SSSSS] for Employees
--            Serial resets monthly per prefix (A, C, E independently).
--            Concurrency safety is achieved via the identifier_sequences
--            table with an atomic INSERT … ON CONFLICT DO UPDATE.
-- ============================================================

-- 1. Concurrency-safe serial counter table.
--    One row per (prefix, year, month) combination.
--    The "current" column is atomically incremented on every ID claim.
CREATE TABLE IF NOT EXISTS "identifier_sequences" (
  "id"      TEXT    NOT NULL DEFAULT gen_random_uuid()::text,
  "prefix"  TEXT    NOT NULL,
  "year"    INTEGER NOT NULL,
  "month"   INTEGER NOT NULL,
  "current" INTEGER NOT NULL DEFAULT 0,
  CONSTRAINT "identifier_sequences_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "identifier_sequences_prefix_year_month_key"
    UNIQUE ("prefix", "year", "month")
);

-- 2. New lifecycle identifier columns on applicants.
ALTER TABLE "applicants"
  ADD COLUMN IF NOT EXISTS "leadNumber"           TEXT,
  ADD COLUMN IF NOT EXISTS "candidateNumber"      TEXT,
  ADD COLUMN IF NOT EXISTS "candidateConvertedAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "employeeConvertedAt"  TIMESTAMP(3);

-- Partial unique indexes so NULL values are allowed (old records without IDs).
CREATE UNIQUE INDEX IF NOT EXISTS "applicants_leadNumber_key"
  ON "applicants"("leadNumber") WHERE "leadNumber" IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS "applicants_candidateNumber_key"
  ON "applicants"("candidateNumber") WHERE "candidateNumber" IS NOT NULL;

-- 3. Traceability columns on employees so prior-stage IDs are visible
--    even after the applicant record is soft-deleted.
ALTER TABLE "employees"
  ADD COLUMN IF NOT EXISTS "leadNumber"           TEXT,
  ADD COLUMN IF NOT EXISTS "candidateNumber"      TEXT,
  ADD COLUMN IF NOT EXISTS "candidateConvertedAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "employeeConvertedAt"  TIMESTAMP(3);

-- 4. Back-fill strategy for existing records:
--    We deliberately do NOT auto-assign IDs to existing rows.
--    Existing applicants will show "Legacy" in the UI until they are
--    re-converted or until an admin-triggered backfill is run.
--    A separate backfill script can populate these values non-destructively.
