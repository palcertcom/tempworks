-- Create system_backups table for database backup metadata registry
CREATE TABLE IF NOT EXISTS "system_backups" (
  "id"           TEXT        NOT NULL PRIMARY KEY,
  "fileName"     TEXT        NOT NULL,
  "filePath"     TEXT        NOT NULL,
  "fileSize"     BIGINT,
  "backupType"   TEXT        NOT NULL DEFAULT 'FULL',
  "status"       TEXT        NOT NULL DEFAULT 'PENDING',
  "notes"        TEXT,
  "errorMessage" TEXT,
  "metadata"     JSONB,
  "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "completedAt"  TIMESTAMP(3),
  "createdById"  TEXT,
  CONSTRAINT "system_backups_createdById_fkey"
    FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS "system_backups_status_idx"  ON "system_backups"("status");
CREATE INDEX IF NOT EXISTS "system_backups_createdAt_idx" ON "system_backups"("createdAt");
