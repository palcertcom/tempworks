-- =============================================================================
-- SaaS Phase 2.63 — DOWN migration
-- =============================================================================
-- Restores pre-2.63 schema. Safe ONLY when no tenant-specific
-- workflow rows exist (workflows.tenantId IS NOT NULL ⇒ data loss
-- if reversed). Operators must first delete or re-NULL tenant-tagged
-- rows.
-- =============================================================================

BEGIN;

DROP INDEX IF EXISTS "workflows_tenantId_idx";

ALTER TABLE "workflows"
  DROP COLUMN IF EXISTS "tenantId";

COMMIT;
