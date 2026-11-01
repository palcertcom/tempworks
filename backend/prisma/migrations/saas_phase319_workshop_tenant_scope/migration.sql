-- Phase 3.19 — Workshop tenant scoping.
-- Additive only. Existing workshops stay tenantless until reassigned.

ALTER TABLE "workshops"
  ADD COLUMN IF NOT EXISTS "tenantId" TEXT;

CREATE INDEX IF NOT EXISTS "workshops_tenantId_idx" ON "workshops"("tenantId");
