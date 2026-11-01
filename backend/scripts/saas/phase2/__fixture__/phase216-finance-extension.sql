-- =============================================================================
-- Phase 2.16 fixture extension — additive only.
-- =============================================================================
-- Materialises the financial_records / financial_record_attachments /
-- financial_record_deductions / finance_transaction_types tables that
-- Prisma's Finance models expect, then seeds two-tenant rows so the
-- equivalence + isolation harnesses can exercise cross-tenant filtering.
--
-- Idempotent. Safe to re-run. Production already has these tables.
-- =============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS financial_records (
  id                            uuid PRIMARY KEY,
  "entityType"                  text NOT NULL,
  "entityId"                    text NOT NULL,
  "applicantId"                 text,
  "stageAtCreation"             text,
  "transactionDate"             timestamptz NOT NULL,
  currency                      text NOT NULL DEFAULT 'EUR',
  "transactionType"             text NOT NULL,
  description                   text,
  "paymentMethod"               text,
  "paidByName"                  text,
  "paidById"                    text,
  "companyDisbursedAmount"      numeric(10,2) NOT NULL DEFAULT 0,
  "employeeOrAgencyPaidAmount"  numeric(10,2) NOT NULL DEFAULT 0,
  status                        text NOT NULL DEFAULT 'PENDING',
  "deductionAmount"             numeric(10,2),
  "deductionDate"               timestamptz,
  "payrollReference"            text,
  notes                         text,
  "createdById"                 text,
  "createdAt"                   timestamptz NOT NULL DEFAULT now(),
  "updatedAt"                   timestamptz NOT NULL DEFAULT now(),
  "deletedAt"                   timestamptz,
  "deletedBy"                   text,
  "deletionReason"              text,
  "tenantId"                    text
);

CREATE INDEX IF NOT EXISTS financial_records_tenant_idx ON financial_records ("tenantId");
CREATE INDEX IF NOT EXISTS financial_records_tenant_date_idx ON financial_records ("tenantId", "transactionDate");
CREATE INDEX IF NOT EXISTS financial_records_entity_idx ON financial_records ("entityType", "entityId");

CREATE TABLE IF NOT EXISTS financial_record_attachments (
  id                  uuid PRIMARY KEY,
  "financialRecordId" uuid NOT NULL REFERENCES financial_records(id) ON DELETE CASCADE,
  name                text NOT NULL,
  "fileUrl"           text NOT NULL,
  "mimeType"          text,
  "fileSize"          integer,
  "uploadedById"      text,
  "createdAt"         timestamptz NOT NULL DEFAULT now(),
  "deletedAt"         timestamptz,
  "deletedBy"         text,
  "deletionReason"    text
);

CREATE TABLE IF NOT EXISTS financial_record_deductions (
  id                  uuid PRIMARY KEY,
  "financialRecordId" uuid NOT NULL REFERENCES financial_records(id) ON DELETE CASCADE,
  amount              numeric(10,2) NOT NULL,
  "deductionDate"     timestamptz NOT NULL,
  "payrollReference"  text,
  notes               text,
  "createdById"       text,
  "createdAt"         timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS finance_transaction_types (
  id          uuid PRIMARY KEY,
  name        text UNIQUE NOT NULL,
  "isActive"  boolean NOT NULL DEFAULT true,
  "sortOrder" integer NOT NULL DEFAULT 100,
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  "updatedAt" timestamptz NOT NULL DEFAULT now()
);

INSERT INTO finance_transaction_types (id, name, "sortOrder")
VALUES
  ('00000000-0000-0000-0000-00000000ff01', 'TRAINING_COST', 10),
  ('00000000-0000-0000-0000-00000000ff02', 'BONUS', 20)
ON CONFLICT (id) DO NOTHING;

DO $do$
DECLARE
  ta uuid;
  tb uuid;
  ea uuid;
  eb uuid;
BEGIN
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
    RAISE NOTICE '[phase216-finance-extension] need 2 tenants with employees; got ta=%, tb=%', ta, tb;
    RETURN;
  END IF;

  SELECT e.id INTO ea FROM employees e WHERE e."tenantId" = ta::text ORDER BY e.id LIMIT 1;
  SELECT e.id INTO eb FROM employees e WHERE e."tenantId" = tb::text ORDER BY e.id LIMIT 1;
  IF ea IS NULL OR eb IS NULL THEN
    RAISE NOTICE '[phase216-finance-extension] need 1 employee per tenant; got ea=%, eb=%', ea, eb;
    RETURN;
  END IF;

  -- Two records per tenant — one PENDING, one DEDUCTED.
  INSERT INTO financial_records
    (id, "entityType", "entityId", "transactionDate", currency, "transactionType",
     description, "companyDisbursedAmount", "employeeOrAgencyPaidAmount", status, "tenantId")
  VALUES
    ('00000000-0000-0000-0000-0000000fa001', 'EMPLOYEE', ea::text, now() - interval '10 days', 'EUR', 'TRAINING_COST',
       'Training A1', 100.00, 0.00, 'PENDING', ta::text),
    ('00000000-0000-0000-0000-0000000fa002', 'EMPLOYEE', ea::text, now() - interval '5 days', 'EUR', 'TRAINING_COST',
       'Training A2', 200.00, 200.00, 'DEDUCTED', ta::text),
    ('00000000-0000-0000-0000-0000000fb001', 'EMPLOYEE', eb::text, now() - interval '10 days', 'EUR', 'TRAINING_COST',
       'Training B1', 150.00, 0.00, 'PENDING', tb::text),
    ('00000000-0000-0000-0000-0000000fb002', 'EMPLOYEE', eb::text, now() - interval '5 days', 'EUR', 'TRAINING_COST',
       'Training B2', 300.00, 300.00, 'DEDUCTED', tb::text)
  ON CONFLICT (id) DO NOTHING;
END
$do$;

COMMIT;
