-- Create IntervalMode enum if it doesn't exist
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_type WHERE typname = 'IntervalMode'
  ) THEN
    CREATE TYPE "IntervalMode" AS ENUM ('DAYS', 'KM', 'BOTH');
  END IF;
END $$;

-- Create maintenance_type table if it doesn't exist
CREATE TABLE IF NOT EXISTS "maintenance_type" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "name" TEXT NOT NULL,
  "description" TEXT,
  "defaultIntervalDays" INTEGER,
  "defaultIntervalKm" INTEGER,
  "intervalMode" "IntervalMode" DEFAULT 'KM',
  "isActive" BOOLEAN NOT NULL DEFAULT true,
  "deletedAt" TIMESTAMP(3),
  "deletedBy" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Create indexes for maintenance_type table
CREATE INDEX IF NOT EXISTS "maintenance_type_isActive_idx" ON "maintenance_type"("isActive");
CREATE INDEX IF NOT EXISTS "maintenance_type_deletedAt_idx" ON "maintenance_type"("deletedAt");
CREATE INDEX IF NOT EXISTS "maintenance_type_name_idx" ON "maintenance_type"("name");
