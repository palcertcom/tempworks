-- Agency.isSystem flag — marks the Tempworks root/owner agency. Users
-- attached to an isSystem=true agency bypass tenancy scoping across
-- backend services; users attached to any other agency are scoped to
-- that agency regardless of their role name.
--
-- Idempotent: safe to re-run. Uses NOT NULL with a sensible default so
-- existing rows get false without a manual backfill step.

ALTER TABLE "agencies"
  ADD COLUMN IF NOT EXISTS "isSystem" boolean NOT NULL DEFAULT false;

-- Flip the original Tempworks owner agency to isSystem so its users
-- keep their pre-migration global visibility. Matches either the
-- seeded email or the seeded display name — one of the two always
-- identifies the root row across existing environments.
UPDATE "agencies"
SET    "isSystem" = true
WHERE  ("isSystem" = false)
  AND  (lower("email") = 'admin@tempworks.sk' OR lower("name") = 'tempworks');
