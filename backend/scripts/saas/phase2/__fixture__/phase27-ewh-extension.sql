-- =============================================================================
-- Phase 2.7 fixture extension — additive only.
-- =============================================================================
-- Adds the tables the employee-work-history pilot harnesses need:
--   - employee_work_history
--   - employee_work_history_attachments
--   - work_history_event_types  (catalog)
--
-- Plus seeds two tenants' worth of work-history rows so the isolation
-- harness can attempt cross-tenant collisions and confirm zero leakage.
--
-- Idempotent. Safe to re-run. Production already has these tables.
-- =============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS employee_work_history (
  id            uuid PRIMARY KEY,
  "employeeId"  uuid NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  date          date NOT NULL,
  "eventType"   text NOT NULL,
  description   text,
  "createdById" uuid,
  "approvedById" uuid,
  "createdAt"   timestamptz NOT NULL DEFAULT now(),
  "updatedAt"   timestamptz NOT NULL DEFAULT now(),
  "deletedAt"   timestamptz,
  "deletedBy"   uuid,
  "tenantId"    text
);
CREATE INDEX IF NOT EXISTS employee_work_history_employeeId_date_idx ON employee_work_history("employeeId", date);
CREATE INDEX IF NOT EXISTS employee_work_history_eventType_idx ON employee_work_history("eventType");
CREATE INDEX IF NOT EXISTS employee_work_history_tenantId_idx ON employee_work_history("tenantId");

CREATE TABLE IF NOT EXISTS employee_work_history_attachments (
  id              uuid PRIMARY KEY,
  "workHistoryId" uuid NOT NULL REFERENCES employee_work_history(id) ON DELETE CASCADE,
  name            text NOT NULL,
  "fileUrl"       text NOT NULL,
  "mimeType"      text,
  "fileSize"      int,
  "uploadedById"  uuid,
  "createdAt"     timestamptz NOT NULL DEFAULT now(),
  "deletedAt"     timestamptz,
  "tenantId"      text
);
CREATE INDEX IF NOT EXISTS employee_work_history_attachments_workHistoryId_idx
  ON employee_work_history_attachments("workHistoryId");
CREATE INDEX IF NOT EXISTS employee_work_history_attachments_tenantId_idx
  ON employee_work_history_attachments("tenantId");

CREATE TABLE IF NOT EXISTS work_history_event_types (
  id          uuid PRIMARY KEY,
  value       text UNIQUE NOT NULL,
  label       text NOT NULL,
  "isActive"  boolean NOT NULL DEFAULT true,
  "sortOrder" int NOT NULL DEFAULT 100,
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  "updatedAt" timestamptz NOT NULL DEFAULT now()
);

INSERT INTO work_history_event_types (id, value, label, "isActive", "sortOrder")
VALUES
  ('00000000-0000-0000-0000-00000000e001', 'NEW_CONTRACT',  'New contract',   true, 10),
  ('00000000-0000-0000-0000-00000000e002', 'PROBATION_END', 'Probation end',  true, 20),
  ('00000000-0000-0000-0000-00000000e003', 'TERMINATION',   'Termination',    true, 30)
ON CONFLICT (id) DO NOTHING;

-- ── Seed two tenants' worth of work-history rows ──────────────────────────
DO $do$
DECLARE
  ta uuid;
  tb uuid;
  emp_a uuid;
  emp_b uuid;
BEGIN
  -- Pick the first two tenants that actually HAVE an employee.
  SELECT t.id INTO ta
    FROM tenants t
   WHERE EXISTS (SELECT 1 FROM employees e WHERE e."tenantId" = t.id::text)
   ORDER BY t.name OFFSET 0 LIMIT 1;
  SELECT t.id INTO tb
    FROM tenants t
   WHERE EXISTS (SELECT 1 FROM employees e WHERE e."tenantId" = t.id::text)
     AND t.id::text <> ta::text
   ORDER BY t.name OFFSET 0 LIMIT 1;
  IF ta IS NULL OR tb IS NULL THEN
    RAISE NOTICE '[phase27-ewh-extension] need at least 2 tenants with employees; got ta=%, tb=%', ta, tb;
    RETURN;
  END IF;

  SELECT id INTO emp_a FROM employees WHERE "tenantId" = ta::text LIMIT 1;
  SELECT id INTO emp_b FROM employees WHERE "tenantId" = tb::text LIMIT 1;
  IF emp_a IS NULL OR emp_b IS NULL THEN
    RAISE NOTICE '[phase27-ewh-extension] missing employee in one tenant; emp_a=%, emp_b=%', emp_a, emp_b;
    RETURN;
  END IF;

  -- Two same-shape rows — one per tenant. Cross-tenant collision check.
  INSERT INTO employee_work_history (id, "employeeId", date, "eventType", description, "tenantId")
  VALUES
    ('00000000-0000-0000-0000-0000000ea001', emp_a, DATE '2025-01-01', 'NEW_CONTRACT',  'tenant A new contract', ta::text),
    ('00000000-0000-0000-0000-0000000eb001', emp_b, DATE '2025-01-01', 'NEW_CONTRACT',  'tenant B new contract', tb::text),
    ('00000000-0000-0000-0000-0000000ea002', emp_a, DATE '2025-04-01', 'PROBATION_END', 'tenant A end probation', ta::text),
    ('00000000-0000-0000-0000-0000000eb002', emp_b, DATE '2025-04-01', 'PROBATION_END', 'tenant B end probation', tb::text)
  ON CONFLICT (id) DO NOTHING;

  -- One legacy row in tenant A with NULL tenantId, to prove the pilot
  -- filter does not surface NULL-tenant rows for either tenant.
  INSERT INTO employee_work_history (id, "employeeId", date, "eventType", description, "tenantId")
  VALUES
    ('00000000-0000-0000-0000-0000000ea999', emp_a, DATE '2024-12-01', 'NEW_CONTRACT', 'legacy NULL-tenant row', NULL)
  ON CONFLICT (id) DO NOTHING;

  -- One attachment in tenant A.
  INSERT INTO employee_work_history_attachments (id, "workHistoryId", name, "fileUrl", "mimeType", "fileSize", "tenantId")
  VALUES
    ('00000000-0000-0000-0000-0000000fa001', '00000000-0000-0000-0000-0000000ea001',
     'contract.pdf', 'fixture://contract-A.pdf', 'application/pdf', 1024, ta::text)
  ON CONFLICT (id) DO NOTHING;
END $do$;

COMMIT;
