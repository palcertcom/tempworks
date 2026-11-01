-- Add enhanced fields to maintenance_records table for driver tracking, drop-off/pick-up, and approvals
-- Uses camelCase column names with double quotes to match codebase convention
--
-- Key columns are TEXT, not UUID: users.id and maintenance_records.id are
-- Prisma `String` ids (TEXT in PostgreSQL). The previous UUID declarations made
-- every FOREIGN KEY fail with "incompatible types: uuid and text", and because
-- the file runs as one implicit transaction NONE of these objects were ever
-- created. Every statement is idempotent (IF NOT EXISTS), so re-running on a
-- database where some objects already exist is a no-op for those objects.

ALTER TABLE maintenance_records ADD COLUMN IF NOT EXISTS "driverId"                  TEXT REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE maintenance_records ADD COLUMN IF NOT EXISTS "driverNameOverride"        TEXT;
ALTER TABLE maintenance_records ADD COLUMN IF NOT EXISTS "dropOffDriverId"           TEXT REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE maintenance_records ADD COLUMN IF NOT EXISTS "dropOffDriverNameOverride" TEXT;
ALTER TABLE maintenance_records ADD COLUMN IF NOT EXISTS "dropOffDateTime"           TIMESTAMP(3);
ALTER TABLE maintenance_records ADD COLUMN IF NOT EXISTS "pickUpDriverId"            TEXT REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE maintenance_records ADD COLUMN IF NOT EXISTS "pickUpDriverNameOverride"  TEXT;
ALTER TABLE maintenance_records ADD COLUMN IF NOT EXISTS "pickUpDateTime"            TIMESTAMP(3);
ALTER TABLE maintenance_records ADD COLUMN IF NOT EXISTS "approvedById"              TEXT REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE maintenance_records ADD COLUMN IF NOT EXISTS "approvedAt"                TIMESTAMP(3);
ALTER TABLE maintenance_records ADD COLUMN IF NOT EXISTS "workDescription"           TEXT;

-- Indexes for query performance
CREATE INDEX IF NOT EXISTS "maintenance_records_driverId_idx"        ON maintenance_records("driverId");
CREATE INDEX IF NOT EXISTS "maintenance_records_dropOffDriverId_idx" ON maintenance_records("dropOffDriverId");
CREATE INDEX IF NOT EXISTS "maintenance_records_pickUpDriverId_idx"  ON maintenance_records("pickUpDriverId");
CREATE INDEX IF NOT EXISTS "maintenance_records_approvedById_idx"    ON maintenance_records("approvedById");
CREATE INDEX IF NOT EXISTS "maintenance_records_completedDate_idx"   ON maintenance_records("completedDate" DESC);

-- Create maintenance_record_attachments table if it doesn't exist
CREATE TABLE IF NOT EXISTS maintenance_record_attachments (
  "id"                  TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  "maintenanceRecordId" TEXT NOT NULL REFERENCES maintenance_records(id) ON DELETE CASCADE,
  "name"                TEXT NOT NULL,
  "fileUrl"             TEXT,
  "fileName"            TEXT,
  "fileSize"            INTEGER,
  "mimeType"            TEXT,
  "documentType"        TEXT,
  "uploadedById"        TEXT REFERENCES users(id) ON DELETE SET NULL,
  "createdAt"           TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "deletedAt"           TIMESTAMP(3)
);

CREATE INDEX IF NOT EXISTS "maintenance_record_attachments_maintenanceRecordId_idx"
  ON maintenance_record_attachments("maintenanceRecordId");
