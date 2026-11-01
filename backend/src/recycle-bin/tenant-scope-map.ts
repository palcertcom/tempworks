/**
 * Phase 2.11 — recycle-bin entity tenant-scope map.
 *
 * Tells the four services which entity types should receive a
 * `tenantId = ctx` filter when the pilot scope is active. Global /
 * catalog / pre-Phase-2.3 entities are NOT filtered (the column
 * either does not exist or is intentionally global).
 *
 * Adding a new entity type here requires:
 *  1. Confirming the underlying model has a `tenantId` column.
 *  2. Updating SAAS_PHASE2_RECYCLE_BIN_SCOPE_MAP.md.
 *  3. Updating the equivalence + isolation harnesses.
 */
export const TENANT_SCOPED_ENTITIES: ReadonlySet<string> = new Set([
  'APPLICANT',          // Phase 1
  'EMPLOYEE',           // Phase 1
  'AGENCY',             // Phase 1
  'DOCUMENT',           // Phase 2.3
  'FINANCIAL_RECORD',   // Phase 2.3
  'JOB_AD',             // Phase 2.9
  'NOTIFICATION',       // Phase 2.3
  'VEHICLE',            // Phase 2.3
  'VEHICLE_DOCUMENT',   // Phase 2.3
  'MAINTENANCE_RECORD', // Phase 2.3
]);

/** Models recycle-bin reads/restores that intentionally remain global. */
export const GLOBAL_RECYCLE_ENTITIES: ReadonlySet<string> = new Set([
  'USER',
  'ROLE',
  'DOCUMENT_TYPE',     // global catalog
  'JOB_TYPE',          // global catalog (soft-delete via isActive=false)
  'MAINTENANCE_TYPE',  // global catalog
  'WORKSHOP',          // shared service-provider table
  'REPORT',            // no tenantId column today
]);

export function isTenantScopedEntity(entityType: string): boolean {
  return TENANT_SCOPED_ENTITIES.has(entityType);
}
