/**
 * Phase 1 — Environment Safety Classifier.
 *
 * Read-only. Inspects the active DATABASE_URL plus a few process / DB
 * signals to classify the current target as one of:
 *
 *   SAFE_CLONE        — definitely a developer / fixture DB on localhost
 *   SAFE_STAGING      — a hostname matching the staging allow-list
 *   READONLY_REPLICA  — the DB itself reports default_transaction_read_only
 *   UNSAFE_PRODUCTION — DB host or name matches the production deny-list
 *   UNKNOWN           — none of the above; refuse to mutate
 *
 * Mutating scripts (the orchestrator, the recon `--apply` paths) MUST
 * fail closed against UNSAFE_PRODUCTION and UNKNOWN.
 */
import { Client, ClientConfig } from 'pg';
import { promises as fs } from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { autoLoadEnv, formatDatabaseUrlMissingMessage } from './reconciliation/lib/env';

autoLoadEnv(__filename);

const STAGING_HOST_RES = [
  /^127\.0\.0\.1$/, /^localhost$/, /^staging[-.]/, /^stg[-.]/,
  /\.staging\./, /\.stg\./, /^postgres-staging-/,
];
const PROD_HOST_RES = [
  /^prod[-.]/, /\.prod\./, /^postgres-prod-/, /\.production\./,
];
const PROD_DBNAME_RES = [/^prod$/i, /^production$/i, /_prod$/i, /^tempworks_prod/i];
const FIXTURE_DBNAME_RES = [/_fixture$/i, /_test$/i, /^spike_/i, /^saas_phase1_fixture$/i];

type Classification =
  | 'SAFE_CLONE' | 'SAFE_STAGING' | 'READONLY_REPLICA'
  | 'UNSAFE_PRODUCTION' | 'UNKNOWN';

interface SafetyReport {
  generatedAt: string;
  classification: Classification;
  reasons: string[];
  signals: {
    databaseUrlMasked: string;
    host: string;
    dbName: string;
    nodeEnv: string;
    allowSaasStagingMutation: boolean;
    allowNonStagingApply: boolean;
    gitBranch: string;
    gitCommit: string;
    serverVersion?: string;
    defaultTransactionReadOnly?: string;
    isPgBouncer?: boolean;
    rowCounts?: Record<string, number>;
  };
  permittedActions: {
    readOnlyAudits: boolean;
    reconciliationApply: boolean;
    tenantBackfillApply: boolean;
    rollbackMigration: boolean;
  };
}

function getDatabaseUrl(): string {
  const arg = process.argv.find((a) => a.startsWith('--db='))?.slice(5);
  const url = arg ?? process.env.DATABASE_URL;
  if (!url) throw new Error(formatDatabaseUrlMissingMessage());
  return url;
}

function maskUrl(url: string): string {
  return url.replace(/:[^:@/]+@/, ':***@');
}

function gitInfo(): { gitBranch: string; gitCommit: string } {
  try {
    const branch = execSync('git rev-parse --abbrev-ref HEAD', { stdio: ['ignore','pipe','ignore'] }).toString().trim();
    const commit = execSync('git rev-parse HEAD',                { stdio: ['ignore','pipe','ignore'] }).toString().trim();
    return { gitBranch: branch, gitCommit: commit };
  } catch { return { gitBranch: 'unknown', gitCommit: 'unknown' }; }
}

async function main(): Promise<void> {
  const url = getDatabaseUrl();
  let host = '', dbName = '';
  try { const u = new URL(url); host = u.hostname; dbName = u.pathname.replace(/^\//, ''); } catch { /* ignore */ }

  const reasons: string[] = [];
  const signals: SafetyReport['signals'] = {
    databaseUrlMasked: maskUrl(url),
    host,
    dbName,
    nodeEnv: process.env.NODE_ENV ?? 'unset',
    allowSaasStagingMutation: process.env.ALLOW_SAAS_STAGING_MUTATION === 'true',
    allowNonStagingApply:     process.env.ALLOW_NON_STAGING_APPLY === 'true',
    ...gitInfo(),
  };

  // Connect and pull live signals.
  const cfg: ClientConfig = { connectionString: url };
  cfg.ssl = (host === '127.0.0.1' || host === 'localhost') ? false : { rejectUnauthorized: false };
  const c = new Client(cfg);
  try {
    await c.connect();
    const v  = await c.query<{ v: string }>(`SELECT version() AS v`);
    signals.serverVersion = v.rows[0]?.v;
    const ro = await c.query<{ s: string }>(`SHOW default_transaction_read_only`);
    signals.defaultTransactionReadOnly = ro.rows[0]?.s;
    const pgb = await c.query<{ p: string | null }>(
      `SELECT current_setting('application_name', true) AS p`,
    );
    signals.isPgBouncer = /pgbouncer/i.test(pgb.rows[0]?.p ?? '');
    // Row-count summary for safety triangulation.
    const tables = ['agencies', 'users', 'employees', 'applicants', 'documents', 'tenants', 'tenant_memberships'];
    signals.rowCounts = {};
    for (const t of tables) {
      try {
        const r = await c.query<{ n: number }>(`SELECT count(*)::int n FROM "${t}"`);
        signals.rowCounts[t] = r.rows[0]?.n ?? 0;
      } catch { /* table missing, skip */ }
    }
  } finally {
    await c.end().catch(() => undefined);
  }

  // Classification logic — strictest match wins.
  let classification: Classification = 'UNKNOWN';
  const isProdHost = PROD_HOST_RES.some((re) => re.test(host));
  const isProdDb   = PROD_DBNAME_RES.some((re) => re.test(dbName));
  const isFixtureDb = FIXTURE_DBNAME_RES.some((re) => re.test(dbName));
  const isStagingHost = STAGING_HOST_RES.some((re) => re.test(host));
  const isReadOnly = signals.defaultTransactionReadOnly === 'on';

  if (isProdHost || isProdDb) {
    classification = 'UNSAFE_PRODUCTION';
    reasons.push(`Host or DB name matches the production deny-list (host=${host}, db=${dbName}).`);
  } else if (isReadOnly) {
    classification = 'READONLY_REPLICA';
    reasons.push('Database reports default_transaction_read_only = on.');
  } else if (isFixtureDb && (host === '127.0.0.1' || host === 'localhost')) {
    classification = 'SAFE_CLONE';
    reasons.push(`DB name "${dbName}" matches a fixture/test pattern and host is localhost.`);
  } else if (isStagingHost && signals.allowSaasStagingMutation) {
    classification = 'SAFE_STAGING';
    reasons.push(`Host "${host}" matches staging allow-list and ALLOW_SAAS_STAGING_MUTATION=true.`);
  } else if (isStagingHost) {
    classification = 'SAFE_STAGING';
    reasons.push(`Host "${host}" matches staging allow-list (mutation requires ALLOW_SAAS_STAGING_MUTATION=true).`);
  } else {
    classification = 'UNKNOWN';
    reasons.push(`Host "${host}" / DB "${dbName}" do not match any known pattern. Refusing to mutate.`);
  }

  if (signals.nodeEnv === 'production') {
    classification = classification === 'UNSAFE_PRODUCTION' ? classification : 'UNSAFE_PRODUCTION';
    reasons.push('NODE_ENV=production. All mutation paths are refused.');
  }

  const permits = {
    readOnlyAudits: classification !== 'UNKNOWN',
    reconciliationApply: classification === 'SAFE_CLONE' ||
      (classification === 'SAFE_STAGING' && signals.allowSaasStagingMutation),
    tenantBackfillApply:  classification === 'SAFE_CLONE' ||
      (classification === 'SAFE_STAGING' && signals.allowSaasStagingMutation),
    rollbackMigration: classification === 'SAFE_CLONE' || classification === 'SAFE_STAGING',
  };

  const report: SafetyReport = {
    generatedAt: new Date().toISOString(),
    classification,
    reasons,
    signals,
    permittedActions: permits,
  };

  const outDir = path.resolve(__dirname, '..', '..', '..', 'reports', 'saas', 'phase1-prod-replica');
  await fs.mkdir(outDir, { recursive: true });
  await fs.writeFile(path.join(outDir, 'env-safety.json'), JSON.stringify(report, null, 2));

  // Console-friendly print
  // eslint-disable-next-line no-console
  console.log(`Classification: ${classification}`);
  // eslint-disable-next-line no-console
  console.log(`Reasons:\n${reasons.map((r) => '  - ' + r).join('\n')}`);
  // eslint-disable-next-line no-console
  console.log(`\nPermitted actions:`);
  for (const [k, v] of Object.entries(permits)) {
    // eslint-disable-next-line no-console
    console.log(`  ${k.padEnd(20)} ${v ? 'YES' : 'no'}`);
  }
  // eslint-disable-next-line no-console
  console.log(`\nSignals:\n${JSON.stringify(signals, null, 2)}`);

  // Exit code: 0 if SAFE_*, 2 if READONLY_REPLICA, 3 if UNSAFE/UNKNOWN.
  if (classification === 'UNSAFE_PRODUCTION' || classification === 'UNKNOWN') process.exit(3);
  if (classification === 'READONLY_REPLICA') process.exit(2);
}

main().catch((e) => { console.error(e); process.exit(1); });
