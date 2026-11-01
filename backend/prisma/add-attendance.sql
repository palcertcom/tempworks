-- Create AttendanceStatus enum
DO $$ BEGIN
  CREATE TYPE "AttendanceStatus" AS ENUM ('PRESENT', 'ABSENT', 'LATE', 'ON_LEAVE', 'HALF_DAY', 'HOLIDAY');
EXCEPTION WHEN duplicate_object THEN null;
END $$;

-- Create attendance_records table
CREATE TABLE IF NOT EXISTS "attendance_records" (
  "id"           TEXT NOT NULL,
  "employeeId"   TEXT NOT NULL,
  "date"         DATE NOT NULL,
  "status"       "AttendanceStatus" NOT NULL DEFAULT 'PRESENT',
  "checkIn"      TEXT,
  "checkOut"     TEXT,
  "workingHours" DOUBLE PRECISION,
  "notes"        TEXT,
  "createdById"  TEXT,
  "updatedById"  TEXT,
  "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "attendance_records_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "attendance_records_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "employees"("id") ON DELETE CASCADE,
  CONSTRAINT "attendance_records_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE SET NULL,
  CONSTRAINT "attendance_records_updatedById_fkey" FOREIGN KEY ("updatedById") REFERENCES "users"("id") ON DELETE SET NULL,
  CONSTRAINT "attendance_records_employeeId_date_key" UNIQUE ("employeeId", "date")
);

CREATE INDEX IF NOT EXISTS "attendance_records_employeeId_idx" ON "attendance_records"("employeeId");
CREATE INDEX IF NOT EXISTS "attendance_records_date_idx" ON "attendance_records"("date");
