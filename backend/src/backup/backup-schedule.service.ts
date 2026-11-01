import { Injectable, Logger, OnModuleInit, Optional } from '@nestjs/common';
import { Cron, SchedulerRegistry } from '@nestjs/schedule';
import { CronJob } from 'cron';
import { PrismaService } from '../prisma/prisma.service';
import { AuditLogService } from '../logs/audit-log.service';
import { NotificationsService } from '../notifications/notifications.service';
import { NOTIF_EVENTS } from '../notifications/notification-events';
import { BackupService } from './backup.service';
import { BackupKind } from './dto/backup.dto';
import { hostname } from 'os';

/**
 * Scheduled full-system backups + failure/staleness reporting.
 *
 * Configuration (environment, nothing is enabled by default):
 *   BACKUP_SCHEDULE_CRON   5-field cron, e.g. "17 2 * * *". UNSET = scheduling DISABLED.
 *   BACKUP_SCHEDULE_TZ     IANA timezone for the cron (default "UTC").
 *   BACKUP_SCHEDULE_KIND   FULL_SYSTEM (default) | DATABASE.
 *   BACKUP_STALE_HOURS     alert when the newest COMPLETED+VERIFIED backup is
 *                          older than this (default 26). Checked hourly.
 *   BACKUP_RETENTION_COUNT applied after every successful backup (BackupService).
 *
 * Several app instances: every instance's cron fires for every occurrence.
 * Each occurrence is CLAIMED with an INSERT into backup_schedule_claims
 * (primary key = schedule + occurrence time rounded to the minute); only the
 * instance whose insert succeeds runs it, the others log and stand down. The
 * hourly staleness alert is claimed the same way, so alerts are not repeated
 * per instance.
 *
 * Overlap safety: a scheduled run goes through BackupService.createBackup,
 * which takes the cross-instance PostgreSQL advisory lock. If a manual or
 * other-instance backup/restore is running, the scheduled run is SKIPPED and
 * reported — never run concurrently.
 *
 * Reporting uses the existing mechanisms: an audit-log entry, an error log
 * line, and a SYSTEM_AUDIT_ALERT in-app/email notification to System Admins.
 */
@Injectable()
export class BackupScheduleService implements OnModuleInit {
  private readonly logger = new Logger('BackupSchedule');
  static readonly JOB_NAME = 'tempworks-scheduled-backup';
  private lastRun: { at: string; outcome: string; backupId?: string; detail?: string } | null = null;
  private readonly instance = `${process.env.HOSTNAME || hostname()}:${process.pid}`;

  constructor(
    private readonly backups: BackupService,
    private readonly prisma: PrismaService,
    private readonly auditLog: AuditLogService,
    private readonly scheduler: SchedulerRegistry,
    @Optional() private readonly notifications?: NotificationsService,
  ) {}

  config() {
    const cron = (process.env.BACKUP_SCHEDULE_CRON || '').trim();
    return {
      enabled: cron.length > 0,
      cron: cron || null,
      timezone: process.env.BACKUP_SCHEDULE_TZ || 'UTC',
      kind: process.env.BACKUP_SCHEDULE_KIND === 'DATABASE' ? BackupKind.DATABASE : BackupKind.FULL_SYSTEM,
      staleHours: Number(process.env.BACKUP_STALE_HOURS || 26),
      retentionCount: Number(process.env.BACKUP_RETENTION_COUNT || 10),
    };
  }

  onModuleInit(): void {
    const c = this.config();
    if (!c.enabled) {
      this.logger.warn('Scheduled backups are DISABLED (BACKUP_SCHEDULE_CRON is not set).');
      return;
    }
    try {
      const job = CronJob.from({ cronTime: c.cron!, onTick: () => { void this.onTick(); }, timeZone: c.timezone });
      this.scheduler.addCronJob(BackupScheduleService.JOB_NAME, job as any);
      job.start();
      this.logger.log(`Scheduled ${c.kind} backups: cron "${c.cron}" (${c.timezone}); next run ${job.nextDate().toISO()}`);
    } catch (e: any) {
      this.logger.error(`Invalid BACKUP_SCHEDULE_CRON "${c.cron}" / TZ "${c.timezone}": ${e?.message ?? e} — scheduling NOT active.`);
    }
  }

  /**
   * Claim an occurrence across instances. true = this instance owns it.
   * Instances fire within seconds of each other; rounding to the minute gives
   * them the same key. If the claim table is unavailable we fall back to
   * running (the advisory lock still prevents concurrent backups).
   */
  async claim(occurrence: string): Promise<boolean> {
    try {
      const n = await (this.prisma as any).$executeRawUnsafe(
        `INSERT INTO "backup_schedule_claims" ("occurrence", "instance") VALUES ($1, $2) ON CONFLICT DO NOTHING`,
        occurrence, this.instance);
      return n === 1;
    } catch (e: any) {
      this.logger.warn(`occurrence claim unavailable (${e?.message ?? e}) — relying on the backup lock only`);
      return true;
    }
  }

  private occurrenceKey(prefix: string, at = Date.now(), unitMs = 60_000): string {
    return `${prefix}:${new Date(Math.round(at / unitMs) * unitMs).toISOString()}`;
  }

  async onTick(at = Date.now()): Promise<boolean> {
    const key = this.occurrenceKey(`backup:${this.config().cron}`, at);
    if (!(await this.claim(key))) {
      this.logger.log(`Scheduled occurrence ${key} already claimed by another instance — not running here.`);
      return false;
    }
    this.logger.log(`Scheduled occurrence ${key} claimed by ${this.instance}.`);
    await this.runScheduled();
    return true;
  }

  /** One scheduled run (also callable directly by tests). */
  async runScheduled(): Promise<void> {
    const c = this.config();
    const at = new Date().toISOString();
    try {
      const row = await this.backups.createBackup({ kind: c.kind, notes: '[SCHEDULED]' } as any);
      this.lastRun = { at, outcome: 'STARTED', backupId: row.id };
      const final = await this.waitFor(row.id, 6 * 60 * 60_000);
      this.lastRun = { at, outcome: final?.status ?? 'UNKNOWN', backupId: row.id };
      if (final?.status === 'DEGRADED') {
        await this.alert('Scheduled backup is DEGRADED (not a complete recovery point)',
          `Scheduled ${c.kind} backup ${row.id} is consistent but incomplete: ${final?.errorMessage ?? ''}`, row.id);
      } else if (final?.status !== 'COMPLETED') {
        await this.alert('Scheduled backup did not complete',
          `Scheduled ${c.kind} backup ${row.id} ended ${final?.status ?? 'UNKNOWN'}: ${final?.errorMessage ?? ''}`, row.id);
      } else if (final.verifyResult !== 'VERIFIED') {
        await this.alert('Scheduled backup failed verification', `Backup ${row.id} completed but integrity verification is ${final.verifyResult ?? 'missing'}.`, row.id);
      } else if (process.env.BACKUP_SPACES_BUCKET && final.offsiteStatus !== 'VERIFIED') {
        await this.alert('Scheduled backup has no verified off-site copy', `Backup ${row.id}: off-site status ${final.offsiteStatus}.`, row.id);
      }
    } catch (e: any) {
      const busy = e?.status === 503 || /in progress/i.test(e?.message ?? '');
      this.lastRun = { at, outcome: busy ? 'SKIPPED_BUSY' : 'FAILED', detail: e?.message };
      await this.auditLog.log({
        action: busy ? 'BACKUP_SCHEDULE_SKIPPED' : 'BACKUP_SCHEDULE_FAILED', entity: 'SystemBackup', entityId: 'schedule',
        changes: { reason: e?.message ?? String(e) },
      }).catch(() => undefined);
      if (!busy) await this.alert('Scheduled backup could not start', e?.message ?? String(e));
      else this.logger.warn(`Scheduled backup skipped — another backup/restore holds the lock: ${e?.message}`);
    }
  }

  private async waitFor(id: string, timeoutMs: number): Promise<any> {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      const r = await (this.prisma as any).systemBackup.findUnique({ where: { id } });
      if (r && r.status !== 'RUNNING') {
        // Give the post-backup integrity verification a moment to record.
        for (let i = 0; i < 120 && !r.verifyResult && r.status === 'COMPLETED'; i++) {
          await new Promise((res) => setTimeout(res, 1000));
          Object.assign(r, await (this.prisma as any).systemBackup.findUnique({ where: { id } }));
        }
        return r;
      }
      await new Promise((res) => setTimeout(res, 5000));
    }
    return null;
  }

  /** Hourly staleness check: alert when no recent recoverable backup exists. */
  @Cron('7 * * * *', { name: 'tempworks-backup-staleness' })
  async scheduledStaleness(): Promise<void> {
    if (!this.config().enabled) return;
    if (!(await this.claim(this.occurrenceKey('staleness', Date.now(), 3_600_000)))) return;
    await (this.prisma as any).$executeRawUnsafe(
      `DELETE FROM "backup_schedule_claims" WHERE "claimedAt" < now() - interval '30 days'`).catch(() => undefined);
    await this.checkStaleness();
  }

  async checkStaleness(): Promise<{ stale: boolean; newest?: string | null }> {
    const c = this.config();
    if (!c.enabled) return { stale: false, newest: null };
    const newest = await (this.prisma as any).systemBackup.findFirst({
      where: { status: 'COMPLETED', verifyResult: 'VERIFIED', fileMissing: false },
      orderBy: { completedAt: 'desc' },
    });
    const ageH = newest?.completedAt ? (Date.now() - new Date(newest.completedAt).getTime()) / 3_600_000 : Infinity;
    const stale = ageH > c.staleHours;
    if (stale) {
      // Only COMPLETE recovery points count; mention a newer partial one.
      const partial = await (this.prisma as any).systemBackup.findFirst({
        where: { status: { in: ['DEGRADED', 'INCOMPLETE'] }, ...(newest?.completedAt ? { completedAt: { gt: newest.completedAt } } : {}) },
        orderBy: { completedAt: 'desc' },
      });
      await this.alert('Backups are stale',
        (newest ? `Newest verified COMPLETE backup is ${ageH.toFixed(1)} h old (limit ${c.staleHours} h).` : 'No verified complete backup exists.')
        + (partial ? ` A newer ${partial.status} backup exists (${partial.id}) but is not a complete recovery point.` : ''));
    }
    return { stale, newest: newest?.completedAt?.toISOString?.() ?? null };
  }

  async status(): Promise<any> {
    const c = this.config();
    let nextRun: string | null = null;
    try { nextRun = (this.scheduler.getCronJob(BackupScheduleService.JOB_NAME) as any).nextDate().toISO(); } catch { /* not scheduled */ }
    const newest = await (this.prisma as any).systemBackup.findFirst({
      where: { status: 'COMPLETED', verifyResult: 'VERIFIED' }, orderBy: { completedAt: 'desc' },
      select: { id: true, completedAt: true, offsiteStatus: true, restoreTestedAt: true },
    });
    const ageH = newest?.completedAt ? (Date.now() - new Date(newest.completedAt).getTime()) / 3_600_000 : null;
    return { ...c, active: !!nextRun, nextRun, lastRun: this.lastRun,
      newestVerified: newest, newestVerifiedAgeHours: ageH, stale: c.enabled && (ageH == null || ageH > c.staleHours) };
  }

  private async alert(title: string, message: string, backupId?: string): Promise<void> {
    this.logger.error(`[backup-alert] ${title}: ${message}`);
    await this.auditLog.log({ action: 'BACKUP_ALERT', entity: 'SystemBackup', entityId: backupId ?? 'schedule',
      changes: { title, message } }).catch(() => undefined);
    try {
      await this.notifications?.notifyUsersByRoles(['System Admin'], NOTIF_EVENTS.SYSTEM_AUDIT_ALERT,
        `Backup: ${title}`, message, 'SystemBackup', backupId);
    } catch (e: any) {
      this.logger.warn(`backup alert notification not delivered (audit + log still recorded): ${e?.message ?? e}`);
    }
  }
}
