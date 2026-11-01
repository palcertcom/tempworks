ALTER TABLE "documents" DROP CONSTRAINT IF EXISTS "document_employee_fk";
ALTER TABLE "documents" DROP CONSTRAINT IF EXISTS "document_applicant_fk";
ALTER TABLE "visas" DROP CONSTRAINT IF EXISTS "visa_employee_fk";
ALTER TABLE "visas" DROP CONSTRAINT IF EXISTS "visa_applicant_fk";
ALTER TABLE "compliance_alerts" DROP CONSTRAINT IF EXISTS "alert_employee_fk";
ALTER TABLE "compliance_alerts" DROP CONSTRAINT IF EXISTS "alert_applicant_fk";
