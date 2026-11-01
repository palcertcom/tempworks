-- =============================================================================
-- SaaS Phase 3.9 — DOWN migration
-- =============================================================================
-- Re-adds `agencies.isSystem` as a boolean defaulting to false.
--
-- ⚠ DATA LOSS CAVEAT: original `isSystem=true` values cannot be reconstructed
-- by this DOWN migration. Operators must either:
--   (a) restore from the pre-Phase-3.9 DB backup, or
--   (b) re-flag the relevant agencies using the operator runbook after this
--       column is recreated (a full-row snapshot taken before Phase 3.9 is
--       required to identify which rows had isSystem=true).
--
-- Phase 3.5 PlatformAdmin rows remain intact; they remain the authoritative
-- source of platform authority. This DOWN migration does NOT reactivate any
-- legacy fallback code path on its own — runtime still reads PlatformAdmin
-- only unless PLATFORM_ADMIN_LEGACY_AGENCY_FALLBACK=true was simultaneously
-- restored in the application configuration.
-- =============================================================================

BEGIN;

ALTER TABLE "agencies"
  ADD COLUMN IF NOT EXISTS "isSystem" boolean NOT NULL DEFAULT false;

COMMIT;
