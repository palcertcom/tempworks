-- Phase 1 prepare — rollback.
-- Safe to run BEFORE any data has been written to the new columns.
-- If any tenant data has been backfilled, do NOT run this script; restore
-- from snapshot instead.

BEGIN;

-- Drop additive Phase 1 columns / indexes (keep Phase 0 foundations intact).

DROP INDEX IF EXISTS "applicants_tenantId_status_createdAt_idx";
DROP INDEX IF EXISTS "employees_tenantId_status_idx";

DROP INDEX IF EXISTS "applicants_tenantId_idx";
DROP INDEX IF EXISTS "employees_tenantId_idx";
DROP INDEX IF EXISTS "vehicles_tenantId_idx";
DROP INDEX IF EXISTS "agencies_tenantId_idx";

ALTER TABLE IF EXISTS "applicants" DROP COLUMN IF EXISTS "tenantId";
ALTER TABLE IF EXISTS "employees"  DROP COLUMN IF EXISTS "tenantId";
ALTER TABLE IF EXISTS "vehicles"   DROP COLUMN IF EXISTS "tenantId";

ALTER TABLE IF EXISTS "agencies"
  DROP COLUMN IF EXISTS "tenantId",
  DROP COLUMN IF EXISTS "isDefault",
  DROP COLUMN IF EXISTS "parentId";

DROP TABLE IF EXISTS "saas_phase1_seq_snapshot";
DROP TABLE IF EXISTS "saas_reconciliation_queue";
DROP TABLE IF EXISTS "agency_split_progress";

-- Phase 0 foundation tables are NOT dropped here. Use the Phase 0 down
-- migration if a complete rollback is required.

COMMIT;
