-- =============================================================================
-- Phase 2.19 fixture extension — Finance AGENCY helper coverage.
--
-- The two per-tenant agencies were already seeded by
-- `phase2171-finance-seed.sql`. This extension only adds an AGENCY-typed
-- financial record on tenant A so the mutation-isolation harness has a
-- target row for the AGENCY-update / notif-helper case.
--
-- Idempotent. Safe for SAFE_CLONE / SAFE_STAGING.
-- =============================================================================

BEGIN;

INSERT INTO financial_records
  (id, "entityType", "entityId", "applicantId", "stageAtCreation",
   "transactionDate", currency, "transactionType",
   description, "companyDisbursedAmount", "employeeOrAgencyPaidAmount",
   status, "tenantId", "updatedAt")
VALUES
  ('00000000-0000-0000-0000-0000000fa021', 'AGENCY',
     'aaaaaaa1-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
     NULL, 'AGENCY',
     now() - interval '2 days', 'EUR', 'BONUS',
     'Agency bonus A1', 50.00, 0.00, 'PENDING',
     '11111111-1111-1111-1111-111111111111', now())
ON CONFLICT (id) DO NOTHING;

COMMIT;
