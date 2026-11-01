/**
 * Phase 2.36 — agencies mutation isolation harness.
 *
 *   1. tenant A: update(tenantB-id) raises NotFound; B unchanged
 *   2. tenant A: remove(tenantB-id) raises NotFound; B unchanged
 *   3. tenant A: uploadLogo(tenantB-id) rejected; NO storage call
 *   4. tenant A: setPermissionOverride(tenantB-id, ...) rejected
 *   5. tenant A: removePermissionOverride(tenantB-id, ...) rejected
 *   6. tenant A: setManager(tenantB-id, ...) rejected at parent gate
 *   7. legacy mode: cross-tenant update succeeds (today's behaviour)
 *   8. concurrent ALS frames isolated (different create attribution)
 *   9. source-level meta-assertion: phase236 patterns + audit routing
 *
 * Output: backend/reports/saas/phase2/agencies-mutation-isolation.{json,md}
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
import { TenantContext, withRequestContext, newRequestId } from '../../../src/saas/context/als';

autoLoadEnv(__filename);

const OUT_DIR = path.resolve(__dirname, '..', '..', '..', 'reports', 'saas', 'phase2');
const SRC_FILE = path.resolve(__dirname, '..', '..', '..', 'src', 'agencies', 'agencies.service.ts');
interface CaseResult { name: string; ok: boolean; detail: string; }

const TENANT_A_AGENCY = 'aaaaaaa1-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const TENANT_B_AGENCY = 'bbbbbbb2-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const SYS_USER = '00000000-0000-0000-0000-00000000us01';

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

interface StorageStubCall { keyPrefix: string; size: number; }
function makeStorageStub(): { storage: any; calls: StorageStubCall[] } {
  const calls: StorageStubCall[] = [];
  const storage: any = {
    onModuleInit: async () => undefined,
    uploadFile: async (buffer: Buffer, opts: any) => {
      calls.push({ keyPrefix: opts.keyPrefix, size: buffer.length });
      return { url: `https://stub/${opts.keyPrefix}/${calls.length}.png`, key: `${opts.keyPrefix}/${calls.length}.png` };
    },
    deleteFileByUrlOrKey: async () => undefined,
  };
  return { storage, calls };
}

function makeService(prisma: PrismaService, pilot: PilotPrismaAccessor, storage: any): AgenciesService {
  return new AgenciesService(prisma, storage, pilot, new TenantAuditLogService(prisma, new FeatureFlagsService()));
}

async function main(): Promise<void> {
  const url = getDatabaseUrl();
  const env = classifyRuntimeEnv();
  if (!isStagingClassification(env.classification)) {
    console.error(`[agencies-mutation-isolation] refusing on classification=${env.classification}`);
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
  const cleanup: { agencies: string[] } = { agencies: [] };
  const stamp = Date.now().toString(36);
  const tinyPng = Buffer.from('89504E470D0A1A0A', 'hex');

  // 1+2 — cross-tenant update / remove rejected
  await withFlags({ TENANT_PRISMA_PILOT_ENABLED: 'true', TENANT_PRISMA_PILOT_MODULES: 'agencies' }, async () => {
    const prisma = new PrismaService();
    const ff = new FeatureFlagsService();
    const pilot = new PilotPrismaAccessor(prisma, new TenantPrismaService(prisma, ff), ff);
    const svc = makeService(prisma, pilot, makeStorageStub().storage);
    try {
      const beforeB: any = await (prisma as any).agency.findUnique({ where: { id: TENANT_B_AGENCY } });
      const ctx = () => TenantContext.attach({ id: tA, slug: 'a', name: 'A', status: 'ACTIVE', region: 'eu' });
      let upL = false; try { await withRequestContext({ requestId: newRequestId() }, async () => { ctx(); await svc.update(TENANT_B_AGENCY, { phone: 'A-trying-B' } as any, SYS_USER); }); upL = true; } catch { upL = false; }
      let rmL = false; try { await withRequestContext({ requestId: newRequestId() }, async () => { ctx(); await svc.remove(TENANT_B_AGENCY, SYS_USER); }); rmL = true; } catch { rmL = false; }
      const afterB: any = await (prisma as any).agency.findUnique({ where: { id: TENANT_B_AGENCY } });
      out.push({ name: '1. update(tenantB-id) rejected; B.phone unchanged', ok: !upL && afterB.phone === beforeB.phone, detail: `phone=${afterB.phone}` });
      out.push({ name: '2. remove(tenantB-id) rejected; B.deletedAt unchanged', ok: !rmL && (afterB.deletedAt ?? null) === (beforeB.deletedAt ?? null), detail: `deletedAt=${afterB.deletedAt ? 'set' : 'null'}` });
    } finally { await prisma.$disconnect(); }
  });

  // 3 — uploadLogo cross-tenant; NO storage write
  await withFlags({ TENANT_PRISMA_PILOT_ENABLED: 'true', TENANT_PRISMA_PILOT_MODULES: 'agencies' }, async () => {
    const prisma = new PrismaService();
    const ff = new FeatureFlagsService();
    const pilot = new PilotPrismaAccessor(prisma, new TenantPrismaService(prisma, ff), ff);
    const { storage, calls } = makeStorageStub();
    const svc = makeService(prisma, pilot, storage);
    try {
      let threw = false;
      try {
        await withRequestContext({ requestId: newRequestId() }, async () => {
          TenantContext.attach({ id: tA, slug: 'a', name: 'A', status: 'ACTIVE', region: 'eu' });
          await svc.uploadLogo(TENANT_B_AGENCY, { buffer: tinyPng, mimetype: 'image/png', originalname: 'b.png' } as any, SYS_USER);
        });
      } catch { threw = true; }
      out.push({ name: '3. uploadLogo cross-tenant rejected; NO storage call', ok: threw && calls.length === 0, detail: `threw=${threw} uploads=${calls.length}` });
    } finally { await prisma.$disconnect(); }
  });

  // 4+5 — permission overrides cross-tenant
  await withFlags({ TENANT_PRISMA_PILOT_ENABLED: 'true', TENANT_PRISMA_PILOT_MODULES: 'agencies' }, async () => {
    const prisma = new PrismaService();
    const ff = new FeatureFlagsService();
    const pilot = new PilotPrismaAccessor(prisma, new TenantPrismaService(prisma, ff), ff);
    const svc = makeService(prisma, pilot, makeStorageStub().storage);
    try {
      const ctx = () => TenantContext.attach({ id: tA, slug: 'a', name: 'A', status: 'ACTIVE', region: 'eu' });
      let s = false; try { await withRequestContext({ requestId: newRequestId() }, async () => { ctx(); await svc.setPermissionOverride(TENANT_B_AGENCY, 'view:test', true, SYS_USER); }); s = true; } catch { s = false; }
      let r = false; try { await withRequestContext({ requestId: newRequestId() }, async () => { ctx(); await svc.removePermissionOverride(TENANT_B_AGENCY, 'view:test', SYS_USER); }); r = true; } catch { r = false; }
      // Verify no override row exists for tenant B with our test permission (cleanup-defensive)
      const exists = await (prisma as any).agencyPermissionOverride.findFirst({ where: { agencyId: TENANT_B_AGENCY, permission: 'view:test' } });
      out.push({ name: '4. setPermissionOverride(tenantB-id) rejected; no override row', ok: !s && !exists, detail: `threw=${!s} row=${!!exists}` });
      out.push({ name: '5. removePermissionOverride(tenantB-id) rejected', ok: !r, detail: r ? 'UNEXPECTED' : 'NotFound' });
    } finally { await prisma.$disconnect(); }
  });

  // 6 — setManager cross-tenant rejected
  await withFlags({ TENANT_PRISMA_PILOT_ENABLED: 'true', TENANT_PRISMA_PILOT_MODULES: 'agencies' }, async () => {
    const prisma = new PrismaService();
    const ff = new FeatureFlagsService();
    const pilot = new PilotPrismaAccessor(prisma, new TenantPrismaService(prisma, ff), ff);
    const svc = makeService(prisma, pilot, makeStorageStub().storage);
    try {
      const beforeB: any = await (prisma as any).agency.findUnique({ where: { id: TENANT_B_AGENCY } });
      let m = false;
      try {
        await withRequestContext({ requestId: newRequestId() }, async () => {
          TenantContext.attach({ id: tA, slug: 'a', name: 'A', status: 'ACTIVE', region: 'eu' });
          await svc.setManager(TENANT_B_AGENCY, SYS_USER, SYS_USER);
        });
        m = true;
      } catch { m = false; }
      const afterB: any = await (prisma as any).agency.findUnique({ where: { id: TENANT_B_AGENCY } });
      out.push({ name: '6. setManager(tenantB-id) rejected; B.managerId unchanged', ok: !m && (afterB.managerId ?? null) === (beforeB.managerId ?? null), detail: `threw=${!m}` });
    } finally { await prisma.$disconnect(); }
  });

  // 7 — legacy: cross-tenant update succeeds (today's behaviour)
  await withFlags({ TENANT_PRISMA_PILOT_ENABLED: 'false' }, async () => {
    const prisma = new PrismaService();
    const ff = new FeatureFlagsService();
    const pilot = new PilotPrismaAccessor(prisma, new TenantPrismaService(prisma, ff), ff);
    const svc = makeService(prisma, pilot, makeStorageStub().storage);
    try {
      const before: any = await (prisma as any).agency.findUnique({ where: { id: TENANT_B_AGENCY } });
      const r: any = await svc.update(TENANT_B_AGENCY, { phone: '+legacy-' + stamp } as any, SYS_USER);
      await (prisma as any).agency.update({ where: { id: TENANT_B_AGENCY }, data: { phone: before.phone } }); // restore
      out.push({ name: '7. legacy: cross-tenant update succeeds (preserved)', ok: r.phone === '+legacy-' + stamp, detail: `phone=${r.phone}` });
    } finally { await prisma.$disconnect(); }
  });

  // 8 — concurrent ALS create attribution
  await withFlags({ TENANT_PRISMA_PILOT_ENABLED: 'true', TENANT_PRISMA_PILOT_MODULES: 'agencies' }, async () => {
    const prisma = new PrismaService();
    const ff = new FeatureFlagsService();
    const pilot = new PilotPrismaAccessor(prisma, new TenantPrismaService(prisma, ff), ff);
    const svc = makeService(prisma, pilot, makeStorageStub().storage);
    try {
      const [a, b] = await Promise.all([
        withRequestContext({ requestId: newRequestId() }, async () => {
          TenantContext.attach({ id: tA, slug: 'a', name: 'A', status: 'ACTIVE', region: 'eu' });
          return svc.create({ name: `Conc-A-${stamp}`, country: 'IE', contactPerson: 'A', email: `a-${stamp}@x.test`, phone: '+1', status: 'ACTIVE' } as any, SYS_USER, 'System Admin');
        }),
        withRequestContext({ requestId: newRequestId() }, async () => {
          TenantContext.attach({ id: tB, slug: 'b', name: 'B', status: 'ACTIVE', region: 'eu' });
          return svc.create({ name: `Conc-B-${stamp}`, country: 'IE', contactPerson: 'B', email: `b-${stamp}@x.test`, phone: '+1', status: 'ACTIVE' } as any, SYS_USER, 'System Admin');
        }),
      ]);
      cleanup.agencies.push((a as any).id, (b as any).id);
      out.push({ name: '8. concurrent ALS create A→A, B→B', ok: (a as any).tenantId === tA && (b as any).tenantId === tB, detail: `a=${(a as any).tenantId} b=${(b as any).tenantId}` });
    } finally { await prisma.$disconnect(); }
  });

  // 9 — source-level meta-assertion
  const src = await fs.readFile(SRC_FILE, 'utf8');
  const ok = /phase236-pilot-scope/.test(src) && /phase236-storage-guard/.test(src) && /phase236-permission-gate/.test(src) && /phase236-manager-gate/.test(src) && /phase236-audit-log-pilot/.test(src) && /tenantAuditLog\.write\(/.test(src);
  out.push({ name: '9. source-level: phase236 tags + tenantAuditLog routing present', ok, detail: ok ? 'OK' : 'missing pattern' });

  // cleanup
  const prisma = new PrismaService();
  try {
    if (cleanup.agencies.length) {
      await (prisma as any).auditLog.deleteMany({ where: { entity: 'Agency', entityId: { in: cleanup.agencies } } }).catch(() => undefined);
      await (prisma as any).agency.deleteMany({ where: { id: { in: cleanup.agencies } } }).catch(() => undefined);
    }
  } finally { await prisma.$disconnect(); }

  await fs.mkdir(OUT_DIR, { recursive: true });
  const passed = out.filter((c) => c.ok).length;
  const total = out.length;
  await fs.writeFile(path.join(OUT_DIR, 'agencies-mutation-isolation.json'),
    JSON.stringify({ passed, total, cases: out }, null, 2));
  const md = [
    `# Phase 2.36 — agencies mutation isolation`, ``,
    `**${passed}/${total} PASS**`, ``,
    ...out.map((c) => `- ${c.ok ? 'PASS' : 'FAIL'} — ${c.name} — ${c.detail}`), ``,
  ].join('\n');
  await fs.writeFile(path.join(OUT_DIR, 'agencies-mutation-isolation.md'), md);
  console.log(`[agencies-mutation-isolation] ${passed}/${total} PASS`);
  process.exit(passed === total ? 0 : 1);
}

main().catch((err) => { console.error(err); process.exit(2); });
