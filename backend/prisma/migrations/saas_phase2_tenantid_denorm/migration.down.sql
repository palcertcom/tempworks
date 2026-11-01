-- Phase 2.3 rollback. Safe BEFORE any column has been used in a NOT NULL
-- query path or a foreign key. The columns added are all nullable, so
-- DROP COLUMN never breaks data integrity.

BEGIN;

-- Drop indexes first (some PG versions whine about dependent indexes
-- otherwise). Each is `IF EXISTS` so this script is idempotent.
DROP INDEX IF EXISTS "documents_tenantId_idx";
DROP INDEX IF EXISTS "documents_tenantId_status_idx";
DROP INDEX IF EXISTS "work_permits_tenantId_idx";
DROP INDEX IF EXISTS "visas_tenantId_idx";
DROP INDEX IF EXISTS "compliance_alerts_tenantId_idx";
DROP INDEX IF EXISTS "compliance_alerts_tenantId_status_idx";
DROP INDEX IF EXISTS "financial_records_tenantId_idx";
DROP INDEX IF EXISTS "financial_records_tenantId_txnDate_idx";
DROP INDEX IF EXISTS "fra_tenantId_idx";
DROP INDEX IF EXISTS "frd_tenantId_idx";
DROP INDEX IF EXISTS "attendance_records_tenantId_idx";
DROP INDEX IF EXISTS "attendance_records_tenantId_date_idx";
DROP INDEX IF EXISTS "notifications_tenantId_idx";
DROP INDEX IF EXISTS "notifications_tenantId_userId_idx";
DROP INDEX IF EXISTS "vehicle_documents_tenantId_idx";
DROP INDEX IF EXISTS "maintenance_records_tenantId_idx";
DROP INDEX IF EXISTS "cwa_tenantId_idx";
DROP INDEX IF EXISTS "ewa_tenantId_idx";
DROP INDEX IF EXISTS "ewh_tenantId_idx";
DROP INDEX IF EXISTS "ewha_tenantId_idx";

-- Drop columns.
ALTER TABLE "documents"                       DROP COLUMN IF EXISTS "tenantId";
ALTER TABLE "work_permits"                    DROP COLUMN IF EXISTS "tenantId";
ALTER TABLE "visas"                           DROP COLUMN IF EXISTS "tenantId";
ALTER TABLE "compliance_alerts"               DROP COLUMN IF EXISTS "tenantId";
ALTER TABLE "financial_records"               DROP COLUMN IF EXISTS "tenantId";
ALTER TABLE "financial_record_attachments"    DROP COLUMN IF EXISTS "tenantId";
ALTER TABLE "financial_record_deductions"     DROP COLUMN IF EXISTS "tenantId";
ALTER TABLE "attendance_records"              DROP COLUMN IF EXISTS "tenantId";
ALTER TABLE "notifications"                   DROP COLUMN IF EXISTS "tenantId";
ALTER TABLE "vehicle_documents"               DROP COLUMN IF EXISTS "tenantId";
ALTER TABLE "maintenance_records"             DROP COLUMN IF EXISTS "tenantId";
ALTER TABLE "candidate_workflow_assignments"  DROP COLUMN IF EXISTS "tenantId";
ALTER TABLE "employee_workflow_assignments"   DROP COLUMN IF EXISTS "tenantId";
ALTER TABLE "employee_work_history"           DROP COLUMN IF EXISTS "tenantId";
ALTER TABLE "employee_work_history_attachments" DROP COLUMN IF EXISTS "tenantId";

COMMIT;
