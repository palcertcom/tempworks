-- Make employeeId unique (one workflow per employee)
-- First remove existing duplicate assignments if any, keeping the most recent
DELETE FROM "employee_workflow_assignments" a
USING "employee_workflow_assignments" b
WHERE a."assignedAt" < b."assignedAt"
  AND a."employeeId" = b."employeeId";

-- Drop old composite unique constraint if exists, add unique on employeeId
ALTER TABLE "employee_workflow_assignments"
  DROP CONSTRAINT IF EXISTS "employee_workflow_assignments_employeeId_workflowId_key";

ALTER TABLE "employee_workflow_assignments"
  ADD CONSTRAINT "employee_workflow_assignments_employeeId_key" UNIQUE ("employeeId");

-- Add currentStageId column
ALTER TABLE "employee_workflow_assignments"
  ADD COLUMN IF NOT EXISTS "currentStageId" TEXT REFERENCES "workflow_stages"("id") ON DELETE SET NULL;
