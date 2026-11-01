-- =============================================================================
-- SaaS Phase 3.10 — Create platform_audit_logs table
-- =============================================================================
-- Adds the table backing the existing Prisma `PlatformAuditLog` model.
-- The Prisma model was added in Phase 2 but no migration created the
-- underlying DB table; this migration closes that gap.
--
-- Additive only:
--   - CREATE TABLE IF NOT EXISTS (idempotent).
--   - Indexes match the @@index annotations on the Prisma model.
--   - No data mutation.
--   - No FK to users(id) — `actorId` is plain text so backfill / system
--     actors (e.g. 'phase350-backfill') can be recorded.
--
-- Tag: phase310-platform-audit-log-migration
-- =============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS "platform_audit_logs" (
  "id"         BIGSERIAL                   PRIMARY KEY,
  "actorId"    text                        NOT NULL,
  "tenantId"   text,
  "action"     text                        NOT NULL,
  "reason"     text                        NOT NULL,
  "target"     jsonb,
  "ip"         text,
  "userAgent"  text,
  "createdAt"  timestamp(3)                NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS "platform_audit_logs_actorId_createdAt_idx"
  ON "platform_audit_logs" ("actorId", "createdAt");

CREATE INDEX IF NOT EXISTS "platform_audit_logs_tenantId_createdAt_idx"
  ON "platform_audit_logs" ("tenantId", "createdAt");

COMMIT;
