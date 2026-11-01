/**
 * Tenant-safe reports runtime — Phase 2.1.
 *
 * Loaded behind `TENANT_SAFE_REPORTS_ENABLED`. The default (false) keeps
 * the legacy `backend/src/reports/reports.service.ts` as the live engine.
 */
export {
  TenantSafeReportsService,
  TenantSafeReportsDisabledError,
  TenantSafeReportsUnknownSourceError,
  TenantSafeReportsSourceDisabledError,
  TenantSafeReportsMissingTenantError,
} from './tenant-safe-reports.service';
export type { RunReportRequest, RunReportResult } from './tenant-safe-reports.service';
export {
  TENANT_SAFE_SOURCES,
  readySourceKeys,
  disabledSources,
} from './report-sources';
export type { MappedSource, SourceStatus } from './report-sources';
