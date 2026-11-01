/**
 * Cross-platform applier for the SaaS Phase 0/1 migration SQL files.
 *
 * Why this exists:
 *   - The standard `psql -f migration.sql` workflow requires `psql.exe`
 *     on PATH. On many Windows installations Postgres is installed but
 *     `psql` is not exposed; operators hit a confusing PowerShell
 *     "term not recognized" error.
 *   - Prisma 7 `migrate deploy` is not configured for these migrations
 *     (Tempworks ships hand-rolled SQL outside Prisma's history).
 *
 * What it does:
 *   - Reads `migration.sql` from each named migration directory.
 *   - Executes the file as a single statement using node-postgres,
 *     inside the script's own connection (one transaction per file via
 *     the SQL's own BEGIN/COMMIT).
 *   - Idempotent — every CREATE / ALTER in our SQL uses
 *     `IF NOT EXISTS`, so re-running is safe.
 *
 * Usage:
 *   npm run saas:apply-migrations            # phase0 + phase1, default
 *   npm run saas:apply-migrations -- --phase 0
 *   npm run saas:apply-migrations -- --phase 1
 *   npm run saas:apply-migrations -- --rollback   # runs migration.down.sql
 *
 * Requires DATABASE_URL (auto-loaded from backend/.env or shell env).
 */
import { Client, ClientConfig } from 'pg';
import { promises as fs } from 'fs';
import path from 'path';
import {
  autoLoadEnv,
  formatDatabaseUrlMissingMessage,
} from './reconciliation/lib/env';

autoLoadEnv(__filename);

const MIGRATIONS = [
  { phase: '0', dir: 'saas_phase0_foundations' },
  { phase: '1', dir: 'saas_phase1_tenant_backfill_prepare' },
];

function getDatabaseUrl(): string {
  const arg = process.argv.find((a) => a.startsWith('--db='))?.slice(5);
  const url = arg ?? process.env.DATABASE_URL;
  if (!url) throw new Error(formatDatabaseUrlMissingMessage());
  return url;
}

async function applyOne(client: Client, file: string): Promise<void> {
  const sql = await fs.readFile(file, 'utf8');
  // The SQL itself wraps everything in BEGIN/COMMIT, so we hand it to
  // the driver as a single statement. node-postgres supports multi-
  // statement query strings out of the box.
  await client.query(sql);
}

async function main(): Promise<void> {
  const url = getDatabaseUrl();
  const phaseArg = process.argv.find((a) => a.startsWith('--phase'));
  const onlyPhase = phaseArg
    ? (process.argv[process.argv.indexOf(phaseArg) + 1] ?? phaseArg.split('=')[1])
    : null;
  const rollback = process.argv.includes('--rollback');

  const targets = MIGRATIONS.filter((m) => !onlyPhase || m.phase === onlyPhase);
  if (rollback) targets.reverse();

  const cfg: ClientConfig = { connectionString: url };
  const host = (() => { try { return new URL(url).hostname; } catch { return ''; } })();
  cfg.ssl = (host === '127.0.0.1' || host === 'localhost') ? false : { rejectUnauthorized: false };

  const client = new Client(cfg);
  await client.connect();
  // eslint-disable-next-line no-console
  console.log(`Connected to ${url.replace(/:[^:@/]+@/, ':***@')}`);

  try {
    for (const m of targets) {
      const which = rollback ? 'migration.down.sql' : 'migration.sql';
      const fp = path.resolve(__dirname, '..', '..', '..', 'prisma', 'migrations', m.dir, which);
      // eslint-disable-next-line no-console
      console.log(`\n--- phase ${m.phase} ${rollback ? '(rollback)' : ''} → ${path.relative(process.cwd(), fp)} ---`);
      try {
        await applyOne(client, fp);
        // eslint-disable-next-line no-console
        console.log(`    OK`);
      } catch (e) {
        // eslint-disable-next-line no-console
        console.error(`    FAILED: ${(e as Error).message}`);
        throw e;
      }
    }
  } finally {
    await client.end();
  }

  // eslint-disable-next-line no-console
  console.log(`\nAll requested migrations applied. Run \`npx prisma generate\` next if you changed schema.prisma.`);
}

main().catch((e) => {
  // eslint-disable-next-line no-console
  console.error(e);
  process.exit(1);
});
