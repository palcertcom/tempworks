-- ============================================================
-- Migration: add_job_ads_required_documents
-- Purpose:   Add requiredDocuments column to job_ads table.
--            Stored as a JSON-encoded array of document type
--            names (e.g. '["Passport","CV"]').
--            Nullable — only populated when HR selects
--            mandatory documents for the job ad.
-- Safe to re-run (IF NOT EXISTS guards).
-- ============================================================

ALTER TABLE "job_ads"
  ADD COLUMN IF NOT EXISTS "requiredDocuments" TEXT;
