-- =============================================================================
-- Phase 2.20 fixture extension — Documents reads-first pilot.
--
-- Seeds:
--   * 2 document types (PASSPORT, VISA) — global catalog
--   * 1 system user (uploader)
--   * 4 document rows: 2 per tenant, same shape, mixed status/expiry
--
-- Depends on phase2171-finance-seed.sql for tenants + employees + agencies.
-- Idempotent. Safe for SAFE_CLONE / SAFE_STAGING.
-- =============================================================================

BEGIN;

-- Document type catalog (global)
INSERT INTO document_types (id, name, category, "updatedAt")
VALUES
  ('00000000-0000-0000-0000-00000000dt01', 'PASSPORT', 'identity', now()),
  ('00000000-0000-0000-0000-00000000dt02', 'VISA',     'identity', now())
ON CONFLICT (id) DO NOTHING;

-- A minimal role row (global) so the system uploader has a roleId.
INSERT INTO roles (id, name, "isSystem", "updatedAt")
VALUES ('00000000-0000-0000-0000-00000000ro01', 'SystemUploader', true, now())
ON CONFLICT (id) DO NOTHING;

-- System uploader user (global; not tenant-scoped). Bound to tenant A's
-- agency so the FK is satisfied.
INSERT INTO users (id, email, "firstName", "lastName", "passwordHash",
                   "roleId", "agencyId", status, "approvalStatus", "updatedAt")
VALUES
  ('00000000-0000-0000-0000-00000000us01', 'sys@tempworks.test', 'Sys', 'Tem', 'x',
   '00000000-0000-0000-0000-00000000ro01',
   'aaaaaaa1-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
   'ACTIVE', 'APPROVED', now())
ON CONFLICT (id) DO NOTHING;

-- 2 documents per tenant pointing at the per-tenant employees seeded
-- by phase2171-finance-seed.sql.
INSERT INTO documents
  (id, name, "documentTypeId", "entityType", "entityId", "fileUrl",
   "mimeType", "fileSize", status, "issueDate", "expiryDate",
   "uploadedById", "tenantId", "updatedAt")
VALUES
  -- Tenant A docs
  ('00000000-0000-0000-0000-0000000dc001', 'Alice Passport', '00000000-0000-0000-0000-00000000dt01',
     'EMPLOYEE', 'eeeeeeea-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
     'https://files.test/a/passport.pdf', 'application/pdf', 1024, 'VERIFIED',
     now() - interval '60 days', now() + interval '300 days',
     '00000000-0000-0000-0000-00000000us01', '11111111-1111-1111-1111-111111111111', now()),
  ('00000000-0000-0000-0000-0000000dc002', 'Alice Visa', '00000000-0000-0000-0000-00000000dt02',
     'EMPLOYEE', 'eeeeeeea-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
     'https://files.test/a/visa.pdf', 'application/pdf', 2048, 'PENDING',
     now() - interval '5 days', now() + interval '20 days',
     '00000000-0000-0000-0000-00000000us01', '11111111-1111-1111-1111-111111111111', now()),
  -- Tenant B docs
  ('00000000-0000-0000-0000-0000000dc101', 'Bob Passport', '00000000-0000-0000-0000-00000000dt01',
     'EMPLOYEE', 'eeeeeeeb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
     'https://files.test/b/passport.pdf', 'application/pdf', 1024, 'VERIFIED',
     now() - interval '70 days', now() + interval '290 days',
     '00000000-0000-0000-0000-00000000us01', '22222222-2222-2222-2222-222222222222', now()),
  ('00000000-0000-0000-0000-0000000dc102', 'Bob Visa', '00000000-0000-0000-0000-00000000dt02',
     'EMPLOYEE', 'eeeeeeeb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
     'https://files.test/b/visa.pdf', 'application/pdf', 2048, 'PENDING',
     now() - interval '4 days', now() + interval '25 days',
     '00000000-0000-0000-0000-00000000us01', '22222222-2222-2222-2222-222222222222', now())
ON CONFLICT (id) DO NOTHING;

COMMIT;
