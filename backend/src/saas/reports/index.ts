/**
 * Tenant-safe reports scaffolding (DORMANT).
 *
 * Phase 2 ships this side-by-side with the legacy
 * `backend/src/reports/reports.service.ts`. No production code path
 * imports from here yet. The legacy engine continues to be the live
 * surface.
 *
 * Phase 3 cuts the live engine over to this scaffolding behind the
 * `TENANT_PRISMA_ENFORCEMENT` flag.
 */
export * from './source-def.types';
export * from './sql-guards';
export * from './where-builder';
export {
  TenantSafeReportSourceRegistry,
  tenantSafeReportSources,
} from './source-registry';
