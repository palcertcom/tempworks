/**
 * Phase 2.35 — agencies reads-first equivalence harness.
 *
 *   1. pilot routing flag
 *   2. legacy findAll: union across tenants
 *   3. pilot findAll(A): total reduced from legacy union
 *   4. findOne(tenantA-id) under pilot A resolves
 *   5. findOne(missing) raises NotFound
 *   6. search filter narrowed by tenant predicate
 *   7. getUsers parent-gated returns array
 *   8. getEmployees parent-gated returns array
 *   9. getStats parent-gated returns counts object
 *  10. listPermissionOverrides parent-gated returns array
 *  11. listPublic stays globally visible (apply form contract)
 *  12. response shape preserved (PaginatedResponse keys)
 *
 * Output: backend/reports/saas/phase2/agencies-equivalence.{json,md}
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
import { TenantAuditLogService } from '../../../src/saas/audit/tenant-audit-log.service';
import { AgenciesService } from '../../../src/agencies/agencies.service';
import { StorageService } from '../../../src/common/storage/storage.service';
import { TenantContext, withRequestContext, newRequestId } from '../../../src/saas/context/als';

autoLoadEnv(__filename);

const OUT_DIR = path.resolve(__dirname, '..', '..', '..', 'reports', 'saas', 'phase2');
interface CaseResult { name: string; ok: boolean; detail: string; }

const TENANT_A_AGENCY = 'aaaaaaa1-aaaa-aaaa-aaaa-aaaaaaaaaaaa';

function getDatabaseUrl(): string {
  const arg = process.argv.find((a) => a.startsWith('--db='))?.slice(5);
  return arg ?? process.env.DATABASE_URL ?? (() => { throw new Error(formatDatabaseUrlMissingMessage()); })();
}

async function withFlags<T>(env: Record<string, string | undefined>, fn: () => Promise<T> | T): Promise<T> {
  const prev = { ...process.env };
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  try { return await fn(); } finally { process.env = prev; }
}

function makeService(prisma: PrismaService, pilot: PilotPrismaAccessor): AgenciesService {
  return new AgenciesService(prisma, new StorageService(), pilot, new TenantAuditLogService(prisma, new FeatureFlagsService()));
}

async function main(): Promise<void> {
  const url = getDatabaseUrl();
  const env = classifyRuntimeEnv();
  if (!isStagingClassification(env.classification)) {
    console.error(`[agencies-equivalence] refusing on classification=${env.classification}`);
    process.exit(3);
  }
  const c = new Client({ connectionString: url, ssl: /127\.0\.0\.1|localhost/.test(url) ? false : { rejectUnauthorized: false } });
  await c.connect();
  const ts = await c.query<{ id: string }>(
    `SELECT t.id FROM tenants t WHERE EXISTS (SELECT 1 FROM agencies a WHERE a."tenantId" = t.id::text) ORDER BY t.name`);
  const tA = ts.rows[0]?.id;
  await c.end();
  if (!tA) { console.error('need tenant A'); process.exit(3); }

  const out: CaseResult[] = [];

  // 1
  await withFlags({ TENANT_PRISMA_PILOT_ENABLED: 'true', TENANT_PRISMA_PILOT_MODULES: 'agencies' }, async () => {
    const prisma = new PrismaService();
    const ff = new FeatureFlagsService();
    const pilot = new PilotPrismaAccessor(prisma, new TenantPrismaService(prisma, ff), ff);
    out.push({ name: '1. pilot active when flag ON + module allowed', ok: pilot.isPilotActive(), detail: JSON.stringify(pilot.pilotReason()) });
    await prisma.$disconnect();
  });

  // 2 — legacy union
  let legacyTotal = 0;
  await withFlags({ TENANT_PRISMA_PILOT_ENABLED: 'false' }, async () => {
    const prisma = new PrismaService();
    const ff = new FeatureFlagsService();
    const pilot = new PilotPrismaAccessor(prisma, new TenantPrismaService(prisma, ff), ff);
    const svc = makeService(prisma, pilot);
    try {
      const r: any = await svc.findAll({} as any);
      legacyTotal = r.meta.total;
      out.push({ name: '2. legacy findAll: union across tenants', ok: legacyTotal >= 2, detail: `total=${legacyTotal}` });
    } finally { await prisma.$disconnect(); }
  });

  // 3 — pilot narrows
  let pilotTotal = 0;
  await withFlags({ TENANT_PRISMA_PILOT_ENABLED: 'true', TENANT_PRISMA_PILOT_MODULES: 'agencies' }, async () => {
    const prisma = new PrismaService();
    const ff = new FeatureFlagsService();
    const pilot = new PilotPrismaAccessor(prisma, new TenantPrismaService(prisma, ff), ff);
    const svc = makeService(prisma, pilot);
    try {
      const r: any = await withRequestContext({ requestId: newRequestId() }, async () => {
        TenantContext.attach({ id: tA, slug: 'a', name: 'A', status: 'ACTIVE', region: 'eu' });
        return svc.findAll({} as any);
      });
      pilotTotal = r.meta.total;
      out.push({ name: '3. pilot findAll(A): total reduced', ok: pilotTotal < legacyTotal && pilotTotal >= 1, detail: `legacy=${legacyTotal} pilot=${pilotTotal}` });
    } finally { await prisma.$disconnect(); }
  });

  // 4 — findOne(tenantA-id)
  await withFlags({ TENANT_PRISMA_PILOT_ENABLED: 'true', TENANT_PRISMA_PILOT_MODULES: 'agencies' }, async () => {
    const prisma = new PrismaService();
    const ff = new FeatureFlagsService();
    const pilot = new PilotPrismaAccessor(prisma, new TenantPrismaService(prisma, ff), ff);
    const svc = makeService(prisma, pilot);
    try {
      const r: any = await withRequestContext({ requestId: newRequestId() }, async () => {
        TenantContext.attach({ id: tA, slug: 'a', name: 'A', status: 'ACTIVE', region: 'eu' });
        return svc.findOne(TENANT_A_AGENCY);
      });
      out.push({ name: '4. findOne resolves tenant A id', ok: r?.id === TENANT_A_AGENCY, detail: `id=${r?.id?.slice(0,8)}` });
    } finally { await prisma.$disconnect(); }
  });

  // 5 — findOne(missing)
  await withFlags({ TENANT_PRISMA_PILOT_ENABLED: 'true', TENANT_PRISMA_PILOT_MODULES: 'agencies' }, async () => {
    const prisma = new PrismaService();
    const ff = new FeatureFlagsService();
    const pilot = new PilotPrismaAccessor(prisma, new TenantPrismaService(prisma, ff), ff);
    const svc = makeService(prisma, pilot);
    try {
      let threw = false;
      try {
        await withRequestContext({ requestId: newRequestId() }, async () => {
          TenantContext.attach({ id: tA, slug: 'a', name: 'A', status: 'ACTIVE', region: 'eu' });
          await svc.findOne('00000000-0000-0000-0000-00000000dead');
        });
      } catch { threw = true; }
      out.push({ name: '5. findOne(missing) raises NotFound', ok: threw, detail: threw ? 'NotFound' : 'UNEXPECTED' });
    } finally { await prisma.$disconnect(); }
  });

  // 6 — search narrowed
  await withFlags({ TENANT_PRISMA_PILOT_ENABLED: 'true', TENANT_PRISMA_PILOT_MODULES: 'agencies' }, async () => {
    const prisma = new PrismaService();
    const ff = new FeatureFlagsService();
    const pilot = new PilotPrismaAccessor(prisma, new TenantPrismaService(prisma, ff), ff);
    const svc = makeService(prisma, pilot);
    try {
      const r: any = await withRequestContext({ requestId: newRequestId() }, async () => {
        TenantContext.attach({ id: tA, slug: 'a', name: 'A', status: 'ACTIVE', region: 'eu' });
        return svc.findAll({ search: 'Agency B' } as any);
      });
      const allA = (r.data as any[]).every((a) => a.tenantId === tA || a.isSystem);
      out.push({ name: '6. search "Agency B" under A: no foreign-tenant rows', ok: allA, detail: `count=${r.meta.total}` });
    } finally { await prisma.$disconnect(); }
  });

  // 7 — getUsers
  await withFlags({ TENANT_PRISMA_PILOT_ENABLED: 'true', TENANT_PRISMA_PILOT_MODULES: 'agencies' }, async () => {
    const prisma = new PrismaService();
    const ff = new FeatureFlagsService();
    const pilot = new PilotPrismaAccessor(prisma, new TenantPrismaService(prisma, ff), ff);
    const svc = makeService(prisma, pilot);
    try {
      const r: any = await withRequestContext({ requestId: newRequestId() }, async () => {
        TenantContext.attach({ id: tA, slug: 'a', name: 'A', status: 'ACTIVE', region: 'eu' });
        return svc.getUsers(TENANT_A_AGENCY, {} as any);
      });
      out.push({ name: '7. getUsers parent-gated returns array', ok: Array.isArray(r.data), detail: `count=${r.meta.total}` });
    } finally { await prisma.$disconnect(); }
  });

  // 8 — getEmployees
  await withFlags({ TENANT_PRISMA_PILOT_ENABLED: 'true', TENANT_PRISMA_PILOT_MODULES: 'agencies' }, async () => {
    const prisma = new PrismaService();
    const ff = new FeatureFlagsService();
    const pilot = new PilotPrismaAccessor(prisma, new TenantPrismaService(prisma, ff), ff);
    const svc = makeService(prisma, pilot);
    try {
      const r: any = await withRequestContext({ requestId: newRequestId() }, async () => {
        TenantContext.attach({ id: tA, slug: 'a', name: 'A', status: 'ACTIVE', region: 'eu' });
        return svc.getEmployees(TENANT_A_AGENCY, {} as any);
      });
      out.push({ name: '8. getEmployees parent-gated returns array', ok: Array.isArray(r.data), detail: `count=${r.meta.total}` });
    } finally { await prisma.$disconnect(); }
  });

  // 9 — getStats
  await withFlags({ TENANT_PRISMA_PILOT_ENABLED: 'true', TENANT_PRISMA_PILOT_MODULES: 'agencies' }, async () => {
    const prisma = new PrismaService();
    const ff = new FeatureFlagsService();
    const pilot = new PilotPrismaAccessor(prisma, new TenantPrismaService(prisma, ff), ff);
    const svc = makeService(prisma, pilot);
    try {
      const r: any = await withRequestContext({ requestId: newRequestId() }, async () => {
        TenantContext.attach({ id: tA, slug: 'a', name: 'A', status: 'ACTIVE', region: 'eu' });
        return svc.getStats(TENANT_A_AGENCY);
      });
      const ok = ['users','employees','activeEmployees','pendingEmployees'].every((k) => k in r);
      out.push({ name: '9. getStats parent-gated returns counts', ok, detail: `users=${r.users} emp=${r.employees}` });
    } finally { await prisma.$disconnect(); }
  });

  // 10 — listPermissionOverrides
  await withFlags({ TENANT_PRISMA_PILOT_ENABLED: 'true', TENANT_PRISMA_PILOT_MODULES: 'agencies' }, async () => {
    const prisma = new PrismaService();
    const ff = new FeatureFlagsService();
    const pilot = new PilotPrismaAccessor(prisma, new TenantPrismaService(prisma, ff), ff);
    const svc = makeService(prisma, pilot);
    try {
      const r: any[] = await withRequestContext({ requestId: newRequestId() }, async () => {
        TenantContext.attach({ id: tA, slug: 'a', name: 'A', status: 'ACTIVE', region: 'eu' });
        return svc.listPermissionOverrides(TENANT_A_AGENCY);
      });
      out.push({ name: '10. listPermissionOverrides parent-gated returns array', ok: Array.isArray(r), detail: `count=${r.length}` });
    } finally { await prisma.$disconnect(); }
  });

  // 11 — listPublic stays global
  await withFlags({ TENANT_PRISMA_PILOT_ENABLED: 'true', TENANT_PRISMA_PILOT_MODULES: 'agencies' }, async () => {
    const prisma = new PrismaService();
    const ff = new FeatureFlagsService();
    const pilot = new PilotPrismaAccessor(prisma, new TenantPrismaService(prisma, ff), ff);
    const svc = makeService(prisma, pilot);
    try {
      // listPublic is auth-less; no ALS frame.
      const r: any[] = await svc.listPublic();
      out.push({ name: '11. listPublic stays globally visible (>= legacy total)', ok: r.length >= legacyTotal, detail: `count=${r.length}` });
    } finally { await prisma.$disconnect(); }
  });

  // 12 — response shape
  await withFlags({ TENANT_PRISMA_PILOT_ENABLED: 'false' }, async () => {
    const prisma = new PrismaService();
    const ff = new FeatureFlagsService();
    const pilot = new PilotPrismaAccessor(prisma, new TenantPrismaService(prisma, ff), ff);
    const svc = makeService(prisma, pilot);
    try {
      const r: any = await svc.findAll({} as any);
      const ok = 'data' in r && 'meta' in r && ['total','page','limit','totalPages'].every((k) => k in r.meta);
      out.push({ name: '12. response shape preserved', ok, detail: Object.keys(r).join(',') });
    } finally { await prisma.$disconnect(); }
  });

  await fs.mkdir(OUT_DIR, { recursive: true });
  const passed = out.filter((c) => c.ok).length;
  const total = out.length;
  await fs.writeFile(path.join(OUT_DIR, 'agencies-equivalence.json'),
    JSON.stringify({ passed, total, cases: out }, null, 2));
  const md = [
    `# Phase 2.35 — agencies equivalence`, ``,
    `**${passed}/${total} PASS**`, ``,
    ...out.map((c) => `- ${c.ok ? 'PASS' : 'FAIL'} — ${c.name} — ${c.detail}`), ``,
  ].join('\n');
  await fs.writeFile(path.join(OUT_DIR, 'agencies-equivalence.md'), md);
  console.log(`[agencies-equivalence] ${passed}/${total} PASS`);
  process.exit(passed === total ? 0 : 1);
}

main().catch((err) => { console.error(err); process.exit(2); });
