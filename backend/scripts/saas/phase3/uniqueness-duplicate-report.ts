/**
 * Phase 3.0 — Per-tenant uniqueness duplicate report (READ-ONLY).
 *
 * Detects duplicate rows that would block adding per-tenant unique
 * constraints. Writes JSON + MD reports to reports/saas/phase3/.
 *
 * NO writes. NO data changes. Read-only SELECTs only.
 *
 * Sections:
 *   1.  Employee.email — duplicates within same tenant
 *   2.  Employee.email — duplicates where tenantId IS NULL
 *   3.  Applicant.email — duplicates within same tenant
 *   4.  Applicant.email — duplicates where tenantId IS NULL
 *   5.  Employee.employeeNumber — duplicates within same tenant
 *   6.  Employee.employeeNumber — duplicates where tenantId IS NULL
 *   7.  Cross-tenant same-email observations (NOT a blocking duplicate
 *       for per-tenant uniqueness; informational only)
 *   8.  Suggested cleanup actions (read-only; no automatic changes)
 */
/* eslint-disable no-console */
import { promises as fs } from 'fs';
import path from 'path';
import { Client } from 'pg';
import { autoLoadEnv, formatDatabaseUrlMissingMessage } from './../phase1/reconciliation/lib/env';

autoLoadEnv(__filename);

const OUT_DIR = path.resolve(__dirname, '..', '..', '..', 'reports', 'saas', 'phase3');

function getDatabaseUrl(): string {
  const arg = process.argv.find((a) => a.startsWith('--db='))?.slice(5);
  return arg ?? process.env.DATABASE_URL ?? (() => { throw new Error(formatDatabaseUrlMissingMessage()); })();
}
function pgClient(url: string): Client {
  return new Client({ connectionString: url, ssl: /127\.0\.0\.1|localhost/.test(url) ? false : { rejectUnauthorized: false } });
}

interface DupGroup { key: string; tenantId: string | null; count: number; ids: string[]; }
interface Section { title: string; total: number; groups: DupGroup[]; note?: string; }

async function findDupsScoped(c: Client, table: string, column: string): Promise<DupGroup[]> {
  // duplicates within same non-null tenantId
  const q = `
    SELECT "tenantId", lower(trim(${column})) AS key, COUNT(*)::int AS count,
           array_agg(id::text ORDER BY "createdAt") AS ids
      FROM "${table}"
     WHERE ${column} IS NOT NULL AND ${column} <> ''
       AND "tenantId" IS NOT NULL
       AND "deletedAt" IS NULL
     GROUP BY "tenantId", lower(trim(${column}))
    HAVING COUNT(*) > 1
     ORDER BY count DESC, key`;
  const r = await c.query(q);
  return r.rows.map((row: any) => ({ key: row.key, tenantId: row.tenantId, count: row.count, ids: row.ids }));
}

async function findDupsNullTenant(c: Client, table: string, column: string): Promise<DupGroup[]> {
  const q = `
    SELECT lower(trim(${column})) AS key, COUNT(*)::int AS count,
           array_agg(id::text ORDER BY "createdAt") AS ids
      FROM "${table}"
     WHERE ${column} IS NOT NULL AND ${column} <> ''
       AND "tenantId" IS NULL
       AND "deletedAt" IS NULL
     GROUP BY lower(trim(${column}))
    HAVING COUNT(*) > 1
     ORDER BY count DESC, key`;
  const r = await c.query(q);
  return r.rows.map((row: any) => ({ key: row.key, tenantId: null, count: row.count, ids: row.ids }));
}

async function findCrossTenantSameEmail(c: Client, table: string): Promise<DupGroup[]> {
  const q = `
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
     LIMIT 200`;
  const r = await c.query(q);
  return r.rows.map((row: any) => ({ key: row.key, tenantId: null, count: row.count, ids: row.ids }));
}

async function main(): Promise<void> {
  const url = getDatabaseUrl();
  const c = pgClient(url); await c.connect();
  const sections: Record<string, Section> = {};
  try {
    // Assert no writes: wrap entire run in a read-only transaction.
    await c.query('BEGIN READ ONLY');

    const empSame  = await findDupsScoped(c, 'employees',  'email');
    const empNull  = await findDupsNullTenant(c, 'employees',  'email');
    const appSame  = await findDupsScoped(c, 'applicants', 'email');
    const appNull  = await findDupsNullTenant(c, 'applicants', 'email');
    const numSame  = await findDupsScoped(c, 'employees',  '"employeeNumber"');
    const numNull  = await findDupsNullTenant(c, 'employees',  '"employeeNumber"');
    const xtEmp    = await findCrossTenantSameEmail(c, 'employees');
    const xtApp    = await findCrossTenantSameEmail(c, 'applicants');

    sections['1_employee_email_same_tenant']         = { title: '1. Employee.email duplicates within same tenant',         total: empSame.length, groups: empSame };
    sections['2_employee_email_null_tenant']         = { title: '2. Employee.email duplicates where tenantId IS NULL',      total: empNull.length, groups: empNull };
    sections['3_applicant_email_same_tenant']        = { title: '3. Applicant.email duplicates within same tenant',        total: appSame.length, groups: appSame };
    sections['4_applicant_email_null_tenant']        = { title: '4. Applicant.email duplicates where tenantId IS NULL',     total: appNull.length, groups: appNull };
    sections['5_employee_number_same_tenant']        = { title: '5. Employee.employeeNumber duplicates within same tenant', total: numSame.length, groups: numSame };
    sections['6_employee_number_null_tenant']        = { title: '6. Employee.employeeNumber duplicates where tenantId IS NULL', total: numNull.length, groups: numNull };
    sections['7_cross_tenant_email_observation']     = {
      title: '7. Cross-tenant same-email observations (informational; NOT blocking per-tenant uniqueness)',
      total: xtEmp.length + xtApp.length,
      groups: [...xtEmp.map((g) => ({ ...g, key: `[employees] ${g.key}` })),
               ...xtApp.map((g) => ({ ...g, key: `[applicants] ${g.key}` }))],
      note: 'Same email appearing under multiple tenants is allowed under per-tenant uniqueness if the User/login model is global. No action required unless product decides otherwise.',
    };

    await c.query('ROLLBACK'); // close read-only txn explicitly
  } finally {
    await c.end();
  }

  const blockingTotal =
    sections['1_employee_email_same_tenant'].total +
    sections['2_employee_email_null_tenant'].total +
    sections['3_applicant_email_same_tenant'].total +
    sections['4_applicant_email_null_tenant'].total +
    sections['5_employee_number_same_tenant'].total +
    sections['6_employee_number_null_tenant'].total;

  const suggested: string[] = [];
  if (sections['1_employee_email_same_tenant'].total > 0)
    suggested.push('Resolve same-tenant Employee.email collisions before adding @@unique([tenantId, email]).');
  if (sections['2_employee_email_null_tenant'].total > 0)
    suggested.push('Backfill tenantId on NULL-tenant Employee rows (Phase 2 backfill pipeline) before enforcing uniqueness.');
  if (sections['3_applicant_email_same_tenant'].total > 0)
    suggested.push('Triage Applicant.email duplicates within tenant (likely re-applications); decide merge vs. keep both before constraint.');
  if (sections['4_applicant_email_null_tenant'].total > 0)
    suggested.push('Backfill tenantId on NULL-tenant Applicant rows.');
  if (sections['5_employee_number_same_tenant'].total > 0)
    suggested.push('Resolve Employee.employeeNumber collisions (likely sequence reuse) before adding @@unique([tenantId, employeeNumber]).');
  if (sections['6_employee_number_null_tenant'].total > 0)
    suggested.push('Backfill tenantId on NULL-tenant Employee rows.');
  if (sections['7_cross_tenant_email_observation'].total > 0)
    suggested.push('Cross-tenant duplicates are informational; allowed if User.email remains global-unique.');
  if (suggested.length === 0)
    suggested.push('No blocking duplicates detected. Per-tenant unique constraints can be staged for a future phase.');

  await fs.mkdir(OUT_DIR, { recursive: true });
  const json = {
    generatedAt: new Date().toISOString(),
    readOnly: true,
    blockingDuplicateGroups: blockingTotal,
    sections,
    suggested,
  };
  await fs.writeFile(path.join(OUT_DIR, 'uniqueness-duplicate-report.json'), JSON.stringify(json, null, 2));

  const md: string[] = [];
  md.push('# SaaS Phase 3.0 — Per-tenant uniqueness duplicate report');
  md.push('');
  md.push(`Generated: ${json.generatedAt}`);
  md.push('');
  md.push(`Read-only: **${json.readOnly}**`);
  md.push('');
  md.push(`**Blocking duplicate groups: ${blockingTotal}**`);
  md.push('');
  for (const key of Object.keys(sections)) {
    const s = sections[key];
    md.push(`## ${s.title}`);
    md.push('');
    md.push(`Total groups: **${s.total}**`);
    if (s.note) { md.push(''); md.push(`> ${s.note}`); }
    md.push('');
    if (s.groups.length === 0) {
      md.push('_No duplicates detected._');
    } else {
      md.push('| key | tenantId | count | first ids |');
      md.push('| --- | --- | --- | --- |');
      for (const g of s.groups.slice(0, 50)) {
        md.push(`| ${g.key} | ${g.tenantId ?? '∅'} | ${g.count} | ${g.ids.slice(0, 3).join(', ')}${g.ids.length > 3 ? '…' : ''} |`);
      }
      if (s.groups.length > 50) md.push(`| … | … | … | (+${s.groups.length - 50} more) |`);
    }
    md.push('');
  }
  md.push('## 8. Suggested cleanup actions');
  md.push('');
  for (const s of suggested) md.push(`- ${s}`);
  md.push('');
  await fs.writeFile(path.join(OUT_DIR, 'uniqueness-duplicate-report.md'), md.join('\n'));

  console.log(`[uniqueness-duplicate-report] blocking=${blockingTotal} sections=${Object.keys(sections).length} (read-only)`);
}

main().catch((err) => { console.error(err); process.exit(2); });
