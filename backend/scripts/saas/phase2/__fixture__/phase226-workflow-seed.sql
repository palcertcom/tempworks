-- =============================================================================
-- Phase 2.26 fixture extension — Workflow reads-first pilot.
--
-- Seeds:
--   * 3 global stage templates (StageTemplate is a global catalog)
--   * 1 employee_stage per tenant (parent-gated via Employee.tenantId)
--   * 1 work_permit per tenant
--   * 1 visa per tenant
--
-- Re-uses tenants/employees/applicants from earlier phase fixtures.
-- Idempotent. Safe for SAFE_CLONE / SAFE_STAGING.
-- =============================================================================

BEGIN;

-- Stage templates (global)
INSERT INTO stage_templates (id, name, "order", category, "isActive", "updatedAt")
VALUES
  ('00000000-0000-0000-0000-00000000st01', 'Phase226 Application',     10, 'INITIAL',    true, now()),
  ('00000000-0000-0000-0000-00000000st02', 'Phase226 Background Check', 20, 'COMPLIANCE', true, now()),
  ('00000000-0000-0000-0000-00000000st03', 'Phase226 Onboarding',       30, 'INITIAL',    true, now())
ON CONFLICT (id) DO NOTHING;

-- One EmployeeStage row per tenant (parent gated by Employee.tenantId)
INSERT INTO employee_stages (id, "employeeId", "stageId", status, "startedAt", "updatedAt")
VALUES
  ('00000000-0000-0000-0000-0000000es001', 'eeeeeeea-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
     '00000000-0000-0000-0000-00000000st01', 'IN_PROGRESS', now() - interval '1 day', now()),
  ('00000000-0000-0000-0000-0000000es101', 'eeeeeeeb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
     '00000000-0000-0000-0000-00000000st01', 'IN_PROGRESS', now() - interval '1 day', now())
ON CONFLICT (id) DO NOTHING;

-- One WorkPermit per tenant
INSERT INTO work_permits (id, "employeeId", "permitType", "applicationDate", "expiryDate",
                          status, "tenantId", "updatedAt")
VALUES
  ('00000000-0000-0000-0000-0000000wp001', 'eeeeeeea-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
     'WORK_VISA_A', now() - interval '30 days', now() + interval '300 days',
     'APPROVED', '11111111-1111-1111-1111-111111111111', now()),
  ('00000000-0000-0000-0000-0000000wp101', 'eeeeeeeb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
     'WORK_VISA_B', now() - interval '30 days', now() + interval '300 days',
     'APPROVED', '22222222-2222-2222-2222-222222222222', now())
ON CONFLICT (id) DO NOTHING;

-- One Visa per tenant
INSERT INTO visas (id, "entityType", "entityId", "visaType", "applicationDate",
                   status, "tenantId", "updatedAt")
VALUES
  ('00000000-0000-0000-0000-0000000vs001', 'EMPLOYEE', 'eeeeeeea-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
     'TOURIST', now() - interval '40 days', 'APPROVED',
     '11111111-1111-1111-1111-111111111111', now()),
  ('00000000-0000-0000-0000-0000000vs101', 'EMPLOYEE', 'eeeeeeeb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
     'TOURIST', now() - interval '40 days', 'APPROVED',
     '22222222-2222-2222-2222-222222222222', now())
ON CONFLICT (id) DO NOTHING;

COMMIT;
