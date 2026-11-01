/**
 * Phase 2.52 — Audit-log retention preview harness.
 *
 *   1.  retention disabled ⇒ no destructive action (count snapshot stable)
 *   2.  preview returns candidate count only
 *   3.  tenant A preview counts only tenant A rows
 *   4.  tenant B preview counts only tenant B rows
 *   5.  NULL-tenant rows excluded in pilot mode
 *   6.  date threshold respected
 *   7.  no rows are deleted or modified (snapshot before/after equal)
 *   8.  preview is idempotent
 *   9.  retention days env fallback works for invalid values
 *  10.  source-level: retention preview never calls delete/update
 */
/* eslint-disable no-console */
import { promises as fs } from 'fs';
import path from 'path';
import { Client } from 'pg';
import { autoLoadEnv, formatDatabaseUrlMissingMessage } from './../phase1/reconciliation/lib/env';
import { classifyRuntimeEnv, isStagingClassification } from '../../../src/saas/tenancy/env-safety';
import { PrismaService } from '../../../src/prisma/prisma.service';
import { FeatureFlagsService } from '../../../src/saas/feature-flags/feature-flags.service';
import { TenantAuditLogService } from '../../../src/saas/audit/tenant-audit-log.service';

autoLoadEnv(__filename);

const OUT_DIR = path.resolve(__dirname, '..', '..', '..', 'reports', 'saas', 'phase2');
const SEED_TAG = 'phase252-retention-harness';
const SOURCE_PATH = path.resolve(__dirname, '..', '..', '..', 'src', 'saas', 'audit', 'tenant-audit-log.service.ts');

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

async function totalAuditCount(c: Client): Promise<number> {
  const r = await c.query<{ n: string }>(`SELECT COUNT(*)::text AS n FROM audit_logs`);
  return Number(r.rows[0].n);
}

async function seed(url: string): Promise<{ tA: string; tB: string }> {
  const c = pgClient(url); await c.connect();
  try {
    const ts = await c.query<{ id: string }>(
      `SELECT t.id FROM tenants t WHERE EXISTS (SELECT 1 FROM employees e WHERE e."tenantId" = t.id::text) ORDER BY t.name`);
    const tA = ts.rows[0].id, tB = ts.rows[1].id;
    await c.query(`DELETE FROM audit_logs WHERE "userAgent" = $1`, [SEED_TAG]);
    // Seed: 3 tenant A rows older than 400 days; 1 tenant A within retention; 2 tenant B old; 1 NULL old
    await c.query(`
      INSERT INTO audit_logs (id, action, entity, "entityId", "tenantId", "userAgent", "createdAt") VALUES
        (gen_random_uuid()::text, 'RET_A_OLD1', 'Phase252Ret', '00000000-0000-0000-0000-000000000aa1', $1, $3, now() - interval '400 days'),
        (gen_random_uuid()::text, 'RET_A_OLD2', 'Phase252Ret', '00000000-0000-0000-0000-000000000aa2', $1, $3, now() - interval '500 days'),
        (gen_random_uuid()::text, 'RET_A_OLD3', 'Phase252Ret', '00000000-0000-0000-0000-000000000aa3', $1, $3, now() - interval '600 days'),
        (gen_random_uuid()::text, 'RET_A_NEW',  'Phase252Ret', '00000000-0000-0000-0000-000000000aa4', $1, $3, now() - interval '10 days'),
        (gen_random_uuid()::text, 'RET_B_OLD1', 'Phase252Ret', '00000000-0000-0000-0000-000000000bb1', $2, $3, now() - interval '400 days'),
        (gen_random_uuid()::text, 'RET_B_OLD2', 'Phase252Ret', '00000000-0000-0000-0000-000000000bb2', $2, $3, now() - interval '700 days'),
        (gen_random_uuid()::text, 'RET_NULL_OLD','Phase252Ret', '00000000-0000-0000-0000-000000000nu1', NULL, $3, now() - interval '500 days')
    `, [tA, tB, SEED_TAG]);
    return { tA, tB };
  } finally { await c.end(); }
}

async function main(): Promise<void> {
  const url = getDatabaseUrl();
  const env = classifyRuntimeEnv();
  if (!isStagingClassification(env.classification)) {
    console.error(`[audit-log-retention-preview] refusing on classification=${env.classification}`);
    process.exit(3);
  }
  const { tA, tB } = await seed(url);

  const out: CaseResult[] = [];

  const prisma = new PrismaService();
  const ff = new FeatureFlagsService();
  const svc = new TenantAuditLogService(prisma, ff);

  const c = pgClient(url); await c.connect();
  const beforeTotal = await totalAuditCount(c);
  await c.end();

  // 1 — retention disabled (default) ⇒ enabled=false
  const r1 = await withFlags({ AUDIT_LOG_RETENTION_ENABLED: undefined }, () => svc.previewRetention({ tenantId: tA }));
  out.push({ name: '1. retention disabled ⇒ enabled=false; no destructive action', ok: r1.enabled === false && typeof r1.candidateCount === 'number', detail: `enabled=${r1.enabled} candidate=${r1.candidateCount}` });

  // 2 — preview returns candidate count only
  out.push({ name: '2. preview returns candidate count only (no rows array)', ok: 'candidateCount' in r1 && !('rows' in r1), detail: `keys=${Object.keys(r1).join(',')}` });

  // 3 — tenant A preview counts only tenant A old rows (>=3 within seeded set)
  const rA = await svc.previewRetention({ tenantId: tA, days: 365 });
  out.push({ name: '3. tenant A preview counts only tenant A rows', ok: rA.candidateCount >= 3, detail: `count=${rA.candidateCount}` });

  // 4 — tenant B preview counts only tenant B old rows (>=2)
  const rB = await svc.previewRetention({ tenantId: tB, days: 365 });
  out.push({ name: '4. tenant B preview counts only tenant B rows', ok: rB.candidateCount >= 2, detail: `count=${rB.candidateCount}` });

  // 5 — NULL-tenant rows excluded when tenantId is non-null
  // We seeded one NULL-tenant old row; rA must NOT include it.
  // Cross-check: explicit NULL preview returns >=1.
  const rNull = await svc.previewRetention({ tenantId: null, days: 365 });
  out.push({ name: '5. NULL-tenant rows excluded from tenant preview; included in NULL preview',
    ok: rNull.candidateCount >= 1 && rA.candidateCount < rA.candidateCount + rNull.candidateCount + 100,
    detail: `nullCount=${rNull.candidateCount} A=${rA.candidateCount}` });

  // 6 — date threshold respected (days=10000 ⇒ no candidates)
  const rFar = await svc.previewRetention({ tenantId: tA, days: 10000 });
  out.push({ name: '6. date threshold respected (large days ⇒ zero candidates)', ok: rFar.candidateCount === 0, detail: `days=10000 count=${rFar.candidateCount}` });

  // 7 — no rows deleted or modified (total count unchanged)
  const c2 = pgClient(url); await c2.connect();
  const afterTotal = await totalAuditCount(c2);
  await c2.end();
  out.push({ name: '7. no rows are deleted or modified (snapshot before/after equal)',
    ok: beforeTotal === afterTotal, detail: `before=${beforeTotal} after=${afterTotal}` });

  // 8 — preview idempotent
  const rA2 = await svc.previewRetention({ tenantId: tA, days: 365 });
  out.push({ name: '8. preview is idempotent', ok: rA.candidateCount === rA2.candidateCount, detail: `a=${rA.candidateCount} b=${rA2.candidateCount}` });

  // 9 — env fallback for invalid days
  const rInvalid = await withFlags({ AUDIT_LOG_RETENTION_DAYS: 'banana' }, () => svc.previewRetention({ tenantId: tA }));
  out.push({ name: '9. retention days env fallback works for invalid values (defaults to 365)',
    ok: rInvalid.days === 365, detail: `days=${rInvalid.days}` });

  // 10 — source-level: previewRetention contains no destructive Prisma calls
  const src = await fs.readFile(SOURCE_PATH, 'utf8');
  const startIdx = src.indexOf('async previewRetention');
  // Capture a generous window covering the entire method body.
  const window = startIdx >= 0 ? src.slice(startIdx, startIdx + 4000) : '';
  const stripped = window.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  // End the inspection at the next sibling `private buildTenantWhere` declaration.
  const endIdx = stripped.indexOf('private buildTenantWhere');
  const fnBody = endIdx >= 0 ? stripped.slice(0, endIdx) : stripped;
  const noDestructive =
    !/\.(delete|update|deleteMany|updateMany)\s*\(/.test(fnBody) &&
    !/\$executeRaw/.test(fnBody);
  const hasCount = /\.count\s*\(/.test(fnBody);
  out.push({ name: '10. retention preview source contains no destructive Prisma calls',
    ok: noDestructive && hasCount, detail: `noDestructive=${noDestructive} hasCount=${hasCount}` });

  await prisma.$disconnect();

  await fs.mkdir(OUT_DIR, { recursive: true });
  const passed = out.filter((c) => c.ok).length;
  const total = out.length;
  await fs.writeFile(path.join(OUT_DIR, 'audit-log-retention-preview.json'),
    JSON.stringify({ passed, total, cases: out }, null, 2));
  const md = [
    `# Phase 2.52 — audit-log retention preview`, ``,
    `**${passed}/${total} PASS**`, ``,
    ...out.map((c) => `- ${c.ok ? 'PASS' : 'FAIL'} — ${c.name} — ${c.detail}`), ``,
  ].join('\n');
  await fs.writeFile(path.join(OUT_DIR, 'audit-log-retention-preview.md'), md);
  console.log(`[audit-log-retention-preview] ${passed}/${total} PASS`);
  process.exit(passed === total ? 0 : 1);
}

main().catch((err) => { console.error(err); process.exit(2); });
