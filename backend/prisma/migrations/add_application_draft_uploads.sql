-- application_drafts — add photo + documents columns so save-for-later
-- preserves file uploads across sessions. Idempotent.
ALTER TABLE "application_drafts"
  ADD COLUMN IF NOT EXISTS "photoUrl"  text;

ALTER TABLE "application_drafts"
  ADD COLUMN IF NOT EXISTS "documents" jsonb NOT NULL DEFAULT '[]'::jsonb;
