-- Create employee_workflow_assignments table (idempotent)
CREATE TABLE IF NOT EXISTS "employee_workflow_assignments" (
  "id"           TEXT        NOT NULL DEFAULT gen_random_uuid()::text,
  "employeeId"   TEXT        NOT NULL,
  "workflowId"   TEXT        NOT NULL,
  "status"       TEXT        NOT NULL DEFAULT 'ACTIVE',
  "assignedAt"   TIMESTAMPTZ NOT NULL DEFAULT now(),
  "completedAt"  TIMESTAMPTZ,
  "assignedById" TEXT,
  "notes"        TEXT,

  CONSTRAINT "employee_workflow_assignments_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "employee_workflow_assignments_employeeId_workflowId_key" UNIQUE ("employeeId", "workflowId"),
  CONSTRAINT "employee_workflow_assignments_employeeId_fkey"
    FOREIGN KEY ("employeeId") REFERENCES "employees"("id") ON DELETE CASCADE,
  CONSTRAINT "employee_workflow_assignments_workflowId_fkey"
    FOREIGN KEY ("workflowId") REFERENCES "workflows"("id") ON DELETE CASCADE,
  CONSTRAINT "employee_workflow_assignments_assignedById_fkey"
    FOREIGN KEY ("assignedById") REFERENCES "users"("id") ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS "employee_workflow_assignments_employeeId_idx"
  ON "employee_workflow_assignments" ("employeeId");
CREATE INDEX IF NOT EXISTS "employee_workflow_assignments_workflowId_idx"
  ON "employee_workflow_assignments" ("workflowId");
