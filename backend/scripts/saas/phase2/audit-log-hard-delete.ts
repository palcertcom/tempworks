/**
 * Phase 2.54 — Audit-log hard-delete (already soft-deleted rows only).
 *
 * Default-OFF, dry-run by default. Apply requires THREE gates plus
 * a scope-specific tenant id when scope=tenant:
 *   AUDIT_LOG_HARD_DELETE_ENABLED=true
 *   AUDIT_LOG_HARD_DELETE_APPLY=true
 *   classifyRuntimeEnv ⇒ SAFE_CLONE / SAFE_STAGING
 *   AUDIT_LOG_HARD_DELETE_TENANT_ID set when scope=tenant
 *
 * Eligibility (ALL must hold):
 *   - audit_logs.deletedAt IS NOT NULL
 *   - audit_logs.deletedAt < now() - AUDIT_LOG_HARD_DELETE_GRACE_DAYS days
 *   - row matches the active scope predicate
 *
 * Grace days default 90. Invalid / non-positive values fall back to 90.
 *
 * Tenant scope (env: AUDIT_LOG_HARD_DELETE_SCOPE):
 *   "tenant"      — default; requires AUDIT_LOG_HARD_DELETE_TENANT_ID
 *   "null-tenant" — explicit; only NULL-tenant soft-deleted rows
 *   "all"         — explicit; every eligible row
 *
 * Reports: backend/reports/saas/phase2/audit-log-hard-delete.{json,md}
 *
 * Tag: phase254-audit-log-hard-delete.
 * This is the ONLY destructive script in the phase 2 suite. It lives
 * in scripts/, not src/ — runtime services never hard-delete audit rows.
 */
/* eslint-disable no-console */
import { promises as fs } from 'fs';
import path from 'path';
import { Client } from 'pg';
import { autoLoadEnv, formatDatabaseUrlMissingMessage } from './../phase1/reconciliation/lib/env';
import { classifyRuntimeEnv, isStagingClassification } from '../../../src/saas/tenancy/env-safety';

autoLoadEnv(__filename);

const OUT_DIR = path.resolve(__dirname, '..', '..', '..', 'reports', 'saas', 'phase2');

export type HardDeleteScope = 'tenant' | 'null-tenant' | 'all';

export interface HardDeleteReport {
  mode: 'dry-run' | 'apply';
  applied: boolean;
  safeClassification: string;
  refusalReason?: string;
  scope: HardDeleteScope;
  tenantId: string | null;
  graceDays: number;
  cutoffIso: string;
  eligibleRows: number;
  excludedNotSoftDeleted: number;
  excludedInsideGrace: number;
  excludedByScope: number;
  deletedRows: number;
  beforeTotalRows: number;
  afterTotalRows: number;
  recommendedSnapshotSql: string;
  fullRowSnapshotSql: string;
}

function getDatabaseUrl(): string {
  const arg = process.argv.find((a) => a.startsWith('--db='))?.slice(5);
  return arg ?? process.env.DATABASE_URL ?? (() => { throw new Error(formatDatabaseUrlMissingMessage()); })();
}

function pgClient(url: string): Client {
  return new Client({ connectionString: url, ssl: /127\.0\.0\.1|localhost/.test(url) ? false : { rejectUnauthorized: false } });
}

function resolveGraceDays(): number {
  const raw = Number(process.env.AUDIT_LOG_HARD_DELETE_GRACE_DAYS);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 90;
}

function resolveScope(): HardDeleteScope {
  const raw = String(process.env.AUDIT_LOG_HARD_DELETE_SCOPE ?? 'tenant').toLowerCase();
  if (raw === 'null-tenant') return 'null-tenant';
  if (raw === 'all') return 'all';
  return 'tenant';
}

function buildScopeWhereSql(scope: HardDeleteScope, tenantId: string | null): { sql: string; params: unknown[] } {
  if (scope === 'tenant') {
    if (!tenantId) throw new Error('scope=tenant requires AUDIT_LOG_HARD_DELETE_TENANT_ID');
    return { sql: '"tenantId" = $1', params: [tenantId] };
  }
  if (scope === 'null-tenant') return { sql: '"tenantId" IS NULL', params: [] };
  return { sql: 'TRUE', params: [] };
}

export async function runHardDelete(databaseUrl: string): Promise<HardDeleteReport> {
  const env = classifyRuntimeEnv();
  const enabled  = String(process.env.AUDIT_LOG_HARD_DELETE_ENABLED ?? '').toLowerCase() === 'true';
  const applyFlag = String(process.env.AUDIT_LOG_HARD_DELETE_APPLY ?? '').toLowerCase() === 'true';
  const safe     = isStagingClassification(env.classification);
  const graceDays = resolveGraceDays();
  const scope    = resolveScope();
  const tenantId = process.env.AUDIT_LOG_HARD_DELETE_TENANT_ID || null;
  const cutoff   = new Date(Date.now() - graceDays * 24 * 60 * 60 * 1000);

  let mode: 'dry-run' | 'apply' = 'dry-run';
  let refusalReason: string | undefined;
  if (!enabled)   refusalReason = 'AUDIT_LOG_HARD_DELETE_ENABLED=false';
  else if (!applyFlag) refusalReason = 'AUDIT_LOG_HARD_DELETE_APPLY=false';
  else if (!safe) refusalReason = `unsafe runtime classification ${env.classification} — apply refused`;
  else if (scope === 'tenant' && !tenantId) refusalReason = 'scope=tenant requires AUDIT_LOG_HARD_DELETE_TENANT_ID';
  else mode = 'apply';

  const where = (() => {
    try { return buildScopeWhereSql(scope, tenantId); }
    catch { return { sql: 'FALSE', params: [] as unknown[] }; }
  })();

  const c = pgClient(databaseUrl);
  await c.connect();
  try {
    const beforeTotalQ = await c.query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM audit_logs WHERE ${where.sql}`,
      where.params,
    );

    // Eligible: deletedAt is non-null AND old enough AND in scope.
    const eligibleQ = await c.query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM audit_logs
       WHERE "deletedAt" IS NOT NULL
         AND "deletedAt" < $${where.params.length + 1}
         AND ${where.sql}`,
      [...where.params, cutoff],
    );

    // Exclusion: never soft-deleted (in scope).
    const notSoftDeletedQ = await c.query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM audit_logs
       WHERE "deletedAt" IS NULL AND ${where.sql}`,
      where.params,
    );

    // Exclusion: soft-deleted inside grace (deletedAt newer than cutoff).
    const insideGraceQ = await c.query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM audit_logs
       WHERE "deletedAt" IS NOT NULL
         AND "deletedAt" >= $${where.params.length + 1}
         AND ${where.sql}`,
      [...where.params, cutoff],
    );

    // Exclusion: outside scope (rows that exist in audit_logs but fail the predicate).
    const excludedScopeQ = await c.query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM audit_logs WHERE NOT (${where.sql})`,
      where.params,
    );

    let deletedRows = 0;
    if (mode === 'apply') {
      // phase254-audit-log-hard-delete: ENABLED + APPLY + SAFE class + scope-tenant id.
      // This is the ONLY DELETE FROM audit_logs in the phase 2 suite.
      const del = await c.query(
        `DELETE FROM audit_logs
         WHERE "deletedAt" IS NOT NULL
           AND "deletedAt" < $${where.params.length + 1}
           AND ${where.sql}`,
        [...where.params, cutoff],
      );
      deletedRows = del.rowCount ?? 0;
    }

    const afterTotalQ = await c.query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM audit_logs WHERE ${where.sql}`,
      where.params,
    );

    const scopeSnippet =
      scope === 'tenant' && tenantId ? ` AND "tenantId" = '${tenantId}'` :
      scope === 'null-tenant' ? ` AND "tenantId" IS NULL` :
      ``;

    return {
      mode,
      applied: mode === 'apply',
      safeClassification: env.classification,
      refusalReason,
      scope,
      tenantId,
      graceDays,
      cutoffIso: cutoff.toISOString(),
      eligibleRows: Number(eligibleQ.rows[0].n),
      excludedNotSoftDeleted: Number(notSoftDeletedQ.rows[0].n),
      excludedInsideGrace: Number(insideGraceQ.rows[0].n),
      excludedByScope: Number(excludedScopeQ.rows[0].n),
      deletedRows,
      beforeTotalRows: Number(beforeTotalQ.rows[0].n),
      afterTotalRows: Number(afterTotalQ.rows[0].n),
      recommendedSnapshotSql:
        `SELECT id, "tenantId", "createdAt", "deletedAt", entity, action ` +
        `FROM audit_logs ` +
        `WHERE "deletedAt" IS NOT NULL ` +
        `AND "deletedAt" < '${cutoff.toISOString()}'` +
        scopeSnippet,
      fullRowSnapshotSql:
        `-- For ROLLBACK after hard-delete you MUST capture the full row, not just ids:\n` +
        `SELECT * FROM audit_logs ` +
        `WHERE "deletedAt" IS NOT NULL ` +
        `AND "deletedAt" < '${cutoff.toISOString()}'` +
        scopeSnippet,
    };
  } finally {
    await c.end();
  }
}

async function main(): Promise<void> {
  const url = getDatabaseUrl();
  const report = await runHardDelete(url);

  await fs.mkdir(OUT_DIR, { recursive: true });
  await fs.writeFile(
    path.join(OUT_DIR, 'audit-log-hard-delete.json'),
    JSON.stringify(report, null, 2),
  );
  const lines = [
    `# Phase 2.54 — audit-log hard-delete`, ``,
    `Generated: ${new Date().toISOString()}`,
    `Mode: **${report.mode}**`,
    `Classification: ${report.safeClassification}`,
    `Scope: ${report.scope}${report.tenantId ? ` (tenantId=${report.tenantId})` : ''}`,
    `Grace days: ${report.graceDays}`,
    `Cutoff: ${report.cutoffIso}`,
    report.refusalReason ? `Refusal reason: ${report.refusalReason}` : `Apply executed.`,
    ``,
    `| Field | Value |`,
    `|---|---:|`,
    `| eligibleRows | ${report.eligibleRows} |`,
    `| excludedNotSoftDeleted | ${report.excludedNotSoftDeleted} |`,
    `| excludedInsideGrace | ${report.excludedInsideGrace} |`,
    `| excludedByScope | ${report.excludedByScope} |`,
    `| deletedRows | ${report.deletedRows} |`,
    `| beforeTotalRows | ${report.beforeTotalRows} |`,
    `| afterTotalRows | ${report.afterTotalRows} |`,
    `| applied | ${report.applied} |`,
    ``,
    `## MANDATORY pre-apply snapshot — full rows`, ``,
    '> id-only snapshots are NOT enough to roll back a hard-delete.',
    '',
    '```sql',
    report.fullRowSnapshotSql,
    '```',
    ``,
    `## Identity-only audit (cheaper, but NOT a rollback source)`, ``,
    '```sql',
    report.recommendedSnapshotSql,
    '```',
    '',
  ].join('\n');
  await fs.writeFile(path.join(OUT_DIR, 'audit-log-hard-delete.md'), lines);

  console.log(
    `[audit-log-hard-delete] mode=${report.mode} scope=${report.scope} ` +
    `eligible=${report.eligibleRows} deleted=${report.deletedRows} ` +
    `before=${report.beforeTotalRows} after=${report.afterTotalRows}`,
  );
}

if (require.main === module) {
  main().catch((err) => { console.error(err); process.exit(2); });
}
