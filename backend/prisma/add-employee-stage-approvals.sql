CREATE TABLE IF NOT EXISTS "employee_stage_approvals" (
  "id"           TEXT NOT NULL PRIMARY KEY,
  "employeeId"   TEXT NOT NULL REFERENCES "employees"("id") ON DELETE CASCADE,
  "stageId"      TEXT NOT NULL REFERENCES "workflow_stages"("id") ON DELETE CASCADE,
  "approvedById" TEXT NOT NULL REFERENCES "users"("id"),
  "approvedAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "notes"        TEXT,
  CONSTRAINT "employee_stage_approvals_employeeId_stageId_key" UNIQUE ("employeeId", "stageId")
);

CREATE INDEX IF NOT EXISTS "employee_stage_approvals_employeeId_idx" ON "employee_stage_approvals"("employeeId");
