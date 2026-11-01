import { Injectable, OnModuleInit, Logger } from '@nestjs/common';
import { NotificationsService } from './notifications.service';
import { FeatureFlagsService } from '../saas/feature-flags/feature-flags.service';
import { classifyRuntimeEnv, isStagingClassification } from '../saas/tenancy/env-safety';

/**
 * Notifications scheduler.
 *
 * Phase 2.14 dispatch:
 *   - flags OFF (production default) → legacy `runAllChecks()`
 *     iterates fleet managers across all tenants exactly as before.
 *   - `TENANT_AWARE_JOBS_ENABLED=true`
 *     AND `TENANT_JOB_FANOUT_ENABLED=true`
 *     AND env classifies as SAFE_CLONE / SAFE_STAGING
 *     → tenant-aware `runAllChecksTenantAware()` plans per-tenant
 *     fanout via `TenantJobFanoutPlanner` and runs each tenant
 *     inside `runForTenant`.
 *   - flags ON outside staging → refused at the service layer
 *     (NotificationsService.runAllChecksTenantAware throws via the
 *     framework's `MissingSafeEnvError`).
 *
 * Cron timing is UNCHANGED: every 6 hours, plus once at boot.
 */
@Injectable()
export class NotificationsSchedulerService implements OnModuleInit {
  private readonly logger = new Logger('NotificationsScheduler');
  private intervalId: NodeJS.Timeout | null = null;

  constructor(
    private readonly notificationsService: NotificationsService,
    private readonly flags: FeatureFlagsService,
  ) {}

  onModuleInit() {
    this.startScheduler();
  }

  /**
   * Choose the active path. The scheduler service stays small; the
   * NotificationsService owns the actual fanout + per-tenant logic.
   */
  private async runOnce(): Promise<void> {
    if (this.shouldUseTenantAwarePath()) {
      this.logger.log('[scheduler] tenant-aware path active');
      await this.notificationsService.runAllChecksTenantAware();
      return;
    }
    // Legacy path. Cross-tenant iteration; unchanged from Phase 0.
    await this.notificationsService.runAllChecks();
  }

  private shouldUseTenantAwarePath(): boolean {
    if (!this.flags.tenantAwareJobsEnabled()) return false;
    if (!this.flags.tenantJobFanoutEnabled()) return false;
    const env = classifyRuntimeEnv();
    return isStagingClassification(env.classification);
  }

  private startScheduler() {
    // Run notification checks every 6 hours.
    const sixHoursInMs = 6 * 60 * 60 * 1000;

    // Run immediately on startup.
    this.runOnce().catch((err) => {
      this.logger.error(`Failed to run initial notification checks: ${err?.message ?? err}`);
    });

    this.intervalId = setInterval(() => {
      this.runOnce().catch((err) => {
        this.logger.error(`Failed to run scheduled notification checks: ${err?.message ?? err}`);
      });
    }, sixHoursInMs);

    this.logger.log('Notifications scheduler started (every 6 hours)');
  }

  onModuleDestroy() {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.logger.log('Notifications scheduler stopped');
    }
  }
}
