-- Add missing fields to notifications table if they don't exist
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT FROM information_schema.columns
    WHERE table_name = 'notifications' AND column_name = 'daysUntilDue'
  ) THEN
    ALTER TABLE "notifications" ADD COLUMN "daysUntilDue" INTEGER;
  END IF;

  IF NOT EXISTS (
    SELECT FROM information_schema.columns
    WHERE table_name = 'notifications' AND column_name = 'kmUntilDue'
  ) THEN
    ALTER TABLE "notifications" ADD COLUMN "kmUntilDue" INTEGER;
  END IF;

  IF NOT EXISTS (
    SELECT FROM information_schema.columns
    WHERE table_name = 'notifications' AND column_name = 'severity'
  ) THEN
    ALTER TABLE "notifications" ADD COLUMN "severity" TEXT DEFAULT 'MEDIUM';
  END IF;
END $$;

-- Create notification_preferences table with idempotent approach
CREATE TABLE IF NOT EXISTS "notification_preferences" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "userId" TEXT NOT NULL UNIQUE,
  "complianceDaysBefore" INTEGER NOT NULL DEFAULT 30,
  "serviceKmBefore" INTEGER NOT NULL DEFAULT 500,
  "enableEmailNotifications" BOOLEAN NOT NULL DEFAULT true,
  "enableInAppNotifications" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "notification_preferences_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users" ("id") ON DELETE CASCADE
);

-- Create index if not exists
CREATE INDEX IF NOT EXISTS "notification_preferences_userId_idx" ON "notification_preferences"("userId");
