/**
 * Phase 2.52 — Audit-log read isolation harness.
 *
 *   1.  tenant A sees only audit rows with tenantId=A
 *   2.  tenant A does not see tenant B audit rows
 *   3.  tenant A does not see NULL-tenant audit rows in pilot mode
 *   4.  tenant B sees only tenant B rows
 *   5.  entity filter under tenant A does not leak tenant B rows
 *   6.  entityId filter for tenant B entity under tenant A returns empty
 *   7.  count under tenant A includes only tenant A rows
 *   8.  pagination under tenant A cannot page into tenant B rows
 *   9.  concurrent ALS frames remain isolated
 *  10.  pilot opt-out returns legacy union (incl. NULL-tenant row)
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

autoLoadEnv(__filename);

const OUT_DIR = path.resolve(__dirname, '..', '..', '..', 'reports', 'saas', 'phase2');
const SEED_TAG = 'phase252-iso-harness';

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
function attach(tid: string, slug: string) {
  TenantContext.attach({ id: tid, slug, name: slug.toUpperCase(), status: 'ACTIVE', region: 'eu' });
}

async function seed(url: string): Promise<{ tA: string; tB: string }> {
  const c = pgClient(url); await c.connect();
  try {
    const ts = await c.query<{ id: string }>(
      `SELECT t.id FROM tenants t WHERE EXISTS (SELECT 1 FROM employees e WHERE e."tenantId" = t.id::text) ORDER BY t.name`);
    const tA = ts.rows[0].id, tB = ts.rows[1].id;
    await c.query(`DELETE FROM audit_logs WHERE "userAgent" = $1`, [SEED_TAG]);
    await c.query(`
      INSERT INTO audit_logs (id, action, entity, "entityId", "tenantId", "userAgent", "createdAt") VALUES
        (gen_random_uuid()::text, 'ISO_A1', 'Phase252Iso', '00000000-0000-0000-0000-000000000aa1', $1, $3, now()),
        (gen_random_uuid()::text, 'ISO_A2', 'Phase252Iso', '00000000-0000-0000-0000-000000000aa2', $1, $3, now()),
        (gen_random_uuid()::text, 'ISO_A3', 'Phase252Iso', '00000000-0000-0000-0000-000000000aa3', $1, $3, now()),
        (gen_random_uuid()::text, 'ISO_B1', 'Phase252Iso', '00000000-0000-0000-0000-000000000bb1', $2, $3, now()),
        (gen_random_uuid()::text, 'ISO_B2', 'Phase252Iso', '00000000-0000-0000-0000-000000000bb2', $2, $3, now()),
        (gen_random_uuid()::text, 'ISO_NULL', 'Phase252Iso', '00000000-0000-0000-0000-000000000null', NULL, $3, now())
    `, [tA, tB, SEED_TAG]);
    return { tA, tB };
  } finally { await c.end(); }
}

async function main(): Promise<void> {
  const url = getDatabaseUrl();
  const env = classifyRuntimeEnv();
  if (!isStagingClassification(env.classification)) {
    console.error(`[audit-log-read-isolation] refusing on classification=${env.classification}`);
    process.exit(3);
  }
  const { tA, tB } = await seed(url);

  const out: CaseResult[] = [];
  const PILOT = { TENANT_PRISMA_PILOT_ENABLED: 'true', TENANT_PRISMA_PILOT_MODULES: 'audit-logs' };
  const isoFilter = { entity: 'Phase252Iso' };

  // 1 — tenant A sees only A rows
  let tenantAList: any[] = [];
  await withFlags(PILOT, async () => {
    const prisma = new PrismaService(); const ff = new FeatureFlagsService();
    const pilot = new PilotPrismaAccessor(prisma, new TenantPrismaService(prisma, ff), ff);
    const svc = makeService(prisma, pilot, ff);
    try {
      const r: any = await withRequestContext({ requestId: newRequestId() }, async () => {
        attach(tA, 'a'); return svc.findAll({ limit: 50 } as any, isoFilter);
      });
      tenantAList = r.data;
      const allA = tenantAList.every((row) => row.tenantId === tA);
      out.push({ name: '1. tenant A sees only audit rows with tenantId=A', ok: allA && tenantAList.length === 3, detail: `count=${tenantAList.length} allA=${allA}` });
    } finally { await prisma.$disconnect(); }
  });

  // 2 — no tenant B rows
  out.push({ name: '2. tenant A does not see tenant B audit rows', ok: !tenantAList.some((r) => r.action === 'ISO_B1' || r.action === 'ISO_B2'), detail: `actions=${tenantAList.map(r=>r.action).join(',')}` });

  // 3 — no NULL-tenant rows
  out.push({ name: '3. tenant A does not see NULL-tenant audit rows in pilot mode', ok: !tenantAList.some((r) => r.action === 'ISO_NULL'), detail: 'NULL excluded' });

  // 4 — tenant B sees only B rows
  await withFlags(PILOT, async () => {
    const prisma = new PrismaService(); const ff = new FeatureFlagsService();
    const pilot = new PilotPrismaAccessor(prisma, new TenantPrismaService(prisma, ff), ff);
    const svc = makeService(prisma, pilot, ff);
    try {
      const r: any = await withRequestContext({ requestId: newRequestId() }, async () => {
        attach(tB, 'b'); return svc.findAll({ limit: 50 } as any, isoFilter);
      });
      const allB = (r.data as any[]).every((row) => row.tenantId === tB);
      out.push({ name: '4. tenant B sees only tenant B rows', ok: allB && r.data.length === 2, detail: `count=${r.data.length} allB=${allB}` });
    } finally { await prisma.$disconnect(); }
  });

  // 5 — entity filter under tenant A does not leak B
  await withFlags(PILOT, async () => {
    const prisma = new PrismaService(); const ff = new FeatureFlagsService();
    const pilot = new PilotPrismaAccessor(prisma, new TenantPrismaService(prisma, ff), ff);
    const svc = makeService(prisma, pilot, ff);
    try {
      const r: any = await withRequestContext({ requestId: newRequestId() }, async () => {
        attach(tA, 'a'); return svc.findAll({ limit: 50 } as any, isoFilter);
      });
      out.push({ name: '5. entity filter under tenant A does not leak tenant B rows', ok: (r.data as any[]).every((row) => row.tenantId === tA), detail: `count=${r.data.length}` });
    } finally { await prisma.$disconnect(); }
  });

  // 6 — entityId filter for tenant B entity under tenant A returns empty
  await withFlags(PILOT, async () => {
    const prisma = new PrismaService(); const ff = new FeatureFlagsService();
    const pilot = new PilotPrismaAccessor(prisma, new TenantPrismaService(prisma, ff), ff);
    const svc = makeService(prisma, pilot, ff);
    try {
      const r: any = await withRequestContext({ requestId: newRequestId() }, async () => {
        attach(tA, 'a'); return svc.findAll({} as any, { entity: 'Phase252Iso', entityId: '00000000-0000-0000-0000-000000000bb1' });
      });
      out.push({ name: '6. entityId filter for tenant B entity under tenant A returns empty', ok: r.data.length === 0 && r.meta.total === 0, detail: `count=${r.data.length}` });
    } finally { await prisma.$disconnect(); }
  });

  // 7 — count under tenant A
  await withFlags(PILOT, async () => {
    const prisma = new PrismaService(); const ff = new FeatureFlagsService();
    const pilot = new PilotPrismaAccessor(prisma, new TenantPrismaService(prisma, ff), ff);
    const svc = makeService(prisma, pilot, ff);
    try {
      const r: any = await withRequestContext({ requestId: newRequestId() }, async () => {
        attach(tA, 'a'); return svc.findAll({ limit: 1 } as any, isoFilter);
      });
      out.push({ name: '7. count under tenant A includes only tenant A rows', ok: r.meta.total === 3, detail: `total=${r.meta.total}` });
    } finally { await prisma.$disconnect(); }
  });

  // 8 — pagination cannot page into B rows
  await withFlags(PILOT, async () => {
    const prisma = new PrismaService(); const ff = new FeatureFlagsService();
    const pilot = new PilotPrismaAccessor(prisma, new TenantPrismaService(prisma, ff), ff);
    const svc = makeService(prisma, pilot, ff);
    try {
      const r1: any = await withRequestContext({ requestId: newRequestId() }, async () => {
        attach(tA, 'a'); return svc.findAll({ page: 1, limit: 2 } as any, isoFilter);
      });
      const r2: any = await withRequestContext({ requestId: newRequestId() }, async () => {
        attach(tA, 'a'); return svc.findAll({ page: 2, limit: 2 } as any, isoFilter);
      });
      const allA = (r1.data as any[]).every((x) => x.tenantId === tA) && (r2.data as any[]).every((x) => x.tenantId === tA);
      out.push({ name: '8. pagination under tenant A cannot page into tenant B rows', ok: allA && r1.data.length + r2.data.length === 3, detail: `p1=${r1.data.length} p2=${r2.data.length}` });
    } finally { await prisma.$disconnect(); }
  });

  // 9 — concurrent ALS frames isolated
  await withFlags(PILOT, async () => {
    const prisma = new PrismaService(); const ff = new FeatureFlagsService();
    const pilot = new PilotPrismaAccessor(prisma, new TenantPrismaService(prisma, ff), ff);
    const svc = makeService(prisma, pilot, ff);
    try {
      const [a, b]: any[] = await Promise.all([
        withRequestContext({ requestId: newRequestId() }, async () => { attach(tA, 'a'); return svc.findAll({ limit: 50 } as any, isoFilter); }),
        withRequestContext({ requestId: newRequestId() }, async () => { attach(tB, 'b'); return svc.findAll({ limit: 50 } as any, isoFilter); }),
      ]);
      const aOk = (a.data as any[]).every((r) => r.tenantId === tA);
      const bOk = (b.data as any[]).every((r) => r.tenantId === tB);
      out.push({ name: '9. concurrent ALS frames remain isolated', ok: aOk && bOk, detail: `A=${a.meta.total} B=${b.meta.total}` });
    } finally { await prisma.$disconnect(); }
  });

  // 10 — pilot opt-out returns legacy union
  await withFlags({ TENANT_PRISMA_PILOT_ENABLED: 'true', TENANT_PRISMA_PILOT_MODULES: 'nothing' }, async () => {
    const prisma = new PrismaService(); const ff = new FeatureFlagsService();
    const pilot = new PilotPrismaAccessor(prisma, new TenantPrismaService(prisma, ff), ff);
    const svc = makeService(prisma, pilot, ff);
    try {
      const r: any = await withRequestContext({ requestId: newRequestId() }, async () => {
        attach(tA, 'a'); return svc.findAll({ limit: 50 } as any, isoFilter);
      });
      const includesB = (r.data as any[]).some((row) => row.tenantId === tB);
      const includesNull = (r.data as any[]).some((row) => row.action === 'ISO_NULL');
      out.push({ name: '10. pilot opt-out (allow-list nothing) returns legacy union (incl. B + NULL)',
        ok: includesB && includesNull,
        detail: `count=${r.data.length} hasB=${includesB} hasNull=${includesNull}` });
    } finally { await prisma.$disconnect(); }
  });

  await fs.mkdir(OUT_DIR, { recursive: true });
  const passed = out.filter((c) => c.ok).length;
  const total = out.length;
  await fs.writeFile(path.join(OUT_DIR, 'audit-log-read-isolation.json'),
    JSON.stringify({ passed, total, cases: out }, null, 2));
  const md = [
    `# Phase 2.52 — audit-log read isolation`, ``,
    `**${passed}/${total} PASS**`, ``,
    ...out.map((c) => `- ${c.ok ? 'PASS' : 'FAIL'} — ${c.name} — ${c.detail}`), ``,
  ].join('\n');
  await fs.writeFile(path.join(OUT_DIR, 'audit-log-read-isolation.md'), md);
  console.log(`[audit-log-read-isolation] ${passed}/${total} PASS`);
  process.exit(passed === total ? 0 : 1);
}

main().catch((err) => { console.error(err); process.exit(2); });
