/**
 * Phase 3.1 — Tenant backfill completeness report (READ-ONLY).
 *
 * Counts NULL-tenant rows for Employee + Applicant on a SAFE clone or
 * SAFE staging DB, broken down by status. NO writes; wraps every query
 * in BEGIN READ ONLY. Refuses to run on UNSAFE_PRODUCTION / UNKNOWN.
 *
 * Output: backend/reports/saas/phase3/tenant-backfill-completeness-report.{json,md}
 */
/* eslint-disable no-console */
import { promises as fs } from 'fs';
import path from 'path';
import { Client } from 'pg';
import { autoLoadEnv, formatDatabaseUrlMissingMessage } from './../phase1/reconciliation/lib/env';
import { classifyRuntimeEnv, isStagingClassification } from '../../../src/saas/tenancy/env-safety';

autoLoadEnv(__filename);

const OUT_DIR = path.resolve(__dirname, '..', '..', '..', 'reports', 'saas', 'phase3');

function getDatabaseUrl(): string {
  const arg = process.argv.find((a) => a.startsWith('--db='))?.slice(5);
  return arg ?? process.env.DATABASE_URL ?? (() => { throw new Error(formatDatabaseUrlMissingMessage()); })();
}
function pgClient(url: string): Client {
  return new Client({ connectionString: url, ssl: /127\.0\.0\.1|localhost/.test(url) ? false : { rejectUnauthorized: false } });
}
function targetType(url: string): string {
  // Reports the kind of host without leaking secrets.
  try {
    const u = new URL(url);
    const host = u.hostname || 'unknown';
    return /127\.0\.0\.1|localhost/.test(host) ? `local (${host})`
         : /staging|stg/.test(host)            ? `staging (${host})`
         : `remote (${host})`;
  } catch { return 'unknown'; }
}

interface TableCompleteness {
  table: string;
  total: number;
  nullTenant: number;
  nonNullTenant: number;
  byStatus: Record<string, { total: number; nullTenant: number }>;
  sampleNullIds: string[];
  blocksConstraints: boolean;
}

async function summarise(c: Client, table: string, statusCol: string): Promise<TableCompleteness> {
  const total = (await c.query<{ c: string }>(`SELECT COUNT(*)::text AS c FROM "${table}"`)).rows[0].c;
  const nullT = (await c.query<{ c: string }>(`SELECT COUNT(*)::text AS c FROM "${table}" WHERE "tenantId" IS NULL`)).rows[0].c;
  const nonNullT = (await c.query<{ c: string }>(`SELECT COUNT(*)::text AS c FROM "${table}" WHERE "tenantId" IS NOT NULL`)).rows[0].c;
  const byStatusRows = await c.query<{ status: string; total: string; null_t: string }>(
    `SELECT ${statusCol}::text AS status, COUNT(*)::text AS total,
            SUM(CASE WHEN "tenantId" IS NULL THEN 1 ELSE 0 END)::text AS null_t
       FROM "${table}" GROUP BY ${statusCol}`);
  const byStatus: Record<string, { total: number; nullTenant: number }> = {};
  for (const r of byStatusRows.rows) byStatus[r.status ?? '(null)'] = { total: Number(r.total), nullTenant: Number(r.null_t) };
  const sample = await c.query<{ id: string }>(
    `SELECT id::text FROM "${table}" WHERE "tenantId" IS NULL ORDER BY "createdAt" LIMIT 10`);
  return {
    table,
    total: Number(total),
    nullTenant: Number(nullT),
    nonNullTenant: Number(nonNullT),
    byStatus,
    sampleNullIds: sample.rows.map((r) => r.id),
    blocksConstraints: Number(nullT) > 0,
  };
}

async function main(): Promise<void> {
  const url = getDatabaseUrl();
  const env = classifyRuntimeEnv();
  if (!isStagingClassification(env.classification)) {
    console.error(`[tenant-backfill-completeness] refusing on classification=${env.classification}`);
    process.exit(3);
  }
  const target = targetType(url);

  const c = pgClient(url); await c.connect();
  let employee: TableCompleteness, applicant: TableCompleteness;
  try {
    await c.query('BEGIN READ ONLY');
    employee  = await summarise(c, 'employees',  'status');
    applicant = await summarise(c, 'applicants', 'status');
    await c.query('ROLLBACK');
  } finally { await c.end(); }

  const blocksCleanup = employee.nullTenant > 0 || applicant.nullTenant > 0;
  const blocksConstraints = blocksCleanup;

  await fs.mkdir(OUT_DIR, { recursive: true });
  const json = {
    generatedAt: new Date().toISOString(),
    readOnly: true,
    classification: env.classification,
    target,
    tables: { employee, applicant },
    blocksPhase32Cleanup: blocksCleanup,
    blocksPhase33Constraints: blocksConstraints,
  };
  await fs.writeFile(path.join(OUT_DIR, 'tenant-backfill-completeness-report.json'), JSON.stringify(json, null, 2));

  const md: string[] = [];
  md.push('# SaaS Phase 3.1 — Tenant backfill completeness report');
  md.push('');
  md.push(`Generated: ${json.generatedAt}`);
  md.push(`Classification: **${env.classification}**`);
  md.push(`Target: ${target}`);
  md.push(`Read-only: **${json.readOnly}**`);
  md.push('');
  for (const [k, t] of Object.entries({ Employee: employee, Applicant: applicant })) {
    md.push(`## ${k}`);
    md.push('');
    md.push(`- total rows: **${t.total}**`);
    md.push(`- tenantId IS NULL: **${t.nullTenant}**`);
    md.push(`- tenantId NOT NULL: **${t.nonNullTenant}**`);
    md.push(`- blocks Phase 3.3 unique constraints: **${t.blocksConstraints}**`);
    md.push('');
    md.push('| status | total | null-tenant |');
    md.push('| --- | --- | --- |');
    for (const [s, v] of Object.entries(t.byStatus)) md.push(`| ${s} | ${v.total} | ${v.nullTenant} |`);
    md.push('');
    if (t.sampleNullIds.length > 0) {
      md.push(`Sample NULL-tenant ids (no PII): ${t.sampleNullIds.join(', ')}`);
      md.push('');
    }
  }
  md.push('## Summary');
  md.push('');
  md.push(`- blocks Phase 3.2 cleanup: **${blocksCleanup}**`);
  md.push(`- blocks Phase 3.3 unique constraints: **${blocksConstraints}**`);
  md.push('');
  await fs.writeFile(path.join(OUT_DIR, 'tenant-backfill-completeness-report.md'), md.join('\n'));
  console.log(`[tenant-backfill-completeness] employee.null=${employee.nullTenant} applicant.null=${applicant.nullTenant} blocks=${blocksConstraints}`);
}

main().catch((err) => { console.error(err); process.exit(2); });
