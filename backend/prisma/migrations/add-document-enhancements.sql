-- ============================================================
-- Document Management Enhancement Migration
-- Adds: business docId, rejectionReason, issueCountry,
--       renewedFromId, DocumentType.code,
--       DocumentTypePermission table, and indexes.
-- All statements are idempotent (IF NOT EXISTS / DO NOTHING).
-- ============================================================

-- 1. Add `code` to document_types (short type code, e.g. PASS, VISA)
ALTER TABLE document_types ADD COLUMN IF NOT EXISTS code TEXT;

-- 2. Add new fields to documents
ALTER TABLE documents ADD COLUMN IF NOT EXISTS "docId"          TEXT;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS "rejectionReason" TEXT;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS "issueCountry"   TEXT;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS "renewedFromId"  TEXT;

-- 3. Unique constraint on docId (allow NULLs – old docs won't have one)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'documents_docId_unique'
  ) THEN
    CREATE UNIQUE INDEX documents_docId_unique
      ON documents ("docId")
      WHERE "docId" IS NOT NULL;
  END IF;
END$$;

-- 4. FK: renewedFromId → documents.id
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'documents_renewedFromId_fkey'
  ) THEN
    ALTER TABLE documents
      ADD CONSTRAINT "documents_renewedFromId_fkey"
      FOREIGN KEY ("renewedFromId") REFERENCES documents(id)
      ON DELETE SET NULL;
  END IF;
END$$;

-- 5. DocumentTypePermission table
CREATE TABLE IF NOT EXISTS document_type_permissions (
  id                TEXT        PRIMARY KEY DEFAULT gen_random_uuid()::TEXT,
  "documentTypeId"  TEXT        NOT NULL REFERENCES document_types(id) ON DELETE CASCADE,
  "roleId"          TEXT        NOT NULL REFERENCES roles(id)          ON DELETE CASCADE,
  "canUpload"       BOOLEAN     NOT NULL DEFAULT TRUE,
  "canView"         BOOLEAN     NOT NULL DEFAULT TRUE,
  "canEdit"         BOOLEAN     NOT NULL DEFAULT FALSE,
  "canDelete"       BOOLEAN     NOT NULL DEFAULT FALSE,
  "canRenew"        BOOLEAN     NOT NULL DEFAULT FALSE,
  "createdAt"       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updatedAt"       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE ("documentTypeId", "roleId")
);

-- 6. Performance indexes
CREATE INDEX IF NOT EXISTS idx_documents_entity
  ON documents ("entityType", "entityId");

CREATE INDEX IF NOT EXISTS idx_documents_status
  ON documents (status) WHERE "deletedAt" IS NULL;

CREATE INDEX IF NOT EXISTS idx_documents_type
  ON documents ("documentTypeId") WHERE "deletedAt" IS NULL;

CREATE INDEX IF NOT EXISTS idx_documents_expiry
  ON documents ("expiryDate") WHERE "deletedAt" IS NULL;

CREATE INDEX IF NOT EXISTS idx_documents_issue_date
  ON documents ("issueDate") WHERE "deletedAt" IS NULL;

CREATE INDEX IF NOT EXISTS idx_documents_created
  ON documents ("createdAt");
