-- =============================================================================
-- Phase 2.28 fixture extension — Applicants reads-first pilot.
--
-- Adds 1 more applicant per tenant + financial profile + agency-history
-- rows so the read paths can be exercised.
--
-- Re-uses tenants/agencies seeded by phase2171-finance-seed.sql and the
-- existing applicants from phase218-finance-applicant-seed.sql.
-- Idempotent. Safe for SAFE_CLONE / SAFE_STAGING.
-- =============================================================================

BEGIN;

-- Second applicant per tenant
INSERT INTO applicants (id, "firstName", "lastName", email, phone, tier, status,
                        "agencyId", "tenantId", "updatedAt")
VALUES
  ('00000000-0000-0000-0000-0000000aa002', 'Anna', 'A-Cand', 'anna@a.test', '+44A2',
     'CANDIDATE', 'ACCEPTED', 'aaaaaaa1-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
     '11111111-1111-1111-1111-111111111111', now()),
  ('00000000-0000-0000-0000-0000000bb002', 'Bella', 'B-Cand', 'bella@b.test', '+49B2',
     'CANDIDATE', 'ACCEPTED', 'bbbbbbb2-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
     '22222222-2222-2222-2222-222222222222', now())
ON CONFLICT (id) DO NOTHING;

-- Financial profiles for the new candidates (1-to-1)
INSERT INTO applicant_financial_profiles (id, "applicantId", "salaryAgreed", "updatedAt")
VALUES
  ('00000000-0000-0000-0000-0000000fp001', '00000000-0000-0000-0000-0000000aa002', 30000, now()),
  ('00000000-0000-0000-0000-0000000fp101', '00000000-0000-0000-0000-0000000bb002', 35000, now())
ON CONFLICT (id) DO NOTHING;

-- Agency history rows
INSERT INTO applicant_agency_history (id, "applicantId", "agencyId", "agencyName", "assignedAt")
VALUES
  ('00000000-0000-0000-0000-0000000ah001', '00000000-0000-0000-0000-0000000aa002',
     'aaaaaaa1-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'Agency A', now() - interval '30 days'),
  ('00000000-0000-0000-0000-0000000ah101', '00000000-0000-0000-0000-0000000bb002',
     'bbbbbbb2-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'Agency B', now() - interval '30 days')
ON CONFLICT (id) DO NOTHING;

COMMIT;
