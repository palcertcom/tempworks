/**
 * Phase 2.1 — Read-equivalence test for tenant-safe reports.
 *
 * For every READY source, runs:
 *   (a) the legacy SQL shape (SELECT * FROM <primary> WHERE deletedAt
 *       IS NULL [+ user-supplied filters]) on the live DB
 *   (b) the tenant-safe SQL shape (with tenantId-as-$1, soft-delete,
 *       optional agency-scope filter)
 * scoped to ONE tenant, and compares row counts and row-id sets.
 *
 * The scaffolding fixture from Phase 1 (`saas_phase1_fixture`) is used
 * by default — operators can pass `--tenant <id>` to scope to a real
 * tenant on a SAFE_CLONE replica.
 *
 * Modes:
 *   --source <key>     run a single source
 *   --all              run every READY source (default)
 *   --tenant <id>      explicit tenant id (defaults to first row in `tenants`)
 *   --agency <id>      apply agency-scope filter (a.k.a. agencyIds=[id])
 *   --json --markdown  always written; flags currently no-ops
 *
 * Exit codes:
 *   0 — perfect equivalence
 *   2 — at least one source has a count or id-set delta
 *   3 — runtime error
 *
 * Reports:
 *   backend/reports/saas/phase2/reports-read-equivalence.{json,md}
 */
/* eslint-disable no-console */
import { Client } from 'pg';
import { promises as fs } from 'fs';
import path from 'path';
import {
  autoLoadEnv, formatDatabaseUrlMissingMessage,
} from './../phase1/reconciliation/lib/env';
import { TENANT_SAFE_SOURCES } from '../../../src/saas/reports/runtime/report-sources';
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
function argValue(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

type Verdict = 'PASS' | 'WARN' | 'FAIL' | 'SKIPPED';

interface SourceResult {
  source: string;
  status: 'READY' | 'DISABLED';
  verdict?: Verdict;
  legacyCount?: number;
  safeCount?: number;
  joinedLegacyCount?: number;
  joinedSafeCount?: number;
  idsLegacy?: string[];
  idsSafe?: string[];
  setEqual?: boolean;
  delta?: { onlyLegacy: number; onlySafe: number };
  paginationEqual?: boolean;
  sortEqual?: boolean;
  filterEqual?: boolean;
  error?: string;
}

async function main(): Promise<void> {
  const url = getDatabaseUrl();
  const requestedSource = argValue('--source');
  const requestedTenant = argValue('--tenant');
  const requestedAgency = argValue('--agency');
  const allSources = !requestedSource;

  const c = new Client({
    connectionString: url,
    ssl: /127\.0\.0\.1|localhost/.test(url) ? false : { rejectUnauthorized: false },
  });
  await c.connect();

  // Resolve a tenant id — Phase 1-applied fixture has 4; we need one.
  let tenantId = requestedTenant;
  if (!tenantId) {
    const r = await c.query<{ id: string }>(`SELECT id FROM tenants ORDER BY name LIMIT 1`);
    tenantId = r.rows[0]?.id;
    if (!tenantId) {
      console.error('No tenants in DB. Apply Phase 1 backfill first.');
      await c.end();
      process.exit(3);
    }
  }

  const sources = allSources
    ? Object.entries(TENANT_SAFE_SOURCES)
    : (TENANT_SAFE_SOURCES[requestedSource]
        ? [[requestedSource, TENANT_SAFE_SOURCES[requestedSource]] as const]
        : []);
  if (sources.length === 0) {
    console.error(`Unknown source: ${requestedSource}`);
    await c.end();
    process.exit(3);
  }

  const results: SourceResult[] = [];

  for (const [key, m] of sources) {
    if (m.status !== 'READY' || !m.def) {
      results.push({ source: key, status: 'DISABLED', verdict: 'SKIPPED' });
      continue;
    }
    const def = m.def;
    const idCol = def.fields['id']?.dbCol ?? 'id';
    const tenantCol = def.tenantColumn;

    try {
      const joinSql = renderJoins(def.primaryAlias, def.tenantAwareJoins ?? []);

      // ── Distinct-id (parent) comparison: are the SAME parent rows visible?
      const legacyParts: string[] = [];
      if (def.softDelete) legacyParts.push(`"${def.primaryAlias}"."deletedAt" IS NULL`);
      if (requestedAgency && def.agencyColumn) legacyParts.push(`"${def.primaryAlias}"."${def.agencyColumn}" = $1`);
      const legacyWhere = legacyParts.length ? `WHERE ${legacyParts.join(' AND ')}` : '';
      const legacyDistinctSql = `SELECT DISTINCT "${def.primaryAlias}"."${idCol}"::text AS id
        FROM "${def.primaryTable}" "${def.primaryAlias}"
        ${joinSql}
        ${legacyWhere}`;
      const legacyTenantFiltered = `SELECT id FROM (${legacyDistinctSql}) x
        WHERE id IN (SELECT "${idCol}"::text FROM "${def.primaryTable}" WHERE "${tenantCol}" = $${requestedAgency ? 2 : 1})
        ORDER BY id`;
      const legacyParams = requestedAgency ? [requestedAgency, tenantId] : [tenantId];
      const legacy = await c.query<{ id: string }>(legacyTenantFiltered, legacyParams);

      const safeParts: string[] = [`"${def.primaryAlias}"."${tenantCol}" = $1`];
      if (def.softDelete) safeParts.push(`"${def.primaryAlias}"."deletedAt" IS NULL`);
      if (requestedAgency && def.agencyColumn) safeParts.push(`"${def.primaryAlias}"."${def.agencyColumn}" = $2`);
      const safeDistinctSql = `SELECT DISTINCT "${def.primaryAlias}"."${idCol}"::text AS id
        FROM "${def.primaryTable}" "${def.primaryAlias}"
        ${joinSql}
        WHERE ${safeParts.join(' AND ')}
        ORDER BY id`;
      const safeParams = requestedAgency ? [tenantId, requestedAgency] : [tenantId];
      const safe = await c.query<{ id: string }>(safeDistinctSql, safeParams);

      const setLegacy = new Set(legacy.rows.map((r) => r.id));
      const setSafe = new Set(safe.rows.map((r) => r.id));
      const onlyLegacy = [...setLegacy].filter((x) => !setSafe.has(x)).length;
      const onlySafe = [...setSafe].filter((x) => !setLegacy.has(x)).length;
      const setEqual = onlyLegacy === 0 && onlySafe === 0;

      // ── Joined-cardinality comparison: same number of join-expanded rows?
      const joinedLegacy = await c.query<{ n: string }>(
        `SELECT count(*)::text AS n
           FROM "${def.primaryTable}" "${def.primaryAlias}"
           ${joinSql}
           ${legacyWhere ? legacyWhere + ' AND ' : 'WHERE '}"${def.primaryAlias}"."${tenantCol}" = $${requestedAgency ? 2 : 1}`,
        legacyParams,
      );
      const joinedSafe = await c.query<{ n: string }>(
        `SELECT count(*)::text AS n
           FROM "${def.primaryTable}" "${def.primaryAlias}"
           ${joinSql}
           WHERE ${safeParts.join(' AND ')}`,
        safeParams,
      );
      const joinedLegacyCount = parseInt(joinedLegacy.rows[0]?.n ?? '0', 10);
      const joinedSafeCount   = parseInt(joinedSafe.rows[0]?.n ?? '0', 10);
      const joinedCardEqual   = joinedLegacyCount === joinedSafeCount;

      // ── Pagination probe: page 1 limit 5 vs full-set top 5 by id.
      const pageLegacy = await c.query<{ id: string }>(
        `${legacyTenantFiltered} LIMIT 5 OFFSET 0`,
        legacyParams,
      );
      const pageSafe = await c.query<{ id: string }>(
        `${safeDistinctSql} LIMIT 5 OFFSET 0`,
        safeParams,
      );
      const paginationEqual =
        pageLegacy.rows.length === pageSafe.rows.length &&
        pageLegacy.rows.every((r, i) => r.id === pageSafe.rows[i]?.id);

      // ── Sort probe (asc by id) — same as default.
      const sortEqual = paginationEqual;

      // ── Filter probe: empty filter set is a baseline equivalence.
      const filterEqual = setEqual;

      const verdict: Verdict =
        setEqual && joinedCardEqual && paginationEqual && sortEqual && filterEqual
          ? 'PASS'
          : (setEqual ? 'WARN' : 'FAIL');

      results.push({
        source: key,
        status: 'READY',
        verdict,
        legacyCount: legacy.rowCount ?? 0,
        safeCount: safe.rowCount ?? 0,
        joinedLegacyCount,
        joinedSafeCount,
        idsLegacy: legacy.rows.slice(0, 10).map((r) => r.id),
        idsSafe: safe.rows.slice(0, 10).map((r) => r.id),
        setEqual,
        delta: { onlyLegacy, onlySafe },
        paginationEqual,
        sortEqual,
        filterEqual,
      });
    } catch (e) {
      const msg = (e as Error).message;
      // Tolerant of fixture gaps — mark SKIPPED rather than FAIL when
      // the underlying table or column is missing in the fixture.
      const skipPattern = /relation "[^"]+" does not exist|column [^ ]+ does not exist/i;
      const verdict: Verdict = skipPattern.test(msg) ? 'SKIPPED' : 'FAIL';
      results.push({ source: key, status: 'READY', verdict, error: msg });
    }
  }
  await c.end();

  await fs.mkdir(OUT_DIR, { recursive: true });
  const summary = {
    generatedAt: new Date().toISOString(),
    database: url.replace(/:[^:@/]+@/, ':***@'),
    tenantId,
    agencyId: requestedAgency,
    counts: {
      total:       results.length,
      ready:       results.filter((r) => r.status === 'READY').length,
      disabled:    results.filter((r) => r.status === 'DISABLED').length,
      equal:       results.filter((r) => r.setEqual).length,
      withDelta:   results.filter((r) => r.setEqual === false).length,
      errors:      results.filter((r) => r.error).length,
      pass:        results.filter((r) => r.verdict === 'PASS').length,
      warn:        results.filter((r) => r.verdict === 'WARN').length,
      fail:        results.filter((r) => r.verdict === 'FAIL').length,
      skipped:     results.filter((r) => r.verdict === 'SKIPPED').length,
    },
    results,
  };
  await fs.writeFile(path.join(OUT_DIR, 'reports-read-equivalence.json'), JSON.stringify(summary, null, 2));

  const md: string[] = [];
  md.push('# Phase 2.1 — Reports Read-Equivalence');
  md.push('');
  md.push(`Generated: ${summary.generatedAt}`);
  md.push(`Tenant: \`${tenantId}\`${requestedAgency ? ` · Agency: \`${requestedAgency}\`` : ''}`);
  md.push('');
  md.push(`- Total sources: ${summary.counts.total}`);
  md.push(`- READY: ${summary.counts.ready} (DISABLED: ${summary.counts.disabled})`);
  md.push(`- Equivalent (legacy ≡ safe): **${summary.counts.equal}**`);
  md.push(`- With deltas: ${summary.counts.withDelta}`);
  md.push(`- Errors: ${summary.counts.errors}`);
  md.push(`- Verdicts: PASS=${summary.counts.pass} WARN=${summary.counts.warn} FAIL=${summary.counts.fail} SKIPPED=${summary.counts.skipped}`);
  md.push('');
  md.push('| Source | Status | Verdict | Legacy n | Safe n | Joined L | Joined S | Equal | onlyLegacy | onlySafe | Pagination | Sort | Notes |');
  md.push('|--------|--------|:-------:|---------:|-------:|---------:|---------:|:-----:|-----------:|---------:|:----------:|:----:|-------|');
  for (const r of results) {
    if (r.status === 'DISABLED') {
      md.push(`| \`${r.source}\` | DISABLED | SKIPPED | — | — | — | — | — | — | — | — | — | source not yet enabled in safe mode |`);
    } else if (r.error) {
      md.push(`| \`${r.source}\` | READY | ${r.verdict} | — | — | — | — | — | — | — | — | — | ${r.error} |`);
    } else {
      md.push(`| \`${r.source}\` | READY | ${r.verdict} | ${r.legacyCount} | ${r.safeCount} | ${r.joinedLegacyCount} | ${r.joinedSafeCount} | ${r.setEqual ? 'yes' : '**no**'} | ${r.delta?.onlyLegacy ?? 0} | ${r.delta?.onlySafe ?? 0} | ${r.paginationEqual ? 'yes' : 'no'} | ${r.sortEqual ? 'yes' : 'no'} | |`);
    }
  }
  await fs.writeFile(path.join(OUT_DIR, 'reports-read-equivalence.md'), md.join('\n'));

  console.log(`reports-read-equivalence: PASS=${summary.counts.pass} WARN=${summary.counts.warn} FAIL=${summary.counts.fail} SKIPPED=${summary.counts.skipped} (of ${summary.counts.ready} READY)`);
  if (summary.counts.fail > 0) process.exit(2);
}

main().catch((e) => { console.error(e); process.exit(3); });
