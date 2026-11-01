-- =============================================================================
-- Phase 2.23 fixture extension — Vehicles reads-first pilot.
--
-- Seeds 2 vehicles per tenant (4 total), 1 maintenance record per tenant,
-- 1 vehicle document per tenant. Re-uses agencies seeded by
-- phase2171-finance-seed.sql.
--
-- Idempotent. Safe for SAFE_CLONE / SAFE_STAGING.
-- =============================================================================

BEGIN;

-- Vehicles: 2 per tenant. Same registration shapes for collision testing.
INSERT INTO vehicles
  (id, "registrationNumber", make, model, status, "agencyId", "tenantId", "updatedAt")
VALUES
  ('00000000-0000-0000-0000-0000000vh001', 'AB-12-A', 'Volvo', 'FH16', 'ACTIVE',
     'aaaaaaa1-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '11111111-1111-1111-1111-111111111111', now()),
  ('00000000-0000-0000-0000-0000000vh002', 'AB-12-B', 'Mercedes', 'Actros', 'IN_MAINTENANCE',
     'aaaaaaa1-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '11111111-1111-1111-1111-111111111111', now()),
  ('00000000-0000-0000-0000-0000000vh101', 'CD-34-A', 'Volvo', 'FH16', 'ACTIVE',
     'bbbbbbb2-bbbb-bbbb-bbbb-bbbbbbbbbbbb', '22222222-2222-2222-2222-222222222222', now()),
  ('00000000-0000-0000-0000-0000000vh102', 'CD-34-B', 'Mercedes', 'Actros', 'SCRAPPED',
     'bbbbbbb2-bbbb-bbbb-bbbb-bbbbbbbbbbbb', '22222222-2222-2222-2222-222222222222', now())
ON CONFLICT (id) DO NOTHING;

-- Maintenance type catalog (global)
INSERT INTO maintenance_types (id, name, "isActive", "updatedAt")
VALUES
  ('00000000-0000-0000-0000-00000000mt01', 'Service A', true, now())
ON CONFLICT (id) DO NOTHING;

-- 1 maintenance record per tenant
INSERT INTO maintenance_records
  (id, "vehicleId", "maintenanceTypeId", status, "scheduledDate", "tenantId", "updatedAt")
VALUES
  ('00000000-0000-0000-0000-0000000mr001', '00000000-0000-0000-0000-0000000vh001',
     '00000000-0000-0000-0000-00000000mt01', 'SCHEDULED', now() + interval '5 days',
     '11111111-1111-1111-1111-111111111111', now()),
  ('00000000-0000-0000-0000-0000000mr101', '00000000-0000-0000-0000-0000000vh101',
     '00000000-0000-0000-0000-00000000mt01', 'SCHEDULED', now() + interval '10 days',
     '22222222-2222-2222-2222-222222222222', now())
ON CONFLICT (id) DO NOTHING;

-- 1 vehicle document per tenant (expiring within 30 days for the dashboard count)
INSERT INTO vehicle_documents
  (id, "vehicleId", name, "documentType", "expiryDate", "tenantId", "updatedAt")
VALUES
  ('00000000-0000-0000-0000-0000000vd001', '00000000-0000-0000-0000-0000000vh001',
     'MOT cert A', 'MOT', now() + interval '15 days', '11111111-1111-1111-1111-111111111111', now()),
  ('00000000-0000-0000-0000-0000000vd101', '00000000-0000-0000-0000-0000000vh101',
     'MOT cert B', 'MOT', now() + interval '15 days', '22222222-2222-2222-2222-222222222222', now())
ON CONFLICT (id) DO NOTHING;

COMMIT;
