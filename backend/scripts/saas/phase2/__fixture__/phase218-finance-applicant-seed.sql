-- =============================================================================
-- Phase 2.18 fixture extension — Finance APPLICANT helper coverage.
--
-- Adds one applicant per tenant + a same-tenant finance record pointing at
-- the tenant A applicant, so the mutation-isolation harness can exercise:
--
--   * tenant A creating with tenant B applicant id        ⇒ NotFoundException
--   * tenant A creating with tenant A applicant id        ⇒ success, tenantId=A
--   * resolveEntityNameForNotif from tenant A on tenant B applicant ⇒ 'Unknown'
--
-- Idempotent. Safe for SAFE_CLONE / SAFE_STAGING. Refuses to run when the
-- seeded tenants from `phase2171-finance-seed.sql` are absent.
-- =============================================================================

BEGIN;

INSERT INTO applicants (id, "firstName", "lastName", email, phone, tier,
                        "agencyId", "tenantId", "updatedAt")
VALUES
  ('00000000-0000-0000-0000-0000000aa001', 'Anita', 'A-Lead', 'anita@a.test', '+44A',
     'CANDIDATE', 'aaaaaaa1-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
     '11111111-1111-1111-1111-111111111111', now()),
  ('00000000-0000-0000-0000-0000000bb001', 'Boris', 'B-Lead', 'boris@b.test', '+49B',
     'CANDIDATE', 'bbbbbbb2-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
     '22222222-2222-2222-2222-222222222222', now())
ON CONFLICT (id) DO NOTHING;

-- One finance record referencing the tenant A applicant so legacy reads
-- naturally see at least one APPLICANT-typed row in the fixture.
INSERT INTO financial_records
  (id, "entityType", "entityId", "applicantId", "stageAtCreation",
   "transactionDate", currency, "transactionType",
   description, "companyDisbursedAmount", "employeeOrAgencyPaidAmount",
   status, "tenantId", "updatedAt")
VALUES
  ('00000000-0000-0000-0000-0000000fa011', 'APPLICANT',
     '00000000-0000-0000-0000-0000000aa001',
     '00000000-0000-0000-0000-0000000aa001', 'CANDIDATE',
     now() - interval '3 days', 'EUR', 'TRAINING_COST',
     'Applicant fee A1', 75.00, 0.00, 'PENDING',
     '11111111-1111-1111-1111-111111111111', now())
ON CONFLICT (id) DO NOTHING;

COMMIT;
