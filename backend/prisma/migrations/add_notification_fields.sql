-- Add FINANCIAL value to NotificationType enum
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'FINANCIAL';

-- Add eventType and channel columns to notifications table
ALTER TABLE "notifications"
  ADD COLUMN IF NOT EXISTS "eventType" TEXT,
  ADD COLUMN IF NOT EXISTS "channel"   TEXT NOT NULL DEFAULT 'in_app';

-- Performance indexes
CREATE INDEX IF NOT EXISTS "notifications_userId_isRead_idx"   ON "notifications"("userId", "isRead");
CREATE INDEX IF NOT EXISTS "notifications_userId_eventType_idx" ON "notifications"("userId", "eventType");
CREATE INDEX IF NOT EXISTS "notifications_userId_type_idx"      ON "notifications"("userId", "type");
