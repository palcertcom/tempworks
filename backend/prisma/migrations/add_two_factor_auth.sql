-- Email-based two-factor authentication.
-- Note: the Prisma model User is mapped to the physical table "users"
-- via @@map("users"), so all references below use the lowercase name.

-- Flag on User to indicate whether 2FA is required on login.
ALTER TABLE "users"
  ADD COLUMN IF NOT EXISTS "twoFactorEnabled" BOOLEAN NOT NULL DEFAULT FALSE;

-- Short-lived OTP challenges awaiting email verification.
CREATE TABLE IF NOT EXISTS "two_factor_challenges" (
  "id"         TEXT PRIMARY KEY,
  "userId"     TEXT NOT NULL,
  "challenge"  TEXT NOT NULL UNIQUE,
  "codeHash"   TEXT NOT NULL,
  "attempts"   INTEGER NOT NULL DEFAULT 0,
  "expiresAt"  TIMESTAMP(3) NOT NULL,
  "consumedAt" TIMESTAMP(3),
  "ipAddress"  TEXT,
  "createdAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "two_factor_challenges_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS "two_factor_challenges_userId_idx"
  ON "two_factor_challenges"("userId");
