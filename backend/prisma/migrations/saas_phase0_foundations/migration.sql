-- =============================================================================
-- SaaS Phase 0 — Tenancy Foundations
-- =============================================================================
-- ADDITIVE ONLY. No existing tables, columns, indexes, or constraints are
-- altered. No data is moved. Runtime behaviour is byte-identical until the
-- application begins reading from these tables (Phase 1+).
--
-- DEPLOYMENT:
--   - Run during a normal release window; idempotent because every CREATE
--     uses IF NOT EXISTS.
--   - Reversible via the `migration.down.sql` companion file.
-- =============================================================================

BEGIN;

-- ---------- Enums ----------

DO $$ BEGIN
  CREATE TYPE "TenantStatus" AS ENUM ('ACTIVE', 'SUSPENDED', 'INACTIVE');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "MembershipStatus" AS ENUM ('INVITED', 'ACTIVE', 'SUSPENDED', 'REMOVED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "AgencyMembershipScope" AS ENUM ('FULL', 'READ_ONLY', 'RECRUITER_ONLY');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "PlatformAdminLevel" AS ENUM ('SUPPORT', 'OPERATOR', 'SUPER');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ---------- Tables ----------

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
  "tenantId"  TEXT NOT NULL,
  "status"    "MembershipStatus" NOT NULL DEFAULT 'ACTIVE',
  "invitedBy" TEXT,
  "invitedAt" TIMESTAMPTZ(3),
  "joinedAt"  TIMESTAMPTZ(3),
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
  "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
  CONSTRAINT "tenant_memberships_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS "tenant_memberships_userId_tenantId_key"
  ON "tenant_memberships"("userId", "tenantId");
CREATE INDEX IF NOT EXISTS "tenant_memberships_tenantId_status_idx"
  ON "tenant_memberships"("tenantId", "status");
CREATE INDEX IF NOT EXISTS "tenant_memberships_userId_idx"
  ON "tenant_memberships"("userId");

CREATE TABLE IF NOT EXISTS "membership_roles" (
  "membershipId" TEXT NOT NULL,
  "roleId"       TEXT NOT NULL,
  PRIMARY KEY ("membershipId", "roleId"),
  CONSTRAINT "membership_roles_membershipId_fkey"
    FOREIGN KEY ("membershipId") REFERENCES "tenant_memberships"("id") ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS "agency_memberships" (
  "id"           TEXT PRIMARY KEY,
  "membershipId" TEXT NOT NULL,
  "agencyId"     TEXT NOT NULL,
  "scope"        "AgencyMembershipScope" NOT NULL DEFAULT 'FULL',
  CONSTRAINT "agency_memberships_membershipId_fkey"
    FOREIGN KEY ("membershipId") REFERENCES "tenant_memberships"("id") ON DELETE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS "agency_memberships_membershipId_agencyId_key"
  ON "agency_memberships"("membershipId", "agencyId");
CREATE INDEX IF NOT EXISTS "agency_memberships_agencyId_idx"
  ON "agency_memberships"("agencyId");

CREATE TABLE IF NOT EXISTS "membership_permission_overrides" (
  "id"           TEXT PRIMARY KEY,
  "membershipId" TEXT NOT NULL,
  "permissionId" TEXT NOT NULL,
  "effect"       BOOLEAN NOT NULL DEFAULT true,
  CONSTRAINT "membership_permission_overrides_membershipId_fkey"
    FOREIGN KEY ("membershipId") REFERENCES "tenant_memberships"("id") ON DELETE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS "membership_permission_overrides_membershipId_permissionId_key"
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
  "tenantId"   TEXT NOT NULL,
  "host"       TEXT NOT NULL,
  "verifiedAt" TIMESTAMPTZ(3),
  "createdAt"  TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
  CONSTRAINT "tenant_domains_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS "tenant_domains_host_key" ON "tenant_domains"("host");
CREATE INDEX        IF NOT EXISTS "tenant_domains_tenantId_idx" ON "tenant_domains"("tenantId");

COMMIT;
