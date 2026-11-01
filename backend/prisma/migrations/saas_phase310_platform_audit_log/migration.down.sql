-- =============================================================================
-- SaaS Phase 3.10 — DOWN migration
-- =============================================================================
-- Drops the `platform_audit_logs` table created by the UP migration.
-- Any rows recorded in the audit log are lost. No production audit
-- emission is wired by Phase 3.10 (emission is deferred until a
-- runtime grant/revoke surface exists), so DROP is safe in development.
-- =============================================================================

BEGIN;

DROP TABLE IF EXISTS "platform_audit_logs";

COMMIT;
