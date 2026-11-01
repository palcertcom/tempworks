/**
 * Phase 3.1 — Production-shaped duplicate scan (READ-ONLY).
 *
 * Refuses to run on UNSAFE_PRODUCTION / UNKNOWN classifications. Wraps
 * every query in BEGIN READ ONLY. Emits MD with masked emails (only
 * domain visible) so report contents can be circulated without
 * exposing PII; JSON keeps full email values for the cleanup tooling
 * that will operate on a SAFE clone in Phase 3.2.
 *
 * Output: backend/reports/saas/phase3/production-duplicate-scan.{json,md}
 *
 * Sections:
 *  1. Employee.email — same-tenant duplicates
 *  2. Employee.email — NULL-tenant duplicates
 *  3. Applicant.email — same-tenant duplicates
 *  4. Applicant.email — NULL-tenant duplicates
 *  5. Employee.employeeNumber — same-tenant duplicates
 *  6. Employee.employeeNumber — NULL-tenant duplicates
 *  7. Cross-tenant same-email observations (NOT blocking)
 *  8. Blocking duplicate count
 *  9. Cleanup buckets:
 *     - exact: identical email + same tenant + identical createdBy/source
 *     - conflicting_active: same key, both rows non-deleted
 *     - null_tenant_assignment_required
 *     - manual_review: anything that doesn't fit the above
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
  try {
    const u = new URL(url); const host = u.hostname || 'unknown';
    return /127\.0\.0\.1|localhost/.test(host) ? `local (${host})`
         : /staging|stg/.test(host)            ? `staging (${host})`
         : `remote (${host})`;
  } catch { return 'unknown'; }
}
function maskEmail(s: string | null): string {
  if (!s) return '∅';
  const at = s.indexOf('@');
  if (at < 0) return '***';
  const local = s.slice(0, at), domain = s.slice(at + 1);
  const head = local.slice(0, 1);
  return `${head}***@${domain}`;
}

interface DupGroup {
  key: string;
  tenantId: string | null;
  count: number;
  ids: string[];
  bucket: 'exact' | 'conflicting_active' | 'null_tenant_assignment_required' | 'manual_review';
}

async function scopedDups(c: Client, table: string, column: string, columnLabel: string): Promise<DupGroup[]> {
  const r = await c.query<{ tenantId: string; key: string; count: number; ids: string[]; active: number; }>(`
    SELECT "tenantId", lower(trim(${column})) AS key, COUNT(*)::int AS count,
           array_agg(id::text ORDER BY "createdAt") AS ids,
           SUM(CASE WHEN "deletedAt" IS NULL THEN 1 ELSE 0 END)::int AS active
      FROM "${table}"
     WHERE ${column} IS NOT NULL AND ${column} <> ''
       AND "tenantId" IS NOT NULL
       AND "deletedAt" IS NULL
     GROUP BY "tenantId", lower(trim(${column}))
    HAVING COUNT(*) > 1
     ORDER BY count DESC, key`);
  return r.rows.map((row: any): DupGroup => ({
    key: `[${columnLabel}] ${row.key}`,
    tenantId: row.tenantId,
    count: row.count,
    ids: row.ids,
    bucket: row.active > 1 ? 'conflicting_active' : 'exact',
  }));
}

async function nullDups(c: Client, table: string, column: string, columnLabel: string): Promise<DupGroup[]> {
  const r = await c.query(`
    SELECT lower(trim(${column})) AS key, COUNT(*)::int AS count,
           array_agg(id::text ORDER BY "createdAt") AS ids
      FROM "${table}"
     WHERE ${column} IS NOT NULL AND ${column} <> ''
       AND "tenantId" IS NULL
       AND "deletedAt" IS NULL
     GROUP BY lower(trim(${column}))
    HAVING COUNT(*) > 1
     ORDER BY count DESC, key`);
  return r.rows.map((row: any): DupGroup => ({
    key: `[${columnLabel}] ${row.key}`,
    tenantId: null,
    count: row.count,
    ids: row.ids,
    bucket: 'null_tenant_assignment_required',
  }));
}

async function crossTenant(c: Client, table: string, label: string): Promise<DupGroup[]> {
  const r = await c.query(`
    SELECT lower(trim(email)) AS key,
           COUNT(DISTINCT "tenantId")::int AS count,
           array_agg(DISTINCT "tenantId"::text) AS ids
      FROM "${table}"
     WHERE email IS NOT NULL AND email <> ''
       AND "tenantId" IS NOT NULL
       AND "deletedAt" IS NULL
     GROUP BY lower(trim(email))
    HAVING COUNT(DISTINCT "tenantId") > 1
     ORDER BY count DESC, key
     LIMIT 500`);
  return r.rows.map((row: any): DupGroup => ({
    key: `[${label}] ${row.key}`,
    tenantId: null,
    count: row.count,
    ids: row.ids,
    bucket: 'manual_review',
  }));
}

async function main(): Promise<void> {
  const url = getDatabaseUrl();
  const env = classifyRuntimeEnv();
  if (!isStagingClassification(env.classification)) {
    console.error(`[production-duplicate-scan] refusing on classification=${env.classification}`);
    process.exit(3);
  }
  const target = targetType(url);

  const c = pgClient(url); await c.connect();
  let s1: DupGroup[], s2: DupGroup[], s3: DupGroup[], s4: DupGroup[], s5: DupGroup[], s6: DupGroup[], s7: DupGroup[];
  try {
    await c.query('BEGIN READ ONLY');
    s1 = await scopedDups(c, 'employees',  'email', 'employees.email');
    s2 = await nullDups(c,   'employees',  'email', 'employees.email');
    s3 = await scopedDups(c, 'applicants', 'email', 'applicants.email');
    s4 = await nullDups(c,   'applicants', 'email', 'applicants.email');
    s5 = await scopedDups(c, 'employees',  '"employeeNumber"', 'employees.employeeNumber');
    s6 = await nullDups(c,   'employees',  '"employeeNumber"', 'employees.employeeNumber');
    const xtE = await crossTenant(c, 'employees',  'employees');
    const xtA = await crossTenant(c, 'applicants', 'applicants');
    s7 = [...xtE, ...xtA];
    await c.query('ROLLBACK');
  } finally { await c.end(); }

  const blocking = s1.length + s2.length + s3.length + s4.length + s5.length + s6.length;
  const buckets: Record<string, number> = { exact: 0, conflicting_active: 0, null_tenant_assignment_required: 0, manual_review: 0 };
  for (const g of [...s1, ...s2, ...s3, ...s4, ...s5, ...s6, ...s7]) buckets[g.bucket]++;

  await fs.mkdir(OUT_DIR, { recursive: true });
  const json = {
    generatedAt: new Date().toISOString(),
    readOnly: true,
    classification: env.classification,
    target,
    productionShaped: true,
    sections: {
      '1_employee_email_same_tenant': s1,
      '2_employee_email_null_tenant': s2,
      '3_applicant_email_same_tenant': s3,
      '4_applicant_email_null_tenant': s4,
      '5_employee_number_same_tenant': s5,
      '6_employee_number_null_tenant': s6,
      '7_cross_tenant_email_observation': s7,
    },
    blockingDuplicateGroups: blocking,
    crossTenantObservationGroups: s7.length,
    cleanupBuckets: buckets,
  };
  await fs.writeFile(path.join(OUT_DIR, 'production-duplicate-scan.json'), JSON.stringify(json, null, 2));

  const md: string[] = [];
  md.push('# SaaS Phase 3.1 — Production-shaped duplicate scan');
  md.push('');
  md.push(`Generated: ${json.generatedAt}`);
  md.push(`Classification: **${env.classification}**`);
  md.push(`Target: ${target}`);
  md.push(`Read-only: **${json.readOnly}**`);
  md.push('');
  md.push(`**Blocking duplicate groups: ${blocking}**`);
  md.push(`Cross-tenant observation groups: ${s7.length} (informational only — NOT blocking under per-tenant uniqueness)`);
  md.push('');
  md.push('Emails are **masked** in this MD report (e.g. `j***@example.com`). The companion JSON keeps full values for cleanup tooling.');
  md.push('');
  const sections: Array<[string, DupGroup[]]> = [
    ['1. Employee.email duplicates within same tenant',                 s1],
    ['2. Employee.email duplicates where tenantId IS NULL',              s2],
    ['3. Applicant.email duplicates within same tenant',                 s3],
    ['4. Applicant.email duplicates where tenantId IS NULL',              s4],
    ['5. Employee.employeeNumber duplicates within same tenant',         s5],
    ['6. Employee.employeeNumber duplicates where tenantId IS NULL',     s6],
    ['7. Cross-tenant same-email observations (NOT blocking)',           s7],
  ];
  for (const [title, groups] of sections) {
    md.push(`## ${title}`);
    md.push('');
    md.push(`Total groups: **${groups.length}**`);
    md.push('');
    if (groups.length === 0) { md.push('_No duplicates detected._'); md.push(''); continue; }
    md.push('| key (masked) | tenantId | count | bucket | first ids |');
    md.push('| --- | --- | --- | --- | --- |');
    for (const g of groups.slice(0, 50)) {
      // Mask only the email part, keep label like "[employees.email] j***@x.com".
      const m = g.key.match(/^(\[[^\]]+\])\s*(.+)$/);
      const masked = m ? `${m[1]} ${maskEmail(m[2])}` : g.key;
      md.push(`| ${masked} | ${g.tenantId ?? '∅'} | ${g.count} | ${g.bucket} | ${g.ids.slice(0, 3).join(', ')}${g.ids.length > 3 ? '…' : ''} |`);
    }
    if (groups.length > 50) md.push(`| … | … | … | … | (+${groups.length - 50} more) |`);
    md.push('');
  }
  md.push('## 8. Blocking duplicate count');
  md.push('');
  md.push(`**${blocking}** blocking duplicate groups (sections 1-6).`);
  md.push('');
  md.push('## 9. Cleanup buckets');
  md.push('');
  for (const [b, n] of Object.entries(buckets)) md.push(`- **${b}**: ${n}`);
  md.push('');
  md.push('No automatic changes. Phase 3.2 will plan per-bucket remediation.');
  md.push('');
  await fs.writeFile(path.join(OUT_DIR, 'production-duplicate-scan.md'), md.join('\n'));
  console.log(`[production-duplicate-scan] blocking=${blocking} xt-obs=${s7.length} buckets=${JSON.stringify(buckets)}`);
}

main().catch((err) => { console.error(err); process.exit(2); });
