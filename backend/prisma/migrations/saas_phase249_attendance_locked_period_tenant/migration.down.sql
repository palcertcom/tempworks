-- =============================================================================
-- SaaS Phase 2.49 — DOWN migration
-- =============================================================================
-- Restores the pre-2.49 schema for `attendance_locked_periods`.
-- Safe ONLY when no per-tenant lock rows exist (tenantId IS NOT NULL).
-- Production rollback: deactivate the pilot first
-- (TENANT_PRISMA_PILOT_ENABLED=false) so no new tenant-tagged rows
-- are written, manually drop them or null-tag them, then run this
-- script.
-- =============================================================================

BEGIN;

DROP INDEX IF EXISTS "attendance_locked_periods_global_year_month_uq";

ALTER TABLE "attendance_locked_periods"
  DROP CONSTRAINT IF EXISTS "attendance_locked_periods_tenant_year_month_key";

DROP INDEX IF EXISTS "attendance_locked_periods_tenantId_idx";

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'attendance_locked_periods_year_month_key'
  ) THEN
    ALTER TABLE "attendance_locked_periods"
      ADD CONSTRAINT "attendance_locked_periods_year_month_key"
      UNIQUE ("year", "month");
  END IF;
END $$;

ALTER TABLE "attendance_locked_periods"
  DROP COLUMN IF EXISTS "tenantId";

COMMIT;
