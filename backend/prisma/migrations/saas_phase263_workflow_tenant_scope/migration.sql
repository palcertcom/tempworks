-- =============================================================================
-- SaaS Phase 2.63 — Workflow tenant scoping
-- =============================================================================
-- Additive only. Adds nullable `tenantId` to `workflows` plus a
-- lookup index. NULL retained for existing global workflow
-- templates (Strategy A backfill — see
-- SAAS_PHASE2_WORKFLOW_TENANT_SCOPE.md). WorkflowStage derives its
-- tenant through `workflowId`; no direct column added.
--
-- No backfill performed: existing workflow rows keep tenantId=NULL
-- so legacy/global behaviour is byte-identical when the pilot is
-- off. Tenant-specific workflows are created going forward under
-- pilot mode.
--
-- Reversible via migration.down.sql. Idempotent (IF NOT EXISTS).
-- =============================================================================

BEGIN;

ALTER TABLE "workflows"
  ADD COLUMN IF NOT EXISTS "tenantId" text;

CREATE INDEX IF NOT EXISTS "workflows_tenantId_idx"
  ON "workflows" ("tenantId");

COMMIT;
