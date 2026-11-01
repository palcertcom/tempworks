/**
 * Phase 2.35 — agencies isolation harness.
 *
 *   1. findAll under tenant A returns A only (system agencies allowed)
 *   2. findOne(tenantB-id) under tenant A raises NotFound
 *   3. search "Agency B" under A doesn't leak B
 *   4. getUsers(tenantB-id) blocked at parent gate
 *   5. getEmployees(tenantB-id) blocked at parent gate
 *   6. getStats(tenantB-id) blocked at parent gate
 *   7. listPermissionOverrides(tenantB-id) blocked at parent gate
 *   8. system agency seeded in tenant A run is visible under both A and B
 *   9. concurrent ALS frames isolated (A, B)
 *  10. legacy mode returns union (today's behaviour)
 *  11. source-level: phase235 patterns + mutation/storage routing through legacyPrisma
 *
 * Output: backend/reports/saas/phase2/agencies-isolation.{json,md}
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
const SRC_FILE = path.resolve(__dirname, '..', '..', '..', 'src', 'agencies', 'agencies.service.ts');
interface CaseResult { name: string; ok: boolean; detail: string; }

const TENANT_A_AGENCY = 'aaaaaaa1-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const TENANT_B_AGENCY = 'bbbbbbb2-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

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
    console.error(`[agencies-isolation] refusing on classification=${env.classification}`);
    process.exit(3);
  }
  const c = new Client({ connectionString: url, ssl: /127\.0\.0\.1|localhost/.test(url) ? false : { rejectUnauthorized: false } });
  await c.connect();
  const ts = await c.query<{ id: string }>(
    `SELECT t.id FROM tenants t WHERE EXISTS (SELECT 1 FROM agencies a WHERE a."tenantId" = t.id::text) ORDER BY t.name`);
  const tA = ts.rows[0]?.id; const tB = ts.rows[1]?.id;
  await c.end();
  if (!tA || !tB) { console.error('need two tenants'); process.exit(3); }

  const out: CaseResult[] = [];

  // Seed a system agency for case 8
  let sysAgencyId = '';
  {
    const prisma = new PrismaService();
    try {
      const sys: any = await (prisma as any).agency.create({
        data: {
          name: `SystemFixture-${Date.now()}`, country: 'IE', contactPerson: 'Sys',
          email: 'sys@x.test', phone: '+1', isSystem: true, status: 'ACTIVE',
        },
      });
      sysAgencyId = sys.id;
    } finally { await prisma.$disconnect(); }
  }

  // 1
  await withFlags({ TENANT_PRISMA_PILOT_ENABLED: 'true', TENANT_PRISMA_PILOT_MODULES: 'agencies' }, async () => {
    const prisma = new PrismaService();
    const ff = new FeatureFlagsService();
    const pilot = new PilotPrismaAccessor(prisma, new TenantPrismaService(prisma, ff), ff);
    const svc = makeService(prisma, pilot);
    try {
      const r: any = await withRequestContext({ requestId: newRequestId() }, async () => {
        TenantContext.attach({ id: tA, slug: 'a', name: 'A', status: 'ACTIVE', region: 'eu' });
        return svc.findAll({ limit: 100 } as any);
      });
      const noB = !(r.data as any[]).some((a) => a.tenantId === tB && !a.isSystem);
      out.push({ name: '1. findAll under tenant A: no tenant B rows (system agencies allowed)', ok: noB, detail: `count=${r.meta.total}` });
    } finally { await prisma.$disconnect(); }
  });

  // 2
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
          await svc.findOne(TENANT_B_AGENCY);
        });
      } catch { threw = true; }
      out.push({ name: '2. findOne(tenantB-id) cross-tenant 404', ok: threw, detail: threw ? 'NotFound' : 'UNEXPECTED' });
    } finally { await prisma.$disconnect(); }
  });

  // 3
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
      const noB = !(r.data as any[]).some((a) => a.tenantId === tB && !a.isSystem);
      out.push({ name: '3. search "Agency B" under A does not leak B', ok: noB, detail: `count=${r.meta.total}` });
    } finally { await prisma.$disconnect(); }
  });

  // 4-7 — child reads gated by parent
  await withFlags({ TENANT_PRISMA_PILOT_ENABLED: 'true', TENANT_PRISMA_PILOT_MODULES: 'agencies' }, async () => {
    const prisma = new PrismaService();
    const ff = new FeatureFlagsService();
    const pilot = new PilotPrismaAccessor(prisma, new TenantPrismaService(prisma, ff), ff);
    const svc = makeService(prisma, pilot);
    try {
      const ctx = () => TenantContext.attach({ id: tA, slug: 'a', name: 'A', status: 'ACTIVE', region: 'eu' });
      let u = false; try { await withRequestContext({ requestId: newRequestId() }, async () => { ctx(); await svc.getUsers(TENANT_B_AGENCY, {} as any); }); } catch { u = true; }
      let e = false; try { await withRequestContext({ requestId: newRequestId() }, async () => { ctx(); await svc.getEmployees(TENANT_B_AGENCY, {} as any); }); } catch { e = true; }
      let s = false; try { await withRequestContext({ requestId: newRequestId() }, async () => { ctx(); await svc.getStats(TENANT_B_AGENCY); }); } catch { s = true; }
      let p = false; try { await withRequestContext({ requestId: newRequestId() }, async () => { ctx(); await svc.listPermissionOverrides(TENANT_B_AGENCY); }); } catch { p = true; }
      out.push({ name: '4. getUsers(tenantB-id) blocked at parent gate', ok: u, detail: u ? 'NotFound' : 'LEAK' });
      out.push({ name: '5. getEmployees(tenantB-id) blocked at parent gate', ok: e, detail: e ? 'NotFound' : 'LEAK' });
      out.push({ name: '6. getStats(tenantB-id) blocked at parent gate', ok: s, detail: s ? 'NotFound' : 'LEAK' });
      out.push({ name: '7. listPermissionOverrides(tenantB-id) blocked at parent gate', ok: p, detail: p ? 'NotFound' : 'LEAK' });
    } finally { await prisma.$disconnect(); }
  });

  // 8 — system agency visible under both A and B
  await withFlags({ TENANT_PRISMA_PILOT_ENABLED: 'true', TENANT_PRISMA_PILOT_MODULES: 'agencies' }, async () => {
    const prisma = new PrismaService();
    const ff = new FeatureFlagsService();
    const pilot = new PilotPrismaAccessor(prisma, new TenantPrismaService(prisma, ff), ff);
    const svc = makeService(prisma, pilot);
    try {
      const seenA = await withRequestContext({ requestId: newRequestId() }, async () => {
        TenantContext.attach({ id: tA, slug: 'a', name: 'A', status: 'ACTIVE', region: 'eu' });
        const r: any = await svc.findAll({ limit: 100 } as any);
        return (r.data as any[]).some((a) => a.id === sysAgencyId);
      });
      const seenB = await withRequestContext({ requestId: newRequestId() }, async () => {
        TenantContext.attach({ id: tB, slug: 'b', name: 'B', status: 'ACTIVE', region: 'eu' });
        const r: any = await svc.findAll({ limit: 100 } as any);
        return (r.data as any[]).some((a) => a.id === sysAgencyId);
      });
      out.push({ name: '8. system agency visible under both A and B (decision §6)', ok: seenA && seenB, detail: `seenA=${seenA} seenB=${seenB}` });
    } finally { await prisma.$disconnect(); }
  });

  // 9 — concurrent ALS frames
  await withFlags({ TENANT_PRISMA_PILOT_ENABLED: 'true', TENANT_PRISMA_PILOT_MODULES: 'agencies' }, async () => {
    const prisma = new PrismaService();
    const ff = new FeatureFlagsService();
    const pilot = new PilotPrismaAccessor(prisma, new TenantPrismaService(prisma, ff), ff);
    const svc = makeService(prisma, pilot);
    try {
      const [a, b] = await Promise.all([
        withRequestContext({ requestId: newRequestId() }, async () => {
          TenantContext.attach({ id: tA, slug: 'a', name: 'A', status: 'ACTIVE', region: 'eu' });
          return svc.findAll({ limit: 100 } as any);
        }),
        withRequestContext({ requestId: newRequestId() }, async () => {
          TenantContext.attach({ id: tB, slug: 'b', name: 'B', status: 'ACTIVE', region: 'eu' });
          return svc.findAll({ limit: 100 } as any);
        }),
      ]);
      const aNoB = !((a as any).data as any[]).some((x) => x.tenantId === tB && !x.isSystem);
      const bNoA = !((b as any).data as any[]).some((x) => x.tenantId === tA && !x.isSystem);
      out.push({ name: '9. concurrent ALS frames isolated', ok: aNoB && bNoA, detail: `aNoB=${aNoB} bNoA=${bNoA}` });
    } finally { await prisma.$disconnect(); }
  });

  // 10 — legacy mode union
  await withFlags({ TENANT_PRISMA_PILOT_ENABLED: 'false' }, async () => {
    const prisma = new PrismaService();
    const ff = new FeatureFlagsService();
    const pilot = new PilotPrismaAccessor(prisma, new TenantPrismaService(prisma, ff), ff);
    const svc = makeService(prisma, pilot);
    try {
      const r: any = await svc.findAll({ limit: 100 } as any);
      const tenants = new Set((r.data as any[]).map((a) => a.tenantId));
      out.push({ name: '10. legacy: returns union across tenants', ok: tenants.size >= 2, detail: `tenants=${tenants.size} total=${r.meta.total}` });
    } finally { await prisma.$disconnect(); }
  });

  // 11 — source-level meta-assertion
  const src = await fs.readFile(SRC_FILE, 'utf8');
  const hasReadTag = /phase235-pilot-scope/.test(src);
  // Phase 2.36 retagged the excluded-mutation/storage sites to phase236-* gates.
  const hasMutTag = /phase235-excluded-mutation/.test(src) || /phase236-pilot-scope-precheck/.test(src);
  const hasStorageTag = /phase235-excluded-storage/.test(src) || /phase236-storage-guard/.test(src);
  const hasGlobalTag = /phase235-global/.test(src);
  const createOnLegacy = /async create\([^)]*\)[\s\S]*?legacyPrisma\.agency\.create/.test(src);
  const updateOnLegacy = /async update\([^)]*\)[\s\S]*?legacyPrisma\.agency\.update/.test(src);
  const ok = hasReadTag && hasMutTag && hasStorageTag && hasGlobalTag && createOnLegacy && updateOnLegacy;
  out.push({ name: '11. source-level: phase235 tags + mutation/storage on legacyPrisma', ok, detail: `read=${hasReadTag} mut=${hasMutTag} storage=${hasStorageTag} global=${hasGlobalTag} create=${createOnLegacy} update=${updateOnLegacy}` });

  // cleanup
  if (sysAgencyId) {
    const prisma = new PrismaService();
    try { await (prisma as any).agency.delete({ where: { id: sysAgencyId } }).catch(() => undefined); } finally { await prisma.$disconnect(); }
  }

  await fs.mkdir(OUT_DIR, { recursive: true });
  const passed = out.filter((c) => c.ok).length;
  const total = out.length;
  await fs.writeFile(path.join(OUT_DIR, 'agencies-isolation.json'),
    JSON.stringify({ passed, total, cases: out }, null, 2));
  const md = [
    `# Phase 2.35 — agencies isolation`, ``,
    `**${passed}/${total} PASS**`, ``,
    ...out.map((c) => `- ${c.ok ? 'PASS' : 'FAIL'} — ${c.name} — ${c.detail}`), ``,
  ].join('\n');
  await fs.writeFile(path.join(OUT_DIR, 'agencies-isolation.md'), md);
  console.log(`[agencies-isolation] ${passed}/${total} PASS`);
  process.exit(passed === total ? 0 : 1);
}

main().catch((err) => { console.error(err); process.exit(2); });
