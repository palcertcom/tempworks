-- Phase 2.17.1 minimal seed for finance harness execution.
-- 2 tenants, 1 agency per tenant, 1 employee per tenant, finance records.

BEGIN;

INSERT INTO tenants (id, slug, name, "updatedAt")
VALUES
  ('11111111-1111-1111-1111-111111111111', 'tenant-a', 'Tenant A', now()),
  ('22222222-2222-2222-2222-222222222222', 'tenant-b', 'Tenant B', now())
ON CONFLICT (id) DO NOTHING;

-- agencies require unique combos; minimal columns
INSERT INTO agencies (id, name, country, "contactPerson", phone, email, "tenantId", "createdAt", "updatedAt")
VALUES
  ('aaaaaaa1-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'Agency A', 'GB', 'A Contact', '+44', 'a@a.test', '11111111-1111-1111-1111-111111111111', now(), now()),
  ('bbbbbbb2-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'Agency B', 'DE', 'B Contact', '+49', 'b@b.test', '22222222-2222-2222-2222-222222222222', now(), now())
ON CONFLICT (id) DO NOTHING;

INSERT INTO employees (id, "firstName", "lastName", email, phone, nationality, "dateOfBirth",
                       "addressLine1", city, country, "postalCode",
                       "agencyId", "tenantId", "createdAt", "updatedAt")
VALUES
  ('eeeeeeea-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'Alice', 'Anderson', 'alice@a.test', '+44', 'GB',
   '1990-01-01'::timestamp, '1 A St', 'London', 'GB', 'EC1',
   'aaaaaaa1-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '11111111-1111-1111-1111-111111111111', now(), now()),
  ('eeeeeeeb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'Bob', 'Brown', 'bob@b.test', '+49', 'DE',
   '1990-01-01'::timestamp, '2 B St', 'Berlin', 'DE', '10115',
   'bbbbbbb2-bbbb-bbbb-bbbb-bbbbbbbbbbbb', '22222222-2222-2222-2222-222222222222', now(), now())
ON CONFLICT (id) DO NOTHING;

INSERT INTO finance_transaction_types (id, name, "sortOrder", "updatedAt")
VALUES
  ('00000000-0000-0000-0000-00000000ff01', 'TRAINING_COST', 10, now()),
  ('00000000-0000-0000-0000-00000000ff02', 'BONUS', 20, now())
ON CONFLICT (id) DO NOTHING;

INSERT INTO financial_records
  (id, "entityType", "entityId", "transactionDate", currency, "transactionType",
   description, "companyDisbursedAmount", "employeeOrAgencyPaidAmount", status, "tenantId", "updatedAt")
VALUES
  ('00000000-0000-0000-0000-0000000fa001', 'EMPLOYEE', 'eeeeeeea-aaaa-aaaa-aaaa-aaaaaaaaaaaa', now() - interval '10 days', 'EUR', 'TRAINING_COST',
     'Training A1', 100.00, 0.00, 'PENDING', '11111111-1111-1111-1111-111111111111', now()),
  ('00000000-0000-0000-0000-0000000fa002', 'EMPLOYEE', 'eeeeeeea-aaaa-aaaa-aaaa-aaaaaaaaaaaa', now() - interval '5 days', 'EUR', 'TRAINING_COST',
     'Training A2', 200.00, 200.00, 'DEDUCTED', '11111111-1111-1111-1111-111111111111', now()),
  ('00000000-0000-0000-0000-0000000fb001', 'EMPLOYEE', 'eeeeeeeb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', now() - interval '10 days', 'EUR', 'TRAINING_COST',
     'Training B1', 150.00, 0.00, 'PENDING', '22222222-2222-2222-2222-222222222222', now()),
  ('00000000-0000-0000-0000-0000000fb002', 'EMPLOYEE', 'eeeeeeeb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', now() - interval '5 days', 'EUR', 'TRAINING_COST',
     'Training B2', 300.00, 300.00, 'DEDUCTED', '22222222-2222-2222-2222-222222222222', now())
ON CONFLICT (id) DO NOTHING;

COMMIT;
