-- Phase 2.9 reverse migration. Idempotent.
BEGIN;
DROP INDEX IF EXISTS job_ads_tenantId_slug_idx;
DROP INDEX IF EXISTS job_ads_tenantId_idx;
ALTER TABLE job_ads DROP COLUMN IF EXISTS "tenantId";
COMMIT;
