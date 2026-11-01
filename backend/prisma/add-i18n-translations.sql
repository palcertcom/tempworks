-- Phase 4: per-locale translation overrides on user-editable label tables.
-- All columns are nullable JSONB; no data backfill needed.
-- Shape: { "<locale>": { "name": "...", "description": "..." } }

ALTER TABLE "document_types"   ADD COLUMN IF NOT EXISTS "translations" JSONB;
ALTER TABLE "job_types"        ADD COLUMN IF NOT EXISTS "translations" JSONB;
ALTER TABLE "workflow_stages"  ADD COLUMN IF NOT EXISTS "translations" JSONB;
