-- =============================================================================
-- ProfileNotes — multi-note timeline on Employee / Applicant / Candidate
-- =============================================================================
-- Adds a polymorphic Note table (one row per note) plus a child Attachment
-- table. The existing free-text `notes` column on Employee/Applicant is
-- untouched and remains the canonical "single-line summary" field.
-- =============================================================================

-- Enums --------------------------------------------------------------------

DO $$ BEGIN
  CREATE TYPE "ProfileNoteOwner" AS ENUM ('EMPLOYEE', 'APPLICANT', 'CANDIDATE');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "ProfileNoteCategory" AS ENUM (
    'HR', 'PERFORMANCE', 'WARNING', 'ATTENDANCE', 'PAYROLL',
    'VEHICLE', 'GENERAL', 'RECRUITMENT', 'MEDICAL', 'LEGAL'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "ProfileNotePriority" AS ENUM ('LOW', 'MEDIUM', 'HIGH', 'CRITICAL');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "ProfileNoteStatus" AS ENUM ('OPEN', 'IN_PROGRESS', 'RESOLVED', 'CLOSED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- profile_notes ------------------------------------------------------------

CREATE TABLE IF NOT EXISTS "profile_notes" (
  "id"          TEXT NOT NULL PRIMARY KEY,
  "ownerType"   "ProfileNoteOwner"   NOT NULL,
  "ownerId"     TEXT                 NOT NULL,
  "text"        TEXT                 NOT NULL,
  "category"    "ProfileNoteCategory" NOT NULL DEFAULT 'GENERAL',
  "priority"    "ProfileNotePriority" NOT NULL DEFAULT 'MEDIUM',
  "status"      "ProfileNoteStatus"   NOT NULL DEFAULT 'OPEN',
  "tenantId"    TEXT,
  "createdById" TEXT NOT NULL,
  "updatedById" TEXT,
  "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"   TIMESTAMP(3) NOT NULL,
  "deletedAt"   TIMESTAMP(3),

  CONSTRAINT "profile_notes_createdById_fkey"
    FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE RESTRICT,
  CONSTRAINT "profile_notes_updatedById_fkey"
    FOREIGN KEY ("updatedById") REFERENCES "users"("id") ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS "profile_notes_ownerType_ownerId_idx" ON "profile_notes"("ownerType", "ownerId");
CREATE INDEX IF NOT EXISTS "profile_notes_tenantId_idx"          ON "profile_notes"("tenantId");
CREATE INDEX IF NOT EXISTS "profile_notes_category_idx"          ON "profile_notes"("category");
CREATE INDEX IF NOT EXISTS "profile_notes_priority_idx"          ON "profile_notes"("priority");
CREATE INDEX IF NOT EXISTS "profile_notes_status_idx"            ON "profile_notes"("status");

-- profile_note_attachments -------------------------------------------------

CREATE TABLE IF NOT EXISTS "profile_note_attachments" (
  "id"        TEXT NOT NULL PRIMARY KEY,
  "noteId"    TEXT NOT NULL,
  "fileUrl"   TEXT NOT NULL,
  "fileName"  TEXT NOT NULL,
  "fileSize"  INTEGER NOT NULL,
  "mimeType"  TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "profile_note_attachments_noteId_fkey"
    FOREIGN KEY ("noteId") REFERENCES "profile_notes"("id") ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS "profile_note_attachments_noteId_idx" ON "profile_note_attachments"("noteId");
