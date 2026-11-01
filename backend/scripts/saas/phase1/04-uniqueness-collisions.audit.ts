/**
 * Audit D — Future Tenant-Scoped Uniqueness Collisions.
 *
 * Today many @unique constraints are global. After backfill they will be
 * scoped to (tenantId, X). Any value duplicated across two tenants will
 * become a collision in the new (tenantId, X) unique. We compute that
 * collision count NOW so reconciliation can proceed before cutover.
 */
import { runAudit, tableExists, columnExists, AuditFinding, AuditMetric } from './lib/audit';
import path from 'path';

interface CollisionCheck {
  table: string;
  column: string;
  ownerCol: string;
  rule: string;
  message: (n: number) => string;
}

const CHECKS: CollisionCheck[] = [
  { table: 'employees',  column: 'email',         ownerCol: 'agencyId', rule: 'unique.employee-email',
    message: (n) => `${n} employee email values appear in 2+ agencies; will collide on (tenantId,email).` },
  { table: 'employees',  column: 'employeeCode',  ownerCol: 'agencyId', rule: 'unique.employee-code',
    message: (n) => `${n} employee codes appear in 2+ agencies; will collide on (tenantId,employeeCode).` },
  // job_ads, reports, attendance_locked_periods, identifier_sequences are global today; we
  // detect duplicates ACROSS the system (every row will need redistribution).
];

async function checkPairCollisions(
  c: import('pg').Client, t: string, col: string, ownerCol: string,
): Promise<{ collisions: number; samples: { value: string; owners: string[] }[] }> {
  const owners = await columnExists(c, t, ownerCol);
  if (!owners) return { collisions: 0, samples: [] };
  const r = await c.query<{ value: string; owners: string[] }>(
    `SELECT lower("${col}") AS value, array_agg(DISTINCT "${ownerCol}"::text) AS owners
       FROM "${t}"
      WHERE "${col}" IS NOT NULL
      GROUP BY lower("${col}")
     HAVING count(DISTINCT "${ownerCol}") > 1
      ORDER BY count(DISTINCT "${ownerCol}") DESC
      LIMIT 50`,
  );
  return { collisions: r.rowCount ?? 0, samples: r.rows };
}

async function main(): Promise<void> {
  const outDir = path.resolve(__dirname, '..', '..', '..', 'reports', 'saas', 'phase1');
  await runAudit('04-uniqueness-collisions', 'Audit D — Uniqueness Collisions', outDir, async (ctx) => {
    const m: AuditMetric[] = [];
    const f: AuditFinding[] = [];
    const c = ctx.client;

    for (const ch of CHECKS) {
      if (!(await tableExists(c, ch.table)) || !(await columnExists(c, ch.table, ch.column))) {
        m.push({ key: `${ch.table}.${ch.column}.absent`, value: 'true' });
        continue;
      }
      const r = await checkPairCollisions(c, ch.table, ch.column, ch.ownerCol);
      m.push({ key: `${ch.table}.${ch.column}.cross-tenant-collisions`, value: r.collisions });
      if (r.collisions > 0) {
        f.push({
          severity: 'BLOCKER',
          rule: ch.rule,
          message: ch.message(r.collisions),
          detail: r.samples,
        });
      }
    }

    // job_ads.slug — globally unique; after split the slug becomes per-tenant.
    // We can't detect "future collision" because each slug is currently unique.
    // What we DO check: is any reserved slug used? (See Phase 0 reserved set.)
    if (await tableExists(c, 'job_ads')) {
      const RESERVED = ['platform', 'admin', 'www', 'api', 'app', 'tempworks'];
      const used = await c.query<{ slug: string }>(
        `SELECT slug FROM job_ads WHERE slug = ANY($1)`,
        [RESERVED],
      );
      if ((used.rowCount ?? 0) > 0) {
        f.push({
          severity: 'WARN',
          rule: 'unique.job-ad-slug-reserved',
          message: `Job ad slug uses a reserved value.`,
          detail: used.rows,
        });
      }
      const total = (await c.query<{ n: number }>(`SELECT count(*)::int n FROM job_ads`)).rows[0].n;
      m.push({ key: 'job_ads.total', value: total });
    }

    // reports.name — global unique today; tenants will collide per (tenantId,name)
    // but until we know which tenant a report belongs to, we just count totals.
    if (await tableExists(c, 'reports')) {
      const total = (await c.query<{ n: number }>(`SELECT count(*)::int n FROM reports`)).rows[0].n;
      m.push({ key: 'reports.total', value: total });
      const nameDupes = await c.query<{ name: string; n: number }>(
        `SELECT lower(name) AS name, count(*)::int n FROM reports GROUP BY 1 HAVING count(*) > 1`,
      );
      if ((nameDupes.rowCount ?? 0) > 0) {
        f.push({
          severity: 'WARN',
          rule: 'unique.report-name',
          message: `${nameDupes.rowCount} report names already duplicated globally — investigate before cutover.`,
        });
      } else {
        f.push({
          severity: 'INFO',
          rule: 'unique.report-name',
          message: `All ${total} report names are globally unique today; (tenantId,name) backfill will be conflict-free.`,
        });
      }
    }

    // attendance_locked_periods — global today
    if (await tableExists(c, 'attendance_locked_periods')) {
      const n = (await c.query<{ n: number }>(`SELECT count(*)::int n FROM attendance_locked_periods`)).rows[0].n;
      m.push({ key: 'attendance_locked_periods.total', value: n });
      f.push({
        severity: 'WARN',
        rule: 'unique.attendance-locked',
        message: `attendance_locked_periods has ${n} GLOBAL rows — must be replicated per tenant on backfill.`,
      });
    }

    // identifier_sequences — global today
    if (await tableExists(c, 'identifier_sequences')) {
      const n = (await c.query<{ n: number }>(`SELECT count(*)::int n FROM identifier_sequences`)).rows[0].n;
      m.push({ key: 'identifier_sequences.total', value: n });
      f.push({
        severity: 'BLOCKER',
        rule: 'unique.identifier-sequences',
        message: `identifier_sequences has ${n} GLOBAL rows — backfill MUST initialise per-tenant counters from existing identifiers before any insert lands on the new key.`,
      });
    }

    return {
      metrics: m,
      findings: f,
      notes: [
        'Cross-tenant collisions on (tenantId, X) are pre-flight blockers; reconcile by either renaming or merging in coordination with Product.',
        'Identifier-sequence backfill is the single most important pre-cutover step (see SAAS_PHASE1_TENANT_BACKFILL_ALGORITHM.md).',
      ],
    };
  });
}

if (require.main === module) main().catch((e) => { console.error(e); process.exit(2); });
export {};
