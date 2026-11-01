/**
 * Phase 2.41 — compliance cron framework wiring.
 *
 * The single decorated entry-point for any background scheduling
 * framework. The cron handler itself does NOT contain tenant
 * enumeration, alert-generation logic, dispatch logic, or any Prisma
 * call. It only delegates to:
 *
 *   ComplianceScheduler.runScheduledComplianceAlertGeneration()
 *
 * which preserves the Phase 2.40 runtime guard
 * (COMPLIANCE_ALERT_SCHEDULER_ENABLED), the Phase 2.39 fan-out gate
 * (TENANT_JOB_FANOUT_ENABLED), the Phase 2.38 per-tenant ALS attach,
 * and the Phase 2.8 pilot scope.
 *
 * Forbidden in this file:
 *   - calling ComplianceService.generateAlerts()
 *   - calling ComplianceService.generateAlertsForTenant()
 *   - calling ComplianceService.dispatchComplianceAlertGenerationForTenants()
 *   - any direct Prisma access
 *
 * Source-level meta-assertions in the harness enforce all four.
 *
 * Cron expression note:
 *   @Cron requires a string at decoration time. We read
 *   COMPLIANCE_ALERT_SCHEDULER_CRON at module-evaluation time and
 *   default to every 6 hours. Changing the env requires a process
 *   restart (acceptable: this is a deployment-time control). Runtime
 *   enable/disable lives at COMPLIANCE_ALERT_SCHEDULER_ENABLED, which
 *   ComplianceScheduler honours per tick — flipping it does NOT
 *   require a restart.
 *
 * @tenant-reviewed: phase241-compliance-cron-framework
 */
import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { ComplianceScheduler } from './compliance.scheduler';

const CRON_EXPRESSION =
  (process.env.COMPLIANCE_ALERT_SCHEDULER_CRON?.trim() || '0 */6 * * *');

@Injectable()
export class ComplianceCron {
  private readonly logger = new Logger('ComplianceCron');

  constructor(private readonly scheduler: ComplianceScheduler) {}

  /**
   * The single compliance cron entry-point. Delegates to the
   * Phase 2.40 scheduler — never anything else.
   *
   * @tenant-reviewed: phase241-compliance-cron-framework
   */
  @Cron(CRON_EXPRESSION, { name: 'compliance-alert-generation' })
  async tick(): Promise<void> {
    const r = await this.scheduler.runScheduledComplianceAlertGeneration();
    if (r.skipped) {
      this.logger.debug(`[cron] skipped: ${r.reason}`);
      return;
    }
    if (r.refused) {
      this.logger.log(`[cron] dispatch refused: ${r.refused}`);
      return;
    }
    if (r.error) {
      this.logger.warn(`[cron] dispatch error: ${r.error}`);
      return;
    }
    const fail = r.results.filter((x) => !x.ok).length;
    this.logger.log(`[cron] processed=${r.processed} failed=${fail}`);
  }
}
