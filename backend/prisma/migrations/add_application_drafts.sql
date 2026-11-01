-- ApplicationDraft — one open draft per user. When submitted, the
-- draft is consumed (Applicant created + row deleted). Idempotent.

CREATE TABLE IF NOT EXISTS "application_drafts" (
  id            text        PRIMARY KEY,
  "createdById" text        NOT NULL UNIQUE,
  "jobAdId"     text,
  "formData"    jsonb       NOT NULL DEFAULT '{}'::jsonb,
  "createdAt"   timestamptz NOT NULL DEFAULT now(),
  "updatedAt"   timestamptz NOT NULL DEFAULT now()
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'application_drafts_createdById_fkey'
  ) THEN
    ALTER TABLE "application_drafts"
      ADD CONSTRAINT application_drafts_createdById_fkey
      FOREIGN KEY ("createdById") REFERENCES users(id) ON DELETE CASCADE;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS application_drafts_jobAdId_idx
  ON "application_drafts"("jobAdId");
