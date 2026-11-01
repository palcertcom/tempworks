-- Agency tenancy workflow additions.
-- All changes are additive, backwards-compatible, and idempotent so a
-- partially-applied run (e.g. an earlier failure before all tables were
-- created) can be re-executed safely.
--
-- NOTE: Prisma stores `String @id` columns as `text`, not `uuid`. Every
-- FK column below is therefore also `text` so the types line up.

-- ─── 1. Approval-state enum ─────────────────────────────────────────────
DO $$ BEGIN
  CREATE TYPE "AgencyApprovalStatus" AS ENUM ('PENDING_APPROVAL', 'APPROVED', 'REJECTED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ─── 2. Approval-state columns on applicants / users ────────────────────
ALTER TABLE "applicants"
  ADD COLUMN IF NOT EXISTS "approvalStatus"   "AgencyApprovalStatus" NOT NULL DEFAULT 'APPROVED',
  ADD COLUMN IF NOT EXISTS "approvedById"     text,
  ADD COLUMN IF NOT EXISTS "approvedAt"       timestamp,
  ADD COLUMN IF NOT EXISTS "rejectionReason"  text;

ALTER TABLE "users"
  ADD COLUMN IF NOT EXISTS "approvalStatus"      "AgencyApprovalStatus" NOT NULL DEFAULT 'APPROVED',
  ADD COLUMN IF NOT EXISTS "approvedById"        text,
  ADD COLUMN IF NOT EXISTS "approvedAt"          timestamp,
  ADD COLUMN IF NOT EXISTS "allowManagerEdit"    boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "allowManagerDelete"  boolean NOT NULL DEFAULT false;

-- If an earlier failed run left `approvedById` as uuid, convert it to
-- text so Prisma (which treats `String` as text) lines up. No-op when
-- the column is already text or the table is fresh.
DO $$ BEGIN
  ALTER TABLE "applicants" ALTER COLUMN "approvedById" TYPE text USING "approvedById"::text;
EXCEPTION WHEN undefined_column THEN NULL;
         WHEN cannot_coerce THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "users" ALTER COLUMN "approvedById" TYPE text USING "approvedById"::text;
EXCEPTION WHEN undefined_column THEN NULL;
         WHEN cannot_coerce THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS "idx_applicants_approval_status" ON "applicants" ("approvalStatus");
CREATE INDEX IF NOT EXISTS "idx_users_approval_status"       ON "users" ("approvalStatus");

-- ─── 3. Per-employee agency-access grants ──────────────────────────────
CREATE TABLE IF NOT EXISTS "employee_agency_access" (
  "id"           text       PRIMARY KEY,
  "employeeId"   text       NOT NULL REFERENCES "employees" ("id") ON DELETE CASCADE,
  "agencyId"     text       NOT NULL REFERENCES "agencies"  ("id") ON DELETE CASCADE,
  "grantedById"  text       REFERENCES "users" ("id") ON DELETE SET NULL,
  "grantedAt"    timestamp  NOT NULL DEFAULT now(),
  "notes"        text,
  UNIQUE ("employeeId", "agencyId")
);

CREATE INDEX IF NOT EXISTS "idx_employee_agency_access_agency"   ON "employee_agency_access" ("agencyId");
CREATE INDEX IF NOT EXISTS "idx_employee_agency_access_employee" ON "employee_agency_access" ("employeeId");

-- ─── 4. Agency-wide permission overrides ───────────────────────────────
CREATE TABLE IF NOT EXISTS "agency_permission_overrides" (
  "id"          text       PRIMARY KEY,
  "agencyId"    text       NOT NULL REFERENCES "agencies" ("id") ON DELETE CASCADE,
  "permission"  text       NOT NULL,
  "allow"       boolean    NOT NULL DEFAULT true,
  "createdAt"   timestamp  NOT NULL DEFAULT now(),
  "updatedAt"   timestamp  NOT NULL DEFAULT now(),
  UNIQUE ("agencyId", "permission")
);

CREATE INDEX IF NOT EXISTS "idx_agency_permission_overrides_agency" ON "agency_permission_overrides" ("agencyId");
