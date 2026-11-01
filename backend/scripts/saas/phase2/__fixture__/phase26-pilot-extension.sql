-- =============================================================================
-- Phase 2.6 fixture extension — additive only.
-- =============================================================================
-- The original `saas_phase1_fixture` seeds Role/Permission/RolePermission as
-- PascalCase tables that pre-date the `@@map("roles")` rename. Prisma 7's
-- generated client looks for the @@map'd lowercase names, so we materialise
-- the new tables (`roles`, `permissions`, `role_permissions`) with the
-- columns the Prisma schema expects, copying rows from the legacy tables.
--
-- Idempotent. Safe to re-run. Production already has the new tables.
-- =============================================================================

BEGIN;

-- ── roles ───────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS roles (
  id              uuid PRIMARY KEY,
  name            text UNIQUE NOT NULL,
  description     text,
  "isSystem"      boolean NOT NULL DEFAULT false,
  "createdAt"     timestamptz NOT NULL DEFAULT now(),
  "updatedAt"     timestamptz NOT NULL DEFAULT now(),
  "deletedAt"     timestamptz,
  "deletedBy"     text,
  "deletionReason" text
);

INSERT INTO roles (id, name, "isSystem")
SELECT id::uuid, name, COALESCE("isSystem", false)
  FROM "Role"
ON CONFLICT (id) DO NOTHING;

-- ── permissions ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS permissions (
  id        uuid PRIMARY KEY,
  name      text UNIQUE NOT NULL,
  module    text NOT NULL,
  action    text NOT NULL,
  "createdAt" timestamptz NOT NULL DEFAULT now()
);

INSERT INTO permissions (id, name, module, action)
SELECT id::uuid, name, module, action FROM "Permission"
ON CONFLICT (id) DO NOTHING;

-- ── role_permissions ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS role_permissions (
  "roleId"       uuid NOT NULL REFERENCES roles(id)       ON DELETE CASCADE,
  "permissionId" uuid NOT NULL REFERENCES permissions(id) ON DELETE CASCADE,
  PRIMARY KEY ("roleId", "permissionId")
);

INSERT INTO role_permissions ("roleId", "permissionId")
SELECT "roleId"::uuid, "permissionId"::uuid FROM "RolePermission"
ON CONFLICT DO NOTHING;

COMMIT;
