/**
 * Tenant-scoped model registry — Phase 0 manifest.
 *
 * Models in this set will, when `TENANT_PRISMA_ENFORCEMENT` is ON, have
 * `tenantId` injected into queries and `SET LOCAL app.tenant_id` issued
 * inside a transaction wrapper.
 *
 * Phase 0 ships this manifest EMPTY. Phase 2 will add models in this
 * order as their `tenantId` columns + composite indexes ship:
 *   1. Agency, Vehicle, Employee, Applicant   (already have `agencyId`)
 *   2. Document, ComplianceAlert, FinancialRecord, Visa
 *   3. AttendanceRecord, AttendanceLockedPeriod, Workshop
 *   4. Workflow, WorkflowStage, JobAd, Report, IdentifierSequence
 *   5. AuditLog, Notification, NotificationPreference, RecycleBinItem
 *
 * The full classification lives in `SAAS_DATABASE_MODEL_CLASSIFICATION.md`.
 */

/** Models that, after Phase 2 backfill, must always be filtered by `tenantId`. */
export const TENANT_SCOPED_MODELS: ReadonlySet<string> = new Set<string>([
  // Phase 0: empty. Populated per-model as backfill lands.
]);

/** Catalog/system-reference tables: `tenantId IS NULL` rows are global, others are tenant overrides. */
export const CATALOG_MODELS: ReadonlySet<string> = new Set<string>([
  // Phase 0: empty. Phase 3:
  //   'DocumentType', 'MaintenanceType', 'NotificationRule'
]);

/** Models that must NEVER be filtered (truly global). */
export const GLOBAL_MODELS: ReadonlySet<string> = new Set<string>([
  'User',
  'Tenant',
  'TenantMembership',
  'MembershipRole',
  'AgencyMembership',
  'MembershipPermissionOverride',
  'PlatformAdmin',
  'PlatformAuditLog',
  'TenantDomain',
  'Permission',
  'Role',  // becomes (tenantId, key) capable but registry treats as global look-up
]);

export function isTenantScoped(model: string): boolean {
  return TENANT_SCOPED_MODELS.has(model);
}

export function classify(model: string): 'TENANT' | 'CATALOG' | 'GLOBAL' | 'UNKNOWN' {
  if (TENANT_SCOPED_MODELS.has(model)) return 'TENANT';
  if (CATALOG_MODELS.has(model))       return 'CATALOG';
  if (GLOBAL_MODELS.has(model))        return 'GLOBAL';
  return 'UNKNOWN';
}
