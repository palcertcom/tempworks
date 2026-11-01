/**
 * Phase 1 audit framework — read-only.
 *
 * Every audit script:
 *   1. Connects to `process.env.DATABASE_URL` (or `--db <url>`).
 *   2. Detects the existence of expected tables / columns first.
 *   3. Runs ONLY SELECT queries.
 *   4. Writes JSON + Markdown reports to `backend/reports/saas/phase1/`.
 *
 * Reports are designed to be safe to run on a production replica: no
 * locks held beyond the SELECT, no temp tables, no advisory locks.
 */

import { Client, ClientConfig } from 'pg';
import { promises as fs } from 'fs';
import path from 'path';
import { autoLoadEnv, formatDatabaseUrlMissingMessage } from '../reconciliation/lib/env';

// Auto-load `.env` from common locations (CWD, backend/, repo root). Safe
// no-op if DATABASE_URL is already in the environment. Removes the
// "export vs $env: vs set" footgun across shells.
autoLoadEnv(__filename);

export type Severity = 'OK' | 'INFO' | 'WARN' | 'BLOCKER';

export interface AuditFinding {
  severity: Severity;
  rule: string;        // short stable code, e.g. 'agency.system-count'
  message: string;
  detail?: unknown;
}

export interface AuditMetric {
  key: string;
  value: number | string | null;
  note?: string;
}

export interface AuditReport {
  slug: string;
  title: string;
  startedAt: string;
  durationMs: number;
  /** Highest severity present in `findings`. */
  status: Severity;
  metrics: AuditMetric[];
  findings: AuditFinding[];
  notes?: string[];
}

export interface AuditContext {
  client: Client;
  /** Output directory for JSON + MD reports. */
  outDir: string;
  /** Whether the DB is detected to be a Tempworks pre-migration shape. */
  shape: { hasTempworksTables: boolean; missingTables: string[] };
}

/** Tables we rely on for the audits. Missing = degrade gracefully. */
const EXPECTED_TABLES = [
  'agencies', 'users', '"Role"', 'applicants', 'employees', 'documents',
  'job_ads', 'attendance_records', 'attendance_locked_periods',
  'financial_records', 'workflows', 'reports', 'notifications',
  'vehicles', 'identifier_sequences', 'audit_logs',
  'employee_agency_access', 'agency_user_permission',
];

export async function connect(): Promise<Client> {
  const argDb = process.argv.find((a) => a.startsWith('--db='))?.slice(5);
  const url = argDb ?? process.env.DATABASE_URL;
  if (!url) throw new Error(formatDatabaseUrlMissingMessage());
  const cfg: ClientConfig = { connectionString: url };
  // SSL handling: respect sslmode= in URL; default to no-SSL for localhost.
  if (/^postgres(?:ql)?:\/\/(?:[^@]*@)?(?:localhost|127\.0\.0\.1)/.test(url)) {
    cfg.ssl = false;
  } else {
    cfg.ssl = { rejectUnauthorized: false };
  }
  const c = new Client(cfg);
  await c.connect();
  return c;
}

export async function detectShape(c: Client): Promise<AuditContext['shape']> {
  const present = new Set<string>();
  const r = await c.query<{ tablename: string }>(
    `SELECT tablename FROM pg_tables WHERE schemaname = 'public'`,
  );
  for (const row of r.rows) present.add(row.tablename);
  const missing: string[] = [];
  for (const t of EXPECTED_TABLES) {
    const bare = t.replace(/"/g, '');
    if (!present.has(bare)) missing.push(bare);
  }
  return { hasTempworksTables: missing.length < EXPECTED_TABLES.length / 2, missingTables: missing };
}

export async function tableExists(c: Client, name: string): Promise<boolean> {
  const r = await c.query<{ ok: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM pg_tables WHERE schemaname='public' AND tablename = $1) AS ok`,
    [name],
  );
  return r.rows[0]?.ok ?? false;
}

export async function columnExists(c: Client, table: string, column: string): Promise<boolean> {
  const r = await c.query<{ ok: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM information_schema.columns
        WHERE table_schema='public' AND table_name=$1 AND column_name=$2
     ) AS ok`,
    [table, column],
  );
  return r.rows[0]?.ok ?? false;
}

export function severityRank(s: Severity): number {
  return { OK: 0, INFO: 1, WARN: 2, BLOCKER: 3 }[s];
}

export function rollupStatus(findings: AuditFinding[]): Severity {
  let max: Severity = 'OK';
  for (const f of findings) if (severityRank(f.severity) > severityRank(max)) max = f.severity;
  return max;
}

/** Write a single audit's JSON + MD reports. */
export async function writeReport(report: AuditReport, outDir: string): Promise<void> {
  await fs.mkdir(outDir, { recursive: true });
  const jsonPath = path.join(outDir, `${report.slug}.json`);
  const mdPath = path.join(outDir, `${report.slug}.md`);
  await fs.writeFile(jsonPath, JSON.stringify(report, null, 2));

  const md: string[] = [];
  md.push(`# ${report.title}`);
  md.push('');
  md.push(`- **Status:** ${report.status}`);
  md.push(`- **Started:** ${report.startedAt}`);
  md.push(`- **Duration:** ${report.durationMs} ms`);
  md.push('');
  if (report.metrics.length) {
    md.push('## Metrics');
    md.push('');
    md.push('| Key | Value | Note |');
    md.push('|-----|-------|------|');
    for (const m of report.metrics) {
      md.push(`| \`${m.key}\` | ${m.value === null ? '—' : String(m.value)} | ${m.note ?? ''} |`);
    }
    md.push('');
  }
  if (report.findings.length) {
    md.push('## Findings');
    md.push('');
    for (const f of report.findings) {
      md.push(`- **[${f.severity}]** \`${f.rule}\` — ${f.message}`);
      if (f.detail) md.push('  ```json\n  ' + JSON.stringify(f.detail).slice(0, 800) + '\n  ```');
    }
  } else {
    md.push('No findings.');
  }
  if (report.notes?.length) {
    md.push('');
    md.push('## Notes');
    for (const n of report.notes) md.push(`- ${n}`);
  }
  md.push('');
  await fs.writeFile(mdPath, md.join('\n'));
}

/** Run a single audit fn safely (catches DB errors as a single BLOCKER finding). */
export async function runAudit(
  slug: string,
  title: string,
  outDir: string,
  fn: (ctx: AuditContext) => Promise<{ metrics: AuditMetric[]; findings: AuditFinding[]; notes?: string[] }>,
): Promise<AuditReport> {
  const startedAt = new Date().toISOString();
  const t0 = Date.now();
  let metrics: AuditMetric[] = [];
  let findings: AuditFinding[] = [];
  let notes: string[] = [];
  let client: Client | null = null;
  try {
    client = await connect();
    const shape = await detectShape(client);
    const ctx: AuditContext = { client, outDir, shape };
    const r = await fn(ctx);
    metrics = r.metrics;
    findings = r.findings;
    notes = r.notes ?? [];
  } catch (e) {
    findings = [
      {
        severity: 'BLOCKER',
        rule: 'audit.exec-failed',
        message: `Audit ${slug} failed: ${(e as Error).message}`,
      },
    ];
  } finally {
    if (client) await client.end().catch(() => undefined);
  }
  const report: AuditReport = {
    slug,
    title,
    startedAt,
    durationMs: Date.now() - t0,
    status: rollupStatus(findings),
    metrics,
    findings,
    notes,
  };
  await writeReport(report, outDir);
  // eslint-disable-next-line no-console
  console.log(`[${report.status.padEnd(7)}] ${slug.padEnd(28)} ${report.findings.length} finding(s)  ${report.durationMs}ms`);
  return report;
}
