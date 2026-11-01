import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../../prisma/prisma.service';
import { StorageService } from './storage.service';
import { withPurgeLocks } from '../../backup/backup-lock';

export interface PurgeResult {
  skippedBecauseBackupRunning: boolean;
  skippedBecauseOtherInstancePurging?: boolean;
  examined: number;
  purged: number;
  stillReferenced: number;
  failed: number;
  graceHours: number;
}

/**
 * Physically removes objects queued by StorageService.deleteFileByUrlOrKey /
 * deleteByPrefix. An object is deleted only when ALL of these hold:
 *
 *   1. it was queued more than STORAGE_PURGE_GRACE_HOURS ago (default 24) —
 *      any backup whose database snapshot could still reference it has long
 *      finished capturing files;
 *   2. no backup/restore currently holds the cross-instance backup lock —
 *      and none can START while the purge runs: the purge holds that lock in
 *      SHARED mode (plus an exclusive purge lock so only one instance purges);
 *   3. no row in a URL column still references it (protects against a caller
 *      whose transaction rolled back after it queued the delete).
 *
 * Together with write-once object keys this guarantees that every object a
 * backup's snapshot references is still present, with the same bytes, when
 * the backup captures files.
 */
@Injectable()
export class StoragePurgeService {
  private readonly logger = new Logger('StoragePurge');
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
  ) {}

  @Cron('*/10 * * * *', { name: 'tempworks-storage-purge' })
  async scheduled(): Promise<void> {
    if (process.env.STORAGE_DEFERRED_DELETE === 'off') return;
    await this.runPurge().catch((e) => this.logger.warn(`purge run failed: ${e?.message ?? e}`));
  }

  async runPurge(opts: { graceHours?: number; limit?: number } = {}): Promise<PurgeResult> {
    const graceHours = opts.graceHours ?? Number(process.env.STORAGE_PURGE_GRACE_HOURS ?? 24);
    const result: PurgeResult = { skippedBecauseBackupRunning: false, examined: 0, purged: 0, stillReferenced: 0, failed: 0, graceHours };
    if (this.running) return result;
    this.running = true;
    try {
      const locked = await withPurgeLocks(() => this.purgeBatch(graceHours, opts.limit ?? 500, result));
      if (!locked.ran) {
        if (locked.reason === 'backup') result.skippedBecauseBackupRunning = true;
        else result.skippedBecauseOtherInstancePurging = true;
      }
      return result;
    } finally {
      this.running = false;
    }
  }

  private async purgeBatch(graceHours: number, limit: number, result: PurgeResult): Promise<void> {
    const rows = await this.prisma.$queryRawUnsafe<Array<{ id: string; objectKey: string; originalRef: string }>>(
      `SELECT "id","objectKey","originalRef" FROM "storage_purge_queue"
        WHERE "requestedAt" <= now() - make_interval(secs => $1)
        ORDER BY "requestedAt" LIMIT $2`,
      graceHours * 3600, limit,
    );
    result.examined = rows.length;
    if (rows.length === 0) return;

    const referenced = await this.referencedSet(rows);
    for (const row of rows) {
      if (referenced.has(row.id)) {
        result.stillReferenced++;
        this.logger.warn(`not purging ${row.objectKey}: still referenced by a database row`);
        await this.prisma.$executeRawUnsafe(`DELETE FROM "storage_purge_queue" WHERE "id" = $1`, row.id);
        continue;
      }
      try {
        await this.storage.deleteNow(row.originalRef || row.objectKey);
        await this.prisma.$executeRawUnsafe(`DELETE FROM "storage_purge_queue" WHERE "id" = $1`, row.id);
        result.purged++;
      } catch (err: any) {
        result.failed++;
        await this.prisma.$executeRawUnsafe(
          `UPDATE "storage_purge_queue" SET "attempts" = "attempts" + 1, "lastError" = $2 WHERE "id" = $1`,
          row.id, String(err?.message ?? err).slice(0, 500),
        );
      }
    }
    if (result.purged || result.stillReferenced) {
      this.logger.log(`purged ${result.purged} object(s); ${result.stillReferenced} still referenced (kept)`);
    }
  }

  /**
   * Ids of queue rows whose object is still referenced by any URL-like text
   * column in the public schema (fileUrl, photoUrl, logoUrl, …). Matches the
   * stored URL exactly or by object key suffix.
   */
  private async referencedSet(rows: Array<{ id: string; objectKey: string; originalRef: string }>): Promise<Set<string>> {
    const cols = await this.prisma.$queryRawUnsafe<Array<{ t: string; c: string }>>(
      `SELECT c.table_name AS t, c.column_name AS c
         FROM information_schema.columns c
         JOIN information_schema.tables tb ON tb.table_schema = c.table_schema AND tb.table_name = c.table_name AND tb.table_type = 'BASE TABLE'
        WHERE c.table_schema = 'public' AND c.data_type IN ('text','character varying')
          AND c.column_name ILIKE '%url%'`,
    );
    const hit = new Set<string>();
    for (const row of rows) {
      const suffix = '%/' + row.objectKey.replace(/[%_\\]/g, (m) => '\\' + m);
      for (const { t, c } of cols) {
        const r = await this.prisma.$queryRawUnsafe<Array<{ one: number }>>(
          `SELECT 1 AS one FROM "${t}" WHERE "${c}" = $1 OR "${c}" LIKE $2 LIMIT 1`,
          row.originalRef, suffix,
        );
        if (r.length) { hit.add(row.id); break; }
      }
    }
    return hit;
  }
}
