/**
 * Phase 2.54 — Audit-log hard-delete harness.
 *
 *   1.  dry-run deletes zero rows
 *   2.  dry-run reports correct eligible count
 *   3.  apply refused when AUDIT_LOG_HARD_DELETE_ENABLED=false
 *   4.  apply refused when AUDIT_LOG_HARD_DELETE_APPLY=false
 *   5.  apply refused outside SAFE_CLONE/SAFE_STAGING (source gate)
 *   6.  apply refuses tenant scope without tenant id
 *   7.  apply hard-deletes only already soft-deleted rows older than grace
 *   8.  apply does not delete rows where deletedAt IS NULL
 *   9.  apply does not delete soft-deleted rows inside grace window
 *  10.  tenant A hard-delete does not touch tenant B rows
 *  11.  tenant B hard-delete does not touch tenant A rows
 *  12.  null-tenant scope deletes only NULL-tenant eligible rows
 *  13.  all scope deletes all eligible rows only when explicitly requested
 *  14.  rerun apply is idempotent
 *  15.  source-level: DELETE FROM audit_logs lives only in this phase 2.54
 *       script and not in src/ runtime services
 */
/* eslint-disable no-console */
import { promises as fs } from 'fs';
import path from 'path';
import { Client } from 'pg';
import { autoLoadEnv, formatDatabaseUrlMissingMessage } from './../phase1/reconciliation/lib/env';
import { classifyRuntimeEnv, isStagingClassification } from '../../../src/saas/tenancy/env-safety';
import { runHardDelete } from './audit-log-hard-delete';

autoLoadEnv(__filename);

const OUT_DIR = path.resolve(__dirname, '..', '..', '..', 'reports', 'saas', 'phase2');
const SCRIPT_PATH = path.resolve(__dirname, 'audit-log-hard-delete.ts');
const SRC_DIR    = path.resolve(__dirname, '..', '..', '..', 'src');
const SCANNER     = path.resolve(__dirname, '..', '..', 'scan-annotations.ts');

const SEED_TAG = 'phase254-harness';

interface CaseResult { name: string; ok: boolean; detail: string; }

function getDatabaseUrl(): string {
  const arg = process.argv.find((a) => a.startsWith('--db='))?.slice(5);
  return arg ?? process.env.DATABASE_URL ?? (() => { throw new Error(formatDatabaseUrlMissingMessage()); })();
}
function pgClient(url: string): Client {
  return new Client({ connectionString: url, ssl: /127\.0\.0\.1|localhost/.test(url) ? false : { rejectUnauthorized: false } });
}
async function withFlags<T>(env: Record<string, string | undefined>, fn: () => Promise<T> | T): Promise<T> {
  const prev = { ...process.env };
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  try { return await fn(); } finally { process.env = prev; }
}

interface Seed {
  tA: string; tB: string;
  eligibleA1: string; eligibleA2: string;   // tA, deletedAt=200d
  eligibleB1: string;                        // tB, deletedAt=200d
  eligibleNull1: string;                     // NULL tenant, deletedAt=200d
  insideGraceA: string;                      // tA, deletedAt=10d
  notDeletedA: string;                       // tA, deletedAt IS NULL
}

async function seed(url: string): Promise<Seed> {
  const c = pgClient(url); await c.connect();
  try {
    const ts = await c.query<{ id: string }>(
      `SELECT t.id FROM tenants t WHERE EXISTS (SELECT 1 FROM employees e WHERE e."tenantId" = t.id::text) ORDER BY t.name`);
    const tA = ts.rows[0].id, tB = ts.rows[1].id;
    await c.query(`DELETE FROM audit_logs WHERE "userAgent" = $1`, [SEED_TAG]);

    const ins = async (action: string, tenantId: string | null, deletedAtAge: string | null): Promise<string> => {
      const deletedAtSql = deletedAtAge ? `now() - $4::interval` : 'NULL';
      const params: any[] = [action, tenantId, SEED_TAG];
      if (deletedAtAge) params.push(deletedAtAge);
      const r = await c.query<{ id: string }>(
        `INSERT INTO audit_logs (id, action, entity, "entityId", "tenantId", "userAgent", "createdAt", "deletedAt")
         VALUES (gen_random_uuid()::text, $1, 'Phase254HardDel', '00000000-0000-0000-0000-000000000fff',
                 $2, $3, now() - interval '300 days', ${deletedAtSql})
         RETURNING id`,
        params);
      return r.rows[0].id;
    };

    const eligibleA1   = await ins('HD_A_OLD1', tA, '200 days');
    const eligibleA2   = await ins('HD_A_OLD2', tA, '210 days');
    const eligibleB1   = await ins('HD_B_OLD1', tB, '220 days');
    const eligibleNull1 = await ins('HD_NULL_OLD', null, '230 days');
    const insideGraceA = await ins('HD_A_INSIDE', tA, '10 days');   // < 90d default grace
    const notDeletedA  = await ins('HD_A_LIVE', tA, null);          // deletedAt IS NULL

    return { tA, tB, eligibleA1, eligibleA2, eligibleB1, eligibleNull1, insideGraceA, notDeletedA };
  } finally { await c.end(); }
}

async function exists(c: Client, id: string): Promise<boolean> {
  const r = await c.query<{ n: string }>(`SELECT COUNT(*)::text AS n FROM audit_logs WHERE id = $1`, [id]);
  return Number(r.rows[0].n) > 0;
}

async function listSrcFiles(dir: string, acc: string[] = []): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === 'node_modules' || e.name === '__tests__') continue;
      await listSrcFiles(full, acc);
    } else if (/\.(ts|js)$/.test(e.name)) acc.push(full);
  }
  return acc;
}

async function main(): Promise<void> {
  const url = getDatabaseUrl();
  const env = classifyRuntimeEnv();
  if (!isStagingClassification(env.classification)) {
    console.error(`[audit-log-hard-delete-harness] refusing on classification=${env.classification}`);
    process.exit(3);
  }
  const seed1 = await seed(url);

  const out: CaseResult[] = [];

  // 1, 2 — dry-run with default flags (ENABLED=false ⇒ refused as dry-run)
  const dry = await withFlags({
    AUDIT_LOG_HARD_DELETE_ENABLED: undefined, AUDIT_LOG_HARD_DELETE_APPLY: undefined,
    AUDIT_LOG_HARD_DELETE_TENANT_ID: seed1.tA, AUDIT_LOG_HARD_DELETE_SCOPE: 'tenant',
  }, () => runHardDelete(url));
  out.push({ name: '1. dry-run deletes zero rows', ok: dry.deletedRows === 0 && dry.applied === false, detail: `mode=${dry.mode} deleted=${dry.deletedRows}` });
  out.push({ name: '2. dry-run reports correct eligible count for tenant A (>=2)', ok: dry.eligibleRows >= 2, detail: `eligible=${dry.eligibleRows}` });

  // 3 — refused when ENABLED=false
  out.push({ name: '3. apply refused when AUDIT_LOG_HARD_DELETE_ENABLED=false',
    ok: dry.mode === 'dry-run' && /ENABLED=false/.test(dry.refusalReason ?? ''), detail: dry.refusalReason ?? '' });

  // 4 — refused when APPLY=false
  const dry2 = await withFlags({
    AUDIT_LOG_HARD_DELETE_ENABLED: 'true', AUDIT_LOG_HARD_DELETE_APPLY: 'false',
    AUDIT_LOG_HARD_DELETE_TENANT_ID: seed1.tA, AUDIT_LOG_HARD_DELETE_SCOPE: 'tenant',
  }, () => runHardDelete(url));
  out.push({ name: '4. apply refused when AUDIT_LOG_HARD_DELETE_APPLY=false',
    ok: dry2.mode === 'dry-run' && /APPLY=false/.test(dry2.refusalReason ?? ''), detail: dry2.refusalReason ?? '' });

  // 5 — source gate
  const src = await fs.readFile(SCRIPT_PATH, 'utf8');
  const stripped = src.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
  const gateOk =
    /isStagingClassification\(\s*env\.classification\s*\)/.test(stripped) &&
    /AUDIT_LOG_HARD_DELETE_ENABLED/.test(stripped) &&
    /AUDIT_LOG_HARD_DELETE_APPLY/.test(stripped) &&
    /enabled[\s\S]*applyFlag[\s\S]*safe/.test(stripped);
  out.push({ name: '5. apply refused outside SAFE_CLONE/SAFE_STAGING (source gate)', ok: gateOk, detail: gateOk ? 'all 3 gates wired' : 'GATE MISSING' });

  // 6 — tenant scope without tenant id refused
  const dry3 = await withFlags({
    AUDIT_LOG_HARD_DELETE_ENABLED: 'true', AUDIT_LOG_HARD_DELETE_APPLY: 'true',
    AUDIT_LOG_HARD_DELETE_SCOPE: 'tenant', AUDIT_LOG_HARD_DELETE_TENANT_ID: undefined,
  }, () => runHardDelete(url));
  out.push({ name: '6. apply refuses tenant scope without tenant id',
    ok: dry3.mode === 'dry-run' && /requires AUDIT_LOG_HARD_DELETE_TENANT_ID/.test(dry3.refusalReason ?? ''),
    detail: dry3.refusalReason ?? '' });

  // 7, 8, 9, 10 — apply tenant A
  const apply = await withFlags({
    AUDIT_LOG_HARD_DELETE_ENABLED: 'true', AUDIT_LOG_HARD_DELETE_APPLY: 'true',
    AUDIT_LOG_HARD_DELETE_TENANT_ID: seed1.tA, AUDIT_LOG_HARD_DELETE_SCOPE: 'tenant',
  }, () => runHardDelete(url));
  out.push({ name: '7. apply hard-deletes only already soft-deleted rows older than grace',
    ok: apply.mode === 'apply' && apply.deletedRows >= 2, detail: `deleted=${apply.deletedRows}` });

  const c = pgClient(url); await c.connect();
  try {
    out.push({ name: '8. apply does not delete rows where deletedAt IS NULL',
      ok: await exists(c, seed1.notDeletedA), detail: `live row preserved` });
    out.push({ name: '9. apply does not delete soft-deleted rows inside grace window',
      ok: await exists(c, seed1.insideGraceA), detail: `inside-grace row preserved` });
    out.push({ name: '10. tenant A hard-delete does not touch tenant B rows',
      ok: await exists(c, seed1.eligibleB1), detail: `B old row preserved` });
    // Confirm tenant A old rows ARE physically gone
    const e1 = await exists(c, seed1.eligibleA1);
    const e2 = await exists(c, seed1.eligibleA2);
    out.push({ name: '7b. tenant A old eligible rows physically removed', ok: !e1 && !e2, detail: `A1.exists=${e1} A2.exists=${e2}` });
  } finally { await c.end(); }

  // 11 — apply tenant B; tenant A live + grace untouched (already deleted, but the never-deleted live row remains)
  const applyB = await withFlags({
    AUDIT_LOG_HARD_DELETE_ENABLED: 'true', AUDIT_LOG_HARD_DELETE_APPLY: 'true',
    AUDIT_LOG_HARD_DELETE_TENANT_ID: seed1.tB, AUDIT_LOG_HARD_DELETE_SCOPE: 'tenant',
  }, () => runHardDelete(url));
  const c2 = pgClient(url); await c2.connect();
  try {
    const bGone = !(await exists(c2, seed1.eligibleB1));
    const aLive = await exists(c2, seed1.notDeletedA);
    const aGrace = await exists(c2, seed1.insideGraceA);
    out.push({ name: '11. tenant B hard-delete does not touch tenant A rows',
      ok: bGone && aLive && aGrace && applyB.deletedRows >= 1,
      detail: `B.gone=${bGone} A.live=${aLive} A.grace=${aGrace} deleted=${applyB.deletedRows}` });
  } finally { await c2.end(); }

  // 12 — null-tenant scope deletes only NULL-tenant
  const seed2 = await seed(url);
  const applyNull = await withFlags({
    AUDIT_LOG_HARD_DELETE_ENABLED: 'true', AUDIT_LOG_HARD_DELETE_APPLY: 'true',
    AUDIT_LOG_HARD_DELETE_SCOPE: 'null-tenant', AUDIT_LOG_HARD_DELETE_TENANT_ID: undefined,
  }, () => runHardDelete(url));
  const c3 = pgClient(url); await c3.connect();
  try {
    const nullGone = !(await exists(c3, seed2.eligibleNull1));
    const aStill = await exists(c3, seed2.eligibleA1);
    const bStill = await exists(c3, seed2.eligibleB1);
    out.push({ name: '12. null-tenant scope deletes only NULL-tenant eligible rows',
      ok: nullGone && aStill && bStill && applyNull.deletedRows >= 1,
      detail: `null.gone=${nullGone} A.still=${aStill} B.still=${bStill} deleted=${applyNull.deletedRows}` });
  } finally { await c3.end(); }

  // 13 — all scope
  const seed3 = await seed(url);
  const applyAll = await withFlags({
    AUDIT_LOG_HARD_DELETE_ENABLED: 'true', AUDIT_LOG_HARD_DELETE_APPLY: 'true',
    AUDIT_LOG_HARD_DELETE_SCOPE: 'all', AUDIT_LOG_HARD_DELETE_TENANT_ID: undefined,
  }, () => runHardDelete(url));
  const c4 = pgClient(url); await c4.connect();
  try {
    const aGone = !(await exists(c4, seed3.eligibleA1));
    const bGone = !(await exists(c4, seed3.eligibleB1));
    const nullGone = !(await exists(c4, seed3.eligibleNull1));
    const live = await exists(c4, seed3.notDeletedA);
    const grace = await exists(c4, seed3.insideGraceA);
    out.push({ name: '13. all scope deletes all eligible rows only when explicitly requested',
      ok: aGone && bGone && nullGone && live && grace && applyAll.deletedRows >= 4,
      detail: `A.gone=${aGone} B.gone=${bGone} null.gone=${nullGone} live=${live} grace=${grace} deleted=${applyAll.deletedRows}` });
  } finally { await c4.end(); }

  // 14 — idempotent: rerun all-scope after the above leaves zero eligibles
  const applyAll2 = await withFlags({
    AUDIT_LOG_HARD_DELETE_ENABLED: 'true', AUDIT_LOG_HARD_DELETE_APPLY: 'true',
    AUDIT_LOG_HARD_DELETE_SCOPE: 'all', AUDIT_LOG_HARD_DELETE_TENANT_ID: undefined,
  }, () => runHardDelete(url));
  out.push({ name: '14. rerun apply is idempotent (zero deletes)',
    ok: applyAll2.deletedRows === 0, detail: `deleted=${applyAll2.deletedRows} eligible=${applyAll2.eligibleRows}` });

  // 15 — source-level: any runtime audit-log hard-delete is the pre-existing
  // System Admin recycle-bin path tagged `phase211-excluded-platform`, and
  // Phase 2.54 introduces no new runtime hard-delete site.
  const srcFiles = await listSrcFiles(SRC_DIR);
  const offenders: string[] = [];
  for (const f of srcFiles) {
    const text = await fs.readFile(f, 'utf8');
    // Strip comments to ignore narrative mentions but keep tagged annotations on the same line.
    const stripped2 = text.replace(/\/\/[^\n]*?@tenant-reviewed[^\n]*$/gm, '_TAGGED_ANNOTATION_')
                          .replace(/\/\/.*$/gm, '')
                          .replace(/\/\*[\s\S]*?\*\//g, '');
    const hasRawDelete = /DELETE\s+FROM\s+audit_logs/i.test(stripped2);
    const hasPrismaDelete = /auditLog\s*\.\s*delete(Many)?\s*\(/.test(stripped2);
    if (!hasRawDelete && !hasPrismaDelete) continue;
    // Allowed: src/recycle-bin/database-cleanup.service.ts AND tagged
    // phase211-excluded-platform on the same delete line.
    const isAllowedFile = /\/src\/recycle-bin\/database-cleanup\.service\.ts$/.test(f);
    const allDeleteLines = text.split('\n').filter((ln) =>
      /auditLog\s*\.\s*delete(Many)?\s*\(/.test(ln) || /DELETE\s+FROM\s+audit_logs/i.test(ln));
    const allTagged = allDeleteLines.every((ln) => /phase211-excluded-platform/.test(ln));
    if (!(isAllowedFile && allTagged)) offenders.push(f);
  }
  out.push({ name: '15. DELETE FROM audit_logs lives ONLY in scripts/ + the pre-existing recycle-bin admin path',
    ok: offenders.length === 0, detail: offenders.length === 0 ? 'allowed sites only' : offenders.join(', ') });

  // 16 — scanner registers tag
  const scannerSrc = await fs.readFile(SCANNER, 'utf8');
  out.push({ name: '16. scanner registers phase254-audit-log-hard-delete', ok: /phase254-audit-log-hard-delete/.test(scannerSrc), detail: 'tag found' });

  await fs.mkdir(OUT_DIR, { recursive: true });
  const passed = out.filter((c) => c.ok).length;
  const total = out.length;
  await fs.writeFile(path.join(OUT_DIR, 'audit-log-hard-delete-harness.json'),
    JSON.stringify({ passed, total, cases: out }, null, 2));
  const md = [
    `# Phase 2.54 — audit-log hard-delete harness`, ``,
    `**${passed}/${total} PASS**`, ``,
    ...out.map((c) => `- ${c.ok ? 'PASS' : 'FAIL'} — ${c.name} — ${c.detail}`), ``,
  ].join('\n');
  await fs.writeFile(path.join(OUT_DIR, 'audit-log-hard-delete-harness.md'), md);
  console.log(`[audit-log-hard-delete-harness] ${passed}/${total} PASS`);
  process.exit(passed === total ? 0 : 1);
}

main().catch((err) => { console.error(err); process.exit(2); });
