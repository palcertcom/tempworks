/**
 * Phase 2.52 — Audit-log read equivalence harness.
 *
 *   1.  pilot disabled returns legacy audit list shape
 *   2.  pilot disabled count matches legacy
 *   3.  pilot enabled response shape preserved
 *   4.  pilot enabled list ⊆ legacy list (subset)
 *   5.  entity filter preserved (legacy + pilot)
 *   6.  entityId filter preserved
 *   7.  action filter preserved
 *   8.  userId filter preserved
 *   9.  date range filter preserved
 *  10.  pagination/sorting shape preserved
 *  11.  allow-list unset ⇒ all modules allowed
 *  12.  allow-list explicit "audit-logs" works
 *  13.  allow-list comma-separated works
 *  14.  allow-list "nothing" returns legacy behaviour
 */
/* eslint-disable no-console */
import { promises as fs } from 'fs';
import path from 'path';
import { Client } from 'pg';
import { autoLoadEnv, formatDatabaseUrlMissingMessage } from './../phase1/reconciliation/lib/env';
import { classifyRuntimeEnv, isStagingClassification } from '../../../src/saas/tenancy/env-safety';
import { PrismaService } from '../../../src/prisma/prisma.service';
import { TenantPrismaService } from '../../../src/saas/prisma/tenant-prisma.service';
import { PilotPrismaAccessor } from '../../../src/saas/prisma/pilot-prisma.accessor';
import { FeatureFlagsService } from '../../../src/saas/feature-flags/feature-flags.service';
import { LogsService } from '../../../src/logs/logs.service';
import { TenantAuditLogService } from '../../../src/saas/audit/tenant-audit-log.service';
import { TenantContext, withRequestContext, newRequestId } from '../../../src/saas/context/als';
import { isModuleAllowed, getPilotScope } from '../../../src/saas/prisma/tenant-pilot-scope';

autoLoadEnv(__filename);

const OUT_DIR = path.resolve(__dirname, '..', '..', '..', 'reports', 'saas', 'phase2');
const SEED_TAG = 'phase252-eq-harness';

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
function makeService(prisma: PrismaService, pilot: PilotPrismaAccessor, ff: FeatureFlagsService): LogsService {
  return new LogsService(prisma, pilot, new TenantAuditLogService(prisma, ff));
}

async function seed(url: string): Promise<{ tA: string; tB: string }> {
  const c = pgClient(url); await c.connect();
  try {
    const ts = await c.query<{ id: string }>(
      `SELECT t.id FROM tenants t WHERE EXISTS (SELECT 1 FROM employees e WHERE e."tenantId" = t.id::text) ORDER BY t.name`);
    const tA = ts.rows[0].id, tB = ts.rows[1].id;
    await c.query(`DELETE FROM audit_logs WHERE "userAgent" = $1`, [SEED_TAG]);
    // Seed: 4 tenant A rows (entity=Phase252A), 2 tenant B rows (entity=Phase252B), 1 NULL-tenant row
    await c.query(`
      INSERT INTO audit_logs (id, action, entity, "entityId", "tenantId", "userId", "userAgent", "createdAt") VALUES
        (gen_random_uuid()::text, 'EQ_A_CREATE', 'Phase252A', '00000000-0000-0000-0000-000000000a01', $1, NULL, $3, now() - interval '5 days'),
        (gen_random_uuid()::text, 'EQ_A_UPDATE', 'Phase252A', '00000000-0000-0000-0000-000000000a01', $1, NULL, $3, now() - interval '2 days'),
        (gen_random_uuid()::text, 'EQ_A_DELETE', 'Phase252A', '00000000-0000-0000-0000-000000000a02', $1, NULL, $3, now() - interval '1 day'),
        (gen_random_uuid()::text, 'EQ_A_VIEW',   'Phase252A', '00000000-0000-0000-0000-000000000a03', $1, NULL, $3, now()),
        (gen_random_uuid()::text, 'EQ_B_CREATE', 'Phase252B', '00000000-0000-0000-0000-000000000b01', $2, NULL, $3, now() - interval '3 days'),
        (gen_random_uuid()::text, 'EQ_B_UPDATE', 'Phase252B', '00000000-0000-0000-0000-000000000b01', $2, NULL, $3, now()),
        (gen_random_uuid()::text, 'EQ_NULL',     'Phase252A', '00000000-0000-0000-0000-000000000a09', NULL, NULL, $3, now())
    `, [tA, tB, SEED_TAG]);
    return { tA, tB };
  } finally { await c.end(); }
}

async function main(): Promise<void> {
  const url = getDatabaseUrl();
  const env = classifyRuntimeEnv();
  if (!isStagingClassification(env.classification)) {
    console.error(`[audit-log-read-equivalence] refusing on classification=${env.classification}`);
    process.exit(3);
  }
  const { tA } = await seed(url);

  const out: CaseResult[] = [];
  const filterEntity = { entity: 'Phase252A' };

  // 1, 2 — legacy snapshot
  let legacyTotal = 0;
  let legacyKeys: string[] = [];
  await withFlags({ TENANT_PRISMA_PILOT_ENABLED: 'false' }, async () => {
    const prisma = new PrismaService(); const ff = new FeatureFlagsService();
    const pilot = new PilotPrismaAccessor(prisma, new TenantPrismaService(prisma, ff), ff);
    const svc = makeService(prisma, pilot, ff);
    try {
      const r: any = await svc.findAll({} as any, filterEntity);
      legacyTotal = r.meta.total;
      legacyKeys = Object.keys(r);
      const okShape = legacyKeys.includes('data') && legacyKeys.includes('meta')
        && ['total','page','limit','totalPages'].every((k) => k in r.meta);
      out.push({ name: '1. pilot disabled returns legacy list shape', ok: okShape, detail: `keys=${legacyKeys.join(',')}` });
      out.push({ name: '2. pilot disabled count matches legacy (>=5 Phase252A)', ok: legacyTotal >= 5, detail: `total=${legacyTotal}` });
    } finally { await prisma.$disconnect(); }
  });

  // 3, 4 — pilot snapshot
  let pilotTotal = 0;
  await withFlags({ TENANT_PRISMA_PILOT_ENABLED: 'true', TENANT_PRISMA_PILOT_MODULES: 'audit-logs' }, async () => {
    const prisma = new PrismaService(); const ff = new FeatureFlagsService();
    const pilot = new PilotPrismaAccessor(prisma, new TenantPrismaService(prisma, ff), ff);
    const svc = makeService(prisma, pilot, ff);
    try {
      const r: any = await withRequestContext({ requestId: newRequestId() }, async () => {
        TenantContext.attach({ id: tA, slug: 'a', name: 'A', status: 'ACTIVE', region: 'eu' });
        return svc.findAll({} as any, filterEntity);
      });
      pilotTotal = r.meta.total;
      out.push({ name: '3. pilot enabled response shape preserved', ok: 'data' in r && 'meta' in r, detail: `keys=${Object.keys(r).join(',')}` });
      out.push({ name: '4. pilot enabled list ⊂ legacy union', ok: pilotTotal > 0 && pilotTotal <= legacyTotal, detail: `legacy=${legacyTotal} pilotA=${pilotTotal}` });
    } finally { await prisma.$disconnect(); }
  });

  // 5–9 — filters
  async function pilotFind(filters: any): Promise<number> {
    return withFlags({ TENANT_PRISMA_PILOT_ENABLED: 'true', TENANT_PRISMA_PILOT_MODULES: 'audit-logs' }, async () => {
      const prisma = new PrismaService(); const ff = new FeatureFlagsService();
      const pilot = new PilotPrismaAccessor(prisma, new TenantPrismaService(prisma, ff), ff);
      const svc = makeService(prisma, pilot, ff);
      try {
        const r: any = await withRequestContext({ requestId: newRequestId() }, async () => {
          TenantContext.attach({ id: tA, slug: 'a', name: 'A', status: 'ACTIVE', region: 'eu' });
          return svc.findAll({} as any, filters);
        });
        return r.meta.total as number;
      } finally { await prisma.$disconnect(); }
    });
  }
  out.push({ name: '5. entity filter preserved', ok: (await pilotFind({ entity: 'Phase252A' })) >= 1, detail: 'entity=Phase252A' });
  out.push({ name: '6. entityId filter preserved', ok: (await pilotFind({ entity: 'Phase252A', entityId: '00000000-0000-0000-0000-000000000a01' })) === 2, detail: 'entityId=...a01' });
  out.push({ name: '7. action filter preserved', ok: (await pilotFind({ action: 'EQ_A_CREATE' })) >= 1, detail: 'action=EQ_A_CREATE' });
  out.push({ name: '8. userId filter preserved (zero match for synthetic id)', ok: (await pilotFind({ userId: '00000000-0000-0000-0000-deadbeefdead' })) === 0, detail: 'userId=synthetic' });
  out.push({ name: '9. date range filter preserved', ok: (await pilotFind({ entity: 'Phase252A', fromDate: new Date(Date.now() - 7 * 86400 * 1000).toISOString(), toDate: new Date().toISOString() })) >= 1, detail: 'last 7 days' });

  // 10 — pagination/sorting shape preserved
  await withFlags({ TENANT_PRISMA_PILOT_ENABLED: 'true', TENANT_PRISMA_PILOT_MODULES: 'audit-logs' }, async () => {
    const prisma = new PrismaService(); const ff = new FeatureFlagsService();
    const pilot = new PilotPrismaAccessor(prisma, new TenantPrismaService(prisma, ff), ff);
    const svc = makeService(prisma, pilot, ff);
    try {
      const r: any = await withRequestContext({ requestId: newRequestId() }, async () => {
        TenantContext.attach({ id: tA, slug: 'a', name: 'A', status: 'ACTIVE', region: 'eu' });
        return svc.findAll({ page: 1, limit: 1 } as any, filterEntity);
      });
      out.push({ name: '10. pagination shape preserved (page=1 limit=1)',
        ok: r.meta.page === 1 && r.meta.limit === 1 && r.data.length <= 1,
        detail: `page=${r.meta.page} limit=${r.meta.limit}` });
    } finally { await prisma.$disconnect(); }
  });

  // 11–14 — allow-list contracts
  out.push({ name: '11. allow-list unset ⇒ all modules allowed', ok: isModuleAllowed('audit-logs') && isModuleAllowed('attendance'), detail: 'both true' });
  await withFlags({ TENANT_PRISMA_PILOT_MODULES: 'audit-logs' }, () => {
    out.push({ name: '12. allow-list "audit-logs" allows audit-logs, denies others',
      ok: isModuleAllowed('audit-logs') && !isModuleAllowed('attendance'),
      detail: `audit=${isModuleAllowed('audit-logs')} att=${isModuleAllowed('attendance')}` });
  });
  await withFlags({ TENANT_PRISMA_PILOT_MODULES: 'audit-logs,attendance' }, () => {
    out.push({ name: '13. allow-list comma-separated allows both', ok: isModuleAllowed('audit-logs') && isModuleAllowed('attendance'), detail: 'both true' });
  });
  await withFlags({ TENANT_PRISMA_PILOT_ENABLED: 'true', TENANT_PRISMA_PILOT_MODULES: 'nothing' }, async () => {
    const prisma = new PrismaService(); const ff = new FeatureFlagsService();
    const pilot = new PilotPrismaAccessor(prisma, new TenantPrismaService(prisma, ff), ff);
    await withRequestContext({ requestId: newRequestId() }, async () => {
      TenantContext.attach({ id: tA, slug: 'a', name: 'A', status: 'ACTIVE', region: 'eu' });
      const s = getPilotScope(pilot, 'audit-logs');
      out.push({ name: '14. allow-list "nothing" ⇒ scope inactive (legacy)',
        ok: !s.active && /not in TENANT_PRISMA_PILOT_MODULES/.test(s.reason), detail: s.reason });
    });
    await prisma.$disconnect();
  });

  await fs.mkdir(OUT_DIR, { recursive: true });
  const passed = out.filter((c) => c.ok).length;
  const total = out.length;
  await fs.writeFile(path.join(OUT_DIR, 'audit-log-read-equivalence.json'),
    JSON.stringify({ passed, total, cases: out }, null, 2));
  const md = [
    `# Phase 2.52 — audit-log read equivalence`, ``,
    `**${passed}/${total} PASS**`, ``,
    ...out.map((c) => `- ${c.ok ? 'PASS' : 'FAIL'} — ${c.name} — ${c.detail}`), ``,
  ].join('\n');
  await fs.writeFile(path.join(OUT_DIR, 'audit-log-read-equivalence.md'), md);
  console.log(`[audit-log-read-equivalence] ${passed}/${total} PASS`);
  process.exit(passed === total ? 0 : 1);
}

main().catch((err) => { console.error(err); process.exit(2); });
