-- Allow multiple applications from the same email address.
-- Drops the unique constraint on applicants.email.
--
-- Idempotent — safe to run multiple times.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'applicants_email_key'
      AND conrelid = 'applicants'::regclass
  ) THEN
    ALTER TABLE applicants DROP CONSTRAINT applicants_email_key;
  END IF;
END;
$$;
