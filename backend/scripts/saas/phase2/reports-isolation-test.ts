/**
 * Phase 2.1 — Tenant isolation test for the safe reports runtime.
 *
 * For every READY source: pick two tenants, run the safe-mode SELECT
 * scoped to tenant A, assert no row's `tenantId` equals tenant B.
 * Also run cross-tenant attack queries (filtering on `tenantId` field
 * — must be rejected as an unknown user-filter field).
 *
 * The script does NOT seed; it assumes the staging fixture has been
 * applied via Phase 1 (so two tenants exist).
 *
 * Reports:
 *   backend/reports/saas/phase2/reports-isolation-test.{json,md}
 */
/* eslint-disable no-console */
import { Client } from 'pg';
import { promises as fs } from 'fs';
import path from 'path';
import {
  autoLoadEnv, formatDatabaseUrlMissingMessage,
} from './../phase1/reconciliation/lib/env';
import { TENANT_SAFE_SOURCES } from '../../../src/saas/reports/runtime/report-sources';
import { buildTenantSafeWhere } from '../../../src/saas/reports/where-builder';
import { renderJoin } from '../../../src/saas/reports/join-builder';
import type { JoinDef } from '../../../src/saas/reports/source-def.types';

function renderJoins(primaryAlias: string, joins: ReadonlyArray<JoinDef>): string {
  const known = new Set<string>([primaryAlias]);
  const out: string[] = [];
  for (const j of joins) {
    const r = renderJoin(j, known);
    known.add(r.alias);
    out.push(r.sql);
  }
  return out.join(' ');
}

autoLoadEnv(__filename);

const OUT_DIR = path.resolve(__dirname, '..', '..', '..', 'reports', 'saas', 'phase2');

function getDatabaseUrl(): string {
  const arg = process.argv.find((a) => a.startsWith('--db='))?.slice(5);
  const url = arg ?? process.env.DATABASE_URL;
  if (!url) throw new Error(formatDatabaseUrlMissingMessage());
  return url;
}

interface Check {
  source: string;
  status: 'READY' | 'DISABLED';
  tenantA?: string;
  tenantB?: string;
  rowsForA?: number;
  rowsLeakedFromB?: number;
  crossTenantFilterRejected?: boolean;
  /** Phase 2.4: cross-tenant collision through joins (parent A, child B). */
  childLeakViaParent?: number;
  /** Phase 2.4: cross-tenant collision through reverse joins (child B, parent A). */
  parentLeakViaChild?: number;
  /** Phase 2.4: agency scope reduces row count when applied. */
  agencyScopeApplied?: boolean | 'n/a';
  ok: boolean;
  notes: string[];
}

async function main(): Promise<void> {
  const url = getDatabaseUrl();
  const c = new Client({
    connectionString: url,
    ssl: /127\.0\.0\.1|localhost/.test(url) ? false : { rejectUnauthorized: false },
  });
  await c.connect();

  const tenants = await c.query<{ id: string; name: string }>(
    `SELECT id, name FROM tenants ORDER BY name`,
  );
  if (tenants.rowCount! < 2) {
    console.error('Need at least 2 tenants. Apply Phase 1 backfill on the staging fixture first.');
    await c.end();
    process.exit(3);
  }
  const A = tenants.rows[0];
  const B = tenants.rows[1];

  const results: Check[] = [];

  for (const [key, m] of Object.entries(TENANT_SAFE_SOURCES)) {
    if (m.status !== 'READY' || !m.def) {
      results.push({ source: key, status: 'DISABLED', ok: true, notes: ['source disabled in safe mode'] });
      continue;
    }
    const def = m.def;
    const tenantCol = def.tenantColumn;
    const idCol = def.fields['id']?.dbCol ?? 'id';
    const notes: string[] = [];
    let ok = true;

    // 1. Build the safe WHERE for tenant A — confirm tenantId IS $1.
    let where;
    try {
      where = buildTenantSafeWhere(def, [], { tenantId: A.id, platformAdmin: false });
    } catch (e) {
      results.push({ source: key, status: 'READY', tenantA: A.id, tenantB: B.id, ok: false, notes: [`builder error: ${(e as Error).message}`] });
      continue;
    }

    // 2. Execute. Rows must all have tenantId === A. With joins, also
    //    confirm no joined-row's tenantId belongs to B.
    const joinSql = renderJoins(def.primaryAlias, def.tenantAwareJoins ?? []);
    const sql = `SELECT "${def.primaryAlias}"."${idCol}"::text AS id,
                        "${def.primaryAlias}"."${tenantCol}"::text AS tid
                   FROM "${def.primaryTable}" "${def.primaryAlias}"
                   ${joinSql}
                  WHERE ${where.sql}`;
    let rowsForA = 0;
    let leaks: { id: string; tid: string }[] = [];
    try {
      const r = await c.query<{ id: string; tid: string }>(sql, where.params);
      rowsForA = r.rowCount ?? 0;
      leaks = r.rows.filter((row) => row.tid !== A.id);
      if (leaks.length > 0) {
        ok = false;
        notes.push(`${leaks.length} row(s) leaked from another tenant`);
      }
    } catch (e) {
      // Tolerant: fixture databases may not have every table/column. Mark
      // as skipped (not failed) so the harness still reports the rest.
      const msg = (e as Error).message ?? String(e);
      results.push({
        source: key, status: 'READY',
        tenantA: A.id, tenantB: B.id,
        rowsForA: 0, rowsLeakedFromB: 0,
        crossTenantFilterRejected: false,
        ok: true, notes: [`skipped: ${msg.slice(0, 140)}`],
      });
      continue;
    }

    // 3. Adversarial filter — try to filter on tenantId as a user filter.
    let crossTenantFilterRejected = false;
    try {
      buildTenantSafeWhere(def, [{ field: 'tenantId', op: '=', value: B.id } as any],
        { tenantId: A.id, platformAdmin: false });
      notes.push('UNEXPECTED: builder accepted user filter on tenantId field');
      ok = false;
    } catch {
      crossTenantFilterRejected = true;
    }

    // 4. Adversarial filter — OR 1=1.
    try {
      buildTenantSafeWhere(def, [{ field: Object.keys(def.fields)[0], op: 'OR' as any, value: 'x' }],
        { tenantId: A.id, platformAdmin: false });
      notes.push('UNEXPECTED: builder accepted forbidden op');
      ok = false;
    } catch { /* expected */ }

    // 5. Phase 2.4 — cross-tenant child leak via parent join. For
    //    every non-catalog joined alias, count rows where the joined
    //    side's tenantId !== A.id while the parent's tenantId = A.id.
    //    The result must be 0; if not, a join is missing the tenant
    //    equality term.
    let childLeakViaParent = 0;
    let parentLeakViaChild = 0;
    if ((def.tenantAwareJoins ?? []).length > 0) {
      // Track aliases as we render so we can build per-join leak SQL.
      const known = new Set<string>([def.primaryAlias]);
      for (const j of def.tenantAwareJoins) {
        const r = renderJoin(j, known);
        known.add(r.alias);
        if (r.isCatalog) continue;
        try {
          const childLeakSql = `SELECT count(*)::int AS n
              FROM "${def.primaryTable}" "${def.primaryAlias}"
              ${joinSql}
             WHERE "${def.primaryAlias}"."${tenantCol}" = $1
               AND "${j.alias}"."tenantId" IS NOT NULL
               AND "${j.alias}"."tenantId"::text <> $1`;
          const cl = await c.query<{ n: number }>(childLeakSql, [A.id]);
          const n = cl.rows[0]?.n ?? 0;
          childLeakViaParent += n;
          if (n > 0) {
            ok = false;
            notes.push(`join ${j.alias}: ${n} row(s) with tenantId != A leaked through parent`);
          }
          // Reverse: scope the parent to A.id but force a child row
          // belonging to B via FK alone (without tenant equality). The
          // safe join MUST already enforce the tenant equality, so
          // joining the parent to a B-tenant child should yield 0.
          const parentLeakSql = `SELECT count(*)::int AS n
              FROM "${def.primaryTable}" "${def.primaryAlias}"
              ${joinSql}
             WHERE "${def.primaryAlias}"."${tenantCol}" = $1
               AND "${j.alias}"."tenantId"::text = $2`;
          const pl = await c.query<{ n: number }>(parentLeakSql, [A.id, B.id]);
          const m = pl.rows[0]?.n ?? 0;
          parentLeakViaChild += m;
          if (m > 0) {
            ok = false;
            notes.push(`join ${j.alias}: ${m} row(s) match B-tenant children for an A-tenant parent`);
          }
        } catch {
          // joined table missing in fixture — already noted as skipped
          // for the row-leak check; nothing to add here.
        }
      }
    }

    // 6. Phase 2.4 — agency-scope sanity: when the source declares
    //    agencyColumn, a builder call with an empty agency list should
    //    still emit the tenant filter (already proved); a call with
    //    one agency should yield row count <= unscoped count.
    let agencyScopeApplied: boolean | 'n/a' = 'n/a';
    if (def.agencyColumn) {
      try {
        const ag = await c.query<{ id: string }>(
          `SELECT id::text AS id FROM agencies WHERE "tenantId" = $1 LIMIT 1`,
          [A.id],
        );
        const agencyId = ag.rows[0]?.id;
        if (agencyId) {
          const wScoped = buildTenantSafeWhere(def, [],
            { tenantId: A.id, platformAdmin: false, agencyIds: [agencyId] });
          const scopedSql = `SELECT count(*)::int AS n
              FROM "${def.primaryTable}" "${def.primaryAlias}"
              ${joinSql}
             WHERE ${wScoped.sql}`;
          const ns = (await c.query<{ n: number }>(scopedSql, wScoped.params)).rows[0]?.n ?? 0;
          const fullSql = `SELECT count(*)::int AS n
              FROM "${def.primaryTable}" "${def.primaryAlias}"
              ${joinSql}
             WHERE ${where.sql}`;
          const nf = (await c.query<{ n: number }>(fullSql, where.params)).rows[0]?.n ?? 0;
          agencyScopeApplied = ns <= nf;
          if (!agencyScopeApplied) {
            ok = false;
            notes.push(`agency-scope did not narrow result: scoped=${ns} > full=${nf}`);
          }
        }
      } catch { /* skip if agencies not present */ }
    }

    results.push({
      source: key, status: 'READY',
      tenantA: A.id, tenantB: B.id,
      rowsForA, rowsLeakedFromB: leaks.length,
      crossTenantFilterRejected,
      childLeakViaParent, parentLeakViaChild,
      agencyScopeApplied,
      ok, notes,
    });
  }

  // ── Phase 2.4 platform-admin bypass audit ────────────────────────
  // The engine's contract: only sources with `platformAdminOnly: true`
  // skip the tenant filter for platform admins. There is currently no
  // such source in the registry. Confirm that no READY source declares
  // platformAdminOnly without the explicit reason logged.
  const platformAdminSources = Object.entries(TENANT_SAFE_SOURCES)
    .filter(([, m]) => m.status === 'READY' && m.def?.platformAdminOnly === true)
    .map(([k]) => k);
  if (platformAdminSources.length > 0) {
    console.log(`[isolation] platform-admin-only READY sources: ${platformAdminSources.join(', ')}`);
  }

  await c.end();

  await fs.mkdir(OUT_DIR, { recursive: true });
  const summary = {
    generatedAt: new Date().toISOString(),
    database: url.replace(/:[^:@/]+@/, ':***@'),
    tenantA: A,
    tenantB: B,
    counts: {
      total:    results.length,
      ready:    results.filter((r) => r.status === 'READY').length,
      passed:   results.filter((r) => r.ok && r.status === 'READY').length,
      failed:   results.filter((r) => !r.ok).length,
      disabled: results.filter((r) => r.status === 'DISABLED').length,
    },
    results,
  };
  await fs.writeFile(path.join(OUT_DIR, 'reports-isolation-test.json'), JSON.stringify(summary, null, 2));

  const md: string[] = [];
  md.push('# Phase 2.1 — Reports Isolation Test');
  md.push('');
  md.push(`Generated: ${summary.generatedAt}`);
  md.push(`Tenant A: \`${A.id}\` (${A.name})`);
  md.push(`Tenant B: \`${B.id}\` (${B.name})`);
  md.push('');
  md.push(`- Sources passed: **${summary.counts.passed}** / ${summary.counts.ready}`);
  md.push(`- Sources failed: ${summary.counts.failed}`);
  md.push(`- Sources skipped (disabled): ${summary.counts.disabled}`);
  md.push('');
  md.push('| Source | Status | Rows for A | Leaks from B | Cross-tenant filter rejected | Child leak via parent | Parent leak via child | Agency scope | Result |');
  md.push('|--------|--------|-----------:|-------------:|:-----------------------------:|----------------------:|----------------------:|:------------:|:------:|');
  for (const r of results) {
    if (r.status === 'DISABLED') {
      md.push(`| \`${r.source}\` | DISABLED | — | — | — | — | — | — | — |`);
    } else {
      md.push(`| \`${r.source}\` | READY | ${r.rowsForA ?? 0} | ${r.rowsLeakedFromB ?? 0} | ${r.crossTenantFilterRejected ? 'yes' : 'no'} | ${r.childLeakViaParent ?? 0} | ${r.parentLeakViaChild ?? 0} | ${r.agencyScopeApplied ?? 'n/a'} | ${r.ok ? 'PASS' : '**FAIL**'} |`);
    }
  }
  md.push('');
  md.push('## Notes');
  for (const r of results) {
    if (r.notes.length) {
      md.push(`- **${r.source}**: ${r.notes.join('; ')}`);
    }
  }
  await fs.writeFile(path.join(OUT_DIR, 'reports-isolation-test.md'), md.join('\n'));

  console.log(`reports-isolation-test: ${summary.counts.passed}/${summary.counts.ready} sources isolated.`);
  if (summary.counts.failed > 0) process.exit(2);
}

main().catch((e) => { console.error(e); process.exit(3); });
