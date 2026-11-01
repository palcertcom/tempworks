-- ── Workflow Pipeline Migration ───────────────────────────────────────────────
-- Idempotent: safe to run multiple times.
-- Creates all tables for the Workflow Pipeline module.

BEGIN;

-- Enums
DO $$ BEGIN
  CREATE TYPE "PipelineStatus" AS ENUM ('ACTIVE', 'ARCHIVED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "CandidateProgressStatus" AS ENUM ('ACTIVE', 'COMPLETED', 'SKIPPED', 'BLOCKED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "PipelineAssignmentStatus" AS ENUM ('ACTIVE', 'COMPLETED', 'WITHDRAWN');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "ApprovalDecision" AS ENUM ('APPROVED', 'REJECTED', 'PENDING');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- pipelines
CREATE TABLE IF NOT EXISTS "pipelines" (
  "id"             TEXT NOT NULL DEFAULT gen_random_uuid()::text,
  "name"           TEXT NOT NULL,
  "description"    TEXT,
  "status"         "PipelineStatus" NOT NULL DEFAULT 'ACTIVE',
  "isDefault"      BOOLEAN NOT NULL DEFAULT false,
  "isPublic"       BOOLEAN NOT NULL DEFAULT true,
  "color"          TEXT NOT NULL DEFAULT '#2563EB',
  "createdById"    TEXT,
  "createdAt"      TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updatedAt"      TIMESTAMPTZ NOT NULL DEFAULT now(),
  "deletedAt"      TIMESTAMPTZ,
  "deletedBy"      TEXT,
  "deletionReason" TEXT,
  CONSTRAINT "pipelines_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "pipelines_status_idx" ON "pipelines"("status");

-- pipeline_stages
CREATE TABLE IF NOT EXISTS "pipeline_stages" (
  "id"              TEXT NOT NULL DEFAULT gen_random_uuid()::text,
  "pipelineId"      TEXT NOT NULL,
  "name"            TEXT NOT NULL,
  "description"     TEXT,
  "order"           INTEGER NOT NULL,
  "color"           TEXT NOT NULL DEFAULT '#6366F1',
  "slaHours"        INTEGER,
  "requiresApproval" BOOLEAN NOT NULL DEFAULT false,
  "isFinal"         BOOLEAN NOT NULL DEFAULT false,
  "createdAt"       TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updatedAt"       TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT "pipeline_stages_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "pipeline_stages_pipelineId_order_key" UNIQUE ("pipelineId", "order"),
  CONSTRAINT "pipeline_stages_pipelineId_fkey" FOREIGN KEY ("pipelineId") REFERENCES "pipelines"("id") ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS "pipeline_stages_pipelineId_idx" ON "pipeline_stages"("pipelineId");

-- pipeline_stage_users
CREATE TABLE IF NOT EXISTS "pipeline_stage_users" (
  "stageId" TEXT NOT NULL,
  "userId"  TEXT NOT NULL,
  "role"    TEXT NOT NULL DEFAULT 'REVIEWER',
  CONSTRAINT "pipeline_stage_users_pkey" PRIMARY KEY ("stageId", "userId"),
  CONSTRAINT "pipeline_stage_users_stageId_fkey" FOREIGN KEY ("stageId") REFERENCES "pipeline_stages"("id") ON DELETE CASCADE,
  CONSTRAINT "pipeline_stage_users_userId_fkey"  FOREIGN KEY ("userId")  REFERENCES "users"("id") ON DELETE CASCADE
);

-- pipeline_stage_required_docs
CREATE TABLE IF NOT EXISTS "pipeline_stage_required_docs" (
  "id"             TEXT NOT NULL DEFAULT gen_random_uuid()::text,
  "stageId"        TEXT NOT NULL,
  "documentTypeId" TEXT NOT NULL,
  "isRequired"     BOOLEAN NOT NULL DEFAULT true,
  CONSTRAINT "pipeline_stage_required_docs_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "pipeline_stage_required_docs_stageId_documentTypeId_key" UNIQUE ("stageId", "documentTypeId"),
  CONSTRAINT "pipeline_stage_required_docs_stageId_fkey"        FOREIGN KEY ("stageId")        REFERENCES "pipeline_stages"("id") ON DELETE CASCADE,
  CONSTRAINT "pipeline_stage_required_docs_documentTypeId_fkey" FOREIGN KEY ("documentTypeId") REFERENCES "document_types"("id") ON DELETE CASCADE
);

-- pipeline_access_users
CREATE TABLE IF NOT EXISTS "pipeline_access_users" (
  "pipelineId" TEXT NOT NULL,
  "userId"     TEXT NOT NULL,
  "grantedAt"  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT "pipeline_access_users_pkey" PRIMARY KEY ("pipelineId", "userId"),
  CONSTRAINT "pipeline_access_users_pipelineId_fkey" FOREIGN KEY ("pipelineId") REFERENCES "pipelines"("id") ON DELETE CASCADE,
  CONSTRAINT "pipeline_access_users_userId_fkey"     FOREIGN KEY ("userId")     REFERENCES "users"("id") ON DELETE CASCADE
);

-- candidate_pipeline_assignments
CREATE TABLE IF NOT EXISTS "candidate_pipeline_assignments" (
  "id"           TEXT NOT NULL DEFAULT gen_random_uuid()::text,
  "candidateId"  TEXT NOT NULL,
  "pipelineId"   TEXT NOT NULL,
  "status"       "PipelineAssignmentStatus" NOT NULL DEFAULT 'ACTIVE',
  "assignedAt"   TIMESTAMPTZ NOT NULL DEFAULT now(),
  "completedAt"  TIMESTAMPTZ,
  "assignedById" TEXT,
  "notes"        TEXT,
  CONSTRAINT "candidate_pipeline_assignments_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "candidate_pipeline_assignments_candidateId_fkey"  FOREIGN KEY ("candidateId")  REFERENCES "applicants"("id") ON DELETE CASCADE,
  CONSTRAINT "candidate_pipeline_assignments_pipelineId_fkey"   FOREIGN KEY ("pipelineId")   REFERENCES "pipelines"("id"),
  CONSTRAINT "candidate_pipeline_assignments_assignedById_fkey" FOREIGN KEY ("assignedById") REFERENCES "users"("id")
);

CREATE INDEX IF NOT EXISTS "candidate_pipeline_assignments_candidateId_idx" ON "candidate_pipeline_assignments"("candidateId");
CREATE INDEX IF NOT EXISTS "candidate_pipeline_assignments_pipelineId_idx"  ON "candidate_pipeline_assignments"("pipelineId");

-- candidate_stage_progress
CREATE TABLE IF NOT EXISTS "candidate_stage_progress" (
  "id"           TEXT NOT NULL DEFAULT gen_random_uuid()::text,
  "assignmentId" TEXT NOT NULL,
  "stageId"      TEXT NOT NULL,
  "status"       "CandidateProgressStatus" NOT NULL DEFAULT 'ACTIVE',
  "enteredAt"    TIMESTAMPTZ NOT NULL DEFAULT now(),
  "completedAt"  TIMESTAMPTZ,
  "slaDeadline"  TIMESTAMPTZ,
  "flagged"      BOOLEAN NOT NULL DEFAULT false,
  "flagReason"   TEXT,
  "createdAt"    TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updatedAt"    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT "candidate_stage_progress_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "candidate_stage_progress_assignmentId_fkey" FOREIGN KEY ("assignmentId") REFERENCES "candidate_pipeline_assignments"("id") ON DELETE CASCADE,
  CONSTRAINT "candidate_stage_progress_stageId_fkey"      FOREIGN KEY ("stageId")      REFERENCES "pipeline_stages"("id")
);

CREATE INDEX IF NOT EXISTS "candidate_stage_progress_assignmentId_idx" ON "candidate_stage_progress"("assignmentId");
CREATE INDEX IF NOT EXISTS "candidate_stage_progress_stageId_idx"      ON "candidate_stage_progress"("stageId");
CREATE INDEX IF NOT EXISTS "candidate_stage_progress_status_idx"        ON "candidate_stage_progress"("status");

-- candidate_stage_approvals
CREATE TABLE IF NOT EXISTS "candidate_stage_approvals" (
  "id"           TEXT NOT NULL DEFAULT gen_random_uuid()::text,
  "progressId"   TEXT NOT NULL,
  "decision"     "ApprovalDecision" NOT NULL DEFAULT 'PENDING',
  "approvedById" TEXT,
  "notes"        TEXT,
  "decidedAt"    TIMESTAMPTZ,
  "createdAt"    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT "candidate_stage_approvals_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "candidate_stage_approvals_progressId_fkey"   FOREIGN KEY ("progressId")   REFERENCES "candidate_stage_progress"("id") ON DELETE CASCADE,
  CONSTRAINT "candidate_stage_approvals_approvedById_fkey" FOREIGN KEY ("approvedById") REFERENCES "users"("id")
);

CREATE INDEX IF NOT EXISTS "candidate_stage_approvals_progressId_idx" ON "candidate_stage_approvals"("progressId");

-- candidate_stage_notes
CREATE TABLE IF NOT EXISTS "candidate_stage_notes" (
  "id"         TEXT NOT NULL DEFAULT gen_random_uuid()::text,
  "progressId" TEXT NOT NULL,
  "content"    TEXT NOT NULL,
  "isPrivate"  BOOLEAN NOT NULL DEFAULT false,
  "authorId"   TEXT,
  "createdAt"  TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updatedAt"  TIMESTAMPTZ NOT NULL DEFAULT now(),
  "deletedAt"  TIMESTAMPTZ,
  CONSTRAINT "candidate_stage_notes_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "candidate_stage_notes_progressId_fkey" FOREIGN KEY ("progressId") REFERENCES "candidate_stage_progress"("id") ON DELETE CASCADE,
  CONSTRAINT "candidate_stage_notes_authorId_fkey"   FOREIGN KEY ("authorId")   REFERENCES "users"("id")
);

CREATE INDEX IF NOT EXISTS "candidate_stage_notes_progressId_idx" ON "candidate_stage_notes"("progressId");

COMMIT;
