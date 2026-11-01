-- Migration: Add user profile fields, auth security fields, preferences,
--            new auth models, agency manager, and candidate delete requests.
-- Idempotent — safe to run multiple times.

-- ─── 1. UserStatus enum: add TERMINATED ──────────────────────────────────────
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_enum
    WHERE enumlabel = 'TERMINATED'
      AND enumtypid = (SELECT oid FROM pg_type WHERE typname = 'UserStatus')
  ) THEN
    ALTER TYPE "UserStatus" ADD VALUE 'TERMINATED';
  END IF;
END $$;

-- ─── 2. User model: new profile, security, and preference columns ─────────────
ALTER TABLE users ADD COLUMN IF NOT EXISTS "userNumber"          TEXT UNIQUE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS "middleName"          TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS "dateOfBirth"         TIMESTAMP(3);
ALTER TABLE users ADD COLUMN IF NOT EXISTS "gender"              "Gender";
ALTER TABLE users ADD COLUMN IF NOT EXISTS "citizenship"         TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS "addressLine1"        TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS "addressLine2"        TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS "city"                TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS "country"             TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS "postalCode"          TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS "jobTitle"            TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS "department"          TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS "startDate"           TIMESTAMP(3);
ALTER TABLE users ADD COLUMN IF NOT EXISTS "photoUrl"            TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS "createdById"         TEXT;

-- Auth security fields
ALTER TABLE users ADD COLUMN IF NOT EXISTS "failedLoginAttempts" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN IF NOT EXISTS "lockedAt"            TIMESTAMP(3);
ALTER TABLE users ADD COLUMN IF NOT EXISTS "passwordChangedAt"   TIMESTAMP(3);
ALTER TABLE users ADD COLUMN IF NOT EXISTS "passwordExpiresAt"   TIMESTAMP(3);

-- Preferences
ALTER TABLE users ADD COLUMN IF NOT EXISTS "preferredLanguage"   TEXT NOT NULL DEFAULT 'en';
ALTER TABLE users ADD COLUMN IF NOT EXISTS "timeZone"            TEXT NOT NULL DEFAULT 'UTC';
ALTER TABLE users ADD COLUMN IF NOT EXISTS "notificationPrefs"   JSONB;

-- ─── 3. Agency model: manager ────────────────────────────────────────────────
ALTER TABLE agencies ADD COLUMN IF NOT EXISTS "managerId" TEXT;

-- ─── 4. activation_tokens ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS activation_tokens (
  id          TEXT        NOT NULL PRIMARY KEY,
  "userId"    TEXT        NOT NULL,
  token       TEXT        NOT NULL UNIQUE,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "usedAt"    TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "activation_tokens_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES users(id) ON DELETE CASCADE
);

-- ─── 5. password_reset_tokens ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS password_reset_tokens (
  id          TEXT        NOT NULL PRIMARY KEY,
  "userId"    TEXT        NOT NULL,
  token       TEXT        NOT NULL UNIQUE,
  type        TEXT        NOT NULL DEFAULT 'USER_INITIATED',
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "usedAt"    TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "password_reset_tokens_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES users(id) ON DELETE CASCADE
);

-- ─── 6. candidate_delete_requests ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS candidate_delete_requests (
  id               TEXT        NOT NULL PRIMARY KEY,
  "candidateId"    TEXT        NOT NULL,
  "requestedById"  TEXT        NOT NULL,
  reason           TEXT        NOT NULL,
  status           TEXT        NOT NULL DEFAULT 'PENDING',
  "reviewedById"   TEXT,
  "reviewedAt"     TIMESTAMP(3),
  "reviewNotes"    TEXT,
  "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "candidate_delete_requests_candidateId_fkey"
    FOREIGN KEY ("candidateId") REFERENCES applicants(id),
  CONSTRAINT "candidate_delete_requests_requestedById_fkey"
    FOREIGN KEY ("requestedById") REFERENCES users(id),
  CONSTRAINT "candidate_delete_requests_reviewedById_fkey"
    FOREIGN KEY ("reviewedById") REFERENCES users(id)
);

-- ─── 7. agency_user_permissions ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS agency_user_permissions (
  id           TEXT        NOT NULL PRIMARY KEY,
  "userId"     TEXT        NOT NULL,
  permission   TEXT        NOT NULL,
  granted      BOOLEAN     NOT NULL DEFAULT TRUE,
  "grantedById" TEXT,
  "createdAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "agency_user_permissions_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT "agency_user_permissions_userId_permission_key"
    UNIQUE ("userId", permission)
);

-- ─── 8. user_number_sequences ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS user_number_sequences (
  id      SERIAL  PRIMARY KEY,
  current INTEGER NOT NULL DEFAULT 0
);
-- Seed the sequence row if table is empty
INSERT INTO user_number_sequences (id, current)
VALUES (1, 0)
ON CONFLICT (id) DO NOTHING;
