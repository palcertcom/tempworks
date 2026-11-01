-- Phase 3.F — Notification i18n metadata
--
-- Adds three nullable columns so notification producers can record the
-- translation key + interpolation params alongside the pre-rendered
-- English text. Reader endpoints resolve `<titleKey, params>` against the
-- requester's locale at fetch time and fall back to the existing
-- `title` / `message` columns when the keys are not set (legacy rows).
--
-- Strictly additive — no data migration, no destructive changes, no
-- column drops. Safe to apply on a live database; old code keeps working
-- because the new columns are nullable and the reader fallback chain
-- preserves the historical English-only behavior.

ALTER TABLE "notifications"
  ADD COLUMN IF NOT EXISTS "titleKey"   TEXT,
  ADD COLUMN IF NOT EXISTS "messageKey" TEXT,
  ADD COLUMN IF NOT EXISTS "params"     JSONB;
