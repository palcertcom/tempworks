-- =============================================================================
-- SaaS Phase 3.3 — DOWN migration
-- =============================================================================
-- Drops ONLY the three additive partial unique indexes introduced by
-- Phase 3.3. Does not touch any existing global UNIQUE constraint.
-- No data changes.
-- =============================================================================

BEGIN;

DROP INDEX IF EXISTS "employees_tenant_email_unique";
DROP INDEX IF EXISTS "employees_tenant_employee_number_unique";
DROP INDEX IF EXISTS "applicants_tenant_email_unique";

COMMIT;
