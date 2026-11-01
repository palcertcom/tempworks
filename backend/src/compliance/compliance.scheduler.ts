/**
 * Phase 2.40 — compliance real scheduler entry point.
 *
 * The ONLY supported scheduler/cron/queue handler for compliance alert
 * generation. Wraps the Phase 2.39 fan-out helper with a flag guard
 * and structured result/error handling, so a future cron framework
 * (Nest @nestjs/schedule, Bull, k8s CronJob, …) only needs to:
 *
 *   await complianceScheduler.runScheduledComplianceAlertGeneration();
 *
 * Every guard layer below MUST be preserved by any future scheduler:
 *
 *   COMPLIANCE_ALERT_SCHEDULER_ENABLED=false
 *     ⇒ this.runScheduledComplianceAlertGeneration() returns
 *       { skipped: true, reason: 'COMPLIANCE_ALERT_SCHEDULER_ENABLED=false' }
 *       and runs zero queries.
 *
 *   COMPLIANCE_ALERT_SCHEDULER_ENABLED=true AND TENANT_JOB_FANOUT_ENABLED=false
 *     ⇒ dispatch helper is invoked but immediately refuses; zero scans.
 *
 *   scheduler + fanout + compliance pilot active
 *     ⇒ dispatch enumerates ACTIVE tenants and runs
 *       generateAlertsForTenant per tenant.
 *
 * The handler MUST NOT call:
 *   - ComplianceService.generateAlerts() directly
 *   - ComplianceService.generateAlertsForTenant() directly
 *   - any raw Prisma alert scan
 *
 * Source-level meta-assertions in the harness enforce this.
 *
 * @tenant-reviewed: phase240-compliance-real-scheduler
 */
import { Injectable, Logger } from '@nestjs/common';
import { ComplianceService } from './compliance.service';
import { FeatureFlagsService } from '../saas/feature-flags/feature-flags.service';

export interface ScheduledRunResult {
  /** True when the scheduler refused to run because its own flag is off. */
  skipped: boolean;
  /** Human-readable reason when `skipped` is true. */
  reason?: string;
  /** Forwarded refusal reason from the dispatch helper, when applicable. */
  refused?: string;
  /** Number of tenants processed by the dispatch helper. */
  processed: number;
  /** Per-tenant results forwarded from the dispatch helper. */
  results: Array<{
    tenantId: string;
    ok: boolean;
    total?: number;
    message?: string;
    error?: string;
    notify?: { skipped?: string; refused?: string; notified?: number; deduped?: number; error?: string };
  }>;
  /** Configured cron expression (informational; no scheduler binds to it yet). */
  cron?: string;
  /** Caught error message when the dispatch helper itself throws unexpectedly. */
  error?: string;
  /** Phase 2.44 — operator-visible health summary; emitted as a structured log line. */
  health?: ScheduledHealthSummary;
}

/**
 * Phase 2.44 — normalized scheduler health summary.
 *
 * Counts only — no document/user names, no payload data, no PII. Suitable
 * for ingestion by external log aggregation (Loki, ELK, CloudWatch) which
 * can then alert on `status=partial_failure` / `status=failed` /
 * `failed > 0` / `notifyFailed > 0`.
 */
export interface ScheduledHealthSummary {
  /** Stable job name. */
  job: 'compliance-alert-generation';
  /** High-level outcome (see status rules in SAAS_PHASE2_COMPLIANCE_SCHEDULER_HEALTH.md). */
  status: 'skipped' | 'ok' | 'partial_failure' | 'failed';
  /** Mirrors `ScheduledRunResult.skipped`. */
  skipped: boolean;
  /** Mirrors `ScheduledRunResult.refused`. */
  refused?: string;
  /** Number of tenants the dispatch helper iterated. */
  processed: number;
  /** Tenants whose scan completed without error. */
  succeeded: number;
  /** Tenants whose scan threw. */
  failed: number;
  /** Sum of per-tenant `total` fields (compliance alerts created during this tick). */
  alertsCreated: number;
  /** Tenants whose notification coupling reported `notify.notified > 0`. */
  notifySucceeded: number;
  /** Tenants whose notification coupling reported a `notify.skipped` or `notify.refused`. */
  notifySkipped: number;
  /** Tenants whose notification coupling reported a `notify.error`. */
  notifyFailed: number;
  /** Sum of per-tenant `notify.deduped` (Phase 2.45). */
  notifyDeduped: number;
  /** Scheduler-level synthetic error message, when status='failed'. */
  error?: string;
  /** Configured cron expression. */
  cron: string;
  /** ISO-8601 timestamp at which the summary was produced. */
  timestamp: string;
}

@Injectable()
export class ComplianceScheduler {
  private readonly logger = new Logger('ComplianceScheduler');

  constructor(
    private readonly compliance: ComplianceService,
    private readonly flags: FeatureFlagsService,
  ) {}

  /**
   * Configured cron expression. Read from COMPLIANCE_ALERT_SCHEDULER_CRON
   * (default 0 [slash]6 [star] [star] [star] — every six hours).
   * Informational only — no cron framework is wired in this phase.
   */
  cron(): string {
    return process.env.COMPLIANCE_ALERT_SCHEDULER_CRON?.trim() || '0 */6 * * *';
  }

  /**
   * The single supported scheduler entry point. Call this from any
   * future cron / Bull / queue handler. Never call the compliance
   * service directly from a scheduler.
   *
   * Always returns a structured result; never throws.
   */
  async runScheduledComplianceAlertGeneration(): Promise<ScheduledRunResult> {
    const cron = this.cron();
    let result: ScheduledRunResult;
    if (!this.flags.complianceAlertSchedulerEnabled()) {
      result = {
        skipped: true,
        reason: 'COMPLIANCE_ALERT_SCHEDULER_ENABLED=false',
        processed: 0,
        results: [],
        cron,
      };
    } else {
      try {
        // The dispatch helper applies its own refusal contract
        // (TENANT_JOB_FANOUT_ENABLED, pilot active, env safe). The
        // scheduler only forwards the result.
        // @tenant-reviewed: phase240-compliance-real-scheduler
        const r = await this.compliance.dispatchComplianceAlertGenerationForTenants();
        result = {
          skipped: false,
          refused: r.refused,
          processed: r.processed,
          results: r.results,
          cron,
        };
      } catch (e: any) {
        // The dispatch helper is designed not to throw, but a future
        // refactor could. Catch here so a scheduler tick never crashes
        // the host process.
        this.logger.error(`[scheduler] dispatch failed: ${e?.message ?? e}`);
        result = {
          skipped: false,
          processed: 0,
          results: [],
          cron,
          error: String(e?.message ?? e),
        };
      }
    }

    // Phase 2.44 — operator-visible health signal.
    // Compute + emit a structured summary EXACTLY ONCE per tick.
    // Logging itself is wrapped in a try/catch so a misbehaving logger
    // can never crash the tick.
    // @tenant-reviewed: phase244-compliance-scheduler-health
    result.health = this.summarizeHealth(result);
    try {
      // Stable fingerprint string at the head of the message, with
      // structured JSON payload appended. External log aggregators
      // can match on `compliance.scheduler.health` and parse the JSON
      // tail.
      this.logger.log(`compliance.scheduler.health ${JSON.stringify(result.health)}`);
    } catch {
      // Swallow — health-emit MUST NOT crash the tick.
    }
    return result;
  }

  /**
   * Phase 2.44 — pure normalizer. Reads only counts off the
   * `ScheduledRunResult` shape and emits a sanitized summary. No
   * tenant-specific payloads, no document/user names, no PII.
   *
   * @tenant-reviewed: phase244-compliance-scheduler-health
   */
  summarizeHealth(r: ScheduledRunResult): ScheduledHealthSummary {
    const cron = r.cron ?? this.cron();
    const timestamp = new Date().toISOString();

    // Scheduler-level error wins regardless of per-tenant counters.
    if (r.error) {
      return {
        job: 'compliance-alert-generation',
        status: 'failed',
        skipped: false,
        processed: r.processed ?? 0,
        succeeded: 0,
        failed: 0,
        alertsCreated: 0,
        notifySucceeded: 0,
        notifySkipped: 0,
        notifyFailed: 0,
        notifyDeduped: 0,
        error: r.error,
        cron,
        timestamp,
      };
    }

    // Refused / skipped paths — refused is preserved on the summary;
    // status is 'skipped' so a single status-string covers both
    // disabled and refused outcomes for log monitoring purposes.
    if (r.skipped || r.refused) {
      return {
        job: 'compliance-alert-generation',
        status: 'skipped',
        skipped: !!r.skipped,
        refused: r.refused,
        processed: r.processed ?? 0,
        succeeded: 0,
        failed: 0,
        alertsCreated: 0,
        notifySucceeded: 0,
        notifySkipped: 0,
        notifyFailed: 0,
        notifyDeduped: 0,
        cron,
        timestamp,
      };
    }

    // Roll up per-tenant counters.
    let succeeded = 0;
    let failed = 0;
    let alertsCreated = 0;
    let notifySucceeded = 0;
    let notifySkipped = 0;
    let notifyFailed = 0;
    let notifyDeduped = 0;
    for (const x of r.results) {
      if (x.ok) succeeded += 1; else failed += 1;
      alertsCreated += x.total ?? 0;
      if (x.notify) {
        if (x.notify.error) notifyFailed += 1;
        else if (x.notify.notified && x.notify.notified > 0) notifySucceeded += 1;
        else if (x.notify.skipped || x.notify.refused) notifySkipped += 1;
        if (typeof x.notify.deduped === 'number') notifyDeduped += x.notify.deduped;
      }
    }

    const status: ScheduledHealthSummary['status'] =
      (failed > 0 || notifyFailed > 0) ? 'partial_failure' : 'ok';

    return {
      job: 'compliance-alert-generation',
      status,
      skipped: false,
      processed: r.processed ?? 0,
      succeeded,
      failed,
      alertsCreated,
      notifySucceeded,
      notifySkipped,
      notifyFailed,
      notifyDeduped,
      cron,
      timestamp,
    };
  }
}
