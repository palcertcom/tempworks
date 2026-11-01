-- =============================================================================
-- Phase 2.61 fixture extension — additive only.
-- =============================================================================
-- Seeds a Workflow + two stages + per-tenant candidate/employee
-- assignments so the pipeline pilot harnesses have something to
-- read. Idempotent — safe to re-run.

DO $$
DECLARE
  ta text;
  tb text;
  emp_a text;
  emp_b text;
  app_a text;
  app_b text;
  wf_id text := '00000000-0000-0000-0000-000000000001';
  stage1 text := '00000000-0000-0000-0000-000000000011';
  stage2 text := '00000000-0000-0000-0000-000000000022';
BEGIN
  SELECT id::text INTO ta FROM tenants ORDER BY name LIMIT 1;
  SELECT id::text INTO tb FROM tenants ORDER BY name OFFSET 1 LIMIT 1;
  IF ta IS NULL OR tb IS NULL THEN RETURN; END IF;
  SELECT id::text INTO emp_a FROM employees WHERE "tenantId" = ta LIMIT 1;
  SELECT id::text INTO emp_b FROM employees WHERE "tenantId" = tb LIMIT 1;
  SELECT id::text INTO app_a FROM applicants WHERE "tenantId" = ta LIMIT 1;
  SELECT id::text INTO app_b FROM applicants WHERE "tenantId" = tb LIMIT 1;

  INSERT INTO workflows (id, name, status, "isDefault", "isPublic", color, "createdAt", "updatedAt")
    VALUES (wf_id, 'Phase261 Hiring Workflow', 'ACTIVE', false, true, '#2563EB', now(), now())
    ON CONFLICT (id) DO NOTHING;

  INSERT INTO workflow_stages (id, "workflowId", name, "order", color, "createdAt", "updatedAt")
    VALUES
      (stage1, wf_id, 'Phase261 Screening',   1, '#6366F1', now(), now()),
      (stage2, wf_id, 'Phase261 Interview',   2, '#10B981', now(), now())
    ON CONFLICT (id) DO NOTHING;

  -- Candidate assignments (one per tenant + one NULL-tenant legacy row)
  IF app_a IS NOT NULL THEN
    INSERT INTO candidate_workflow_assignments(id, "candidateId", "workflowId", status, "tenantId", "assignedAt")
      VALUES ('00000000-0000-0000-0000-000000000a01', app_a, wf_id, 'ACTIVE', ta, now())
      ON CONFLICT (id) DO NOTHING;
    INSERT INTO candidate_workflow_assignments(id, "candidateId", "workflowId", status, "tenantId", "assignedAt")
      VALUES ('00000000-0000-0000-0000-000000000a02', app_a, wf_id, 'COMPLETED', ta, now())
      ON CONFLICT (id) DO NOTHING;
    INSERT INTO candidate_workflow_assignments(id, "candidateId", "workflowId", status, "tenantId", "assignedAt")
      VALUES ('00000000-0000-0000-0000-000000000aNN', app_a, wf_id, 'ACTIVE', NULL, now())
      ON CONFLICT (id) DO NOTHING;
  END IF;
  IF app_b IS NOT NULL THEN
    INSERT INTO candidate_workflow_assignments(id, "candidateId", "workflowId", status, "tenantId", "assignedAt")
      VALUES ('00000000-0000-0000-0000-000000000b01', app_b, wf_id, 'ACTIVE', tb, now())
      ON CONFLICT (id) DO NOTHING;
  END IF;

  -- Employee assignments (one per tenant)
  IF emp_a IS NOT NULL THEN
    INSERT INTO employee_workflow_assignments(id, "employeeId", "workflowId", status, "tenantId", "assignedAt", "currentStageId")
      VALUES ('00000000-0000-0000-0000-000000000eA1', emp_a, wf_id, 'ACTIVE', ta, now(), stage1)
      ON CONFLICT (id) DO NOTHING;
  END IF;
  IF emp_b IS NOT NULL THEN
    INSERT INTO employee_workflow_assignments(id, "employeeId", "workflowId", status, "tenantId", "assignedAt", "currentStageId")
      VALUES ('00000000-0000-0000-0000-000000000eB1', emp_b, wf_id, 'ACTIVE', tb, now(), stage1)
      ON CONFLICT (id) DO NOTHING;
  END IF;
END $$;
