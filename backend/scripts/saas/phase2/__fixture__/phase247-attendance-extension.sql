-- =============================================================================
-- Phase 2.47 fixture extension — additive only.
-- =============================================================================
-- Extends the Phase 1 `attendance_records` table with the columns that
-- the real Prisma `AttendanceRecord` model declares (status, checkIn,
-- checkOut, breakIn, breakOut, workingHours, notes, createdById,
-- updatedById, updatedAt, tenantId).
--
-- Seeds rows for the same two tenants the rest of the Phase 2 fixtures
-- use, plus a single NULL-tenant legacy row to verify pilot-mode
-- exclusion. Idempotent — safe to re-run.
-- =============================================================================

ALTER TABLE attendance_records
  ADD COLUMN IF NOT EXISTS status        text NOT NULL DEFAULT 'PRESENT',
  ADD COLUMN IF NOT EXISTS "checkIn"     text,
  ADD COLUMN IF NOT EXISTS "checkOut"    text,
  ADD COLUMN IF NOT EXISTS "breakIn"     text,
  ADD COLUMN IF NOT EXISTS "breakOut"    text,
  ADD COLUMN IF NOT EXISTS "workingHours" double precision,
  ADD COLUMN IF NOT EXISTS notes         text,
  ADD COLUMN IF NOT EXISTS "createdById" uuid,
  ADD COLUMN IF NOT EXISTS "updatedById" uuid,
  ADD COLUMN IF NOT EXISTS "updatedAt"   timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS "tenantId"    text;

CREATE INDEX IF NOT EXISTS attendance_records_tenantId_idx
  ON attendance_records ("tenantId");

DO $$
DECLARE
  ta text;
  tb text;
  emp_a text;
  emp_b text;
BEGIN
  SELECT id::text INTO ta FROM tenants ORDER BY name LIMIT 1;
  SELECT id::text INTO tb FROM tenants ORDER BY name OFFSET 1 LIMIT 1;
  IF ta IS NULL OR tb IS NULL THEN RETURN; END IF;

  SELECT id::text INTO emp_a FROM employees WHERE "tenantId" = ta LIMIT 1;
  SELECT id::text INTO emp_b FROM employees WHERE "tenantId" = tb LIMIT 1;
  IF emp_a IS NULL OR emp_b IS NULL THEN RETURN; END IF;

  -- Tenant A — three rows in Jan 2025
  INSERT INTO attendance_records(id, "employeeId", date, status, "workingHours", "tenantId", "updatedAt")
    VALUES
      (gen_random_uuid()::text, emp_a, DATE '2025-01-06', 'PRESENT', 8.0, ta, now()),
      (gen_random_uuid()::text, emp_a, DATE '2025-01-07', 'PRESENT', 7.5, ta, now()),
      (gen_random_uuid()::text, emp_a, DATE '2025-01-08', 'ABSENT',  0.0, ta, now())
    ON CONFLICT ("employeeId", date) DO NOTHING;

  -- Tenant B — two rows in Jan 2025
  INSERT INTO attendance_records(id, "employeeId", date, status, "workingHours", "tenantId", "updatedAt")
    VALUES
      (gen_random_uuid()::text, emp_b, DATE '2025-01-06', 'PRESENT', 8.0, tb, now()),
      (gen_random_uuid()::text, emp_b, DATE '2025-01-07', 'SICK',    0.0, tb, now())
    ON CONFLICT ("employeeId", date) DO NOTHING;

  -- One NULL-tenant legacy row on tenant A's employee — must be
  -- excluded from pilot-mode reads.
  INSERT INTO attendance_records(id, "employeeId", date, status, "workingHours", "tenantId", "updatedAt")
    VALUES (gen_random_uuid()::text, emp_a, DATE '2024-12-31', 'PRESENT', 8.0, NULL, now())
    ON CONFLICT ("employeeId", date) DO NOTHING;
END $$;
