-- Per-agency view/edit split on EmployeeAgencyAccess. Before this
-- migration the mere presence of a row meant "this agency can do
-- everything with this employee". We now store two explicit flags so
-- a Tempworks admin can grant read-only access without also granting
-- edit, or revoke just one of the two without deleting the row.
--
-- Idempotent: default both columns to true so existing grants retain
-- their pre-migration behaviour (full view + edit).

ALTER TABLE "employee_agency_access"
  ADD COLUMN IF NOT EXISTS "canView" boolean NOT NULL DEFAULT true;

ALTER TABLE "employee_agency_access"
  ADD COLUMN IF NOT EXISTS "canEdit" boolean NOT NULL DEFAULT true;
