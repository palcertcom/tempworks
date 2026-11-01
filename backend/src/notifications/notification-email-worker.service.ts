import { Injectable, OnModuleInit, OnModuleDestroy, Logger } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { PrismaService } from '../prisma/prisma.service';
import { EmailService } from '../email/email.service';
import { NotificationsService } from './notifications.service';
import { metaFor, type NotifEventKey } from './notification-events';

/**
 * Stage 6 — Notification email worker.
 *
 * Drains the `notification_email_outbox` table on a fixed interval and
 * dispatches each PENDING row through the existing EmailService. The
 * outbox is added by `prisma.service.healAdditiveDrift()` so neither
 * the table nor this worker depend on a Prisma migration.
 *
 * Design choices:
 *   - Tick interval: 60s. Email is async by spec; we don't try to be
 *     real-time. A row queued mid-tick waits up to one cycle.
 *   - Batch cap per tick: 50 rows. Bounds the worst-case Resend round
 *     trips per cycle; the worker re-fires on the next tick to drain
 *     the rest.
 *   - Retry policy: up to 3 attempts; after the 3rd failure the row
 *     moves to FAILED status. Status transitions are atomic via a
 *     single UPDATE per row.
 *   - Dedup: the outbox itself is the dedup gate — every send is at
 *     least once per row, and rows are inserted only when the user has
 *     `email: true` on the matrix. Multi-tier expiry already dedups
 *     upstream so we don't get duplicate inserts there either.
 *   - Concurrency safety: each tick claims rows with a row-level
 *     UPDATE that flips them to SENDING with the current pid before
 *     loading them, so multiple worker instances (vertical scaling)
 *     don't race on the same row. SKIP LOCKED keeps the claim cheap.
 *   - Errors never propagate: a malformed row, a missing email, or
 *     a Resend outage logs warn and moves on.
 */
@Injectable()
export class NotificationEmailWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger('NotificationEmailWorker');
  private interval: NodeJS.Timeout | null = null;
  private running = false;

  /** Per-tick batch ceiling — bounds Resend round-trips per cycle. */
  private static readonly BATCH_SIZE = 50;
  /** Hard ceiling on per-row attempts before we mark FAILED. */
  private static readonly MAX_ATTEMPTS = 3;
  /** Tick interval in ms. */
  private static readonly TICK_MS = 60_000;

  constructor(
    private readonly prisma: PrismaService,
    private readonly email: EmailService,
    private readonly moduleRef: ModuleRef,
  ) {}

  /** Late-bound to avoid a constructor cycle (NotificationsService is
   *  in the same module). Resolved once and cached. */
  private notificationsCache: NotificationsService | null = null;
  private getNotifications(): NotificationsService | null {
    if (this.notificationsCache) return this.notificationsCache;
    try {
      this.notificationsCache = this.moduleRef.get(NotificationsService, { strict: false });
    } catch {
      this.notificationsCache = null;
    }
    return this.notificationsCache;
  }

  onModuleInit(): void {
    // First drain right after boot so a row queued by something
    // running during start-up doesn't sit until the first tick.
    this.runOnce().catch((e) => this.logger.warn(`initial drain failed: ${(e as Error)?.message}`));
    this.interval = setInterval(() => {
      this.runOnce().catch((e) => this.logger.warn(`tick drain failed: ${(e as Error)?.message}`));
    }, NotificationEmailWorker.TICK_MS);
    this.logger.log(`Notification email worker started (every ${NotificationEmailWorker.TICK_MS / 1000}s)`);
  }

  onModuleDestroy(): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
      this.logger.log('Notification email worker stopped');
    }
  }

  /**
   * One drain pass. Public so tests + harnesses can step the worker
   * deterministically. No-op when a previous pass is still running.
   */
  async runOnce(): Promise<{ sent: number; failed: number }> {
    if (this.running) return { sent: 0, failed: 0 };
    this.running = true;
    let sent = 0, failed = 0;
    try {
      // Atomic claim: flip the first N PENDING rows (oldest first) to
      // SENDING with a per-row UPDATE. SKIP LOCKED prevents two ticks
      // (or two workers) from grabbing the same row.
      const rows = await this.prisma.$queryRawUnsafe<Array<{
        id: string; userId: string; email: string; name: string | null;
        eventType: string; title: string; message: string; locale: string | null;
        relatedEntity: string | null; relatedEntityId: string | null; params: any;
        attemptCount: number;
      }>>(
        `WITH claimed AS (
           SELECT id FROM "notification_email_outbox"
            WHERE "status" = 'PENDING'
              AND "attemptCount" < $2
            ORDER BY "createdAt" ASC
            LIMIT $1
            FOR UPDATE SKIP LOCKED
         )
         UPDATE "notification_email_outbox" o
            SET "status" = 'SENDING',
                "lastAttemptAt" = NOW(),
                "attemptCount" = o."attemptCount" + 1
          FROM claimed
          WHERE o.id = claimed.id
          RETURNING o.id, o."userId", o.email, o.name, o."eventType",
                    o.title, o.message, o.locale,
                    o."relatedEntity", o."relatedEntityId", o.params,
                    o."attemptCount"`,
        NotificationEmailWorker.BATCH_SIZE,
        NotificationEmailWorker.MAX_ATTEMPTS,
      );

      const notifications = this.getNotifications();
      for (const row of rows ?? []) {
        try {
          // Digest-only guard. Events that the registry marks
          // `digestOnly: true` (today: the document-compliance set)
          // must not be sent as one-off emails — they're rolled up
          // into the daily DocumentDigestCron instead. Legacy rows
          // queued before the digest cutover are still PENDING in
          // the outbox; this guard drops them at dispatch. Status
          // becomes 'SKIPPED_DIGEST' with a lastError that
          // preserves the reason for the audit trail.
          let isDigestOnly = false;
          try {
            isDigestOnly = !!metaFor(row.eventType as NotifEventKey).digestOnly;
          } catch {
            // Unknown event keys fall through to normal dispatch —
            // we'd rather over-send than silently swallow a row
            // whose registry entry doesn't exist anymore.
          }
          if (isDigestOnly) {
            await this.prisma.$executeRawUnsafe(
              `UPDATE "notification_email_outbox"
                  SET "status" = 'SKIPPED_DIGEST',
                      "lastError" = 'event rolled into daily document digest; per-row email suppressed'
                WHERE id = $1`,
              row.id,
            );
            continue;
          }
          // Late preference re-check. The enqueue path already gates on
          // the user's matrix, but a row queued before the user opted
          // out of email for this event would otherwise still be sent
          // on the next drain. Re-checking here closes that window —
          // when the user has email=false for this event by send time,
          // mark the row CANCELLED and skip the dispatch.
          if (notifications && !(await notifications.wantsChannel(row.userId, row.eventType, 'email'))) {
            await this.prisma.$executeRawUnsafe(
              `UPDATE "notification_email_outbox"
                  SET "status" = 'CANCELLED', "lastError" = 'user opted out of email for this event'
                WHERE id = $1`,
              row.id,
            );
            continue;
          }
          await this.email.sendNotificationEmail(
            row.email,
            row.name ?? row.email,
            row.title,
            row.message,
            row.eventType,
            (row.locale ?? 'en') as any,
            // Entity context → clickable profile/document links in the
            // email. JSONB `params` may arrive as a string from
            // $queryRawUnsafe, so normalise it.
            {
              relatedEntity: row.relatedEntity,
              relatedEntityId: row.relatedEntityId,
              params: typeof row.params === 'string'
                ? (() => { try { return JSON.parse(row.params); } catch { return null; } })()
                : row.params,
            },
          );
          await this.prisma.$executeRawUnsafe(
            `UPDATE "notification_email_outbox"
                SET "status" = 'SENT', "sentAt" = NOW(), "lastError" = NULL
              WHERE id = $1`,
            row.id,
          );
          sent += 1;
        } catch (e) {
          const reachedMax = row.attemptCount >= NotificationEmailWorker.MAX_ATTEMPTS;
          await this.prisma.$executeRawUnsafe(
            `UPDATE "notification_email_outbox"
                SET "status" = $2, "lastError" = $3
              WHERE id = $1`,
            row.id,
            reachedMax ? 'FAILED' : 'PENDING',
            String((e as Error)?.message ?? e).slice(0, 1000),
          );
          failed += 1;
        }
      }
    } catch (e) {
      // A failure of the claim query itself: log and move on; the next
      // tick will retry.
      this.logger.warn(`drain claim failed: ${(e as Error)?.message}`);
    } finally {
      this.running = false;
    }
    if (sent + failed > 0) {
      this.logger.log(`drain pass: sent=${sent} failed=${failed}`);
    }
    return { sent, failed };
  }
}
