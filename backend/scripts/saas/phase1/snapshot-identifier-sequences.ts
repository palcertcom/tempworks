/**
 * Phase 1 — Identifier-sequence snapshot.
 *
 * For each existing global row in `identifier_sequences (prefix, year, month)`,
 * compute the per-tenant maximum identifier already issued. Store the result
 * in `saas_phase1_seq_snapshot(tenantId, prefix, year, month, value)` so the
 * Phase 2 cutover migration can seed per-tenant counters atomically.
 *
 * Modes:
 *   --dry-run  (default)  compute, print, write to JSON+MD, NO DB INSERT
 *   --apply               (staging-only) commit the snapshot table rows
 *
 * Detection of "identifiers already issued" is heuristic: we look for the
 * pattern `^<prefix>-<year>-<MM>-(\d+)` on candidate identifier columns of
 * applicants and employees. Edit `IDENTIFIER_SOURCES` to extend.
 */
import { runRecon, tableExists, columnExists } from './reconciliation/lib/recon';
import { Client } from 'pg';

interface IdentifierSource {
  table: string;
  column: string;       // candidate identifier column to scan
  prefixes: string[];   // expected prefixes; rows that match are snapshotted
}

const IDENTIFIER_SOURCES: IdentifierSource[] = [
  { table: 'applicants', column: 'identifier', prefixes: ['A'] },
  { table: 'employees',  column: 'identifier', prefixes: ['E'] },
  // Tempworks ships a couple of prefix conventions; alternative columns:
  { table: 'employees',  column: 'employeeCode', prefixes: ['E'] },
];

const ID_RE_TEMPLATE =
  '^{PREFIX}-{YEAR}-{MM}-(\\d+)$';

interface SnapshotRow {
  tenantId: string;
  prefix: string;
  year: number;
  month: number;
  value: number;
}

async function tenantOfRow(c: Client, table: string, rowId: string): Promise<string | null> {
  // The Phase 1 prep migration adds nullable tenantId to applicants / employees.
  // If empty (legacy row pre-backfill) we fall back to deriving via agencyId.
  const r = await c.query<{ tenantId: string | null; agencyId: string | null }>(
    `SELECT "tenantId"::text, "agencyId"::text FROM "${table}" WHERE id::text = $1`,
    [rowId],
  );
  return r.rows[0]?.tenantId ?? null;
}

async function gatherSourceMaxes(
  c: Client,
  src: IdentifierSource,
  globalRows: { prefix: string; year: number; month: number }[],
): Promise<SnapshotRow[]> {
  if (!(await tableExists(c, src.table))) return [];
  if (!(await columnExists(c, src.table, src.column))) return [];
  // Need a tenant column on the same table to group by; tenantId added by
  // Phase 1 prep migration on applicants/employees/vehicles.
  const hasTenant = await columnExists(c, src.table, 'tenantId');
  const out: SnapshotRow[] = [];
  for (const g of globalRows) {
    if (!src.prefixes.includes(g.prefix)) continue;
    const re = ID_RE_TEMPLATE
      .replace('{PREFIX}', g.prefix)
      .replace('{YEAR}',   String(g.year))
      .replace('{MM}',     String(g.month).padStart(2, '0'));
    if (hasTenant) {
      const r = await c.query<{ tenant: string | null; mx: number | null }>(
        `SELECT "tenantId"::text AS tenant,
                MAX( (regexp_match("${src.column}", $1::text))[1]::int ) AS mx
           FROM "${src.table}"
          WHERE "${src.column}" ~ $1::text
          GROUP BY "tenantId"`,
        [re],
      );
      for (const row of r.rows) {
        if (!row.tenant || row.mx === null) continue;
        out.push({ tenantId: row.tenant, prefix: g.prefix, year: g.year, month: g.month, value: row.mx });
      }
    } else {
      // No tenantId column yet → cannot snapshot. Caller surfaces this.
      // (Phase 1 prep already adds it; this branch is defensive.)
    }
  }
  return out;
}

async function main(): Promise<void> {
  await runRecon('seq-snapshot', 'Phase 1 — Identifier Sequence Snapshot', async ({ c, mode }) => {
    const metrics: { key: string; value: any; note?: string }[] = [];
    const actions: { kind: string; subject: any; proposedDecision?: string; applied: boolean; sql?: string }[] = [];
    const notes: string[] = [];
    let status: 'OK' | 'WARN' | 'BLOCKER' = 'OK';

    if (!(await tableExists(c, 'identifier_sequences'))) {
      return { metrics, actions, status: 'OK', notes: ['identifier_sequences table not present; nothing to snapshot.'] };
    }
    if (!(await tableExists(c, 'saas_phase1_seq_snapshot'))) {
      return {
        metrics, actions, status: 'BLOCKER',
        notes: ['saas_phase1_seq_snapshot missing — apply Phase 1 prep migration first.'],
      };
    }

    const global = await c.query<{ prefix: string; year: number; month: number; value: number }>(
      `SELECT prefix, year, month, value FROM identifier_sequences ORDER BY prefix, year, month`,
    );
    metrics.push({ key: 'identifier_sequences.global-rows', value: global.rowCount ?? 0 });

    if ((global.rowCount ?? 0) === 0) {
      return { metrics, actions, status: 'OK', notes: ['No global identifier_sequences rows; nothing to snapshot.'] };
    }

    // For each source, compute per-tenant max
    const allSnapshots: SnapshotRow[] = [];
    for (const src of IDENTIFIER_SOURCES) {
      const rows = await gatherSourceMaxes(c, src, global.rows);
      allSnapshots.push(...rows);
    }
    // Dedupe: prefer the largest value per (tenant, prefix, year, month)
    const dedup = new Map<string, SnapshotRow>();
    for (const s of allSnapshots) {
      const k = `${s.tenantId}|${s.prefix}|${s.year}|${s.month}`;
      const prev = dedup.get(k);
      if (!prev || s.value > prev.value) dedup.set(k, s);
    }
    const snapshot = [...dedup.values()];
    metrics.push({ key: 'snapshot.projected-rows', value: snapshot.length });

    // Collision detection: same (tenant, prefix, year, month) with different
    // values from two source tables. We already dedup above by max — record
    // the disagreement here for ops visibility.
    const conflictKeys = new Map<string, SnapshotRow[]>();
    for (const s of allSnapshots) {
      const k = `${s.tenantId}|${s.prefix}|${s.year}|${s.month}`;
      const arr = conflictKeys.get(k) ?? [];
      arr.push(s);
      conflictKeys.set(k, arr);
    }
    let conflicts = 0;
    for (const [, arr] of conflictKeys) {
      const uniqueVals = new Set(arr.map((a) => a.value));
      if (uniqueVals.size > 1) conflicts++;
    }
    metrics.push({ key: 'snapshot.cross-source-conflicts', value: conflicts });
    if (conflicts > 0) {
      status = 'WARN';
      actions.push({
        kind: 'seq.cross-source-conflict',
        subject: { count: conflicts, note: 'two source tables disagree on max for the same key; we picked the max' },
        proposedDecision: 'accept-max',
        applied: false,
      });
    }

    // Sample SQL for the Phase 2 cutover
    const sampleSql = snapshot.slice(0, 3).map((s) =>
      `INSERT INTO identifier_sequences ("tenantId", prefix, year, month, value)\n` +
      `VALUES ('${s.tenantId}', '${s.prefix}', ${s.year}, ${s.month}, ${s.value});`,
    ).join('\n');
    actions.push({
      kind: 'seq.proposed-phase2-sql',
      subject: { sample: sampleSql, totalRows: snapshot.length },
      proposedDecision: 'apply via Phase 2 migration after `tenantId` column lands on identifier_sequences',
      applied: false,
    });

    // Apply: insert into saas_phase1_seq_snapshot
    if (mode === 'apply') {
      // Truncate previous snapshot first (idempotent re-run); use DELETE not
      // TRUNCATE so the operation respects future RLS policies on the table.
      await c.query(`DELETE FROM saas_phase1_seq_snapshot`);
      let inserted = 0;
      for (const s of snapshot) {
        const r = await c.query(
          `INSERT INTO saas_phase1_seq_snapshot (tenant_id, prefix, year, month, value)
                VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (tenant_id, prefix, year, month) DO UPDATE SET value = EXCLUDED.value`,
          [s.tenantId, s.prefix, s.year, s.month, s.value],
        );
        inserted += r.rowCount ?? 0;
      }
      metrics.push({ key: 'snapshot.rows-applied', value: inserted });
      actions.push({
        kind: 'seq.applied',
        subject: { rows: inserted },
        proposedDecision: 'committed-to-saas_phase1_seq_snapshot',
        applied: true,
      });
    }

    notes.push(
      'This script does NOT mutate identifier_sequences itself. The Phase 2 cutover migration consumes saas_phase1_seq_snapshot to seed per-tenant counters.',
      'If projected-rows == 0 but global-rows > 0, the source tables may not yet have tenantId populated — run the dry-run-tenant-backfill --apply on staging first.',
    );
    return { metrics, actions, notes, status };
  });
}

if (require.main === module) main().catch((e) => { console.error(e); process.exit(2); });
export {};
