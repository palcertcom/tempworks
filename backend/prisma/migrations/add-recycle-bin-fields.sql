-- =============================================================================
-- Migration: add-recycle-bin-fields
-- Adds deletedBy (actor FK as text) and deletionReason to all soft-deletable
-- entities.  Also adds soft-delete support to document_types which lacked it.
-- All statements are idempotent (IF NOT EXISTS / DO $$ blocks).
-- =============================================================================

-- ── users ─────────────────────────────────────────────────────────────────────
ALTER TABLE users ADD COLUMN IF NOT EXISTS "deletedBy"       TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS "deletionReason"  TEXT;

-- ── agencies ──────────────────────────────────────────────────────────────────
ALTER TABLE agencies ADD COLUMN IF NOT EXISTS "deletedBy"       TEXT;
ALTER TABLE agencies ADD COLUMN IF NOT EXISTS "deletionReason"  TEXT;

-- ── employees ─────────────────────────────────────────────────────────────────
ALTER TABLE employees ADD COLUMN IF NOT EXISTS "deletedBy"       TEXT;
ALTER TABLE employees ADD COLUMN IF NOT EXISTS "deletionReason"  TEXT;

-- ── applicants ────────────────────────────────────────────────────────────────
ALTER TABLE applicants ADD COLUMN IF NOT EXISTS "deletedBy"       TEXT;
ALTER TABLE applicants ADD COLUMN IF NOT EXISTS "deletionReason"  TEXT;

-- ── documents ─────────────────────────────────────────────────────────────────
ALTER TABLE documents ADD COLUMN IF NOT EXISTS "deletedBy"       TEXT;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS "deletionReason"  TEXT;

-- ── roles ─────────────────────────────────────────────────────────────────────
ALTER TABLE roles ADD COLUMN IF NOT EXISTS "deletedBy"       TEXT;
ALTER TABLE roles ADD COLUMN IF NOT EXISTS "deletionReason"  TEXT;

-- ── job_ads ───────────────────────────────────────────────────────────────────
ALTER TABLE job_ads ADD COLUMN IF NOT EXISTS "deletedBy"       TEXT;
ALTER TABLE job_ads ADD COLUMN IF NOT EXISTS "deletionReason"  TEXT;

-- ── financial_records ─────────────────────────────────────────────────────────
ALTER TABLE financial_records ADD COLUMN IF NOT EXISTS "deletedBy"       TEXT;
ALTER TABLE financial_records ADD COLUMN IF NOT EXISTS "deletionReason"  TEXT;

-- ── financial_record_attachments ──────────────────────────────────────────────
ALTER TABLE financial_record_attachments ADD COLUMN IF NOT EXISTS "deletedBy"       TEXT;
ALTER TABLE financial_record_attachments ADD COLUMN IF NOT EXISTS "deletionReason"  TEXT;

-- ── notifications ─────────────────────────────────────────────────────────────
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS "deletedBy"       TEXT;
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS "deletionReason"  TEXT;

-- ── notification_rules ────────────────────────────────────────────────────────
ALTER TABLE notification_rules ADD COLUMN IF NOT EXISTS "deletedBy"       TEXT;
ALTER TABLE notification_rules ADD COLUMN IF NOT EXISTS "deletionReason"  TEXT;

-- ── reports ───────────────────────────────────────────────────────────────────
ALTER TABLE reports ADD COLUMN IF NOT EXISTS "deletedBy"       TEXT;
ALTER TABLE reports ADD COLUMN IF NOT EXISTS "deletionReason"  TEXT;

-- ── document_types (add full soft-delete support) ─────────────────────────────
ALTER TABLE document_types ADD COLUMN IF NOT EXISTS "deletedAt"      TIMESTAMP;
ALTER TABLE document_types ADD COLUMN IF NOT EXISTS "deletedBy"      TEXT;
ALTER TABLE document_types ADD COLUMN IF NOT EXISTS "deletionReason" TEXT;

-- ── audit_logs (add deletedBy for completeness) ───────────────────────────────
ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS "deletedBy"       TEXT;
ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS "deletionReason"  TEXT;

-- ── Performance: index deletedAt on high-volume tables ────────────────────────
CREATE INDEX IF NOT EXISTS idx_applicants_deleted_at
  ON applicants ("deletedAt") WHERE "deletedAt" IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_employees_deleted_at
  ON employees ("deletedAt") WHERE "deletedAt" IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_documents_deleted_at
  ON documents ("deletedAt") WHERE "deletedAt" IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_users_deleted_at
  ON users ("deletedAt") WHERE "deletedAt" IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_financial_records_deleted_at
  ON financial_records ("deletedAt") WHERE "deletedAt" IS NOT NULL;
