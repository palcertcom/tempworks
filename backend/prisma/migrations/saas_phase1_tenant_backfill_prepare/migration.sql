-- ============================================================================
-- SaaS Phase 1 — Tenant Backfill Preparation
-- ============================================================================
-- ADDITIVE ONLY — no existing tables are altered destructively.
--
-- This migration:
--   1. Ensures the Phase 0 foundation tables exist (idempotent).
--   2. Adds an `isDefault` flag to `agencies` (nullable; backfill-safe).
--   3. Adds `tenantId` (NULLABLE) to a small set of "leading" tenant-scoped
--      tables so writes can begin propagating it without breaking reads.
--   4. Adds composite indexes leading with tenantId where appropriate.
--   5. Creates the `agency_split_progress` checkpoint table used by the
--      backfill script.
--
-- This migration does NOT:
--   - drop any existing constraint or index
--   - mark `tenantId` NOT NULL
--   - enable RLS
--   - touch reports / documents / financial_records / attendance / workflow
--     (those are Phase 2 deliverables; their tenantId is derived through a
--     parent entity, not yet appropriate to add)
--   - delete any data
--
-- Reverse with `migration.down.sql`.
-- ============================================================================

BEGIN;

-- ---------- (1) Phase 0 foundation tables — idempotent guard ----------
-- These are normally already present (saas_phase0_foundations migration);
-- repeat the IF NOT EXISTS DDL to keep this migration self-contained when
-- replayed against a partially-migrated environment.

DO $$ BEGIN
  CREATE TYPE "TenantStatus"          AS ENUM ('ACTIVE', 'SUSPENDED', 'INACTIVE');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TYPE "MembershipStatus"      AS ENUM ('INVITED', 'ACTIVE', 'SUSPENDED', 'REMOVED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TYPE "AgencyMembershipScope" AS ENUM ('FULL', 'READ_ONLY', 'RECRUITER_ONLY');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TYPE "PlatformAdminLevel"    AS ENUM ('SUPPORT', 'OPERATOR', 'SUPER');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS "tenants" (
  "id"           TEXT PRIMARY KEY,
  "slug"         TEXT NOT NULL,
  "name"         TEXT NOT NULL,
  "status"       "TenantStatus" NOT NULL DEFAULT 'ACTIVE',
  "region"       TEXT NOT NULL DEFAULT 'eu',
  "customDomain" TEXT,
  "branding"     JSONB,
  "planId"       TEXT,
  "createdAt"    TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
  "updatedAt"    TIMESTAMPTZ(3) NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS "tenants_slug_key"         ON "tenants"("slug");
CREATE UNIQUE INDEX IF NOT EXISTS "tenants_customDomain_key" ON "tenants"("customDomain");

CREATE TABLE IF NOT EXISTS "tenant_memberships" (
  "id"        TEXT PRIMARY KEY,
  "userId"    TEXT NOT NULL,
  "tenantId"  TEXT NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "status"    "MembershipStatus" NOT NULL DEFAULT 'ACTIVE',
  "invitedBy" TEXT,
  "invitedAt" TIMESTAMPTZ(3),
  "joinedAt"  TIMESTAMPTZ(3),
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
  "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS "tenant_memberships_userId_tenantId_key"
  ON "tenant_memberships"("userId", "tenantId");
CREATE INDEX IF NOT EXISTS "tenant_memberships_tenantId_status_idx"
  ON "tenant_memberships"("tenantId", "status");
CREATE INDEX IF NOT EXISTS "tenant_memberships_userId_idx"
  ON "tenant_memberships"("userId");

CREATE TABLE IF NOT EXISTS "membership_roles" (
  "membershipId" TEXT NOT NULL REFERENCES "tenant_memberships"("id") ON DELETE CASCADE,
  "roleId"       TEXT NOT NULL,
  PRIMARY KEY ("membershipId", "roleId")
);

CREATE TABLE IF NOT EXISTS "agency_memberships" (
  "id"           TEXT PRIMARY KEY,
  "membershipId" TEXT NOT NULL REFERENCES "tenant_memberships"("id") ON DELETE CASCADE,
  "agencyId"     TEXT NOT NULL,
  "scope"        "AgencyMembershipScope" NOT NULL DEFAULT 'FULL'
);
CREATE UNIQUE INDEX IF NOT EXISTS "agency_memberships_membershipId_agencyId_key"
  ON "agency_memberships"("membershipId", "agencyId");
CREATE INDEX IF NOT EXISTS "agency_memberships_agencyId_idx"
  ON "agency_memberships"("agencyId");

CREATE TABLE IF NOT EXISTS "membership_permission_overrides" (
  "id"           TEXT PRIMARY KEY,
  "membershipId" TEXT NOT NULL REFERENCES "tenant_memberships"("id") ON DELETE CASCADE,
  "permissionId" TEXT NOT NULL,
  "effect"       BOOLEAN NOT NULL DEFAULT true
);
CREATE UNIQUE INDEX IF NOT EXISTS "mem_perm_overrides_unique"
  ON "membership_permission_overrides"("membershipId", "permissionId");

CREATE TABLE IF NOT EXISTS "platform_admins" (
  "id"        TEXT PRIMARY KEY,
  "userId"    TEXT NOT NULL,
  "level"     "PlatformAdminLevel" NOT NULL DEFAULT 'SUPPORT',
  "grantedBy" TEXT,
  "grantedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS "platform_admins_userId_key"
  ON "platform_admins"("userId");

CREATE TABLE IF NOT EXISTS "platform_audit_logs" (
  "id"        BIGSERIAL PRIMARY KEY,
  "actorId"   TEXT NOT NULL,
  "tenantId"  TEXT,
  "action"    TEXT NOT NULL,
  "reason"    TEXT NOT NULL,
  "target"    JSONB,
  "ip"        TEXT,
  "userAgent" TEXT,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "platform_audit_logs_actorId_createdAt_idx"
  ON "platform_audit_logs"("actorId", "createdAt");
CREATE INDEX IF NOT EXISTS "platform_audit_logs_tenantId_createdAt_idx"
  ON "platform_audit_logs"("tenantId", "createdAt");

CREATE TABLE IF NOT EXISTS "tenant_domains" (
  "id"         TEXT PRIMARY KEY,
  "tenantId"   TEXT NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "host"       TEXT NOT NULL,
  "verifiedAt" TIMESTAMPTZ(3),
  "createdAt"  TIMESTAMPTZ(3) NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS "tenant_domains_host_key"     ON "tenant_domains"("host");
CREATE INDEX        IF NOT EXISTS "tenant_domains_tenantId_idx" ON "tenant_domains"("tenantId");

-- ---------- (2) Backfill checkpoint table ----------

CREATE TABLE IF NOT EXISTS "agency_split_progress" (
  "old_agency_id"          TEXT PRIMARY KEY,
  "new_tenant_id"          TEXT NOT NULL,
  "new_default_agency_id"  TEXT NOT NULL,
  "status"                 TEXT NOT NULL DEFAULT 'PENDING',
  "error"                  TEXT,
  "started_at"             TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
  "finished_at"            TIMESTAMPTZ(3)
);
CREATE INDEX IF NOT EXISTS "agency_split_progress_status_idx"
  ON "agency_split_progress"("status");

-- ---------- (3) Additive columns on `agencies` ----------

ALTER TABLE "agencies"
  ADD COLUMN IF NOT EXISTS "tenantId"  TEXT,
  ADD COLUMN IF NOT EXISTS "isDefault" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "parentId"  TEXT;

CREATE INDEX IF NOT EXISTS "agencies_tenantId_idx" ON "agencies"("tenantId");

-- ---------- (4) Add tenantId (NULLABLE) on the "leading" tenant-scoped models
-- Why these specifically: each already has a direct `agencyId`, so the Phase
-- 2 backfill is a one-line UPDATE per row. Models with ENTITY-keyed tenancy
-- (Document, FinancialRecord, ComplianceAlert, Visa) intentionally are NOT
-- touched here — their `tenantId` is derived through their parent entity in
-- Phase 2.

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname='public' AND tablename='applicants') THEN
    ALTER TABLE "applicants"
      ADD COLUMN IF NOT EXISTS "tenantId" TEXT;
    CREATE INDEX IF NOT EXISTS "applicants_tenantId_idx" ON "applicants"("tenantId");
  END IF;
  IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname='public' AND tablename='employees') THEN
    ALTER TABLE "employees"
      ADD COLUMN IF NOT EXISTS "tenantId" TEXT;
    CREATE INDEX IF NOT EXISTS "employees_tenantId_idx" ON "employees"("tenantId");
  END IF;
  IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname='public' AND tablename='vehicles') THEN
    ALTER TABLE "vehicles"
      ADD COLUMN IF NOT EXISTS "tenantId" TEXT;
    CREATE INDEX IF NOT EXISTS "vehicles_tenantId_idx" ON "vehicles"("tenantId");
  END IF;
END $$;

-- ---------- (5) Tenant-leading composite indexes (additive; do not drop old) ----------
-- These coexist with the existing per-agency indexes. They will be the
-- partition-pruning hot index after RLS turns on (Phase 2+).

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname='public' AND tablename='applicants') THEN
    CREATE INDEX IF NOT EXISTS "applicants_tenantId_status_createdAt_idx"
      ON "applicants"("tenantId", "status", "createdAt" DESC);
  END IF;
  IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname='public' AND tablename='employees') THEN
    CREATE INDEX IF NOT EXISTS "employees_tenantId_status_idx"
      ON "employees"("tenantId", "status");
  END IF;
END $$;

-- ---------- (6) Documentation table for the data-reconciliation queue ----------
-- Rows manually flagged for human review live here. The backfill script
-- inserts rows it CANNOT confidently classify; ops triages.

CREATE TABLE IF NOT EXISTS "saas_reconciliation_queue" (
  "id"         BIGSERIAL PRIMARY KEY,
  "kind"       TEXT NOT NULL,    -- e.g. 'user.no-agency', 'employee.code-collision'
  "subject"    JSONB NOT NULL,
  "decision"   TEXT,             -- pending / assign-to-tenant:<id> / promote-platform-admin / hard-delete
  "decided_by" TEXT,
  "decided_at" TIMESTAMPTZ(3),
  "createdAt"  TIMESTAMPTZ(3) NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "saas_reconciliation_queue_kind_idx"
  ON "saas_reconciliation_queue"("kind");

-- ---------- (7) Identifier-sequence snapshot table ----------
-- Populated by `npm run saas:phase1-seq-snapshot`. Consumed by the Phase 2
-- cutover migration to seed per-tenant identifier counters.
CREATE TABLE IF NOT EXISTS "saas_phase1_seq_snapshot" (
  "id"          BIGSERIAL PRIMARY KEY,
  "tenant_id"   TEXT NOT NULL,
  "prefix"      TEXT NOT NULL,
  "year"        INT  NOT NULL,
  "month"       INT  NOT NULL,
  "value"       INT  NOT NULL,
  "computed_at" TIMESTAMPTZ(3) NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS "saas_phase1_seq_snapshot_unique"
  ON "saas_phase1_seq_snapshot"("tenant_id", "prefix", "year", "month");

COMMIT;
