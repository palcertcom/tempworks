-- =============================================================================
-- Phase 2.9 fixture extension — additive only.
-- =============================================================================
-- Adds the columns Prisma's JobAd model expects but the staging fixture's
-- narrow `job_ads` table didn't materialise, then seeds two-tenant job
-- ads so the isolation harness can exercise cross-tenant collisions.
--
-- Idempotent. Safe to re-run. Production already has these columns.
-- =============================================================================

BEGIN;

ALTER TABLE job_ads ADD COLUMN IF NOT EXISTS category          text NOT NULL DEFAULT 'general';
ALTER TABLE job_ads ADD COLUMN IF NOT EXISTS description       text NOT NULL DEFAULT '';
ALTER TABLE job_ads ADD COLUMN IF NOT EXISTS city              text NOT NULL DEFAULT 'fixture';
ALTER TABLE job_ads ADD COLUMN IF NOT EXISTS country           text NOT NULL DEFAULT 'GB';
ALTER TABLE job_ads ADD COLUMN IF NOT EXISTS "contractType"    text NOT NULL DEFAULT 'Full-time';
ALTER TABLE job_ads ADD COLUMN IF NOT EXISTS "salaryMin"       numeric(10,2);
ALTER TABLE job_ads ADD COLUMN IF NOT EXISTS "salaryMax"       numeric(10,2);
ALTER TABLE job_ads ADD COLUMN IF NOT EXISTS currency          text NOT NULL DEFAULT 'GBP';
ALTER TABLE job_ads ADD COLUMN IF NOT EXISTS "publishedAt"     timestamptz;
ALTER TABLE job_ads ADD COLUMN IF NOT EXISTS "requiredDocuments" text;
ALTER TABLE job_ads ADD COLUMN IF NOT EXISTS "createdById"     uuid;
ALTER TABLE job_ads ADD COLUMN IF NOT EXISTS "updatedAt"       timestamptz NOT NULL DEFAULT now();
ALTER TABLE job_ads ADD COLUMN IF NOT EXISTS "deletedAt"       timestamptz;
ALTER TABLE job_ads ADD COLUMN IF NOT EXISTS "deletedBy"       uuid;
ALTER TABLE job_ads ADD COLUMN IF NOT EXISTS "deletionReason"  text;

-- Prisma's JobAd has a `applicants Applicant[]` relation through
-- Applicant.jobAdId. The fixture's `applicants` table is narrow.
ALTER TABLE applicants ADD COLUMN IF NOT EXISTS "jobAdId" uuid;

DO $do$
DECLARE
  ta uuid;
  tb uuid;
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
  IF ta IS NULL OR tb IS NULL THEN
    RAISE NOTICE '[phase29-jobads-extension] need 2 tenants with employees; got ta=%, tb=%', ta, tb;
    RETURN;
  END IF;

  -- Two same-shape ads — one per tenant. Note: slug is GLOBALLY unique
  -- in the current schema (Phase 3 will swap to per-tenant unique).
  -- Both ads here have distinct slugs to avoid violating the existing
  -- constraint while still exercising the tenant filter.
  INSERT INTO job_ads(id, slug, title, status, "tenantId", category, description, city, country, "contractType", currency, "publishedAt")
  VALUES
    ('00000000-0000-0000-0000-0000000a0001', 'engineer-acme',  'Engineer (Acme)',  'PUBLISHED', ta::text, 'engineering', 'A description', 'London',  'GB', 'Full-time', 'GBP', now()),
    ('00000000-0000-0000-0000-0000000a0002', 'engineer-globex','Engineer (Globex)','PUBLISHED', tb::text, 'engineering', 'B description', 'Berlin',  'DE', 'Full-time', 'EUR', now()),
    ('00000000-0000-0000-0000-0000000a0003', 'driver-acme',    'Driver (Acme)',    'DRAFT',     ta::text, 'logistics',   'A driver',      'Bristol', 'GB', 'Part-time', 'GBP', NULL),
    ('00000000-0000-0000-0000-0000000a0004', 'driver-globex',  'Driver (Globex)',  'PUBLISHED', tb::text, 'logistics',   'B driver',      'Munich',  'DE', 'Part-time', 'EUR', now()),
    ('00000000-0000-0000-0000-0000000a0999', 'legacy-null',    'Legacy NULL ad',   'PUBLISHED', NULL,     'general',     'pre-Phase-2.9 row', 'Nowhere', 'GB', 'Full-time', 'GBP', now())
  ON CONFLICT (id) DO NOTHING;
END $do$;

COMMIT;
