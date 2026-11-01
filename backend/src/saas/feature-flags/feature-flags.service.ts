import { Injectable, Logger } from '@nestjs/common';
import { FlagKey, FLAG_KEYS, FLAG_DEFAULTS, parseFlag } from './flags';

/**
 * Centralised, typed feature-flag accessor.
 *
 * Reads `process.env` exactly once at construction. Subsequent env mutation
 * is intentionally NOT honoured: feature flags are deployment-time controls,
 * not runtime knobs (predictability > flexibility for tenant-isolation flags).
 */
@Injectable()
export class FeatureFlagsService {
  private readonly logger = new Logger('FeatureFlags');
  private readonly snapshot: Readonly<Record<FlagKey, boolean>>;

  constructor() {
    const snap = {} as Record<FlagKey, boolean>;
    for (const k of FLAG_KEYS) {
      snap[k] = parseFlag(process.env[k], FLAG_DEFAULTS[k]);
    }
    this.snapshot = Object.freeze(snap);
    this.logger.log(
      `Phase 0 feature flags: ${FLAG_KEYS.map(k => `${k}=${this.snapshot[k]}`).join(' ')}`,
    );
  }

  /** Generic read. Prefer the typed accessors below in application code. */
  isEnabled(key: FlagKey): boolean {
    return this.snapshot[key];
  }

  multiTenantEnabled():     boolean { return this.snapshot.MULTI_TENANT_ENABLED; }
  tenantPrismaEnforcement():boolean { return this.snapshot.TENANT_PRISMA_ENFORCEMENT; }
  rlsEnforcement():         boolean { return this.snapshot.RLS_ENFORCEMENT; }
  signedUrlsEnabled():      boolean { return this.snapshot.SIGNED_URLS_ENABLED; }
  tenantSwitchingEnabled(): boolean { return this.snapshot.TENANT_SWITCHING_ENABLED; }
  platformAdminEnabled():   boolean { return this.snapshot.PLATFORM_ADMIN_ENABLED; }
  tenantSafeReportsEnabled():boolean{ return this.snapshot.TENANT_SAFE_REPORTS_ENABLED; }
  tenantContextStagingOnly():boolean{ return this.snapshot.TENANT_CONTEXT_STAGING_ONLY; }
  tenantContextRequiredForSafeReports():boolean{ return this.snapshot.TENANT_CONTEXT_REQUIRED_FOR_SAFE_REPORTS; }
  tenantPrismaPilotEnabled():boolean { return this.snapshot.TENANT_PRISMA_PILOT_ENABLED; }
  tenantAwareJobsEnabled(): boolean { return this.snapshot.TENANT_AWARE_JOBS_ENABLED; }
  tenantJobFanoutEnabled(): boolean { return this.snapshot.TENANT_JOB_FANOUT_ENABLED; }
  tenantAuditLogPilotEnabled(): boolean { return this.snapshot.TENANT_AUDIT_LOG_PILOT_ENABLED; }
  complianceAlertSchedulerEnabled(): boolean { return this.snapshot.COMPLIANCE_ALERT_SCHEDULER_ENABLED; }
  complianceNotifyOnAlert(): boolean { return this.snapshot.COMPLIANCE_NOTIFY_ON_ALERT; }
  notificationDedupEnabled(): boolean { return this.snapshot.NOTIFICATION_DEDUP_ENABLED; }

  /** Test-only: build a service from an explicit map (no env reads). */
  static forTesting(overrides: Partial<Record<FlagKey, boolean>>): FeatureFlagsService {
    const svc = Object.create(FeatureFlagsService.prototype) as FeatureFlagsService;
    const snap = {} as Record<FlagKey, boolean>;
    for (const k of FLAG_KEYS) snap[k] = overrides[k] ?? FLAG_DEFAULTS[k];
    (svc as any).snapshot = Object.freeze(snap);
    (svc as any).logger = new Logger('FeatureFlags(test)');
    return svc;
  }

  /** Read-only export for `/bootstrap` shaping in Phase 4. */
  publicSnapshot(): Readonly<Record<FlagKey, boolean>> {
    return this.snapshot;
  }
}
