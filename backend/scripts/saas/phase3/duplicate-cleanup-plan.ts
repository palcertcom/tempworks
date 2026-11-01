/**
 * Phase 3.2 — Duplicate cleanup plan (READ-ONLY).
 *
 * Detects same-tenant duplicates for Employee.email,
 * Employee.employeeNumber, and Applicant.email, then classifies each
 * group into one of:
 *
 *   - exact                            (auto-cleanable; lower-priority
 *                                       row has zero dependents)
 *   - conflicting_active               (manual review required)
 *   - null_tenant_assignment_required  (tenantId IS NULL; gated)
 *   - cross_tenant_observation         (not blocking; informational)
 *
 * Per group, the plan records a keep-id (priority: active >
 * newest-updatedAt > lowest-id) and a list of soft-delete-id(s).
 *
 * NO writes. Wraps every query in BEGIN READ ONLY.
 *
 * Output: backend/reports/saas/phase3/duplicate-cleanup-plan.{json,md}
 * MD masks emails. JSON keeps full values for controlled apply tooling.
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
  try { const u = new URL(url); const host = u.hostname || 'unknown';
    return /127\.0\.0\.1|localhost/.test(host) ? `local (${host})`
      : /staging|stg/.test(host) ? `staging (${host})` : `remote (${host})`;
  } catch { return 'unknown'; }
}
function maskEmail(s: string | null): string {
  if (!s) return '∅';
  const at = s.indexOf('@');
  if (at < 0) return '***';
  return `${s.slice(0, 1)}***@${s.slice(at + 1)}`;
}

type Bucket = 'exact' | 'conflicting_active' | 'null_tenant_assignment_required' | 'cross_tenant_observation';
interface MemberRow { id: string; updatedAt: string; deletedAt: string | null; dependents: number; }
interface PlanGroup {
  table: 'employees' | 'applicants';
  column: 'email' | 'employeeNumber';
  key: string;
  tenantId: string | null;
  bucket: Bucket;
  keepId: string | null;
  softDeleteIds: string[];
  members: MemberRow[];
  rationale: string;
}

async function dependentCount(c: Client, table: 'employees' | 'applicants', id: string): Promise<number> {
  if (table === 'applicants') {
    const r = await c.query<{ c: string }>(
      `SELECT COUNT(*)::text AS c FROM candidate_workflow_assignments WHERE "candidateId" = $1`, [id]);
    return Number(r.rows[0].c);
  }
  // employees: count attendance + stage rows
  const r = await c.query<{ c: string }>(`
    SELECT (
      (SELECT COUNT(*) FROM attendance_records WHERE "employeeId" = $1)
      + (SELECT COUNT(*) FROM employee_stages WHERE "employeeId" = $1)
    )::text AS c`, [id]);
  return Number(r.rows[0].c);
}

async function planForKey(
  c: Client, table: 'employees' | 'applicants', column: 'email' | 'employeeNumber',
): Promise<{ scoped: PlanGroup[]; nulls: PlanGroup[] }> {
  const col = column === 'email' ? 'email' : '"employeeNumber"';
  const scopedRows = await c.query(`
    SELECT "tenantId", lower(trim(${col})) AS key, array_agg(id::text ORDER BY "createdAt") AS ids
      FROM "${table}"
     WHERE ${col} IS NOT NULL AND ${col} <> ''
       AND "tenantId" IS NOT NULL
       AND "deletedAt" IS NULL
     GROUP BY "tenantId", lower(trim(${col}))
    HAVING COUNT(*) > 1`);
  const nullRows = await c.query(`
    SELECT lower(trim(${col})) AS key, array_agg(id::text ORDER BY "createdAt") AS ids
      FROM "${table}"
     WHERE ${col} IS NOT NULL AND ${col} <> ''
       AND "tenantId" IS NULL
       AND "deletedAt" IS NULL
     GROUP BY lower(trim(${col}))
    HAVING COUNT(*) > 1`);

  const scoped: PlanGroup[] = [];
  for (const row of scopedRows.rows as any[]) {
    const ids: string[] = row.ids;
    const rows = await c.query<{ id: string; updated_at: string; deleted_at: string | null }>(
      `SELECT id::text, "updatedAt"::text AS updated_at, "deletedAt"::text AS deleted_at
         FROM "${table}" WHERE id = ANY($1)`, [ids]);
    const members: MemberRow[] = [];
    for (const r of rows.rows) {
      const dep = await dependentCount(c, table, r.id);
      members.push({ id: r.id, updatedAt: r.updated_at, deletedAt: r.deleted_at, dependents: dep });
    }
    // Priority: pick keep = active with most dependents, tiebreak newest updatedAt, then lowest id
    const active = members.filter((m) => m.deletedAt == null);
    const sortKeep = (xs: MemberRow[]) => [...xs].sort((a, b) =>
      (b.dependents - a.dependents) ||
      (new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()) ||
      a.id.localeCompare(b.id));
    const keep = sortKeep(active.length > 0 ? active : members)[0] ?? null;
    const others = members.filter((m) => m.id !== keep?.id);
    const lowerPriorityActive = others.filter((m) => m.deletedAt == null);
    const lowerPriorityHasDependents = lowerPriorityActive.some((m) => m.dependents > 0);

    // Bucket:
    //   - exact: all lower-priority active rows have 0 dependents (safe soft-delete)
    //   - conflicting_active: any lower-priority active row carries dependents
    let bucket: Bucket;
    let rationale: string;
    const anyActiveHasDependents = active.some((m) => m.dependents > 0);
    if (active.length <= 1) {
      bucket = 'exact';
      rationale = 'At most one active row; remaining rows already soft-deleted (metadata-only cleanup).';
    } else if (anyActiveHasDependents) {
      // Any active row carrying dependents makes the keep decision
      // ambiguous: kept row might still be the wrong choice and the
      // lower-priority active row may need to merge dependents first.
      bucket = 'conflicting_active';
      rationale = 'Multiple active rows; at least one carries dependent records — manual review required.';
    } else {
      bucket = 'exact';
      rationale = 'Multiple active rows; none carry dependent records — safe soft-delete of lower-priority rows.';
    }
    scoped.push({
      table, column,
      key: row.key, tenantId: row.tenantId,
      bucket,
      keepId: keep?.id ?? null,
      softDeleteIds: bucket === 'exact' ? others.filter((m) => m.deletedAt == null).map((m) => m.id) : [],
      members, rationale,
    });
    void lowerPriorityHasDependents;
  }

  const nulls: PlanGroup[] = (nullRows.rows as any[]).map((row) => ({
    table, column,
    key: row.key, tenantId: null,
    bucket: 'null_tenant_assignment_required' as Bucket,
    keepId: null,
    softDeleteIds: [],
    members: (row.ids as string[]).map((id) => ({ id, updatedAt: '', deletedAt: null, dependents: 0 })),
    rationale: 'tenantId IS NULL — gated behind backfill.',
  }));

  return { scoped, nulls };
}

async function crossTenant(c: Client, table: 'employees' | 'applicants'): Promise<PlanGroup[]> {
  const r = await c.query(`
    SELECT lower(trim(email)) AS key,
           array_agg(DISTINCT "tenantId"::text) AS ids,
           COUNT(DISTINCT "tenantId")::int AS count
      FROM "${table}"
     WHERE email IS NOT NULL AND email <> ''
       AND "tenantId" IS NOT NULL AND "deletedAt" IS NULL
     GROUP BY lower(trim(email))
    HAVING COUNT(DISTINCT "tenantId") > 1
     LIMIT 500`);
  return (r.rows as any[]).map((row) => ({
    table, column: 'email' as const,
    key: row.key,
    tenantId: null,
    bucket: 'cross_tenant_observation' as Bucket,
    keepId: null,
    softDeleteIds: [],
    members: (row.ids as string[]).map((id) => ({ id, updatedAt: '', deletedAt: null, dependents: 0 })),
    rationale: 'Cross-tenant same email; allowed under per-tenant uniqueness if User.email stays global.',
  }));
}

function snapshotSql(groups: PlanGroup[]): string[] {
  const idsByTable: Record<string, Set<string>> = { employees: new Set(), applicants: new Set() };
  for (const g of groups) {
    if (g.bucket !== 'exact') continue;
    for (const id of [g.keepId, ...g.softDeleteIds, ...g.members.map((m) => m.id)]) if (id) idsByTable[g.table].add(id);
  }
  const sql: string[] = [];
  for (const [t, ids] of Object.entries(idsByTable)) {
    if (ids.size === 0) continue;
    const list = [...ids].map((s) => `'${s}'`).join(', ');
    sql.push(`-- Snapshot ${t} affected by phase320-duplicate-cleanup`);
    sql.push(`SELECT * FROM "${t}" WHERE id IN (${list});`);
  }
  return sql;
}

async function main(): Promise<void> {
  const url = getDatabaseUrl();
  const env = classifyRuntimeEnv();
  if (!isStagingClassification(env.classification)) {
    console.error(`[duplicate-cleanup-plan] refusing on classification=${env.classification}`);
    process.exit(3);
  }
  const target = targetType(url);

  const c = pgClient(url); await c.connect();
  let groups: PlanGroup[] = [];
  try {
    await c.query('BEGIN READ ONLY');
    const empEmail = await planForKey(c, 'employees', 'email');
    const empNum   = await planForKey(c, 'employees', 'employeeNumber');
    const appEmail = await planForKey(c, 'applicants', 'email');
    const xtEmp    = await crossTenant(c, 'employees');
    const xtApp    = await crossTenant(c, 'applicants');
    groups = [...empEmail.scoped, ...empNum.scoped, ...appEmail.scoped,
              ...empEmail.nulls,  ...empNum.nulls,  ...appEmail.nulls,
              ...xtEmp, ...xtApp];
    await c.query('ROLLBACK');
  } finally { await c.end(); }

  const counts: Record<Bucket, number> = {
    exact: 0, conflicting_active: 0, null_tenant_assignment_required: 0, cross_tenant_observation: 0,
  };
  for (const g of groups) counts[g.bucket]++;
  const exactGroups = groups.filter((g) => g.bucket === 'exact' && g.softDeleteIds.length > 0);
  const totalSoftDeletes = exactGroups.reduce((acc, g) => acc + g.softDeleteIds.length, 0);

  await fs.mkdir(OUT_DIR, { recursive: true });
  const json = {
    generatedAt: new Date().toISOString(),
    readOnly: true,
    classification: env.classification,
    target,
    counts,
    plannedSoftDeletes: totalSoftDeletes,
    snapshotSql: snapshotSql(groups),
    groups,
  };
  await fs.writeFile(path.join(OUT_DIR, 'duplicate-cleanup-plan.json'), JSON.stringify(json, null, 2));

  const md: string[] = [];
  md.push('# SaaS Phase 3.2 — Duplicate cleanup plan (dry-run)');
  md.push('');
  md.push(`Generated: ${json.generatedAt}`);
  md.push(`Classification: **${env.classification}**`);
  md.push(`Target: ${target}`);
  md.push(`Read-only: **true**`);
  md.push('');
  md.push('Emails are **masked** in this MD report. The companion JSON keeps full values for the apply step.');
  md.push('');
  md.push('## Buckets');
  md.push('');
  for (const [b, n] of Object.entries(counts)) md.push(`- **${b}**: ${n}`);
  md.push('');
  md.push(`Planned soft-deletes: **${totalSoftDeletes}**`);
  md.push('');
  md.push('## Groups');
  md.push('');
  md.push('| table | column | key (masked) | tenantId | bucket | keep | soft-delete |');
  md.push('| --- | --- | --- | --- | --- | --- | --- |');
  for (const g of groups.slice(0, 100)) {
    const k = g.column === 'email' ? maskEmail(g.key) : g.key;
    md.push(`| ${g.table} | ${g.column} | ${k} | ${g.tenantId ?? '∅'} | ${g.bucket} | ${g.keepId?.slice(0,8) ?? '—'} | ${g.softDeleteIds.map((s) => s.slice(0,8)).join(', ') || '—'} |`);
  }
  if (groups.length > 100) md.push(`| … | … | … | … | … | … | (+${groups.length - 100} more) |`);
  md.push('');
  md.push('## Snapshot SQL');
  md.push('');
  md.push('Run BEFORE apply to capture rows touched. Pipe to a file.');
  md.push('');
  md.push('```sql');
  for (const line of json.snapshotSql) md.push(line);
  md.push('```');
  md.push('');
  md.push('## Apply gates');
  md.push('');
  md.push('- `PHASE3_DUPLICATE_CLEANUP_ENABLED=true`');
  md.push('- `PHASE3_DUPLICATE_CLEANUP_APPLY=true`');
  md.push('- Runtime classification must be `SAFE_CLONE` or `SAFE_STAGING`');
  md.push('');
  md.push('Apply is soft-delete only. Hard-delete is not implemented. Conflicting/active groups are never mutated.');
  md.push('');
  await fs.writeFile(path.join(OUT_DIR, 'duplicate-cleanup-plan.md'), md.join('\n'));
  console.log(`[duplicate-cleanup-plan] exact=${counts.exact} conflicting=${counts.conflicting_active} null=${counts.null_tenant_assignment_required} xt=${counts.cross_tenant_observation} planned-soft-deletes=${totalSoftDeletes}`);
}

main().catch((err) => { console.error(err); process.exit(2); });
