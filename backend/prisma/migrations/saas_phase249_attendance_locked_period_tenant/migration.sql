-- =============================================================================
-- SaaS Phase 2.49 — AttendanceLockedPeriod tenant scoping
-- =============================================================================
-- Adds a nullable `tenantId` column, replaces the existing global
-- unique on `(year, month)` with a tenant-aware unique on
-- `(tenantId, year, month)`, and preserves the pre-2.49 invariant
-- "one global lock per (year, month)" via a partial unique index
-- restricted to NULL-tenant rows.
--
-- Backfill strategy: NONE. Existing global rows (tenantId IS NULL)
-- are preserved as-is so legacy deployments — where the pilot flag
-- is OFF — keep observing the historical "global lock" semantics
-- through the partial unique index. New per-tenant rows are written
-- with `tenantId = <active>` only when the Phase 2.47 pilot is
-- enabled. See SAAS_PHASE2_ATTENDANCE_LOCK_PERIOD_TENANT_SCOPE.md
-- for production rollout strategies (A/B/C).
--
-- Reversible via `migration.down.sql`. Idempotent.
-- =============================================================================

BEGIN;

-- 1) Additive column.
ALTER TABLE "attendance_locked_periods"
  ADD COLUMN IF NOT EXISTS "tenantId" text;

-- 2) Tenant-leading lookup index.
CREATE INDEX IF NOT EXISTS "attendance_locked_periods_tenantId_idx"
  ON "attendance_locked_periods" ("tenantId");

-- 3) Drop the old global unique constraint or index, if present, and
--    create the tenant-aware one. Both names are guarded by IF EXISTS
--    so the migration is safe to re-run on partial fixtures. Some
--    Prisma backends materialise the original `@@unique` as a plain
--    UNIQUE INDEX rather than a CONSTRAINT — handle both shapes.
ALTER TABLE "attendance_locked_periods"
  DROP CONSTRAINT IF EXISTS "attendance_locked_periods_year_month_key";

DROP INDEX IF EXISTS "attendance_locked_periods_year_month_key";

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'attendance_locked_periods_tenant_year_month_key'
  ) THEN
    ALTER TABLE "attendance_locked_periods"
      ADD CONSTRAINT "attendance_locked_periods_tenant_year_month_key"
      UNIQUE ("tenantId", "year", "month");
  END IF;
END $$;

-- 4) Preserve the pre-2.49 invariant for NULL-tenant rows: at most
--    one global lock per (year, month). Composite unique above uses
--    NULLS DISTINCT (Postgres default), which would otherwise allow
--    multiple NULL-tenant duplicates.
CREATE UNIQUE INDEX IF NOT EXISTS
  "attendance_locked_periods_global_year_month_uq"
  ON "attendance_locked_periods" ("year", "month")
  WHERE "tenantId" IS NULL;

COMMIT;
