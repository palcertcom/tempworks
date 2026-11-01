-- =============================================================================
-- SaaS Phase 2.3 — Entity-Keyed `tenantId` Denormalisation
-- =============================================================================
-- ADDITIVE ONLY. Adds nullable `tenantId` columns + tenant-leading indexes
-- to entity-keyed models that today derive ownership through joins. No
-- existing column, index, or constraint is modified or dropped. RLS stays
-- off. Production behaviour unchanged.
--
-- Tolerant of missing tables: each ALTER is guarded by an IF EXISTS check
-- so the migration runs cleanly against fixture databases that don't have
-- every model materialised. Real production runs see all tables present.
--
-- Reversible via `migration.down.sql`. Idempotent (every DDL uses
-- IF NOT EXISTS).
-- =============================================================================

BEGIN;

DO $$
DECLARE
  t TEXT;
BEGIN
  FOR t IN SELECT unnest(ARRAY[
    'documents',
    'work_permits',
    'visas',
    'compliance_alerts',
    'financial_records',
    'financial_record_attachments',
    'financial_record_deductions',
    'attendance_records',
    'notifications',
    'vehicle_documents',
    'maintenance_records',
    'candidate_workflow_assignments',
    'employee_workflow_assignments',
    'employee_work_history',
    'employee_work_history_attachments'
  ])
  LOOP
    IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname='public' AND tablename = t) THEN
      EXECUTE format('ALTER TABLE %I ADD COLUMN IF NOT EXISTS "tenantId" TEXT', t);
      EXECUTE format('CREATE INDEX IF NOT EXISTS %I ON %I("tenantId")',
                     t || '_tenantId_idx', t);
    ELSE
      RAISE NOTICE '[saas_phase2_tenantid_denorm] table % not present — skipped', t;
    END IF;
  END LOOP;
END $$;

-- ─── Optional secondary indexes on common report-pattern queries ──────────
-- Each is guarded by both table-exists AND column-exists so partial
-- fixtures don't roll back the whole migration.
DO $$
DECLARE
  pairs CONSTANT TEXT[][] := ARRAY[
    ARRAY['documents',          'documents_tenantId_status_idx',           '"tenantId", "status"',          'status'],
    ARRAY['compliance_alerts',  'compliance_alerts_tenantId_status_idx',   '"tenantId", "status"',          'status'],
    ARRAY['financial_records',  'financial_records_tenantId_txnDate_idx',  '"tenantId", "transactionDate"', 'transactionDate'],
    ARRAY['attendance_records', 'attendance_records_tenantId_date_idx',    '"tenantId", "date"',            'date'],
    ARRAY['notifications',      'notifications_tenantId_userId_idx',       '"tenantId", "userId"',          'userId']
  ];
  p TEXT[];
BEGIN
  FOREACH p SLICE 1 IN ARRAY pairs LOOP
    IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname='public' AND tablename = p[1])
       AND EXISTS (SELECT 1 FROM information_schema.columns
                    WHERE table_schema='public' AND table_name = p[1] AND column_name = p[4])
    THEN
      EXECUTE format('CREATE INDEX IF NOT EXISTS %I ON %I(%s)', p[2], p[1], p[3]);
    ELSE
      RAISE NOTICE '[saas_phase2_tenantid_denorm] secondary index on %.% skipped (table or column missing)', p[1], p[4];
    END IF;
  END LOOP;
END $$;

COMMIT;
