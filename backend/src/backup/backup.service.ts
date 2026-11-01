import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
  ServiceUnavailableException,
  InternalServerErrorException,
  OnModuleInit,
  OnModuleDestroy,
} from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { AuditLogService } from '../logs/audit-log.service';
import { PaginatedResponse } from '../common/dto/pagination-response.dto';
import {
  CreateBackupDto, ListBackupsDto, RestoreBackupDto, RestoreMode, BackupKind,
} from './dto/backup.dto';
import { resolvePgTools, resolvePgToolsForRestore, PgToolError } from './pg-tools';
import { Client } from 'pg';
import { spawn, ChildProcess } from 'child_process';
import { Readable } from 'stream';
import * as path from 'path';
import * as fs from 'fs';
import { v4 as uuidv4 } from 'uuid';

// Cross-instance advisory lock (shared with the storage purge worker).
import { BACKUP_ADVISORY_LOCK_KEY, connectLockClient, backupRunningAnywhere } from './backup-lock';

/**
 * Backup engines:
 *   stream  — scripts/dr/snapshot.sh: snapshots stream straight into a
 *             separate private bucket (BACKUP_SPACES_*). Bounded local disk and
 *             memory; the bucket is the single source of truth, so every app
 *             instance sees, verifies and downloads the same backups. Default
 *             whenever BACKUP_SPACES_BUCKET is configured.
 *   staging — scripts/dr/backup.sh: builds the package on local disk
 *             (BACKUP_DIR) then optionally copies it off-site. For hosts whose
 *             disk is larger than the dataset (single VM / recovery host).
 * Override with BACKUP_ENGINE=stream|staging.
 */
type Engine = 'stream' | 'staging';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ── Helpers ────────────────────────────────────────────────────────────────────

interface DBConn {
  host: string; port: number; database: string;
  username: string; password: string; sslmode?: string;
}

function parseDatabaseUrl(url: string): DBConn {
  const u = new URL(url);
  return {
    host: u.hostname || 'localhost',
    port: parseInt(u.port || '5432', 10),
    database: u.pathname.slice(1),
    username: decodeURIComponent(u.username),
    password: decodeURIComponent(u.password),
    sslmode: u.searchParams.get('sslmode') ?? undefined,
  };
}

function pgEnv(conn: DBConn): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, PGPASSWORD: conn.password };
  if (conn.sslmode) env.PGSSLMODE = conn.sslmode;
  return env;
}

function formatBytes(bytes: bigint | number | null | undefined): string {
  if (!bytes) return '—';
  const n = Number(bytes);
  if (n < 1024) return `${n} B`;
  if (n < 1048576) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1073741824) return `${(n / 1048576).toFixed(1)} MB`;
  return `${(n / 1073741824).toFixed(2)} GB`;
}

function dirSize(p: string): bigint {
  let total = 0n;
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full);
      else try { total += BigInt(fs.statSync(full).size); } catch { /* ignore */ }
    }
  };
  try { walk(p); } catch { /* ignore */ }
  return total;
}

const RESTORE_CONFIRM_PHRASE = 'RESTORE DATABASE';

// ── Service ────────────────────────────────────────────────────────────────────

@Injectable()
export class BackupService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger('BackupService');
  private readonly backupDir: string;
  private readonly drDir: string;
  /** The backup child process this instance is running (for shutdown handling). */
  private active: { id: string; child: ChildProcess; lock: Client | null } | null = null;
  private remoteCache: { at: number; map: Map<string, any> } | null = null;

  constructor(
    private prisma: PrismaService,
    private auditLog: AuditLogService,
  ) {
    // Durable by default: honour BACKUP_DIR (should point at a persistent
    // volume in production — see docs/DISASTER_RECOVERY_RUNBOOK.md). Falls
    // back to <cwd>/backups only for local dev.
    this.backupDir = process.env.BACKUP_DIR
      ? path.resolve(process.env.BACKUP_DIR)
      : path.join(process.cwd(), 'backups');
    // The DR shell scripts are NOT compiled into dist/; resolve them across
    // dev (ts-node) and prod (node dist/main.js) layouts.
    const drCandidates = [
      process.env.DR_SCRIPTS_DIR,
      path.join(__dirname, '..', '..', 'scripts', 'dr'),  // dev: src/backup -> backend/scripts/dr
      path.join(process.cwd(), 'scripts', 'dr'),           // prod: cwd=backend
      path.join(process.cwd(), 'backend', 'scripts', 'dr'),// prod: cwd=repo root
    ].filter(Boolean) as string[];
    this.drDir = drCandidates.find((d) => fs.existsSync(path.join(d, 'backup.sh'))) || drCandidates[1];
    this.ensureBackupDir();
  }

  private ensureBackupDir(): void {
    if (!fs.existsSync(this.backupDir)) {
      fs.mkdirSync(this.backupDir, { recursive: true });
      this.logger.log(`Created backup directory: ${this.backupDir}`);
    }
  }

  // ── Cross-instance locking + restart reconciliation ─────────────────────────
  //
  // A dedicated PostgreSQL connection holds an advisory lock for the whole
  // backup/restore. This serialises operations across ALL app instances (not
  // just one process), and PostgreSQL auto-releases it if the process dies —
  // so there is never a stale lock. On boot, any RUNNING catalog row with no
  // live lock is reconciled to FAILED (its process was killed mid-job).

  async onModuleInit(): Promise<void> {
    try { await this.reconcileStaleRunning(); }
    catch (e: any) { this.logger.warn(`stale-running reconcile skipped: ${e?.message ?? e}`); }
  }

  /**
   * Try to take the global operation lock (EXCLUSIVE). Returns the holding
   * client, or null if a backup/restore is running anywhere. A storage purge
   * holds the lock SHARED for a few seconds; we wait that out (up to 30 s).
   */
  private async tryLockRaw(waitForPurgeMs = 30_000): Promise<Client | null> {
    const client = await connectLockClient();
    const deadline = Date.now() + waitForPurgeMs;
    try {
      for (;;) {
        const r = await client.query('SELECT pg_try_advisory_lock($1) AS locked', [BACKUP_ADVISORY_LOCK_KEY]);
        if (r.rows[0]?.locked === true) return client;
        if (await backupRunningAnywhere(client) || Date.now() > deadline) { await client.end(); return null; }
        await sleep(1000);
      }
    } catch (e) {
      await client.end().catch(() => undefined);
      throw e;
    }
  }

  /** Acquire the lock or throw 503. */
  private async acquireLock(): Promise<Client> {
    const c = await this.tryLockRaw();
    if (!c) throw new ServiceUnavailableException(
      'Another backup or restore operation is currently in progress (held by this or another app instance). Please try again later.',
    );
    return c;
  }

  private async releaseLock(client: Client | null): Promise<void> {
    if (!client) return;
    try { await client.query('SELECT pg_advisory_unlock($1)', [BACKUP_ADVISORY_LOCK_KEY]); } catch { /* ignore */ }
    await client.end().catch(() => undefined);
  }

  /** Is a backup/restore currently running anywhere? */
  private async isLocked(): Promise<boolean> {
    const c = await connectLockClient();
    try { return await backupRunningAnywhere(c); }
    finally { await c.end().catch(() => undefined); }
  }

  /**
   * Mark orphaned RUNNING rows (no live lock anywhere) as FAILED. Runs on boot
   * and every 2 minutes on every instance, so a backup whose instance was
   * killed (redeploy SIGKILL, crash, scale-in) is reported promptly by the
   * surviving instance — PostgreSQL releases the dead session's lock once its
   * shortened TCP keepalive expires (~1 min).
   */
  private async reconcileStaleRunning(): Promise<number> {
    if (this.active) return 0;
    const probe = await this.tryLockRaw(0);
    if (!probe) return 0; // an operation really is in progress — leave RUNNING rows alone
    try {
      const stale = await (this.prisma as any).systemBackup.updateMany({
        where: { status: 'RUNNING', createdAt: { lt: new Date(Date.now() - 60_000) } },
        data: { status: 'FAILED', errorMessage: 'Interrupted — the app instance running this backup stopped before completion (redeploy, crash or scale-in). No snapshot was committed.' },
      });
      if (stale.count > 0) this.logger.warn(`Reconciled ${stale.count} orphaned RUNNING backup(s) to FAILED.`);
      return stale.count;
    } finally {
      await this.releaseLock(probe);
    }
  }

  @Interval('tempworks-backup-stale-reconcile', 120_000)
  async periodicReconcile(): Promise<void> {
    await this.reconcileStaleRunning().catch((e) => this.logger.warn(`stale-running reconcile skipped: ${e?.message ?? e}`));
  }

  /**
   * Instance shutdown (App Platform sends SIGTERM on redeploy/scale-in, then
   * SIGKILL after the grace period). Stop the running backup child — the
   * streaming engine aborts its upload and removes uncommitted files — and
   * record the interruption over the LOCK connection (independent of Prisma's
   * pool, which may already be closing), then release the lock.
   */
  async onModuleDestroy(): Promise<void> {
    const a = this.active;
    if (!a) return;
    this.logger.warn(`Instance shutting down — interrupting running backup ${a.id}.`);
    a.child.kill('SIGTERM');
    await Promise.race([new Promise((r) => a.child.once('close', r)), sleep(25_000)]);
    if (a.lock) {
      await a.lock.query(
        `UPDATE system_backups SET status = 'FAILED', "errorMessage" = $2 WHERE id = $1 AND status = 'RUNNING'`,
        [a.id, 'Interrupted — app instance shut down (redeploy/scale-in) during the backup. No snapshot was committed.'],
      ).catch(() => undefined);
      await this.releaseLock(a.lock);
    }
  }

  // ── Engine selection + remote (authoritative) snapshot listing ─────────────

  private engine(): Engine {
    const e = (process.env.BACKUP_ENGINE || '').toLowerCase();
    if (e === 'stream' || e === 'staging') return e;
    return process.env.BACKUP_SPACES_BUCKET ? 'stream' : 'staging';
  }

  /** Catalog status for a stored snapshot (recovery completeness). */
  private statusOf(snap: any): string {
    const r = snap.recoverability || (snap.complete === false ? 'INCOMPLETE' : 'COMPLETE');
    return r === 'COMPLETE' ? 'COMPLETED' : r;
  }

  private isStream(record: any): boolean {
    return (record?.metadata as any)?.engine === 'stream';
  }

  private pkgOf(record: any): string {
    return (record?.metadata as any)?.package || record?.fileName;
  }

  /**
   * Snapshots that really exist in the backup bucket (MANIFEST.json committed).
   * Cached 30 s. null = bucket unreachable → presence UNKNOWN (never "missing").
   */
  private async remoteSnapshots(force = false): Promise<Map<string, any> | null> {
    if (!force && this.remoteCache && Date.now() - this.remoteCache.at < 30_000) return this.remoteCache.map;
    const r = await this.runScript('snapshot.sh', ['list']);
    if (r.status !== 0) {
      this.logger.warn(`backup storage listing failed: ${this.redact(r.stderr).split('\n').filter(Boolean).pop()}`);
      return null;
    }
    try {
      const list: any[] = JSON.parse(r.stdout.trim().split('\n').pop() || '[]');
      const map = new Map(list.map((x) => [x.package, x]));
      this.remoteCache = { at: Date.now(), map };
      return map;
    } catch { return null; }
  }

  private scriptEnv(): NodeJS.ProcessEnv {
    return { ...process.env, BACKUP_DIR: this.backupDir };
  }

  private script(name: string): string {
    return path.join(this.drDir, name);
  }

  // ── Toolchain / server version ─────────────────────────────────────────────

  private async serverMajor(): Promise<number | undefined> {
    try {
      const r = await this.prisma.$queryRaw<[{ server_version_num: string }]>`SHOW server_version_num`;
      const num = parseInt((r[0] as any)?.server_version_num, 10);
      return Number.isFinite(num) ? Math.floor(num / 10000) : undefined;
    } catch {
      return undefined;
    }
  }

  // ── Preflight (fixes the silent 500 — fail fast with actionable errors) ─────

  async preflight(): Promise<any> {
    const res = await this.runScript('preflight.sh', ['--backup-dir', this.backupDir, '--engine', this.engine()]);
    let parsed: any = null;
    try { parsed = JSON.parse(res.stdout.trim().split('\n').pop() || '{}'); } catch { /* ignore */ }
    return {
      ok: res.status === 0,
      checks: parsed?.checks ?? [],
      serverMajor: parsed?.serverMajor ?? null,
      raw: res.status === 0 ? undefined : this.redact(res.stderr),
    };
  }

  private redact(s: string): string {
    return (s || '').replace(/(postgres(?:ql)?:\/\/)[^@\s/]+@/gi, '$1***:***@').slice(-2000);
  }

  // ── Script runners ──────────────────────────────────────────────────────────

  /** Run a DR script without blocking the event loop (verify can be long). */
  private runScript(name: string, args: string[], extraEnv: NodeJS.ProcessEnv = {}): Promise<{ status: number; stdout: string; stderr: string }> {
    return new Promise((resolve) => {
      const child = spawn('bash', [this.script(name), ...args], { env: { ...this.scriptEnv(), ...extraEnv }, stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '', stderr = '';
      child.stdout.on('data', (d) => { stdout += d.toString(); });
      child.stderr.on('data', (d) => { stderr += d.toString(); });
      child.on('close', (code) => resolve({ status: code ?? 1, stdout, stderr }));
      child.on('error', (e) => resolve({ status: 1, stdout, stderr: stderr + String(e?.message ?? e) }));
    });
  }

  // ── Public API ────────────────────────────────────────────────────────────

  /**
   * Create a backup. Runs preflight synchronously (so the caller gets an
   * actionable error immediately), then performs the dump IN THE BACKGROUND
   * and returns the RUNNING catalog row — the HTTP request does not stay open
   * for the whole dump.
   */
  async createBackup(dto: CreateBackupDto, userId?: string, userEmail?: string): Promise<any> {
    const kind = dto.kind === BackupKind.FULL_SYSTEM ? 'full' : 'database';

    // Preflight — catches the version mismatch, connectivity, permission,
    // capacity and destination problems BEFORE we take the lock / create a row.
    const pf = await this.preflight();
    if (!pf.ok) {
      const failed = (pf.checks || []).filter((c: any) => c.state === 'fail').map((c: any) => `${c.name}: ${c.detail}`);
      throw new ServiceUnavailableException(
        `Backup preflight failed — ${failed.join('; ') || this.redact(pf.raw || '')}`,
      );
    }

    // Cross-instance lock, held by a dedicated connection for the whole job.
    const lock = await this.acquireLock();
    const id = uuidv4();
    const record = await (this.prisma as any).systemBackup.create({
      data: {
        id,
        fileName: `(pending ${kind} backup)`,
        filePath: '',
        backupType: kind === 'full' ? 'FULL_SYSTEM' : 'DATABASE',
        kind: kind === 'full' ? 'FULL_SYSTEM' : 'DATABASE',
        status: 'RUNNING',
        notes: dto.notes ?? null,
        createdById: userId ?? null,
      },
    });
    this.logger.log(`Backup started: ${id} (kind=${kind})`);

    // Fire-and-forget: the dump runs detached from the HTTP request. The lock
    // is released only when the background job finishes.
    this.runBackupJob(id, kind, dto, userId, userEmail, lock)
      .catch((e) => this.logger.error(`Background backup ${id} crashed: ${e?.message ?? e}`))
      .finally(() => { void this.releaseLock(lock); });

    return this.formatBackup(record);
  }

  /** Run a backup synchronously (used by the restore safety backup, under an
   *  already-held lock). Returns the finalised catalog row. */
  private async doBackupSync(kind: string, dto: CreateBackupDto, userId?: string, userEmail?: string, lock: Client | null = null): Promise<any> {
    const id = uuidv4();
    await (this.prisma as any).systemBackup.create({
      data: {
        id, fileName: `(pending ${kind} backup)`, filePath: '',
        backupType: kind === 'full' ? 'FULL_SYSTEM' : 'DATABASE',
        kind: kind === 'full' ? 'FULL_SYSTEM' : 'DATABASE',
        status: 'RUNNING', notes: dto.notes ?? null, createdById: userId ?? null,
      },
    });
    await this.runBackupJob(id, kind, dto, userId, userEmail, lock);
    return (this.prisma as any).systemBackup.findUnique({ where: { id } });
  }

  /** Background worker that drives the backup engine and finalises the catalog row. */
  private async runBackupJob(
    id: string, kind: string, dto: CreateBackupDto, userId?: string, userEmail?: string, lock: Client | null = null,
  ): Promise<void> {
    const stream = this.engine() === 'stream';
    const args = stream
      ? ['backup', '--kind', kind, '--label', dto.notes ?? '']
      : ['--kind', kind, '--label', dto.notes ?? '', ...(this.offsiteConfigured() ? ['--offsite'] : [])];

    const child = spawn('bash', [this.script(stream ? 'snapshot.sh' : 'backup.sh'), ...args], {
      // BACKUP_CATALOG_ID lets restore.sh reconcile this row inside the
      // restored catalog (it is RUNNING inside its own snapshot).
      // DR_LOCK_HELD: this service already holds the cross-instance lock.
      env: { ...this.scriptEnv(), BACKUP_CATALOG_ID: id, DR_LOCK_HELD: '1' }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.active = { id, child, lock };
    let stdout = '', stderr = '';
    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr = (stderr + d.toString()).slice(-20_000); });

    const code: number = await new Promise((resolve) => {
      child.on('close', (c, sig) => resolve(c ?? (sig ? 143 : 1)));
      child.on('error', () => resolve(1));
    });
    this.active = null;
    this.remoteCache = null;

    try {
      // A written backup has TWO independent verdicts:
      //   status        = recovery completeness: COMPLETED (complete recovery
      //                   point) | DEGRADED (consistent, required files missing
      //                   everywhere) | INCOMPLETE (race / prerequisite missing)
      //   verifyResult  = artifact integrity of the stored bytes (VERIFIED|FAILED)
      // Exit 0 COMPLETE, 6 DEGRADED, 4 INCOMPLETE, 3 (stream) integrity failed.
      if (code === 0 || code === 4 || code === 6 || (stream && code === 3)) {
        const result = JSON.parse(stdout.trim().split('\n').pop() || '{}');
        const recoverability: string = result.recoverability
          || (code === 4 ? 'INCOMPLETE' : code === 6 ? 'DEGRADED' : 'COMPLETE');
        const status = recoverability === 'COMPLETE' ? 'COMPLETED' : recoverability;
        const incomplete = status !== 'COMPLETED';
        const issues: any[] = (result.recoveryIssues || []).filter((i: any) => i.severity !== 'INFO');
        let fileName: string, filePath: string, fileSize: bigint, manifest: any, artifact: string;
        if (stream) {
          fileName = result.package;
          filePath = result.offsiteLocation;
          artifact = result.offsiteLocation;
          fileSize = BigInt((result.databaseBytes ?? 0) + (result.uploadsBytes ?? 0));
          manifest = result.manifest ?? null;
        } else {
          const dir: string = result.dir;
          artifact = result.artifact || dir;
          fileName = path.basename(artifact);
          filePath = dir;
          fileSize = fs.existsSync(artifact) && fs.statSync(artifact).isFile()
            ? BigInt(fs.statSync(artifact).size) : dirSize(dir);
          manifest = this.readManifest(dir);
        }

        await (this.prisma as any).systemBackup.update({
          where: { id },
          data: {
            status,
            errorMessage: incomplete
              ? `${recoverability}: ${issues.map((i) => `${i.code} (${i.count}) — ${i.detail}. Action: ${i.action}`).join(' | ') || 'not a complete recovery point'}`.slice(0, 2000)
              : null,
            fileName,
            filePath,
            fileSize,
            checksum: result.databaseSha256 ?? null,
            completedAt: new Date(),
            offsiteStatus: result.offsiteStatus ?? (this.offsiteConfigured() ? 'UPLOADED' : 'NONE'),
            offsiteLocation: result.offsiteLocation || null,
            // The streaming engine verifies the STORED copy itself (re-reads
            // the dump, parses the archive, checks every blob) before exiting.
            ...(stream ? { verifyResult: code === 3 ? 'FAILED' : 'VERIFIED', verifiedAt: new Date() } : {}),
            metadata: {
              kind, artifact, manifest,
              engine: stream ? 'stream' : 'staging',
              package: stream ? result.package : undefined,
              uploadsIncluded: result.uploadsIncluded ?? false,
              uploadsCount: result.uploadsCount ?? 0,
              uploadsBytes: result.uploadsBytes ?? 0,
              globalsCaptured: result.globalsCaptured ?? false,
              databaseBytes: result.databaseBytes ?? 0,
              uploadsComplete: result.uploadsComplete ?? (kind !== 'full'),
              danglingReferences: result.danglingReferences ?? 0,
              recoverability,
              recoveryIssues: result.recoveryIssues ?? [],
              prerequisitesCaptured: result.prerequisitesCaptured ?? null,
              consistencyAttempts: result.consistencyAttempts ?? 1,
              transfer: result.transfer ?? undefined,
            },
          },
        });
        await this.auditLog.log({
          userId, userEmail,
          action: incomplete ? `BACKUP_${status}` : 'BACKUP_CREATED',
          entity: 'SystemBackup', entityId: id,
          changes: { fileName, kind, status, recoverability, issues: issues.map((i) => ({ code: i.code, count: i.count })), offsiteStatus: result.offsiteStatus, engine: stream ? 'stream' : 'staging' },
        });
        this.logger.log(`Backup ${status}: ${id} (${fileName})`);
        // Integrity verification is recorded as its own state
        // (verifyResult/verifiedAt), distinct from completeness.
        if (!stream && status !== 'INCOMPLETE') await this.verifyBackup(id, userId, userEmail).catch((e) => this.logger.warn(`auto-verify: ${e?.message}`));
        // Retention keeps complete and partial backups apart, so running it
        // after a partial one can never evict the last complete backup.
        if (stream || !incomplete) await this.enforceRetention(true).catch((e) => this.logger.warn(`retention: ${e?.message}`));
      } else if (code === 143) {
        throw new Error('Interrupted — the backup process was terminated (instance shutdown/redeploy). No snapshot was committed.');
      } else {
        throw new Error(this.redact(stderr).split('\n').filter(Boolean).pop() || 'backup engine failed');
      }
    } catch (err: any) {
      this.logger.error(`Backup failed: ${id}: ${err.message}`);
      await (this.prisma as any).systemBackup.update({
        where: { id }, data: { status: 'FAILED', errorMessage: this.redact(err.message) },
      }).catch(() => undefined);
      await this.auditLog.log({
        userId, userEmail, action: 'BACKUP_FAILED', entity: 'SystemBackup', entityId: id,
        changes: { error: this.redact(err.message) },
      }).catch(() => undefined);
    }
    // Note: the advisory lock is released by the caller (createBackup's
    // .finally, or restoreBackup) — not here — so it spans the whole operation.
  }

  private offsiteConfigured(): boolean {
    return !!process.env.BACKUP_SPACES_BUCKET &&
      !!(process.env.BACKUP_SPACES_ACCESS_KEY || process.env.DO_SPACES_ACCESS_KEY);
  }

  private readManifest(dir: string): any {
    try { return JSON.parse(fs.readFileSync(path.join(dir, 'MANIFEST.json'), 'utf8')); }
    catch { return null; }
  }

  /** Paginated list with reconciled on-disk existence. */
  async findAll(dto: ListBackupsDto): Promise<PaginatedResponse<any>> {
    const { page = 1, limit = 20, search, status } = dto;
    const skip = (Number(page) - 1) * Number(limit);
    const where: any = {};
    if (status) where.status = status;
    if ((dto as any).kind) where.kind = (dto as any).kind;
    if (search) {
      where.OR = [
        { fileName: { contains: search, mode: 'insensitive' } },
        { notes: { contains: search, mode: 'insensitive' } },
      ];
    }
    const [rows, total] = await Promise.all([
      (this.prisma as any).systemBackup.findMany({
        where, skip, take: Number(limit), orderBy: { createdAt: 'desc' },
        include: { createdBy: { select: { id: true, firstName: true, lastName: true, email: true } } },
      }),
      (this.prisma as any).systemBackup.count({ where }),
    ]);
    const remote = rows.some((r: any) => this.isStream(r)) ? await this.remoteSnapshots() : null;
    return PaginatedResponse.create(
      rows.map((r: any) => this.formatBackup(r, remote)), total, Number(page), Number(limit),
    );
  }

  async findOne(id: string): Promise<any> {
    const record = await (this.prisma as any).systemBackup.findUnique({
      where: { id },
      include: { createdBy: { select: { id: true, firstName: true, lastName: true, email: true } } },
    });
    if (!record) throw new NotFoundException(`Backup ${id} not found`);
    return this.formatBackup(record, this.isStream(record) ? await this.remoteSnapshots() : null);
  }

  /** Resolve the artifact to download: tarball for package dirs, else the file. */
  private downloadPath(record: any): string | null {
    const meta = record.metadata as any;
    if (meta?.artifact && fs.existsSync(meta.artifact)) return meta.artifact;
    if (record.filePath && fs.existsSync(record.filePath)) {
      const st = fs.statSync(record.filePath);
      if (st.isFile()) return record.filePath;        // legacy single-file dump
    }
    return null;
  }

  async getDownloadStream(id: string, userId?: string, userEmail?: string) {
    const record = await (this.prisma as any).systemBackup.findUnique({ where: { id } });
    if (!record) throw new NotFoundException(`Backup ${id} not found`);
    // Partial backups stay downloadable (their MANIFEST.json states what is
    // missing); only backups that never produced an artifact are refused.
    if (!['COMPLETED', 'DEGRADED', 'INCOMPLETE'].includes(record.status)) {
      throw new BadRequestException(`Backup has no downloadable artifact (status: ${record.status})`);
    }
    if (this.isStream(record)) {
      // Served from the backup bucket by ANY instance: the package is streamed
      // as a POSIX tar (verify.sh/restore.sh layout) with per-file integrity
      // checks; nothing is staged on local disk. Chunked — no Content-Length.
      const remote = await this.remoteSnapshots(true);
      if (remote && !remote.has(this.pkgOf(record))) throw new NotFoundException('Snapshot not found in backup storage (reconcile may have flagged it missing).');
      const child = spawn('bash', [this.script('snapshot.sh'), 'export', this.pkgOf(record)], { env: this.scriptEnv(), stdio: ['ignore', 'pipe', 'pipe'] });
      let stderr = '';
      child.stderr.on('data', (d) => { stderr = (stderr + d.toString()).slice(-4000); });
      child.on('close', (code) => {
        if (code !== 0) {
          this.logger.error(`backup download ${id} aborted: ${this.redact(stderr).split('\n').filter(Boolean).pop()}`);
          child.stdout.destroy(new Error('export failed'));
        }
      });
      await this.auditLog.log({
        userId, userEmail, action: 'BACKUP_DOWNLOADED', entity: 'SystemBackup', entityId: id,
        changes: { fileName: record.fileName, engine: 'stream' },
      });
      return { stream: child.stdout as Readable, fileName: `${this.pkgOf(record)}.tar`, fileSize: null as bigint | null, cancel: () => child.kill('SIGTERM') };
    }
    const p = this.downloadPath(record);
    if (!p) throw new NotFoundException('Backup artifact not found on disk (reconcile may have flagged it missing).');

    await this.auditLog.log({
      userId, userEmail, action: 'BACKUP_DOWNLOADED', entity: 'SystemBackup', entityId: id,
      changes: { fileName: record.fileName },
    });
    return { stream: fs.createReadStream(p) as Readable, fileName: path.basename(p), fileSize: BigInt(fs.statSync(p).size) as bigint | null, cancel: () => undefined };
  }

  // ── Integrity verification (distinct state from "created") ──────────────────

  async verifyBackup(id: string, userId?: string, userEmail?: string): Promise<any> {
    const record = await (this.prisma as any).systemBackup.findUnique({ where: { id } });
    if (!record) throw new NotFoundException(`Backup ${id} not found`);
    let res: { status: number; stdout: string; stderr: string };
    if (this.isStream(record)) {
      // Deep verification of the STORED snapshot: re-hash the dump and every
      // file blob, parse the archive completely. Works from any instance.
      res = await this.runScript('snapshot.sh', ['verify', this.pkgOf(record), '--deep']);
    } else {
      const target = this.verifyTarget(record);
      if (!target) throw new BadRequestException('Nothing to verify — artifact missing on disk.');
      res = await this.runScript('verify.sh', [target]);
    }
    // Exit 0 = intact AND complete; 6 = intact but partial (DEGRADED /
    // INCOMPLETE); anything else = the stored bytes are not intact.
    const integrityOk = res.status === 0 || res.status === 6;
    const recoverability = res.status === 0 ? 'COMPLETE'
      : ((record.metadata as any)?.recoverability ?? (record.status === 'COMPLETED' ? 'UNKNOWN' : record.status));
    await (this.prisma as any).systemBackup.update({
      where: { id },
      data: { verifiedAt: new Date(), verifyResult: integrityOk ? 'VERIFIED' : 'FAILED' },
    });
    await this.auditLog.log({
      userId, userEmail, action: integrityOk ? 'BACKUP_VERIFIED' : 'BACKUP_VERIFY_FAILED',
      entity: 'SystemBackup', entityId: id, changes: { fileName: record.fileName, integrity: integrityOk ? 'OK' : 'FAILED', recoverability },
    });
    return {
      id, integrity: integrityOk ? 'OK' : 'FAILED', recoverability,
      // "verified" = usable as a complete recovery point (never true for a partial backup)
      verified: res.status === 0,
      detail: this.redact((res.status === 0 ? res.stdout : res.stderr)).split('\n').slice(-12).join('\n'),
    };
  }

  private verifyTarget(record: any): string | null {
    const meta = record.metadata as any;
    if (record.filePath && fs.existsSync(record.filePath) && fs.statSync(record.filePath).isDirectory()) return record.filePath;
    if (meta?.artifact && fs.existsSync(meta.artifact)) return meta.artifact;
    return null;
  }

  // ── Reconcile catalog vs actual stored artifacts ────────────────────────────

  async reconcile(userId?: string, userEmail?: string): Promise<any> {
    const rows = await (this.prisma as any).systemBackup.findMany({ where: { status: { in: ['COMPLETED', 'DEGRADED', 'INCOMPLETE'] } } });
    let missing = 0, present = 0, imported = 0;
    const remote = rows.some((r: any) => this.isStream(r)) || this.engine() === 'stream' ? await this.remoteSnapshots(true) : null;
    if (this.engine() === 'stream' && !remote) {
      throw new ServiceUnavailableException('Backup storage is unreachable — cannot reconcile (no backup was marked missing).');
    }
    for (const r of rows) {
      const exists = this.isStream(r)
        ? remote!.has(this.pkgOf(r))
        : (!!this.downloadPath(r) || this.verifyTarget(r) != null);
      await (this.prisma as any).systemBackup.update({
        where: { id: r.id }, data: { fileMissing: !exists },
      });
      if (exists) present++; else missing++;
    }
    // The bucket is authoritative: snapshots with no catalog row (made by an
    // external runner, or created before this database was restored) are
    // imported so they are visible, verifiable and downloadable in the UI.
    if (remote) {
      const known = new Set<string>(rows.map((r: any) => this.pkgOf(r)));
      const allIds = new Set<string>((await (this.prisma as any).systemBackup.findMany({ select: { id: true } })).map((r: any) => r.id));
      for (const snap of remote.values()) {
        if (known.has(snap.package)) continue;
        const id = snap.catalogId && !allIds.has(snap.catalogId) ? snap.catalogId : uuidv4();
        if (snap.catalogId && allIds.has(snap.catalogId)) {
          // The row exists (e.g. RUNNING inside a restored catalog): finalise it.
          await (this.prisma as any).systemBackup.update({ where: { id: snap.catalogId }, data: {
            status: this.statusOf(snap), fileName: snap.package, filePath: snap.location,
            fileSize: BigInt((snap.databaseBytes ?? 0) + (snap.uploadsBytes ?? 0)), checksum: snap.databaseSha256,
            completedAt: new Date(snap.createdAt), offsiteStatus: 'UPLOADED', offsiteLocation: snap.location, fileMissing: false,
            metadata: { engine: 'stream', package: snap.package, artifact: snap.location, kind: snap.kind, uploadsCount: snap.uploadsCount, uploadsBytes: snap.uploadsBytes, databaseBytes: snap.databaseBytes, danglingReferences: snap.danglingReferences, recoverability: snap.recoverability, recoveryIssues: snap.recoveryIssues, reconciledFromStorage: true },
          } });
        } else {
          await (this.prisma as any).systemBackup.create({ data: {
            id, fileName: snap.package, filePath: snap.location,
            fileSize: BigInt((snap.databaseBytes ?? 0) + (snap.uploadsBytes ?? 0)),
            backupType: snap.kind === 'full' ? 'FULL_SYSTEM' : 'DATABASE', kind: snap.kind === 'full' ? 'FULL_SYSTEM' : 'DATABASE',
            status: this.statusOf(snap), checksum: snap.databaseSha256,
            notes: `[imported from backup storage]${snap.label ? ' ' + snap.label : ''}`,
            createdAt: new Date(snap.createdAt), completedAt: new Date(snap.createdAt),
            offsiteStatus: 'UPLOADED', offsiteLocation: snap.location, fileMissing: false,
            metadata: { engine: 'stream', package: snap.package, artifact: snap.location, kind: snap.kind, uploadsCount: snap.uploadsCount, uploadsBytes: snap.uploadsBytes, databaseBytes: snap.databaseBytes, danglingReferences: snap.danglingReferences, recoverability: snap.recoverability, recoveryIssues: snap.recoveryIssues, imported: true },
          } });
        }
        imported++;
      }
    }
    await this.auditLog.log({
      userId, userEmail, action: 'BACKUP_RECONCILED', entity: 'SystemBackup', entityId: 'catalog',
      changes: { present, missing, imported, total: rows.length },
    });
    return { total: rows.length, present, missing, imported };
  }

  // ── Retention (never delete the last verified recoverable backup) ───────────

  async enforceRetention(lockHeld = false): Promise<void> {
    const keep = parseInt(process.env.BACKUP_RETENTION_COUNT || '10', 10);
    if (this.engine() === 'stream') {
      // The bucket decides: keep the newest N complete snapshots (+ the newest
      // VERIFIED one, + the newest FULL one), garbage-collect unreferenced blobs.
      const newestVerified = await (this.prisma as any).systemBackup.findFirst({
        where: { status: 'COMPLETED', verifyResult: 'VERIFIED' }, orderBy: { createdAt: 'desc' },
      });
      const protect = newestVerified && this.isStream(newestVerified) ? ['--protect', this.pkgOf(newestVerified)] : [];
      const r = await this.runScript('snapshot.sh', ['retention', '--keep', String(keep), ...protect], lockHeld ? { DR_LOCK_HELD: '1' } : {});
      if (r.status !== 0) throw new Error(this.redact(r.stderr).split('\n').filter(Boolean).pop() || 'retention failed');
      const removed: string[] = JSON.parse(r.stdout.trim().split('\n').pop() || '{}').removed || [];
      if (removed.length) {
        const rows = await (this.prisma as any).systemBackup.findMany({ where: { fileName: { in: removed } } });
        for (const row of rows.filter((x: any) => this.isStream(x))) {
          await (this.prisma as any).systemBackup.delete({ where: { id: row.id } }).catch(() => undefined);
          this.logger.log(`Retention removed snapshot ${row.fileName}`);
        }
      }
      this.remoteCache = null;
      return;
    }
    const rows = await (this.prisma as any).systemBackup.findMany({
      where: { status: 'COMPLETED' }, orderBy: { createdAt: 'desc' },
    });
    if (rows.length <= keep) return;

    // Always preserve the most-recent verified backup, the newest overall and
    // the newest FULL_SYSTEM backup (database-only runs must not evict it).
    const newestVerified = rows.find((r: any) => r.verifyResult === 'VERIFIED');
    const newestFull = rows.find((r: any) => r.kind === 'FULL_SYSTEM');
    const protectedIds = new Set<string>([rows[0]?.id, newestVerified?.id, newestFull?.id].filter(Boolean));

    const candidates = rows.slice(keep).filter((r: any) => !protectedIds.has(r.id));
    for (const r of candidates) {
      await this.removeArtifacts(r);
      await (this.prisma as any).systemBackup.delete({ where: { id: r.id } }).catch(() => undefined);
      this.logger.log(`Retention removed backup ${r.id} (${r.fileName})`);
    }
  }

  private async removeArtifacts(record: any): Promise<void> {
    if (this.isStream(record)) {
      const r = await this.runScript('snapshot.sh', ['delete', this.pkgOf(record)]);
      if (r.status !== 0) throw new InternalServerErrorException(`Could not delete snapshot from backup storage: ${this.redact(r.stderr).split('\n').filter(Boolean).pop()}`);
      this.remoteCache = null;
      return;
    }
    const meta = record.metadata as any;
    for (const p of [record.filePath, meta?.artifact, meta?.artifact ? `${meta.artifact}.sha256` : null]) {
      if (!p || !fs.existsSync(p)) continue;
      try {
        const st = fs.statSync(p);
        if (st.isDirectory()) fs.rmSync(p, { recursive: true, force: true });
        else fs.unlinkSync(p);
      } catch (e: any) { this.logger.warn(`remove ${p}: ${e?.message}`); }
    }
  }

  // ── Preview / validate before restore ───────────────────────────────────────

  async previewRestore(id: string): Promise<any> {
    const record = await (this.prisma as any).systemBackup.findUnique({ where: { id } });
    if (!record) throw new NotFoundException(`Backup ${id} not found`);
    const warnings: string[] = [];
    let exists: boolean;
    let remote: Map<string, any> | null = null;
    if (this.isStream(record)) {
      remote = await this.remoteSnapshots(true);
      exists = !!remote?.has(this.pkgOf(record));
      if (!remote) warnings.push('Backup storage is unreachable. Restore will fail.');
      else if (!exists) warnings.push('Snapshot is missing from backup storage. Restore will fail.');
    } else {
      const dumpPath = this.dumpPathFor(record);
      exists = !!dumpPath && fs.existsSync(dumpPath);
      if (!exists) warnings.push('Backup database dump is missing from disk. Restore will fail.');
    }
    if (await this.isLocked()) warnings.push('Another backup or restore operation is currently running.');
    if (record.status === 'DEGRADED') {
      for (const i of ((record.metadata as any)?.recoveryIssues ?? []).filter((x: any) => x.severity !== 'INFO')) {
        warnings.push(`DEGRADED backup — ${i.code} (${i.count}): ${i.detail}. Restoring requires explicit acceptance (acceptDegraded).`);
      }
    }

    return {
      backup: this.formatBackup(record, remote),
      fileExists: exists,
      warnings,
      restoreOptions: [
        { mode: RestoreMode.FULL, label: 'Full Restore', risk: 'HIGH',
          description: 'Drop all database objects, then restore schema + data from backup.' },
        { mode: RestoreMode.DATA_ONLY, label: 'Data-Only Restore', risk: 'MEDIUM',
          description: 'Restore row data only. Current schema is kept as-is.' },
        { mode: RestoreMode.CLEAN, label: 'Clean Data Restore', risk: 'HIGH',
          description: 'TRUNCATE all tables (cascade), then restore data from backup.' },
      ],
    };
  }

  /** Locate the database.dump for a package dir, or the legacy single file. */
  private dumpPathFor(record: any): string | null {
    if (!record.filePath) return null;
    try {
      if (fs.statSync(record.filePath).isDirectory()) {
        const p = path.join(record.filePath, 'database', 'database.dump');
        return fs.existsSync(p) ? p : null;
      }
      return record.filePath; // legacy single-file .dump
    } catch { return null; }
  }

  // ── Restore (version-aware; in-place over the current DB) ────────────────────

  async restoreBackup(id: string, dto: RestoreBackupDto, userId?: string, userEmail?: string): Promise<any> {
    if (dto.confirmPhrase !== RESTORE_CONFIRM_PHRASE) {
      throw new BadRequestException(`Confirmation phrase incorrect. You must type exactly: ${RESTORE_CONFIRM_PHRASE}`);
    }
    const record = await (this.prisma as any).systemBackup.findUnique({ where: { id } });
    if (!record) throw new NotFoundException(`Backup ${id} not found`);
    if (record.status === 'DEGRADED' && dto.acceptDegraded !== true) {
      throw new BadRequestException('This backup is DEGRADED: files referenced by its database are missing from it (see the backup\'s recovery issues). Restoring it requires acceptDegraded=true.');
    }
    if (record.status !== 'COMPLETED' && record.status !== 'DEGRADED') {
      throw new BadRequestException(`Backup is not a usable recovery point (status: ${record.status})`);
    }
    const stream = this.isStream(record);
    const dumpPath = stream ? null : this.dumpPathFor(record);
    if (!stream && !dumpPath) throw new NotFoundException(`Backup database dump not found on disk for ${id}.`);

    const conn = parseDatabaseUrl(process.env.DATABASE_URL!);
    const targetMajor = await this.serverMajor();
    const archiveMajor = (record.metadata as any)?.manifest?.source?.serverMajor;
    let tools;
    try {
      // In-place restore targets the CURRENT server; require a client matching
      // that major (not merely the newest installed).
      tools = targetMajor
        ? resolvePgToolsForRestore(targetMajor, archiveMajor)
        : resolvePgTools(undefined);
    } catch (e) {
      if (e instanceof PgToolError) throw new ServiceUnavailableException(e.message);
      throw e;
    }

    // Single cross-instance lock for the whole restore (incl. the safety backup,
    // which runs under the SAME lock via doBackupSync — no re-acquire deadlock).
    const lock = await this.acquireLock();

    await this.auditLog.log({
      userId, userEmail, action: 'RESTORE_REQUESTED', entity: 'SystemBackup', entityId: id,
      changes: { fileName: record.fileName, restoreMode: dto.restoreMode },
    });

    let safetyBackupId: string | null = null;
    try {
      if (!dto.skipSafetyBackup) {
        try {
          const safety = await this.doBackupSync(
            'database', { notes: `[SAFETY] pre-restore of ${record.fileName}`, kind: BackupKind.DATABASE } as any,
            userId, userEmail, lock);
          safetyBackupId = safety?.id ?? null;
        } catch (e: any) {
          this.logger.warn(`Safety backup failed (continuing): ${e?.message}`);
        }
      }

      await this.auditLog.log({
        userId, userEmail, action: 'RESTORE_STARTED', entity: 'SystemBackup', entityId: id,
        changes: { restoreMode: dto.restoreMode, safetyBackupId },
      });

      if (stream) {
        // Verify the stored snapshot (dump sha256 + complete archive parse)
        // BEFORE touching the database, then stream the dump straight from the
        // bucket into pg_restore — no local copy, bounded memory.
        const v = await this.runScript('snapshot.sh', ['verify', this.pkgOf(record)]);
        if (v.status !== 0 && v.status !== 6) throw new Error(`stored snapshot failed verification: ${this.redact(v.stderr).split('\n').filter((l) => l.includes('✗')).slice(0, 3).join('; ')}`);
      }
      if (dto.restoreMode === RestoreMode.CLEAN) await this.truncateAllTables();
      await this.runPgRestore(tools.pgRestore, conn, stream ? { snapshot: this.pkgOf(record) } : { file: dumpPath! }, dto.restoreMode);

      await this.auditLog.log({
        userId, userEmail, action: 'RESTORE_COMPLETED', entity: 'SystemBackup', entityId: id,
        changes: { restoreMode: dto.restoreMode, safetyBackupId },
      });
      return {
        success: true, backupId: id, restoreMode: dto.restoreMode, safetyBackupId,
        completedAt: new Date().toISOString(),
        message: 'Restore completed successfully.' +
          (safetyBackupId ? ` Safety backup ${safetyBackupId} created.` : ''),
      };
    } catch (err: any) {
      await this.auditLog.log({
        userId, userEmail, action: 'RESTORE_FAILED', entity: 'SystemBackup', entityId: id,
        changes: { error: this.redact(err.message), safetyBackupId },
      });
      throw new InternalServerErrorException(
        `Restore failed: ${this.redact(err.message)}.` +
        (safetyBackupId ? ` A safety backup exists (ID ${safetyBackupId}).` : ''));
    } finally {
      await this.releaseLock(lock);
    }
  }

  private runPgRestore(pgRestore: string, conn: DBConn, source: { file: string } | { snapshot: string }, mode: RestoreMode): Promise<void> {
    return new Promise((resolve, reject) => {
      const baseArgs = [
        '--no-owner', '--no-acl',
        `--host=${conn.host}`, `--port=${conn.port}`,
        `--username=${conn.username}`, `--dbname=${conn.database}`,
      ];
      let extra: string[];
      switch (mode) {
        case RestoreMode.FULL: extra = ['--clean', '--if-exists']; break;
        case RestoreMode.DATA_ONLY: extra = ['--data-only', '--disable-triggers']; break;
        case RestoreMode.CLEAN: extra = ['--data-only', '--disable-triggers']; break;
      }
      const fromSnapshot = 'snapshot' in source;
      const child = spawn(pgRestore, [...baseArgs, ...extra, ...(fromSnapshot ? [] : [source.file])], {
        env: pgEnv(conn), stdio: [fromSnapshot ? 'pipe' : 'ignore', 'pipe', 'pipe'],
      });
      if (fromSnapshot) {
        const cat = spawn('bash', [this.script('snapshot.sh'), 'cat', source.snapshot, 'database/database.dump'], { env: this.scriptEnv(), stdio: ['ignore', 'pipe', 'pipe'] });
        cat.stdout.pipe(child.stdin!);
        child.stdin!.on('error', () => undefined);
        cat.on('close', (code) => { if (code !== 0) child.kill('SIGTERM'); });
      }
      let stderr = '';
      child.stderr?.on('data', (d) => { stderr += d.toString(); });
      child.on('close', (code) => {
        if (code === 0 || code === 1) {
          if (stderr.trim()) this.logger.warn(`pg_restore warnings: ${stderr.trim().slice(-500)}`);
          resolve();
        } else reject(new Error(`pg_restore exited ${code}: ${stderr.trim().slice(-500)}`));
      });
      child.on('error', (err) => reject(new Error(`pg_restore spawn error: ${err.message}`)));
    });
  }

  private async truncateAllTables(): Promise<void> {
    const tables = await this.prisma.$queryRaw<{ tablename: string }[]>`
      SELECT tablename FROM pg_tables
      WHERE schemaname = 'public' AND tablename != 'system_backups'
      ORDER BY tablename`;
    if (tables.length === 0) return;
    const list = tables.map((t) => `"${t.tablename}"`).join(', ');
    await this.prisma.$executeRawUnsafe(`TRUNCATE TABLE ${list} RESTART IDENTITY CASCADE`);
  }

  async deleteBackup(id: string, userId?: string, userEmail?: string): Promise<{ message: string }> {
    const record = await (this.prisma as any).systemBackup.findUnique({ where: { id } });
    if (!record) throw new NotFoundException(`Backup ${id} not found`);
    if (record.status === 'RUNNING') throw new BadRequestException('Cannot delete a backup that is currently in progress.');
    await this.removeArtifacts(record);
    await (this.prisma as any).systemBackup.delete({ where: { id } });
    await this.auditLog.log({
      userId, userEmail, action: 'BACKUP_DELETED', entity: 'SystemBackup', entityId: id,
      changes: { fileName: record.fileName },
    });
    return { message: `Backup "${record.fileName}" deleted successfully.` };
  }

  /**
   * Record which legacy "/uploads/…" files THIS instance holds on its local
   * disk (App Platform disks are per instance). Backups taken by any instance
   * then resolve references from it. Call repeatedly until every running
   * instance has answered — the response names the instance that served it.
   */
  async legacyInventory(userId?: string, userEmail?: string): Promise<any> {
    if (this.engine() !== 'stream') throw new BadRequestException('Legacy inventories are stored in the backup bucket (streaming engine only).');
    const r = await this.runScript('snapshot.sh', ['legacy-inventory']);
    if (r.status !== 0) throw new ServiceUnavailableException(`legacy inventory failed: ${this.redact(r.stderr).split('\n').filter(Boolean).pop()}`);
    const out = JSON.parse(r.stdout.trim().split('\n').pop() || '{}');
    await this.auditLog.log({ userId, userEmail, action: 'BACKUP_LEGACY_INVENTORY', entity: 'SystemBackup', entityId: 'legacy-inventory', changes: out });
    return out;
  }

  /** Which instances have recorded a legacy inventory (instance, when, how many files). */
  async legacyInventories(): Promise<any> {
    if (this.engine() !== 'stream') throw new BadRequestException('Legacy inventories are stored in the backup bucket (streaming engine only).');
    const r = await this.runScript('snapshot.sh', ['legacy-inventories']);
    if (r.status !== 0) throw new ServiceUnavailableException(`listing legacy inventories failed: ${this.redact(r.stderr).split('\n').filter(Boolean).pop()}`);
    return { servedBy: process.env.HOSTNAME || null, inventories: JSON.parse(r.stdout.trim().split('\n').pop() || '[]') };
  }

  async getActiveOperation(): Promise<{ locked: boolean }> {
    return { locked: await this.isLocked() };
  }

  // ── Formatter ───────────────────────────────────────────────────────────────

  private formatBackup(record: any, remote: Map<string, any> | null = null): any {
    const meta = record.metadata as any;
    const kind = record.kind || record.backupType || 'DATABASE';
    const legacy = !record.kind; // rows created before the kind column existed
    // Stream snapshots live in the backup bucket: presence is what the bucket
    // says (any instance gives the same answer), never this instance's disk.
    // Bucket unreachable → fall back to the last reconciled state.
    const present = this.isStream(record)
      ? (remote ? remote.has(this.pkgOf(record)) : !record.fileMissing)
      : (!!this.downloadPath(record) || this.verifyTarget(record) != null);
    return {
      id: record.id,
      fileName: record.fileName,
      fileSize: Number(record.fileSize ?? 0),
      fileSizeHuman: formatBytes(record.fileSize),
      backupType: record.backupType,
      kind: legacy ? 'DATABASE' : kind,
      kindLabel: legacy ? 'Database (legacy)' : (kind === 'FULL_SYSTEM' ? 'Full System' : 'Database'),
      status: record.status,
      notes: record.notes,
      errorMessage: record.errorMessage,
      checksum: record.checksum ?? null,
      verifyResult: record.verifyResult ?? null,
      verifiedAt: record.verifiedAt ?? null,
      restoreTestedAt: record.restoreTestedAt ?? null,
      offsiteStatus: record.offsiteStatus ?? 'NONE',
      fileMissing: this.isStream(record) ? !present : (record.fileMissing ?? !present),
      engine: meta?.engine ?? 'staging',
      // Two separate verdicts: is it a complete recovery point, and are the
      // stored bytes intact?
      recoverability: meta?.recoverability ?? (record.status === 'COMPLETED' ? 'COMPLETE' : record.status === 'DEGRADED' ? 'DEGRADED' : record.status === 'INCOMPLETE' ? 'INCOMPLETE' : null),
      integrity: record.verifyResult === 'VERIFIED' ? 'OK' : record.verifyResult === 'FAILED' ? 'FAILED' : null,
      recoveryIssues: (meta?.recoveryIssues ?? []).filter((i: any) => i.severity !== 'INFO')
        .map((i: any) => ({ code: i.code, severity: i.severity, count: i.count, detail: i.detail, action: i.action })),
      location: this.isStream(record) ? record.offsiteLocation ?? record.filePath : undefined,
      danglingReferences: meta?.danglingReferences ?? 0,
      components: meta?.manifest?.components ?? null,
      uploadsIncluded: meta?.uploadsIncluded ?? false,
      uploadsCount: meta?.uploadsCount ?? 0,
      metadata: meta,
      createdAt: record.createdAt,
      completedAt: record.completedAt,
      createdBy: record.createdBy
        ? { id: record.createdBy.id, name: `${record.createdBy.firstName} ${record.createdBy.lastName}`, email: record.createdBy.email }
        : null,
      fileExists: present,
    };
  }
}
