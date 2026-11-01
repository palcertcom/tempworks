/**
 * Phase 2.53 — Audit-log retention enforcement (soft-delete).
 *
 * Default-OFF, dry-run by default. Apply requires THREE gates:
 *   AUDIT_LOG_RETENTION_ENABLED=true
 *   AUDIT_LOG_RETENTION_APPLY=true
 *   classifyRuntimeEnv ⇒ SAFE_CLONE / SAFE_STAGING
 *
 * Soft-delete only (`deletedAt = now()`). NEVER calls
 * `prisma.auditLog.delete` / `deleteMany` / `$executeRaw`.
 *
 * Tenant scope (env: `AUDIT_LOG_RETENTION_SCOPE`):
 *   "tenant"      — default; requires AUDIT_LOG_RETENTION_TENANT_ID;
 *                   only soft-deletes rows with tenantId = <id>
 *   "null-tenant" — explicit; only soft-deletes rows with tenantId IS NULL
 *   "all"         — explicit; soft-deletes every eligible row regardless of tenantId
 *
 * Cutoff: now() - AUDIT_LOG_RETENTION_DAYS days (default 365; invalid ⇒ 365).
 *
 * Reports: backend/reports/saas/phase2/audit-log-retention-enforce.{json,md}
 *
 * Tag: phase253-audit-log-retention-enforce.
 */
/* eslint-disable no-console */
import { promises as fs } from 'fs';
import path from 'path';
import { Client } from 'pg';
import { autoLoadEnv, formatDatabaseUrlMissingMessage } from './../phase1/reconciliation/lib/env';
import { classifyRuntimeEnv, isStagingClassification } from '../../../src/saas/tenancy/env-safety';

autoLoadEnv(__filename);

const OUT_DIR = path.resolve(__dirname, '..', '..', '..', 'reports', 'saas', 'phase2');

export type RetentionScope = 'tenant' | 'null-tenant' | 'all';

export interface RetentionReport {
  mode: 'dry-run' | 'apply';
  applied: boolean;
  safeClassification: string;
  refusalReason?: string;
  scope: RetentionScope;
  tenantId: string | null;
  days: number;
  cutoffIso: string;
  candidateRows: number;
  alreadyDeletedRows: number;
  excludedByCutoff: number;
  updatedRows: number;
  beforeAliveRows: number;
  afterAliveRows: number;
  recommendedSnapshotSql: string;
}

function getDatabaseUrl(): string {
  const arg = process.argv.find((a) => a.startsWith('--db='))?.slice(5);
  return arg ?? process.env.DATABASE_URL ?? (() => { throw new Error(formatDatabaseUrlMissingMessage()); })();
}

function pgClient(url: string): Client {
  return new Client({ connectionString: url, ssl: /127\.0\.0\.1|localhost/.test(url) ? false : { rejectUnauthorized: false } });
}

function resolveDays(): number {
  const raw = Number(process.env.AUDIT_LOG_RETENTION_DAYS);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 365;
}

function resolveScope(): RetentionScope {
  const raw = String(process.env.AUDIT_LOG_RETENTION_SCOPE ?? 'tenant').toLowerCase();
  if (raw === 'null-tenant') return 'null-tenant';
  if (raw === 'all') return 'all';
  return 'tenant';
}

function buildScopeWhereSql(scope: RetentionScope, tenantId: string | null): { sql: string; params: unknown[] } {
  // Returns "<predicate>" composed with the rest of the WHERE clause.
  // Always pure; never used in DELETE statements.
  if (scope === 'tenant') {
    if (!tenantId) throw new Error('scope=tenant requires AUDIT_LOG_RETENTION_TENANT_ID');
    return { sql: '"tenantId" = $1', params: [tenantId] };
  }
  if (scope === 'null-tenant') return { sql: '"tenantId" IS NULL', params: [] };
  // all
  return { sql: 'TRUE', params: [] };
}

export async function runRetentionEnforce(databaseUrl: string): Promise<RetentionReport> {
  const env = classifyRuntimeEnv();
  const enabled = String(process.env.AUDIT_LOG_RETENTION_ENABLED ?? '').toLowerCase() === 'true';
  const applyFlag = String(process.env.AUDIT_LOG_RETENTION_APPLY ?? '').toLowerCase() === 'true';
  const safe = isStagingClassification(env.classification);
  const days = resolveDays();
  const scope = resolveScope();
  const tenantId = process.env.AUDIT_LOG_RETENTION_TENANT_ID || null;
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

  let mode: 'dry-run' | 'apply' = 'dry-run';
  let refusalReason: string | undefined;
  if (!enabled) refusalReason = 'AUDIT_LOG_RETENTION_ENABLED=false';
  else if (!applyFlag) refusalReason = 'AUDIT_LOG_RETENTION_APPLY=false';
  else if (!safe)     refusalReason = `unsafe runtime classification ${env.classification} — apply refused`;
  else if (scope === 'tenant' && !tenantId) refusalReason = 'scope=tenant requires AUDIT_LOG_RETENTION_TENANT_ID';
  else mode = 'apply';

  const where = (() => {
    try { return buildScopeWhereSql(scope, tenantId); }
    catch { return { sql: 'FALSE', params: [] as unknown[] }; }
  })();

  const c = pgClient(databaseUrl);
  await c.connect();
  try {
    // Counts: candidates (older than cutoff, alive, in scope), already deleted in scope,
    // excluded by cutoff (alive but newer than cutoff in scope), and total alive in scope.
    const candidateQ = await c.query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM audit_logs
       WHERE "deletedAt" IS NULL AND "createdAt" < $${where.params.length + 1} AND ${where.sql}`,
      [...where.params, cutoff],
    );
    const alreadyDeletedQ = await c.query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM audit_logs
       WHERE "deletedAt" IS NOT NULL AND "createdAt" < $${where.params.length + 1} AND ${where.sql}`,
      [...where.params, cutoff],
    );
    const excludedQ = await c.query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM audit_logs
       WHERE "deletedAt" IS NULL AND "createdAt" >= $${where.params.length + 1} AND ${where.sql}`,
      [...where.params, cutoff],
    );
    const beforeAliveQ = await c.query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM audit_logs
       WHERE "deletedAt" IS NULL AND ${where.sql}`,
      where.params,
    );

    let updatedRows = 0;
    if (mode === 'apply') {
      // phase253-audit-log-retention-enforce: gated by ENABLED + APPLY + SAFE class.
      // Soft-delete only — no DELETE / deleteMany / $executeRaw.
      const upd = await c.query(
        `UPDATE audit_logs
         SET "deletedAt" = now()
         WHERE "deletedAt" IS NULL
           AND "createdAt" < $${where.params.length + 1}
           AND ${where.sql}`,
        [...where.params, cutoff],
      );
      updatedRows = upd.rowCount ?? 0;
    }

    const afterAliveQ = await c.query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM audit_logs
       WHERE "deletedAt" IS NULL AND ${where.sql}`,
      where.params,
    );

    return {
      mode,
      applied: mode === 'apply',
      safeClassification: env.classification,
      refusalReason,
      scope,
      tenantId,
      days,
      cutoffIso: cutoff.toISOString(),
      candidateRows: Number(candidateQ.rows[0].n),
      alreadyDeletedRows: Number(alreadyDeletedQ.rows[0].n),
      excludedByCutoff: Number(excludedQ.rows[0].n),
      updatedRows,
      beforeAliveRows: Number(beforeAliveQ.rows[0].n),
      afterAliveRows: Number(afterAliveQ.rows[0].n),
      recommendedSnapshotSql:
        `SELECT id, "tenantId", "createdAt", "deletedAt" ` +
        `FROM audit_logs ` +
        `WHERE "createdAt" < '${cutoff.toISOString()}' ` +
        `AND "deletedAt" IS NULL` +
        (scope === 'tenant' && tenantId ? ` AND "tenantId" = '${tenantId}'` :
         scope === 'null-tenant' ? ` AND "tenantId" IS NULL` :
         ``),
    };
  } finally {
    await c.end();
  }
}

async function main(): Promise<void> {
  const url = getDatabaseUrl();
  const report = await runRetentionEnforce(url);

  await fs.mkdir(OUT_DIR, { recursive: true });
  await fs.writeFile(
    path.join(OUT_DIR, 'audit-log-retention-enforce.json'),
    JSON.stringify(report, null, 2),
  );
  const lines = [
    `# Phase 2.53 — audit-log retention enforcement`, ``,
    `Generated: ${new Date().toISOString()}`,
    `Mode: **${report.mode}**`,
    `Classification: ${report.safeClassification}`,
    `Scope: ${report.scope}${report.tenantId ? ` (tenantId=${report.tenantId})` : ''}`,
    `Days: ${report.days}`,
    `Cutoff: ${report.cutoffIso}`,
    report.refusalReason ? `Refusal reason: ${report.refusalReason}` : `Apply executed.`,
    ``,
    `| Field | Value |`,
    `|---|---:|`,
    `| candidateRows | ${report.candidateRows} |`,
    `| alreadyDeletedRows | ${report.alreadyDeletedRows} |`,
    `| excludedByCutoff | ${report.excludedByCutoff} |`,
    `| updatedRows | ${report.updatedRows} |`,
    `| beforeAliveRows | ${report.beforeAliveRows} |`,
    `| afterAliveRows | ${report.afterAliveRows} |`,
    `| applied | ${report.applied} |`,
    ``,
    `## Recommended pre-apply snapshot`,
    '',
    '```sql',
    report.recommendedSnapshotSql,
    '```',
    '',
  ].join('\n');
  await fs.writeFile(path.join(OUT_DIR, 'audit-log-retention-enforce.md'), lines);

  console.log(
    `[audit-log-retention-enforce] mode=${report.mode} scope=${report.scope} ` +
    `candidate=${report.candidateRows} updated=${report.updatedRows} ` +
    `before=${report.beforeAliveRows} after=${report.afterAliveRows}`,
  );
}

if (require.main === module) {
  main().catch((err) => { console.error(err); process.exit(2); });
}
