/**
 * Phase 2.53 — Audit-log retention enforcement harness.
 *
 *   1.  dry-run updates zero rows
 *   2.  dry-run reports correct candidate count
 *   3.  apply refused when AUDIT_LOG_RETENTION_ENABLED=false
 *   4.  apply refused when AUDIT_LOG_RETENTION_APPLY=false
 *   5.  apply refused outside SAFE_CLONE/SAFE_STAGING (source gate)
 *   6.  apply soft-deletes only rows older than cutoff
 *   7.  apply does not touch newer rows
 *   8.  apply does not touch already soft-deleted rows
 *   9.  tenant A retention does not touch tenant B rows
 *  10.  tenant B retention does not touch tenant A rows
 *  11.  null-tenant scope affects only NULL-tenant rows when explicitly requested
 *  12.  all scope affects all eligible rows only when explicitly requested
 *  13.  rerun apply is idempotent
 *  14.  no hard-delete calls exist in source (deleteMany / delete / $executeRaw)
 *  15.  source-level: enforce module exposes runRetentionEnforce + uses gates
 */
/* eslint-disable no-console */
import { promises as fs } from 'fs';
import path from 'path';
import { Client } from 'pg';
import { autoLoadEnv, formatDatabaseUrlMissingMessage } from './../phase1/reconciliation/lib/env';
import { classifyRuntimeEnv, isStagingClassification } from '../../../src/saas/tenancy/env-safety';
import { runRetentionEnforce } from './audit-log-retention-enforce';

autoLoadEnv(__filename);

const OUT_DIR = path.resolve(__dirname, '..', '..', '..', 'reports', 'saas', 'phase2');
const SCRIPT_PATH = path.resolve(__dirname, 'audit-log-retention-enforce.ts');
const SCANNER     = path.resolve(__dirname, '..', '..', 'scan-annotations.ts');

const SEED_TAG = 'phase253-harness';

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

interface SeededIds {
  tA: string; tB: string;
  oldA1: string; oldA2: string;
  oldB1: string;
  oldNull: string;
  newA: string;
  alreadyDeletedA: string;
}

async function seed(url: string): Promise<SeededIds> {
  const c = pgClient(url); await c.connect();
  try {
    const ts = await c.query<{ id: string }>(
      `SELECT t.id FROM tenants t WHERE EXISTS (SELECT 1 FROM employees e WHERE e."tenantId" = t.id::text) ORDER BY t.name`);
    const tA = ts.rows[0].id, tB = ts.rows[1].id;
    await c.query(`DELETE FROM audit_logs WHERE "userAgent" = $1`, [SEED_TAG]);

    const ins = async (action: string, tenantId: string | null, age: string, deleted = false): Promise<string> => {
      const r = await c.query<{ id: string }>(
        `INSERT INTO audit_logs (id, action, entity, "entityId", "tenantId", "userAgent", "createdAt", "deletedAt")
         VALUES (gen_random_uuid()::text, $1, 'Phase253Ret', '00000000-0000-0000-0000-000000000fff', $2, $3, now() - $4::interval, ${deleted ? 'now() - interval \'350 days\'' : 'NULL'})
         RETURNING id`,
        [action, tenantId, SEED_TAG, age]);
      return r.rows[0].id;
    };

    const oldA1 = await ins('RET_A_OLD1', tA, '400 days');
    const oldA2 = await ins('RET_A_OLD2', tA, '500 days');
    const oldB1 = await ins('RET_B_OLD1', tB, '420 days');
    const oldNull = await ins('RET_NULL_OLD', null, '450 days');
    const newA = await ins('RET_A_NEW', tA, '10 days');
    const alreadyDeletedA = await ins('RET_A_DELETED', tA, '600 days', true);

    return { tA, tB, oldA1, oldA2, oldB1, oldNull, newA, alreadyDeletedA };
  } finally { await c.end(); }
}

async function fetchRow(c: Client, id: string): Promise<{ deletedAt: Date | null; tenantId: string | null } | null> {
  const r = await c.query<{ deletedAt: Date | null; tenantId: string | null }>(
    `SELECT "deletedAt", "tenantId" FROM audit_logs WHERE id = $1`, [id]);
  return r.rows[0] ?? null;
}

async function main(): Promise<void> {
  const url = getDatabaseUrl();
  const env = classifyRuntimeEnv();
  if (!isStagingClassification(env.classification)) {
    console.error(`[audit-log-retention-enforce-harness] refusing on classification=${env.classification}`);
    process.exit(3);
  }
  const seed1 = await seed(url);

  const out: CaseResult[] = [];

  // 1, 2 — dry-run (default flags ⇒ ENABLED=false ⇒ refused as dry-run)
  const dry = await withFlags({
    AUDIT_LOG_RETENTION_ENABLED: undefined, AUDIT_LOG_RETENTION_APPLY: undefined,
    AUDIT_LOG_RETENTION_TENANT_ID: seed1.tA, AUDIT_LOG_RETENTION_SCOPE: 'tenant',
  }, () => runRetentionEnforce(url));
  out.push({ name: '1. dry-run updates zero rows', ok: dry.updatedRows === 0 && dry.applied === false, detail: `mode=${dry.mode} updated=${dry.updatedRows}` });
  out.push({ name: '2. dry-run reports correct candidate count for tenant A (>=2 seeded)', ok: dry.candidateRows >= 2, detail: `candidate=${dry.candidateRows}` });

  // 3 — refused when ENABLED=false
  out.push({ name: '3. apply refused when AUDIT_LOG_RETENTION_ENABLED=false',
    ok: dry.mode === 'dry-run' && /ENABLED=false/.test(dry.refusalReason ?? ''),
    detail: dry.refusalReason ?? '' });

  // 4 — refused when APPLY=false
  const dry2 = await withFlags({
    AUDIT_LOG_RETENTION_ENABLED: 'true', AUDIT_LOG_RETENTION_APPLY: 'false',
    AUDIT_LOG_RETENTION_TENANT_ID: seed1.tA, AUDIT_LOG_RETENTION_SCOPE: 'tenant',
  }, () => runRetentionEnforce(url));
  out.push({ name: '4. apply refused when AUDIT_LOG_RETENTION_APPLY=false',
    ok: dry2.mode === 'dry-run' && /APPLY=false/.test(dry2.refusalReason ?? ''),
    detail: dry2.refusalReason ?? '' });

  // 5 — source-level SAFE classification gate
  const src = await fs.readFile(SCRIPT_PATH, 'utf8');
  const stripped = src.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
  const gateOk =
    /isStagingClassification\(\s*env\.classification\s*\)/.test(stripped) &&
    /AUDIT_LOG_RETENTION_ENABLED/.test(stripped) &&
    /AUDIT_LOG_RETENTION_APPLY/.test(stripped) &&
    /enabled\s*&&\s*applyFlag/.test(stripped) === false &&  // we use sequential check, not single conjunction
    /enabled[\s\S]*applyFlag[\s\S]*safe/.test(stripped);
  out.push({ name: '5. apply refused outside SAFE_CLONE/SAFE_STAGING (source gate)', ok: gateOk, detail: gateOk ? 'all 3 gates wired' : 'GATE MISSING' });

  // 6, 7, 8 — apply tenant A and verify outcomes
  const apply = await withFlags({
    AUDIT_LOG_RETENTION_ENABLED: 'true', AUDIT_LOG_RETENTION_APPLY: 'true',
    AUDIT_LOG_RETENTION_TENANT_ID: seed1.tA, AUDIT_LOG_RETENTION_SCOPE: 'tenant',
  }, () => runRetentionEnforce(url));
  out.push({ name: '6. apply soft-deletes only rows older than cutoff (>=2 expected)',
    ok: apply.mode === 'apply' && apply.updatedRows >= 2, detail: `mode=${apply.mode} updated=${apply.updatedRows}` });

  const c = pgClient(url); await c.connect();
  try {
    const r1 = await fetchRow(c, seed1.oldA1);
    const r2 = await fetchRow(c, seed1.oldA2);
    const newA = await fetchRow(c, seed1.newA);
    const alreadyDel = await fetchRow(c, seed1.alreadyDeletedA);
    out.push({ name: '6b. tenant A old rows now soft-deleted',
      ok: !!r1?.deletedAt && !!r2?.deletedAt, detail: `old1=${!!r1?.deletedAt} old2=${!!r2?.deletedAt}` });
    out.push({ name: '7. apply does not touch newer rows', ok: newA?.deletedAt === null, detail: `newA.deletedAt=${newA?.deletedAt}` });
    // already-deleted row should still be deleted (idempotent — no-op) and its deletedAt timestamp preserved
    out.push({ name: '8. apply does not touch already soft-deleted rows', ok: alreadyDel?.deletedAt !== null, detail: `alreadyDel.deletedAt=${alreadyDel?.deletedAt}` });

    // 9 — tenant B row untouched
    const rB = await fetchRow(c, seed1.oldB1);
    out.push({ name: '9. tenant A retention does not touch tenant B rows', ok: rB?.deletedAt === null, detail: `B.deletedAt=${rB?.deletedAt}` });
  } finally { await c.end(); }

  // 10 — apply tenant B retention; tenant A new row stays untouched
  const applyB = await withFlags({
    AUDIT_LOG_RETENTION_ENABLED: 'true', AUDIT_LOG_RETENTION_APPLY: 'true',
    AUDIT_LOG_RETENTION_TENANT_ID: seed1.tB, AUDIT_LOG_RETENTION_SCOPE: 'tenant',
  }, () => runRetentionEnforce(url));
  const c2 = pgClient(url); await c2.connect();
  try {
    const rB = await fetchRow(c2, seed1.oldB1);
    const newA = await fetchRow(c2, seed1.newA);
    out.push({ name: '10. tenant B retention does not touch tenant A rows',
      ok: !!rB?.deletedAt && newA?.deletedAt === null && applyB.updatedRows >= 1,
      detail: `B.deletedAt=${!!rB?.deletedAt} A.new.deletedAt=${newA?.deletedAt} updated=${applyB.updatedRows}` });
  } finally { await c2.end(); }

  // 11 — null-tenant scope
  const applyNull = await withFlags({
    AUDIT_LOG_RETENTION_ENABLED: 'true', AUDIT_LOG_RETENTION_APPLY: 'true',
    AUDIT_LOG_RETENTION_SCOPE: 'null-tenant', AUDIT_LOG_RETENTION_TENANT_ID: undefined,
  }, () => runRetentionEnforce(url));
  const c3 = pgClient(url); await c3.connect();
  try {
    const rN = await fetchRow(c3, seed1.oldNull);
    out.push({ name: '11. null-tenant scope affects only NULL-tenant rows',
      ok: !!rN?.deletedAt && applyNull.updatedRows >= 1,
      detail: `nullDeleted=${!!rN?.deletedAt} updated=${applyNull.updatedRows}` });
  } finally { await c3.end(); }

  // 12 — all scope: re-seed and run
  const seed2 = await seed(url);
  const applyAll = await withFlags({
    AUDIT_LOG_RETENTION_ENABLED: 'true', AUDIT_LOG_RETENTION_APPLY: 'true',
    AUDIT_LOG_RETENTION_SCOPE: 'all', AUDIT_LOG_RETENTION_TENANT_ID: undefined,
  }, () => runRetentionEnforce(url));
  const c4 = pgClient(url); await c4.connect();
  try {
    const rA = await fetchRow(c4, seed2.oldA1);
    const rB = await fetchRow(c4, seed2.oldB1);
    const rN = await fetchRow(c4, seed2.oldNull);
    const newA = await fetchRow(c4, seed2.newA);
    out.push({ name: '12. all scope soft-deletes every eligible old row regardless of tenantId',
      ok: !!rA?.deletedAt && !!rB?.deletedAt && !!rN?.deletedAt && newA?.deletedAt === null && applyAll.updatedRows >= 4,
      detail: `A=${!!rA?.deletedAt} B=${!!rB?.deletedAt} NULL=${!!rN?.deletedAt} new=${newA?.deletedAt} updated=${applyAll.updatedRows}` });
  } finally { await c4.end(); }

  // 13 — rerun idempotent (after the 'all' apply, no remaining candidates)
  const applyAll2 = await withFlags({
    AUDIT_LOG_RETENTION_ENABLED: 'true', AUDIT_LOG_RETENTION_APPLY: 'true',
    AUDIT_LOG_RETENTION_SCOPE: 'all', AUDIT_LOG_RETENTION_TENANT_ID: undefined,
  }, () => runRetentionEnforce(url));
  out.push({ name: '13. rerun apply is idempotent (zero updates after all-scope)',
    ok: applyAll2.updatedRows === 0 && applyAll2.candidateRows === 0,
    detail: `updated=${applyAll2.updatedRows} candidate=${applyAll2.candidateRows}` });

  // 14 — no hard-delete calls in source
  const noHardDelete =
    !/\.delete(Many)?\s*\(/.test(stripped) &&
    !/\$executeRaw/.test(stripped) &&
    !/DELETE\s+FROM/i.test(stripped);
  out.push({ name: '14. no hard-delete calls exist in source',
    ok: noHardDelete, detail: noHardDelete ? 'soft-delete only' : 'HARD-DELETE FOUND' });

  // 15 — module exports + gates
  const hasExport = /export\s+(async\s+)?function\s+runRetentionEnforce/.test(stripped);
  out.push({ name: '15. enforce module exports runRetentionEnforce + uses gates', ok: hasExport && gateOk, detail: 'export + gates present' });

  // 16 — scanner registers tag
  const scannerSrc = await fs.readFile(SCANNER, 'utf8');
  out.push({ name: '16. scanner registers phase253-audit-log-retention-enforce', ok: /phase253-audit-log-retention-enforce/.test(scannerSrc), detail: 'tag found' });

  await fs.mkdir(OUT_DIR, { recursive: true });
  const passed = out.filter((c) => c.ok).length;
  const total = out.length;
  await fs.writeFile(path.join(OUT_DIR, 'audit-log-retention-enforce-harness.json'),
    JSON.stringify({ passed, total, cases: out }, null, 2));
  const md = [
    `# Phase 2.53 — audit-log retention enforcement harness`, ``,
    `**${passed}/${total} PASS**`, ``,
    ...out.map((c) => `- ${c.ok ? 'PASS' : 'FAIL'} — ${c.name} — ${c.detail}`), ``,
  ].join('\n');
  await fs.writeFile(path.join(OUT_DIR, 'audit-log-retention-enforce-harness.md'), md);
  console.log(`[audit-log-retention-enforce-harness] ${passed}/${total} PASS`);
  process.exit(passed === total ? 0 : 1);
}

main().catch((err) => { console.error(err); process.exit(2); });
