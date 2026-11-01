-- Backfill: copy citizenship → nationality for existing applicants
-- where nationality is NULL but citizenship is set.
-- This fixes records created before the dual-write fix was deployed.
--
-- Idempotent — safe to run multiple times.

UPDATE applicants
SET    nationality = citizenship
WHERE  nationality IS NULL
  AND  citizenship IS NOT NULL;
