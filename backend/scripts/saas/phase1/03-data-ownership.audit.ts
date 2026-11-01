/**
 * Audit C — Data Ownership.
 *
 * For each major model: row counts grouped by ownership, NULLs, orphans,
 * and "no ownership column" callouts.
 */
import { runAudit, tableExists, columnExists, AuditFinding, AuditMetric } from './lib/audit';
import path from 'path';

interface ModelSpec {
  table: string;
  ownerCol?: string;             // direct agencyId column, if any
  parent?: { table: string; via: string }; // entity-keyed (Document, FinancialRecord)
  ownershipNote?: string;
}

const MODELS: ModelSpec[] = [
  { table: 'applicants',                ownerCol: 'agencyId' },
  { table: 'employees',                 ownerCol: 'agencyId' },
  { table: 'job_ads',                   ownerCol: undefined, ownershipNote: 'NO ownership column today (global slug)' },
  { table: 'documents',                 ownerCol: undefined, parent: { table: 'employees', via: 'entityId' }, ownershipNote: 'entity-keyed; tenancy via parent' },
  { table: 'attendance_records',        ownerCol: undefined, parent: { table: 'employees', via: 'employeeId' }, ownershipNote: 'via Employee' },
  { table: 'attendance_locked_periods', ownerCol: undefined, ownershipNote: 'GLOBAL today; must become per-tenant' },
  { table: 'financial_records',         ownerCol: undefined, parent: { table: 'employees', via: 'entityId' }, ownershipNote: 'entity-keyed' },
  { table: 'workflows',                 ownerCol: undefined, ownershipNote: 'no ownership; system-template + clone-on-use planned' },
  { table: 'reports',                   ownerCol: 'createdById', ownershipNote: 'creator-scoped only' },
  { table: 'notifications',             ownerCol: 'userId',      ownershipNote: 'user-scoped; tenancy via user' },
  { table: 'vehicles',                  ownerCol: 'agencyId' },
  { table: 'identifier_sequences',      ownerCol: undefined, ownershipNote: 'GLOBAL today; must become per-tenant' },
  { table: 'audit_logs',                ownerCol: 'userId',      ownershipNote: 'user-scoped; per-tenant audit added Phase 2' },
  { table: 'workshops',                 ownerCol: undefined, ownershipNote: 'GLOBAL today; review per-tenant ownership' },
];

async function main(): Promise<void> {
  const outDir = path.resolve(__dirname, '..', '..', '..', 'reports', 'saas', 'phase1');
  await runAudit('03-data-ownership', 'Audit C — Data Ownership', outDir, async (ctx) => {
    const m: AuditMetric[] = [];
    const f: AuditFinding[] = [];
    const c = ctx.client;

    for (const spec of MODELS) {
      if (!(await tableExists(c, spec.table))) {
        f.push({
          severity: 'INFO',
          rule: `model.${spec.table}.absent`,
          message: `Table ${spec.table} not present in this DB; skipped.`,
        });
        continue;
      }
      const total = (await c.query<{ n: number }>(`SELECT count(*)::int n FROM "${spec.table}"`)).rows[0].n;
      m.push({ key: `${spec.table}.total`, value: total });

      if (spec.ownerCol) {
        const has = await columnExists(c, spec.table, spec.ownerCol);
        if (!has) {
          f.push({
            severity: 'WARN',
            rule: `model.${spec.table}.owner-col-missing`,
            message: `Expected owner column "${spec.ownerCol}" not present.`,
          });
          continue;
        }
        // Row count by owner
        const grp = await c.query<{ owner: string | null; n: number }>(
          `SELECT "${spec.ownerCol}" AS owner, count(*)::int n FROM "${spec.table}"
            GROUP BY 1 ORDER BY n DESC LIMIT 100`,
        );
        const nulls = grp.rows.find((r) => r.owner === null)?.n ?? 0;
        m.push({ key: `${spec.table}.distinct-owners`, value: grp.rowCount ?? 0 });
        m.push({ key: `${spec.table}.null-owner`, value: nulls });
        if (nulls > 0) {
          f.push({
            severity: 'WARN',
            rule: `model.${spec.table}.null-owner`,
            message: `${nulls} rows with NULL ${spec.ownerCol} — must be reconciled before backfill.`,
          });
        }

        // Orphan: ownerId references a non-existent row in agencies/users
        if (spec.ownerCol === 'agencyId' && await tableExists(c, 'agencies')) {
          const orphan = (await c.query<{ n: number }>(
            `SELECT count(*)::int n FROM "${spec.table}" t
              WHERE t."${spec.ownerCol}" IS NOT NULL
                AND NOT EXISTS (SELECT 1 FROM agencies a WHERE a.id = t."${spec.ownerCol}")`,
          )).rows[0].n;
          if (orphan > 0) {
            f.push({
              severity: 'BLOCKER',
              rule: `model.${spec.table}.orphan-owner`,
              message: `${orphan} rows reference a non-existent agency.`,
            });
          }
        }
      } else {
        f.push({
          severity: 'INFO',
          rule: `model.${spec.table}.no-direct-ownership`,
          message: spec.ownershipNote ?? 'Model has no direct ownership column; manual decision required.',
        });
      }
    }

    return {
      metrics: m,
      findings: f,
      notes: [
        'Models with `entity-keyed` ownership (Document, FinancialRecord) need a tenantId denorm in Phase 2 derived from the parent entity at backfill time.',
        'Global models (workshops, identifier_sequences, attendance_locked_periods) require a per-tenant split decision before any backfill writes.',
      ],
    };
  });
}

if (require.main === module) main().catch((e) => { console.error(e); process.exit(2); });
export {};
