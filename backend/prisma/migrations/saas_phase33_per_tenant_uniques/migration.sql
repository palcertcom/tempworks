-- =============================================================================
-- SaaS Phase 3.3 — Additive per-tenant unique indexes
-- =============================================================================
-- Adds three partial unique indexes that enforce per-tenant uniqueness
-- for Employee.email, Employee.employeeNumber, and Applicant.email.
--
-- All three are PARTIAL (filtered) indexes:
--   - exclude tenantId IS NULL (Phase 1/2 transitional rows)
--   - exclude deletedAt IS NOT NULL (soft-deleted rows do not block reuse)
--   - exclude NULL key column (sparse keys)
-- Email is also lower-cased so case-only variants collide.
--
-- Additive only:
--   - Existing global UNIQUE(email) on employees REMAINS in place.
--   - Existing global UNIQUE(employeeNumber) on employees REMAINS in place.
--   - Applicant.email previously had no constraint; this is the first.
--   - No data is mutated.
--
-- Reversible via migration.down.sql (drops only the three new indexes).
-- =============================================================================

BEGIN;

CREATE UNIQUE INDEX IF NOT EXISTS "employees_tenant_email_unique"
  ON "employees" ("tenantId", lower(email))
  WHERE "tenantId" IS NOT NULL
    AND email IS NOT NULL
    AND "deletedAt" IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS "employees_tenant_employee_number_unique"
  ON "employees" ("tenantId", "employeeNumber")
  WHERE "tenantId" IS NOT NULL
    AND "employeeNumber" IS NOT NULL
    AND "deletedAt" IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS "applicants_tenant_email_unique"
  ON "applicants" ("tenantId", lower(email))
  WHERE "tenantId" IS NOT NULL
    AND email IS NOT NULL
    AND "deletedAt" IS NULL;

COMMIT;
