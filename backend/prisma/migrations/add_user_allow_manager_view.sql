-- Per-user manager view override — third flag in the existing
-- allowManagerEdit / allowManagerDelete pair. Default true so any
-- existing agency user rows stay visible to the owning tenant
-- (the lock-down kicks in only when a Tempworks admin explicitly
-- toggles view off for a specific user).
ALTER TABLE "users"
  ADD COLUMN IF NOT EXISTS "allowManagerView" boolean NOT NULL DEFAULT true;
