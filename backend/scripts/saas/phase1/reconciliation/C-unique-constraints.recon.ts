/**
 * Recon C — Unique Constraint Reconciliation.
 *
 * Detects every value that will collide once the corresponding @unique
 * constraint becomes (tenantId, X) instead of just X. Records each pair in
 * the reconciliation queue with a proposed disposition.
 *
 * Read-only by default. `--apply` writes proposals to the queue.
 */
import { runRecon, tableExists, columnExists, ReconAction } from './lib/recon';

interface PairCheck {
  table: string;
  column: string;
  ownerCol: string;
  kind: string;
}

const CHECKS: PairCheck[] = [
  { table: 'employees', column: 'email',        ownerCol: 'agencyId', kind: 'collision.employee-email' },
  { table: 'employees', column: 'employeeCode', ownerCol: 'agencyId', kind: 'collision.employee-code' },
];

async function main(): Promise<void> {
  await runRecon('C-unique-constraints', 'Recon C — Unique Constraint Reconciliation', async ({ c, mode }) => {
    const metrics: { key: string; value: any; note?: string }[] = [];
    const actions: ReconAction[] = [];
    const notes: string[] = [];
    let status: 'OK' | 'WARN' | 'BLOCKER' = 'OK';

    // ---- Pairwise collision detection on tenant-scoped columns ----
    for (const ch of CHECKS) {
      if (!(await tableExists(c, ch.table)) || !(await columnExists(c, ch.table, ch.column))) {
        metrics.push({ key: `${ch.table}.${ch.column}.absent`, value: 'true' });
        continue;
      }
      const r = await c.query<{ value: string; owners: string[]; ids: string[] }>(
        `SELECT lower("${ch.column}") AS value,
                array_agg(DISTINCT "${ch.ownerCol}"::text) AS owners,
                array_agg(id::text) AS ids
           FROM "${ch.table}"
          WHERE "${ch.column}" IS NOT NULL AND "${ch.column}" <> ''
          GROUP BY lower("${ch.column}")
         HAVING count(DISTINCT "${ch.ownerCol}") > 1
          ORDER BY count(DISTINCT "${ch.ownerCol}") DESC
          LIMIT 500`,
      );
      metrics.push({ key: `${ch.table}.${ch.column}.cross-tenant-pairs`, value: r.rowCount ?? 0 });
      for (const row of r.rows) {
        // For employee.email, multiple agencies sharing a value is acceptable
        // post-tenant-split (different tenants → different (tenantId,email) keys).
        // We still surface the pair in the queue so ops can confirm.
        if (status === 'OK') status = 'WARN';
        actions.push({
          kind: ch.kind,
          subject: { value: row.value, ownerAgencies: row.owners, exampleIds: row.ids.slice(0, 5) },
          proposedDecision: 'accept-as-tenant-scoped (no rename) | rename-one | merge',
          applied: false,
        });
      }
    }

    // ---- Reserved/colliding job-ad slugs (global today) ----
    if (await tableExists(c, 'job_ads')) {
      const RESERVED = ['platform','admin','www','api','app','tempworks'];
      const used = await c.query<{ id: string; slug: string }>(
        `SELECT id::text, slug FROM job_ads WHERE slug = ANY($1)`,
        [RESERVED],
      );
      for (const r of used.rows) {
        if (status === 'OK') status = 'WARN';
        actions.push({
          kind: 'collision.job-ad-slug-reserved',
          subject: { id: r.id, slug: r.slug },
          proposedDecision: 'rename-slug',
          applied: false,
        });
      }
      metrics.push({ key: 'job_ads.reserved-slug-count', value: used.rowCount ?? 0 });
    }

    // ---- Report.name dupes (already-global; will become per-tenant) ----
    if (await tableExists(c, 'reports')) {
      const dupes = await c.query<{ name: string; n: number }>(
        `SELECT lower(name) AS name, count(*)::int n FROM reports GROUP BY 1 HAVING count(*) > 1`,
      );
      metrics.push({ key: 'reports.global-name-dupes', value: dupes.rowCount ?? 0 });
      for (const r of dupes.rows) {
        if (status === 'OK') status = 'WARN';
        actions.push({
          kind: 'collision.report-name',
          subject: { name: r.name, count: r.n },
          proposedDecision: 'rename-pre-cutover',
          applied: false,
        });
      }
    }

    // ---- Identifier sequences (global today) — must be snapshotted per-tenant ----
    if (await tableExists(c, 'identifier_sequences')) {
      const rows = await c.query<{ prefix: string; year: number; month: number; value: number }>(
        `SELECT prefix, year, month, value FROM identifier_sequences ORDER BY prefix, year, month`,
      );
      metrics.push({ key: 'identifier_sequences.global-rows', value: rows.rowCount ?? 0 });
      if ((rows.rowCount ?? 0) > 0) {
        // Mandatory blocker: phase 2 cutover requires per-tenant rows.
        status = 'BLOCKER';
        actions.push({
          kind: 'collision.identifier-sequences',
          subject: { rowsToSnapshot: rows.rows.length, sample: rows.rows.slice(0, 10) },
          proposedDecision: 'run TKT-P1-05 (seq-snapshot) before cutover',
          applied: false,
        });
      }
    }

    // ---- Attendance lock periods (global today) ----
    if (await tableExists(c, 'attendance_locked_periods')) {
      const rows = await c.query<{ year: number; month: number }>(
        `SELECT year, month FROM attendance_locked_periods ORDER BY year, month`,
      );
      metrics.push({ key: 'attendance_locked_periods.global-rows', value: rows.rowCount ?? 0 });
      for (const r of rows.rows) {
        if (status === 'OK') status = 'WARN';
        actions.push({
          kind: 'collision.attendance-locked-period',
          subject: r,
          proposedDecision: 'replicate-to-every-tenant (default) | per-tenant-policy',
          applied: false,
        });
      }
    }

    // ---- Apply mode: write proposals ----
    if (mode === 'apply' && (await tableExists(c, 'saas_reconciliation_queue'))) {
      for (const a of actions) {
        await c.query(
          `INSERT INTO saas_reconciliation_queue (kind, subject, decision)
                VALUES ($1, $2::jsonb, 'pending')`,
          [a.kind, JSON.stringify(a.subject)],
        );
        a.applied = true;
      }
    }

    notes.push(
      'Identifier-sequences are the one HARD blocker: per-tenant rows must exist before any application writer cuts over.',
      'Cross-tenant employee email/code pairs are typically benign once the constraint is scoped — treat as WARN unless Product disagrees.',
      'Attendance locked periods default to replicate-to-every-tenant; do not change without finance sign-off.',
    );

    return { metrics, actions, notes, status };
  });
}

if (require.main === module) main().catch((e) => { console.error(e); process.exit(2); });
export {};
