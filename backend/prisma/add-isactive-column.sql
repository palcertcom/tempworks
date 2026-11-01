-- Add isActive column to workflow_stages (idempotent)
ALTER TABLE "workflow_stages" ADD COLUMN IF NOT EXISTS "isActive" BOOLEAN NOT NULL DEFAULT true;
