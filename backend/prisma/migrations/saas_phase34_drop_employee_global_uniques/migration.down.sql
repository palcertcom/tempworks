-- =============================================================================
-- SaaS Phase 3.4 — DOWN migration
-- =============================================================================
-- Recreates the legacy global Employee UNIQUEs:
--
--   employees(email)            — single-column UNIQUE
--   employees(employeeNumber)   — single-column UNIQUE
--
-- ⚠ CAVEAT: this DOWN migration WILL FAIL if cross-tenant duplicate
-- emails or employeeNumbers were inserted after Phase 3.4 went live —
-- that was the whole point of dropping the globals. Operators must
-- either:
--   (a) resolve cross-tenant duplicates first (re-run Phase 3.2
--       cleanup planning with the global already dropped), or
--   (b) restore from a pre-Phase-3.4 DB backup.
--
-- This DOWN does NOT touch the Phase 3.3 per-tenant partial indexes.
-- =============================================================================

BEGIN;

CREATE UNIQUE INDEX IF NOT EXISTS "employees_email_key"
  ON "employees" (email);

CREATE UNIQUE INDEX IF NOT EXISTS "employees_employeeNumber_key"
  ON "employees" ("employeeNumber");

COMMIT;
