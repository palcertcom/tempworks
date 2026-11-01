/**
 * Audit A — Agency Structure.
 *
 * Reports:
 *   - all agencies (count + sample)
 *   - isSystem agencies (count)
 *   - parent/child relationships if any
 *   - agencies with users / candidates / employees / documents
 *   - agencies that likely become Tenants
 *   - agencies that likely remain sub-agencies (today: none — current
 *     schema is flat)
 */
import { runAudit, tableExists, columnExists, AuditFinding, AuditMetric } from './lib/audit';
import path from 'path';

async function audit(): Promise<{ metrics: AuditMetric[]; findings: AuditFinding[]; notes?: string[] }> {
  return { metrics: [], findings: [] }; // placeholder; main wraps via runAudit
}

async function main(): Promise<void> {
  const outDir = path.resolve(__dirname, '..', '..', '..', 'reports', 'saas', 'phase1');
  await runAudit('01-agency-structure', 'Audit A — Agency Structure', outDir, async (ctx) => {
    const m: AuditMetric[] = [];
    const f: AuditFinding[] = [];
    const c = ctx.client;
    if (!(await tableExists(c, 'agencies'))) {
      f.push({ severity: 'BLOCKER', rule: 'agencies.missing-table', message: 'Table `agencies` not found.' });
      return { metrics: m, findings: f };
    }
    const total = (await c.query<{ n: number }>(`SELECT count(*)::int n FROM agencies`)).rows[0].n;
    m.push({ key: 'agencies.total', value: total });

    const sysCol = await columnExists(c, 'agencies', 'isSystem');
    const sysCount = sysCol
      ? (await c.query<{ n: number }>(`SELECT count(*)::int n FROM agencies WHERE "isSystem" = true`)).rows[0].n
      : null;
    m.push({ key: 'agencies.isSystem', value: sysCount, note: sysCol ? '' : 'isSystem column missing' });
    if (sysCount === 0) {
      f.push({
        severity: 'WARN',
        rule: 'agency.system-count',
        message: 'No isSystem=true agency found. Platform admin backfill source unclear.',
      });
    } else if (sysCount && sysCount > 1) {
      f.push({
        severity: 'WARN',
        rule: 'agency.system-count',
        message: `Multiple isSystem=true agencies (${sysCount}). Phase 1 expects exactly one.`,
      });
    }

    const parentCol = await columnExists(c, 'agencies', 'parentId');
    if (parentCol) {
      const withParent = (await c.query<{ n: number }>(
        `SELECT count(*)::int n FROM agencies WHERE "parentId" IS NOT NULL`,
      )).rows[0].n;
      m.push({ key: 'agencies.with-parent', value: withParent });
      if (withParent > 0) {
        f.push({
          severity: 'INFO',
          rule: 'agency.has-hierarchy',
          message: `${withParent} agencies have a parent. Hierarchical model NOT in Phase 1 scope; review manually.`,
        });
      }
    } else {
      m.push({ key: 'agencies.parent-column', value: 'absent' });
    }

    // Agencies with users / employees / applicants / documents
    const usersByAg = await c.query<{ agencyId: string | null; n: number }>(
      `SELECT "agencyId", count(*)::int n FROM users GROUP BY "agencyId" ORDER BY n DESC`,
    );
    m.push({ key: 'users.distinct-agencies', value: usersByAg.rowCount ?? 0 });

    const empByAg = await c.query<{ agencyId: string | null; n: number }>(
      `SELECT "agencyId", count(*)::int n FROM employees GROUP BY "agencyId" ORDER BY n DESC`,
    );
    const appByAg = await c.query<{ agencyId: string | null; n: number }>(
      `SELECT "agencyId", count(*)::int n FROM applicants GROUP BY "agencyId" ORDER BY n DESC`,
    );

    // "Empty" customer agencies: no users, no employees, no applicants
    if (sysCol) {
      const empties = await c.query<{ id: string; name: string }>(
        `SELECT id, name FROM agencies a
          WHERE a."isSystem" = false
            AND NOT EXISTS (SELECT 1 FROM users      u WHERE u."agencyId" = a.id)
            AND NOT EXISTS (SELECT 1 FROM employees  e WHERE e."agencyId" = a.id)
            AND NOT EXISTS (SELECT 1 FROM applicants p WHERE p."agencyId" = a.id)`,
      );
      m.push({ key: 'agencies.empty-customer', value: empties.rowCount ?? 0 });
      if ((empties.rowCount ?? 0) > 0) {
        f.push({
          severity: 'INFO',
          rule: 'agency.empty',
          message: `${empties.rowCount} customer agencies have no users/employees/applicants — verify they should still become tenants.`,
          detail: empties.rows,
        });
      }
    }

    // Tenant projection: every non-system Agency → 1 Tenant + 1 Default Agency
    const candidate = sysCol
      ? (await c.query<{ n: number }>(`SELECT count(*)::int n FROM agencies WHERE "isSystem" = false`)).rows[0].n
      : total;
    m.push({ key: 'phase1.candidate-tenants', value: candidate });
    f.push({
      severity: 'INFO',
      rule: 'phase1.tenant-projection',
      message: `Phase 1 backfill projects ${candidate} new Tenant rows (one per non-system Agency).`,
    });

    return {
      metrics: m,
      findings: f,
      notes: [
        'Per ADR-003: each non-system Agency becomes a Tenant (id reused) plus a Default sub-Agency.',
        'isSystem agencies are not created as Tenants; their users become PlatformAdmin rows.',
      ],
    };
  });
}

if (require.main === module) main().catch((e) => { console.error(e); process.exit(2); });
export {};
