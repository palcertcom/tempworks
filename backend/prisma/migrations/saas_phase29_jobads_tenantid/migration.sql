-- =============================================================================
-- Phase 2.9 — Job Ads tenantId denormalisation
-- =============================================================================
-- ADDITIVE ONLY. Adds nullable `tenantId` column + tenant-leading indexes
-- to job_ads. The existing global `slug @unique` constraint is
-- preserved exactly — public URLs continue to work byte-for-byte.
-- A future Phase 3 migration will replace the global unique with a
-- composite `(tenantId, slug)` once every existing public URL is
-- reconciled.
--
-- Reversible via `migration.down.sql`. Idempotent.
-- =============================================================================

BEGIN;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname='public' AND tablename='job_ads') THEN
    EXECUTE 'ALTER TABLE job_ads ADD COLUMN IF NOT EXISTS "tenantId" TEXT';
    EXECUTE 'CREATE INDEX IF NOT EXISTS job_ads_tenantId_idx ON job_ads("tenantId")';
    EXECUTE 'CREATE INDEX IF NOT EXISTS job_ads_tenantId_slug_idx ON job_ads("tenantId", slug)';
  ELSE
    RAISE NOTICE '[saas_phase29_jobads_tenantid] table job_ads not present — skipped';
  END IF;
END $$;

COMMIT;
