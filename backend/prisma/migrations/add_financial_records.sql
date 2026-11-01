-- ============================================================
-- Migration: add_financial_records
-- Purpose:   Create the financial_records and
--            financial_record_attachments tables for tracking
--            company disbursements to Candidates and Employees
--            for payroll-deduction reconciliation.
-- ============================================================

-- 1. Main financial records table
CREATE TABLE IF NOT EXISTS "financial_records" (
  "id"                         TEXT        NOT NULL DEFAULT gen_random_uuid()::text,
  "entityType"                 TEXT        NOT NULL,           -- 'APPLICANT' | 'EMPLOYEE'
  "entityId"                   TEXT        NOT NULL,
  "transactionDate"            TIMESTAMP(3) NOT NULL,
  "currency"                   TEXT        NOT NULL DEFAULT 'EUR',
  "transactionType"            TEXT        NOT NULL,
  "description"                TEXT,
  "paymentMethod"              TEXT,
  "paidByName"                 TEXT,
  "paidById"                   TEXT,
  -- Amounts
  "companyDisbursedAmount"     NUMERIC(10,2) NOT NULL DEFAULT 0,
  "employeeOrAgencyPaidAmount" NUMERIC(10,2) NOT NULL DEFAULT 0,
  -- Deduction tracking
  "status"                     TEXT        NOT NULL DEFAULT 'PENDING',
  "deductionAmount"            NUMERIC(10,2),
  "deductionDate"              TIMESTAMP(3),
  "payrollReference"           TEXT,
  "notes"                      TEXT,
  "createdById"                TEXT,
  "createdAt"                  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"                  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "deletedAt"                  TIMESTAMP(3),

  CONSTRAINT "financial_records_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "financial_records_paidById_fkey"
    FOREIGN KEY ("paidById") REFERENCES "users"("id") ON DELETE SET NULL,
  CONSTRAINT "financial_records_createdById_fkey"
    FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS "financial_records_entityType_entityId_idx"
  ON "financial_records"("entityType", "entityId");
CREATE INDEX IF NOT EXISTS "financial_records_status_idx"
  ON "financial_records"("status");
CREATE INDEX IF NOT EXISTS "financial_records_transactionDate_idx"
  ON "financial_records"("transactionDate");
CREATE INDEX IF NOT EXISTS "financial_records_transactionType_idx"
  ON "financial_records"("transactionType");

-- 2. Attachments per financial record
CREATE TABLE IF NOT EXISTS "financial_record_attachments" (
  "id"                TEXT        NOT NULL DEFAULT gen_random_uuid()::text,
  "financialRecordId" TEXT        NOT NULL,
  "name"              TEXT        NOT NULL,
  "fileUrl"           TEXT        NOT NULL,
  "mimeType"          TEXT,
  "fileSize"          INTEGER,
  "uploadedById"      TEXT,
  "createdAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "deletedAt"         TIMESTAMP(3),

  CONSTRAINT "financial_record_attachments_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "financial_record_attachments_recordId_fkey"
    FOREIGN KEY ("financialRecordId") REFERENCES "financial_records"("id") ON DELETE CASCADE,
  CONSTRAINT "financial_record_attachments_uploadedById_fkey"
    FOREIGN KEY ("uploadedById") REFERENCES "users"("id") ON DELETE SET NULL
);
