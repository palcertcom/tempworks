-- =============================================================================
-- SaaS Phase 3.4 — Drop legacy global Employee UNIQUEs
-- =============================================================================
-- Drops the two legacy global single-column unique constraints/indexes that
-- previously blocked cross-tenant Employee identity reuse:
--
--   employees.email             — single-column UNIQUE
--   employees.employeeNumber    — single-column UNIQUE
--
-- The Phase 3.3 partial per-tenant indexes
--   employees_tenant_email_unique
--   employees_tenant_employee_number_unique
--   applicants_tenant_email_unique
-- are LEFT IN PLACE. User.email, Role.name, Tenant.slug, Tenant.customDomain
-- and all Applicant indexes are likewise untouched.
--
-- This is the only destructive Phase 3 migration. Backup is mandatory and
-- staging bake of Phase 3.3 (>=24h) is a prerequisite.
--
-- The DO blocks below carefully drop ONLY single-column non-partial unique
-- indexes whose definition mentions exactly the target column with no
-- additional predicates. Composite, partial, or tenantId-filtered indexes
-- are skipped.
-- =============================================================================

BEGIN;

-- Drop the constraint first (if present), which in Postgres also drops the
-- backing index. Constraint name is the standard Prisma-generated one.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'employees'::regclass
       AND conname  = 'employees_email_key'
       AND contype  = 'u'
  ) THEN
    EXECUTE 'ALTER TABLE "employees" DROP CONSTRAINT "employees_email_key"';
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'employees'::regclass
       AND conname  = 'employees_employeeNumber_key'
       AND contype  = 'u'
  ) THEN
    EXECUTE 'ALTER TABLE "employees" DROP CONSTRAINT "employees_employeeNumber_key"';
  END IF;
END $$;

-- If the standalone unique index still exists (because the constraint had
-- been previously detached), drop it only when it is a SINGLE-COLUMN,
-- NON-PARTIAL unique index. We compare to the exact definitions Prisma
-- generates; anything more complex is skipped.
DO $$
DECLARE
  def text;
BEGIN
  SELECT indexdef INTO def FROM pg_indexes
   WHERE schemaname = 'public' AND tablename = 'employees'
     AND indexname  = 'employees_email_key';
  IF def IS NOT NULL
     AND def ~* 'UNIQUE INDEX'
     AND def ~  '\(email\)'
     AND def !~* 'WHERE'
     AND def !~* 'tenantId'
  THEN
    EXECUTE 'DROP INDEX "employees_email_key"';
  END IF;
END $$;

DO $$
DECLARE
  def text;
BEGIN
  SELECT indexdef INTO def FROM pg_indexes
   WHERE schemaname = 'public' AND tablename = 'employees'
     AND indexname  = 'employees_employeeNumber_key';
  IF def IS NOT NULL
     AND def ~* 'UNIQUE INDEX'
     AND def ~  '\("employeeNumber"\)'
     AND def !~* 'WHERE'
     AND def !~* 'tenantId'
  THEN
    EXECUTE 'DROP INDEX "employees_employeeNumber_key"';
  END IF;
END $$;

COMMIT;
