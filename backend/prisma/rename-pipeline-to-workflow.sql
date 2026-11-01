-- ── Rename Pipeline → Workflow tables & enums ─────────────────────────────────
-- Idempotent: uses IF EXISTS / DO $$ checks throughout.
-- Run AFTER add-pipeline.sql (which created the original pipeline_* tables).
-- Also renames old workflow_stages → stage_templates to free the name for new workflow_stages.

BEGIN;

-- ── 1. Rename OLD employee-workflow tables ─────────────────────────────────────
ALTER TABLE IF EXISTS "workflow_stages"           RENAME TO "stage_templates";
ALTER TABLE IF EXISTS "employee_workflow_stages"  RENAME TO "employee_stages";

-- Fix indexes on renamed old tables
DO $$ BEGIN
  ALTER INDEX IF EXISTS "workflow_stages_pkey"          RENAME TO "stage_templates_pkey";
EXCEPTION WHEN undefined_table THEN NULL; WHEN undefined_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER INDEX IF EXISTS "employee_workflow_stages_pkey" RENAME TO "employee_stages_pkey";
EXCEPTION WHEN undefined_table THEN NULL; WHEN undefined_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER INDEX IF EXISTS "employee_workflow_stages_employeeId_stageId_key" RENAME TO "employee_stages_employeeId_stageId_key";
EXCEPTION WHEN undefined_table THEN NULL; WHEN undefined_object THEN NULL; END $$;

-- ── 2. Rename Pipeline → Workflow tables ──────────────────────────────────────
ALTER TABLE IF EXISTS "pipelines"                    RENAME TO "workflows";
ALTER TABLE IF EXISTS "pipeline_stages"              RENAME TO "workflow_stages";
ALTER TABLE IF EXISTS "pipeline_stage_users"         RENAME TO "workflow_stage_users";
ALTER TABLE IF EXISTS "pipeline_stage_required_docs" RENAME TO "workflow_stage_required_docs";
ALTER TABLE IF EXISTS "pipeline_access_users"        RENAME TO "workflow_access_users";
ALTER TABLE IF EXISTS "candidate_pipeline_assignments" RENAME TO "candidate_workflow_assignments";

-- ── 3. Rename column pipelineId → workflowId in workflow_stages ───────────────
DO $$ BEGIN
  ALTER TABLE "workflow_stages" RENAME COLUMN "pipelineId" TO "workflowId";
EXCEPTION WHEN undefined_column THEN NULL; END $$;

-- ── 4. Rename column pipelineId → workflowId in workflow_access_users ─────────
DO $$ BEGIN
  ALTER TABLE "workflow_access_users" RENAME COLUMN "pipelineId" TO "workflowId";
EXCEPTION WHEN undefined_column THEN NULL; END $$;

-- ── 5. Rename column pipelineId → workflowId in candidate_workflow_assignments ─
DO $$ BEGIN
  ALTER TABLE "candidate_workflow_assignments" RENAME COLUMN "pipelineId" TO "workflowId";
EXCEPTION WHEN undefined_column THEN NULL; END $$;

-- ── 6. Rename enum types ───────────────────────────────────────────────────────
DO $$ BEGIN
  ALTER TYPE "PipelineStatus"           RENAME TO "WorkflowStatus";
EXCEPTION WHEN duplicate_object THEN NULL; WHEN undefined_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TYPE "PipelineAssignmentStatus" RENAME TO "WorkflowAssignmentStatus";
EXCEPTION WHEN duplicate_object THEN NULL; WHEN undefined_object THEN NULL; END $$;

-- ── 7. Update unique constraint on workflow_stages (pipelineId,order → workflowId,order) ─
DO $$ BEGIN
  ALTER TABLE "workflow_stages" RENAME CONSTRAINT "pipeline_stages_pipelineId_order_key"
    TO "workflow_stages_workflowId_order_key";
EXCEPTION WHEN undefined_object THEN NULL; END $$;

COMMIT;
