/**
 * Recon D — Data Ownership.
 *
 * Surfaces NULL / orphan / inferable agency ownership across the major
 * domain models. Inferred dispositions are ALWAYS proposed as `pending` —
 * the script never silently writes a tenantId.
 */
import { runRecon, tableExists, columnExists, ReconAction } from './lib/recon';

interface ModelSpec {
  table: string;
  ownerCol?: string;
  parent?: { table: string; via: string; ownerCol: string };
  needsManual?: boolean;
}

const MODELS: ModelSpec[] = [
  { table: 'applicants', ownerCol: 'agencyId' },
  { table: 'employees',  ownerCol: 'agencyId' },
  { table: 'vehicles',   ownerCol: 'agencyId' },
  { table: 'documents',         parent: { table: 'employees', via: 'entityId', ownerCol: 'agencyId' } },
  { table: 'financial_records', parent: { table: 'employees', via: 'entityId', ownerCol: 'agencyId' } },
  { table: 'job_ads',     needsManual: true },
  { table: 'workflows',   needsManual: true },
  { table: 'workshops',   needsManual: true },
];

async function main(): Promise<void> {
  await runRecon('D-data-ownership', 'Recon D — Data Ownership', async ({ c, mode }) => {
    const metrics: { key: string; value: any; note?: string }[] = [];
    const actions: ReconAction[] = [];
    const notes: string[] = [];
    let status: 'OK' | 'WARN' | 'BLOCKER' = 'OK';

    for (const m of MODELS) {
      if (!(await tableExists(c, m.table))) {
        metrics.push({ key: `${m.table}.absent`, value: 'true' });
        continue;
      }
      const total = (await c.query<{ n: number }>(`SELECT count(*)::int n FROM "${m.table}"`)).rows[0].n;
      metrics.push({ key: `${m.table}.total`, value: total });

      if (m.ownerCol) {
        if (!(await columnExists(c, m.table, m.ownerCol))) {
          actions.push({
            kind: `ownership.column-missing`,
            subject: { table: m.table, expected: m.ownerCol },
            proposedDecision: 'manual-review',
            applied: false,
          });
          status = 'BLOCKER';
          continue;
        }
        const nulls = await c.query<{ id: string }>(
          `SELECT id::text FROM "${m.table}" WHERE "${m.ownerCol}" IS NULL LIMIT 200`,
        );
        metrics.push({ key: `${m.table}.null-owner`, value: nulls.rowCount ?? 0 });
        for (const row of nulls.rows) {
          if (status === 'OK') status = 'WARN';
          actions.push({
            kind: `ownership.null.${m.table}`,
            subject: { id: row.id, table: m.table },
            proposedDecision: 'assign-tenant | hard-delete (after review)',
            applied: false,
          });
        }
        // Orphan owner — references a non-existent agency
        if (m.ownerCol === 'agencyId' && (await tableExists(c, 'agencies'))) {
          const orphan = await c.query<{ id: string; ownerId: string }>(
            `SELECT id::text, "${m.ownerCol}"::text AS "ownerId" FROM "${m.table}" t
              WHERE t."${m.ownerCol}" IS NOT NULL
                AND NOT EXISTS (SELECT 1 FROM agencies a WHERE a.id = t."${m.ownerCol}")
              LIMIT 200`,
          );
          metrics.push({ key: `${m.table}.orphan-owner`, value: orphan.rowCount ?? 0 });
          for (const r of orphan.rows) {
            status = 'BLOCKER';
            actions.push({
              kind: `ownership.orphan.${m.table}`,
              subject: { id: r.id, ownerId: r.ownerId, table: m.table },
              proposedDecision: 'restore-agency | hard-delete-orphan',
              applied: false,
            });
          }
        }
      }

      if (m.parent) {
        // Cannot infer tenantId yet (the parent's agencyId may itself be NULL).
        // Capture the inferable rate as a metric.
        const parent = m.parent.table;
        const via = m.parent.via;
        const join = `JOIN "${parent}" p ON p.id = t."${via}"`;
        if (await tableExists(c, parent)) {
          const inferable = (await c.query<{ n: number }>(
            `SELECT count(*)::int n FROM "${m.table}" t ${join} WHERE p."${m.parent.ownerCol}" IS NOT NULL`,
          )).rows[0].n;
          const orphan = (await c.query<{ n: number }>(
            `SELECT count(*)::int n FROM "${m.table}" t ${join} WHERE p."${m.parent.ownerCol}" IS NULL`,
          )).rows[0].n;
          // Rows whose entity_id does not resolve to a parent at all
          const dangling = (await c.query<{ n: number }>(
            `SELECT count(*)::int n FROM "${m.table}" t WHERE NOT EXISTS (SELECT 1 FROM "${parent}" p WHERE p.id = t."${via}")`,
          )).rows[0].n;
          metrics.push({ key: `${m.table}.inferable-via-${parent}`, value: inferable });
          metrics.push({ key: `${m.table}.unresolved-parent`, value: dangling });
          if (orphan > 0 || dangling > 0) {
            if (status === 'OK') status = 'WARN';
            actions.push({
              kind: `ownership.infer-via-parent`,
              subject: { table: m.table, parent, inferable, parentOwnerNull: orphan, dangling },
              proposedDecision: 'derive-tenantId-at-backfill | quarantine-rows-without-parent',
              applied: false,
            });
          }
        }
      }

      if (m.needsManual) {
        actions.push({
          kind: 'ownership.manual-decision-required',
          subject: { table: m.table },
          proposedDecision: 'product-decision: tenant-scope | system-template-with-clone | catalog',
          applied: false,
        });
      }
    }

    // Apply mode → queue
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
      'For entity-keyed models (Document, FinancialRecord), tenantId is inferred from the parent entity AT BACKFILL — never silently assigned at recon time.',
      'Rows whose parent is missing entirely (`unresolved-parent`) are quarantined; ops decides delete vs ignore.',
    );
    return { metrics, actions, notes, status };
  });
}

if (require.main === module) main().catch((e) => { console.error(e); process.exit(2); });
export {};
