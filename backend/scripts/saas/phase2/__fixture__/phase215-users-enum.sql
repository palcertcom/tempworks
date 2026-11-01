-- =============================================================================
-- Phase 2.15 fixture extension — additive only.
-- =============================================================================
-- The notifications fanout writers (`notifyUsersByRoles`,
-- `notifyUploaderAndRoles`) read `users.status` and Prisma 7's
-- generated client casts it to the `UserStatus` enum. The staging
-- fixture's `users.status` is `text`. This extension creates the
-- enum and casts the column so the harness can exercise the writers
-- end-to-end.
--
-- Idempotent. Safe to re-run. Production already has the column +
-- enum from the original schema.
-- =============================================================================

BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'UserStatus') THEN
    CREATE TYPE "UserStatus" AS ENUM ('ACTIVE','INACTIVE','SUSPENDED','PENDING','TERMINATED');
  END IF;
END $$;

DO $$
DECLARE
  st text;
BEGIN
  SELECT data_type INTO st FROM information_schema.columns
   WHERE table_name='users' AND column_name='status';
  IF st = 'text' THEN
    ALTER TABLE users
      ALTER COLUMN status DROP DEFAULT,
      ALTER COLUMN status TYPE "UserStatus" USING (
        CASE WHEN status IS NULL OR status='' THEN 'ACTIVE'::"UserStatus"
             ELSE status::"UserStatus" END),
      ALTER COLUMN status SET NOT NULL,
      ALTER COLUMN status SET DEFAULT 'ACTIVE'::"UserStatus";
  END IF;
END $$;

-- The legacy fixture's `notifications.kind` column is NOT NULL but
-- Prisma's `Notification` model has no `kind` field. New rows
-- created via `prisma.notification.create` therefore fail the NOT
-- NULL constraint. Make it nullable so the harness can exercise the
-- fanout writers end-to-end. Production has no such column.
ALTER TABLE notifications ALTER COLUMN kind DROP NOT NULL;

COMMIT;
