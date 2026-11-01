/**
 * Reconciliation script framework.
 *
 * Every reconciliation script:
 *   - is DRY-RUN by default; mutations require explicit `--apply`.
 *   - in `--apply` mode, refuses to run unless the DB URL host is
 *     whitelisted as staging (see `assertStagingOnly`).
 *   - writes both JSON and Markdown to `backend/reports/saas/phase1/recon-<slug>.{json,md}`.
 *   - never executes destructive SQL on its own (no DELETE/DROP/TRUNCATE
 *     allowed in `--apply`); only INSERT/UPDATE on the `saas_reconciliation_queue`
 *     and the new tenancy tables.
 *
 * Usage pattern from the script:
 *   await runRecon('users', 'User reconciliation', async (ctx) => { ... })
 */

import { Client, ClientConfig } from 'pg';
import { promises as fs } from 'fs';
import path from 'path';
import { autoLoadEnv, formatDatabaseUrlMissingMessage } from './env';

// Auto-load `.env` from common locations so PowerShell / cmd users don't
// need to remember the platform-specific export syntax. Safe no-op if
// DATABASE_URL is already set.
autoLoadEnv(__filename);

export type Mode = 'dry-run' | 'apply' | 'preview';

export interface ReconAction {
  kind: string;             // e.g. 'user.no-agency.queue'
  subject: Record<string, unknown>;
  proposedDecision?: string;
  applied: boolean;         // true if this run executed the action
  sql?: string;             // human-readable SQL preview (no auto-execute beyond INSERT/UPDATE)
}

export interface ReconResult {
  slug: string;
  title: string;
  mode: Mode;
  database: string;
  startedAt: string;
  durationMs: number;
  metrics: { key: string; value: number | string | null; note?: string }[];
  actions: ReconAction[];
  notes?: string[];
  status: 'OK' | 'WARN' | 'BLOCKER';
}

/**
 * Whitelist hosts allowed for `--apply`. `production` should NEVER be here.
 * Operators must add their staging host explicitly.
 */
const STAGING_HOST_PATTERNS = [
  /^127\.0\.0\.1$/,
  /^localhost$/,
  /^staging[-.]/,
  /^stg[-.]/,
  /\.staging\./,
  /\.stg\./,
  /^postgres-staging-/,
];

const PROD_DENY_PATTERNS = [
  /^prod[-.]/,
  /\.prod\./,
  /^postgres-prod-/,
  /\.production\./,
];

export function parseMode(): Mode {
  if (process.argv.includes('--apply'))         return 'apply';
  if (process.argv.includes('--tenant-preview')) return 'preview';
  return 'dry-run';
}

export function getDatabaseUrl(): string {
  const argDb = process.argv.find((a) => a.startsWith('--db='))?.slice(5);
  const url = argDb ?? process.env.DATABASE_URL;
  if (!url) throw new Error(formatDatabaseUrlMissingMessage());
  return url;
}

export function assertStagingOnly(url: string): void {
  let host = '';
  try { host = new URL(url).hostname; } catch { host = ''; }
  if (PROD_DENY_PATTERNS.some((re) => re.test(host))) {
    throw new Error(`Refusing --apply: host "${host}" matches production deny pattern`);
  }
  if (!STAGING_HOST_PATTERNS.some((re) => re.test(host))) {
    throw new Error(
      `Refusing --apply: host "${host}" is not in the staging allowlist. ` +
      `Set ALLOW_NON_STAGING_APPLY=true to override (DO NOT do this against production).`,
    );
  }
}

export async function connect(): Promise<Client> {
  const url = getDatabaseUrl();
  const cfg: ClientConfig = { connectionString: url };
  const host = (() => { try { return new URL(url).hostname; } catch { return ''; } })();
  cfg.ssl = (host === '127.0.0.1' || host === 'localhost') ? false : { rejectUnauthorized: false };
  const c = new Client(cfg);
  await c.connect();
  return c;
}

export async function tableExists(c: Client, name: string): Promise<boolean> {
  const r = await c.query<{ ok: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM pg_tables WHERE schemaname='public' AND tablename=$1) AS ok`,
    [name],
  );
  return r.rows[0]?.ok ?? false;
}

export async function columnExists(c: Client, t: string, col: string): Promise<boolean> {
  const r = await c.query<{ ok: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM information_schema.columns
        WHERE table_schema='public' AND table_name=$1 AND column_name=$2
     ) AS ok`,
    [t, col],
  );
  return r.rows[0]?.ok ?? false;
}

export async function writeReport(r: ReconResult, outDir: string): Promise<void> {
  await fs.mkdir(outDir, { recursive: true });
  await fs.writeFile(path.join(outDir, `recon-${r.slug}.json`), JSON.stringify(r, null, 2));
  const md: string[] = [];
  md.push(`# ${r.title}`);
  md.push('');
  md.push(`- **Mode:** \`${r.mode}\``);
  md.push(`- **Status:** **${r.status}**`);
  md.push(`- **Database:** \`${r.database}\``);
  md.push(`- **Started:** ${r.startedAt}`);
  md.push(`- **Duration:** ${r.durationMs} ms`);
  md.push('');
  if (r.metrics.length) {
    md.push('## Metrics');
    md.push('');
    md.push('| Key | Value | Note |');
    md.push('|-----|-------|------|');
    for (const m of r.metrics) md.push(`| \`${m.key}\` | ${m.value ?? '—'} | ${m.note ?? ''} |`);
    md.push('');
  }
  md.push('## Actions');
  md.push('');
  if (!r.actions.length) {
    md.push('*No actions required.*');
  } else {
    md.push('| Kind | Applied | Proposed | Subject |');
    md.push('|------|---------|----------|---------|');
    for (const a of r.actions) {
      const subj = JSON.stringify(a.subject).slice(0, 200);
      md.push(`| \`${a.kind}\` | ${a.applied ? 'yes' : 'no'} | ${a.proposedDecision ?? ''} | ${subj} |`);
    }
  }
  if (r.notes?.length) {
    md.push('');
    md.push('## Notes');
    for (const n of r.notes) md.push(`- ${n}`);
  }
  md.push('');
  await fs.writeFile(path.join(outDir, `recon-${r.slug}.md`), md.join('\n'));
}

// __dirname = backend/scripts/saas/phase1/reconciliation/lib
// Five `..`s climb back to `backend/`; then `reports/saas/phase1` is the
// canonical output directory shared with the audit framework.
const REPORTS_DIR = path.resolve(__dirname, '..', '..', '..', '..', '..', 'reports', 'saas', 'phase1');

export async function runRecon(
  slug: string,
  title: string,
  fn: (ctx: { c: Client; mode: Mode }) => Promise<{
    metrics: ReconResult['metrics'];
    actions: ReconResult['actions'];
    notes?: string[];
    status: ReconResult['status'];
  }>,
): Promise<ReconResult> {
  const startedAt = new Date().toISOString();
  const t0 = Date.now();
  const mode = parseMode();
  const url = getDatabaseUrl();
  if (mode === 'apply' && !process.env.ALLOW_NON_STAGING_APPLY) assertStagingOnly(url);

  const c = await connect();
  let metrics: ReconResult['metrics'] = [];
  let actions: ReconResult['actions'] = [];
  let notes: string[] = [];
  let status: ReconResult['status'] = 'OK';
  try {
    const r = await fn({ c, mode });
    metrics = r.metrics;
    actions = r.actions;
    notes = r.notes ?? [];
    status = r.status;
  } catch (e) {
    actions.push({
      kind: 'recon.error',
      subject: { error: (e as Error).message },
      applied: false,
    });
    status = 'BLOCKER';
  } finally {
    await c.end().catch(() => undefined);
  }
  const result: ReconResult = {
    slug, title, mode,
    database: url.replace(/:[^:@/]+@/, ':***@'),
    startedAt,
    durationMs: Date.now() - t0,
    metrics, actions, notes, status,
  };
  await writeReport(result, REPORTS_DIR);
  // eslint-disable-next-line no-console
  console.log(
    `[${result.status.padEnd(7)}] ${slug.padEnd(20)} mode=${mode.padEnd(8)} ` +
    `metrics=${metrics.length} actions=${actions.length} (${result.durationMs}ms)`,
  );
  return result;
}

/** Strict UUID test (matches the RLS helper). */
export const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
