/**
 * Daily employment-status sweep.
 *
 * Auto-transitions an employee to TERMINATED once the last day of their
 * most recent contract has fully passed (status flips after 00:00 the
 * following day, in CONTRACT_STATUS_TZ). This lets HR enter a
 * termination in advance without the status changing early.
 *
 * Runs shortly after midnight so the flip lands on the correct day, plus
 * once at boot to catch anything missed while the service was down.
 * The precise per-employee calendar check lives in
 * ContractsService.evaluateEmployeeStatusFromContracts — this cron only
 * schedules the sweep.
 */
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { ContractsService } from './contracts.service';

// 00:20 daily in the configured timezone — just after midnight so an
// employee whose contract ended "yesterday" is terminated first thing.
const CRON_EXPRESSION = process.env.CONTRACT_STATUS_CRON?.trim() || '20 0 * * *';
const CRON_TIMEZONE = process.env.CONTRACT_STATUS_TZ?.trim() || 'Europe/Bratislava';

@Injectable()
export class ContractStatusCron implements OnModuleInit {
  private readonly logger = new Logger('ContractStatusCron');

  constructor(private readonly contracts: ContractsService) {}

  async onModuleInit(): Promise<void> {
    // Best-effort catch-up on boot; never block startup.
    this.runOnce().catch(() => undefined);
  }

  @Cron(CRON_EXPRESSION, { name: 'contract-status-sweep', timeZone: CRON_TIMEZONE })
  async tick(): Promise<void> {
    await this.runOnce();
  }

  private async runOnce(): Promise<void> {
    try {
      const r = await this.contracts.runStatusSweep();
      if (r.terminated > 0) {
        this.logger.log(`[contract-status] scanned=${r.scanned} terminated=${r.terminated}`);
      }
    } catch (err: any) {
      this.logger.warn(`[contract-status] sweep failed: ${err?.message ?? err}`);
    }
  }
}
