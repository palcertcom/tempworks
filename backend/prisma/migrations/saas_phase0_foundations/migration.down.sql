-- Rollback for SaaS Phase 0 foundations.
-- Safe to run BEFORE any data is written into these tables.
BEGIN;
DROP TABLE IF EXISTS "tenant_domains";
DROP TABLE IF EXISTS "platform_audit_logs";
DROP TABLE IF EXISTS "platform_admins";
DROP TABLE IF EXISTS "membership_permission_overrides";
DROP TABLE IF EXISTS "agency_memberships";
DROP TABLE IF EXISTS "membership_roles";
DROP TABLE IF EXISTS "tenant_memberships";
DROP TABLE IF EXISTS "tenants";
DROP TYPE IF EXISTS "PlatformAdminLevel";
DROP TYPE IF EXISTS "AgencyMembershipScope";
DROP TYPE IF EXISTS "MembershipStatus";
DROP TYPE IF EXISTS "TenantStatus";
COMMIT;
