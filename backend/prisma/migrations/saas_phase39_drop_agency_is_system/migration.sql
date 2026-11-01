-- =============================================================================
-- SaaS Phase 3.9 — Drop Agency.isSystem column (DESTRUCTIVE)
-- =============================================================================
-- Removes the legacy `agencies.isSystem` column. By Phase 3.8 the runtime
-- already no longer reads this column for authorization (PlatformAdmin is
-- authoritative). This migration completes the retirement.
--
-- Prerequisites — operators must confirm before running:
--   - Phase 3.5 backfill applied to production
--   - Phase 3.7B signal agreement: goPhase38 === true
--     (legacyOnly === 0, inactivePlatform === 0,
--      missingAgencyOnPlatform === 0)
--   - Phase 3.8 baked ≥1 release under default flags
--   - PLATFORM_ADMIN_LEGACY_AGENCY_FALLBACK left at default (false)
--   - Full DB backup taken
--
-- Caveat: down migration re-adds the column with default `false`. Original
-- isSystem=true values cannot be reconstructed except from a pre-migration
-- backup or full-row snapshot.
-- =============================================================================

BEGIN;

ALTER TABLE "agencies" DROP COLUMN IF EXISTS "isSystem";

COMMIT;
