import { Client } from 'pg';
import { resolvePoolSsl } from '../../prisma/pg-ssl';

/**
 * Cross-instance PostgreSQL advisory locks.
 *
 * BACKUP lock (one key, two modes):
 *   EXCLUSIVE — held by a backup/restore for the whole operation (the app's
 *               BackupService or scripts/dr/snapshot-engine.mjs on any host).
 *   SHARED    — held by the storage purge worker while it deletes objects, so a
 *               backup can never START between the purge's reference check and
 *               its deletes (and a purge never runs while a backup is between
 *               its database snapshot and its file capture).
 * PURGE lock — exclusive, so only one app instance purges at a time.
 *
 * Locks are session-level on a dedicated connection; PostgreSQL releases them
 * when the session ends (process exit, or — for a killed host — when the
 * shortened server-side TCP keepalive below detects the dead peer).
 */
export const BACKUP_ADVISORY_LOCK_KEY = 7243008153;
export const PURGE_ADVISORY_LOCK_KEY = 7243008154;

export function newLockClient(): Client {
  return new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: resolvePoolSsl(process.env.DATABASE_URL) as any,
  });
}

/** Connect a lock session with short server-side keepalives (dead hosts release locks in ~1 min). */
export async function connectLockClient(): Promise<Client> {
  const c = newLockClient();
  await c.connect();
  await c.query('SET tcp_keepalives_idle = 20; SET tcp_keepalives_interval = 10; SET tcp_keepalives_count = 3')
    .catch(() => undefined); // not fatal (e.g. unix socket)
  return c;
}

/** Is the backup lock held in EXCLUSIVE mode (a real backup/restore) by any session? */
export async function backupRunningAnywhere(c: Client): Promise<boolean> {
  const r = await c.query(
    `SELECT count(*)::int AS n FROM pg_locks
      WHERE locktype = 'advisory' AND mode = 'ExclusiveLock' AND granted AND objsubid = 1
        AND ((classid::bigint << 32) | objid::bigint) = $1`, [BACKUP_ADVISORY_LOCK_KEY]);
  return (r.rows[0]?.n ?? 0) > 0;
}

/** True when a backup/restore (exclusive holder) is running in this or another instance. */
export async function isBackupLockHeld(): Promise<boolean> {
  const c = await connectLockClient();
  try { return await backupRunningAnywhere(c); }
  finally { await c.end().catch(() => undefined); }
}

/**
 * Run `fn` holding the purge lock + the SHARED backup lock. Skips (ran=false)
 * when another instance is purging or a backup/restore is running.
 */
export async function withPurgeLocks<T>(fn: () => Promise<T>): Promise<{ ran: boolean; reason?: 'backup' | 'purge'; value?: T }> {
  const c = await connectLockClient();
  try {
    const p = await c.query('SELECT pg_try_advisory_lock($1) AS ok', [PURGE_ADVISORY_LOCK_KEY]);
    if (p.rows[0]?.ok !== true) return { ran: false, reason: 'purge' };
    const b = await c.query('SELECT pg_try_advisory_lock_shared($1) AS ok', [BACKUP_ADVISORY_LOCK_KEY]);
    if (b.rows[0]?.ok !== true) return { ran: false, reason: 'backup' };
    return { ran: true, value: await fn() };
  } finally {
    await c.end().catch(() => undefined); // ending the session releases both locks
  }
}
