-- =============================================================================
-- Phase 2.10 fixture extension — additive only.
-- =============================================================================
-- Adds the columns Prisma's Notification model expects on the staging
-- fixture's narrow `notifications` table, plus the `notification_preferences`
-- table, and seeds two-tenant notification rows for the read-path harness.
--
-- Idempotent. Safe to re-run. Production already has these columns.
-- =============================================================================

BEGIN;

-- Enum type
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'NotificationType') THEN
    CREATE TYPE "NotificationType" AS ENUM (
      'INFO','WARNING','ERROR','SUCCESS','COMPLIANCE','DOCUMENT_EXPIRY','WORKFLOW','SYSTEM','FINANCIAL',
      'VEHICLE_MOT_EXPIRING','VEHICLE_TAX_EXPIRING','VEHICLE_INSURANCE_EXPIRING',
      'VEHICLE_REGISTRATION_EXPIRING','VEHICLE_TACHOGRAPH_EXPIRING','VEHICLE_ATP_EXPIRING',
      'VEHICLE_PRESSURE_TEST_DUE','VEHICLE_SERVICE_DUE','VEHICLE_SERVICE_OVERDUE'
    );
  END IF;
END $$;

ALTER TABLE notifications ADD COLUMN IF NOT EXISTS title           text;
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS message         text;
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS "titleKey"      text;
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS "messageKey"    text;
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS params          jsonb;
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS type            "NotificationType" NOT NULL DEFAULT 'INFO';
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS "eventType"     text;
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS channel         text NOT NULL DEFAULT 'in_app';
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS "isRead"        boolean NOT NULL DEFAULT false;
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS "relatedEntity" text;
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS "relatedEntityId" text;
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS "daysUntilDue"  int;
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS "kmUntilDue"    int;
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS severity        text;
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS "deletedAt"     timestamptz;
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS "deletedBy"     uuid;
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS "deletionReason" text;

-- Backfill required NOT NULL fields on legacy rows.
UPDATE notifications SET title = COALESCE(title, kind), message = COALESCE(message, '') WHERE title IS NULL OR message IS NULL;
ALTER TABLE notifications ALTER COLUMN title   SET NOT NULL;
ALTER TABLE notifications ALTER COLUMN message SET NOT NULL;

-- notification_preferences (per-user global; no tenantId).
CREATE TABLE IF NOT EXISTS notification_preferences (
  id                          uuid PRIMARY KEY,
  "userId"                    uuid UNIQUE NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  "complianceDaysBefore"      int  NOT NULL DEFAULT 30,
  "serviceKmBefore"           int  NOT NULL DEFAULT 500,
  "enableEmailNotifications"  boolean NOT NULL DEFAULT true,
  "enableInAppNotifications"  boolean NOT NULL DEFAULT true,
  "createdAt"                 timestamptz NOT NULL DEFAULT now(),
  "updatedAt"                 timestamptz NOT NULL DEFAULT now()
);

-- Seed two tenants' worth of notifications.
DO $do$
DECLARE
  ta uuid;
  tb uuid;
  user_a uuid;
  user_b uuid;
BEGIN
  SELECT t.id INTO ta
    FROM tenants t
   WHERE EXISTS (SELECT 1 FROM users u WHERE u."agencyId" IN (SELECT id FROM agencies WHERE "tenantId" = t.id::text))
   ORDER BY t.name OFFSET 0 LIMIT 1;
  SELECT t.id INTO tb
    FROM tenants t
   WHERE EXISTS (SELECT 1 FROM users u WHERE u."agencyId" IN (SELECT id FROM agencies WHERE "tenantId" = t.id::text))
     AND t.id::text <> ta::text
   ORDER BY t.name OFFSET 0 LIMIT 1;
  IF ta IS NULL OR tb IS NULL THEN
    RAISE NOTICE '[phase210-notifications-extension] need 2 tenants; got ta=%, tb=%', ta, tb;
    RETURN;
  END IF;

  SELECT u.id INTO user_a FROM users u
   WHERE u."agencyId" IN (SELECT id FROM agencies WHERE "tenantId" = ta::text)
   LIMIT 1;
  SELECT u.id INTO user_b FROM users u
   WHERE u."agencyId" IN (SELECT id FROM agencies WHERE "tenantId" = tb::text)
   LIMIT 1;
  IF user_a IS NULL OR user_b IS NULL THEN
    RAISE NOTICE '[phase210-notifications-extension] need 1 user per tenant; got user_a=%, user_b=%', user_a, user_b;
    RETURN;
  END IF;

  INSERT INTO notifications (id, "userId", kind, "tenantId", title, message, type, "isRead", "createdAt")
  VALUES
    -- Tenant A: 3 unread, 1 read
    ('00000000-0000-0000-0000-000000c00001', user_a, 'INFO', ta::text, 'A: hello',     'tenant A msg 1', 'INFO',    false, now()),
    ('00000000-0000-0000-0000-000000c00002', user_a, 'INFO', ta::text, 'A: warning',   'tenant A msg 2', 'WARNING', false, now()),
    ('00000000-0000-0000-0000-000000c00003', user_a, 'INFO', ta::text, 'A: another',   'tenant A msg 3', 'INFO',    false, now()),
    ('00000000-0000-0000-0000-000000c00004', user_a, 'INFO', ta::text, 'A: read msg',  'tenant A msg 4', 'INFO',    true,  now()),
    -- Tenant B: 2 unread, 1 read
    ('00000000-0000-0000-0000-000000c00101', user_b, 'INFO', tb::text, 'B: hello',     'tenant B msg 1', 'INFO',    false, now()),
    ('00000000-0000-0000-0000-000000c00102', user_b, 'INFO', tb::text, 'B: warning',   'tenant B msg 2', 'WARNING', false, now()),
    ('00000000-0000-0000-0000-000000c00103', user_b, 'INFO', tb::text, 'B: read msg',  'tenant B msg 3', 'INFO',    true,  now()),
    -- NULL-tenant legacy row, owned by user_a.
    ('00000000-0000-0000-0000-000000c00999', user_a, 'INFO', NULL,     'legacy', 'pre-Phase-2.10 row',   'INFO',    false, now() - interval '7 days')
  ON CONFLICT (id) DO NOTHING;

  -- High-balance probe row for wasHighBalanceAlertRecentlySent test.
  INSERT INTO notifications (id, "userId", kind, "tenantId", title, message, type, "relatedEntityId", "isRead", "createdAt")
  VALUES
    ('00000000-0000-0000-0000-000000c00501', user_a, 'WARN', ta::text, 'A: high balance', 'recent', 'WARNING', '00000000-0000-0000-0000-deadbeef0001', false, now()),
    ('00000000-0000-0000-0000-000000c00502', user_b, 'WARN', tb::text, 'B: high balance', 'recent', 'WARNING', '00000000-0000-0000-0000-deadbeef0001', false, now())
  ON CONFLICT (id) DO NOTHING;
END $do$;

COMMIT;
