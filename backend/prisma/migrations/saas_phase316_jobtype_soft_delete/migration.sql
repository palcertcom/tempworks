-- Phase 3.16 — JobType soft-delete columns + index.
-- Additive only. No data loss. Existing rows keep deletedAt = NULL.

ALTER TABLE "job_types"
  ADD COLUMN IF NOT EXISTS "deletedAt"      TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "deletedBy"      TEXT,
  ADD COLUMN IF NOT EXISTS "deletionReason" TEXT;

CREATE INDEX IF NOT EXISTS "job_types_deletedAt_idx" ON "job_types"("deletedAt");
