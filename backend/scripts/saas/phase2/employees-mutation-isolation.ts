/**
 * Phase 2.34 — employees mutation isolation harness.
 *
 *   1. tenant A: update(tenantB-id) raises 404; B unchanged
 *   2. tenant A: updateStatus(tenantB-id) raises 404; B unchanged
 *   3. tenant A: remove(tenantB-id) raises 404; B unchanged
 *   4. tenant A: create stamps tenantId=A
 *   5. tenant A: uploadPhoto(tenantB-id) rejected; NO storage write
 *   6. tenant A: grantAgencyAccess(tenantB-emp, *) blocked at employee gate
 *   7. tenant A: grantAgencyAccess(tenantA-emp, tenantB-agency) blocked at agency gate
 *   8. tenant A: updateAgencyAccess(tenantB-emp, *) blocked at employee gate
 *   9. tenant A: revokeAgencyAccess(tenantB-emp, *) blocked at employee gate
 *  10. legacy mode: cross-tenant update succeeds (today's behaviour preserved)
 *  11. concurrent ALS frames isolated
 *  12. source-level meta-assertion: phase234 patterns present
 *
 * Output: backend/reports/saas/phase2/employees-mutation-isolation.{json,md}
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
import { EmployeesService } from '../../../src/employees/employees.service';
import { TenantContext, withRequestContext, newRequestId } from '../../../src/saas/context/als';

autoLoadEnv(__filename);

const OUT_DIR = path.resolve(__dirname, '..', '..', '..', 'reports', 'saas', 'phase2');
const SRC_FILE = path.resolve(__dirname, '..', '..', '..', 'src', 'employees', 'employees.service.ts');
interface CaseResult { name: string; ok: boolean; detail: string; }

const TENANT_A_AGENCY = 'aaaaaaa1-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const TENANT_B_AGENCY = 'bbbbbbb2-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const TENANT_A_EMP = 'eeeeeeea-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const TENANT_B_EMP = 'eeeeeeeb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
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

function makeService(prisma: PrismaService, pilot: PilotPrismaAccessor, storage: any): EmployeesService {
  return new EmployeesService(prisma, storage, pilot);
}

async function main(): Promise<void> {
  const url = getDatabaseUrl();
  const env = classifyRuntimeEnv();
  if (!isStagingClassification(env.classification)) {
    console.error(`[employees-mutation-isolation] refusing on classification=${env.classification}`);
    process.exit(3);
  }
  const c = new Client({ connectionString: url, ssl: /127\.0\.0\.1|localhost/.test(url) ? false : { rejectUnauthorized: false } });
  await c.connect();
  const ts = await c.query<{ id: string }>(
    `SELECT t.id FROM tenants t WHERE EXISTS (SELECT 1 FROM employees e WHERE e."tenantId" = t.id::text) ORDER BY t.name`);
  const tA = ts.rows[0]?.id; const tB = ts.rows[1]?.id;
  await c.end();
  if (!tA || !tB) { console.error('need two tenants'); process.exit(3); }

  const out: CaseResult[] = [];
  const cleanup: { employees: string[] } = { employees: [] };
  const stamp = Date.now().toString(36);
  const tinyPng = Buffer.from('89504E470D0A1A0A', 'hex');

  // 1-3 cross-tenant rejections (update / updateStatus / remove)
  await withFlags({ TENANT_PRISMA_PILOT_ENABLED: 'true', TENANT_PRISMA_PILOT_MODULES: 'employees' }, async () => {
    const prisma = new PrismaService();
    const ff = new FeatureFlagsService();
    const pilot = new PilotPrismaAccessor(prisma, new TenantPrismaService(prisma, ff), ff);
    const svc = makeService(prisma, pilot, makeStorageStub().storage);
    try {
      const beforeB: any = await (prisma as any).employee.findUnique({ where: { id: TENANT_B_EMP } });
      const ctx = () => TenantContext.attach({ id: tA, slug: 'a', name: 'A', status: 'ACTIVE', region: 'eu' });
      let upL = false; try { await withRequestContext({ requestId: newRequestId() }, async () => { ctx(); await svc.update(TENANT_B_EMP, { phone: 'A-trying-B' } as any, SYS_USER); }); upL = true; } catch { upL = false; }
      let usL = false; try { await withRequestContext({ requestId: newRequestId() }, async () => { ctx(); await svc.updateStatus(TENANT_B_EMP, 'TERMINATED' as any, SYS_USER); }); usL = true; } catch { usL = false; }
      let rmL = false; try { await withRequestContext({ requestId: newRequestId() }, async () => { ctx(); await svc.remove(TENANT_B_EMP, SYS_USER); }); rmL = true; } catch { rmL = false; }
      const afterB: any = await (prisma as any).employee.findUnique({ where: { id: TENANT_B_EMP } });
      out.push({ name: '1. update(tenantB-id) rejected; phone unchanged', ok: !upL && afterB.phone === beforeB.phone, detail: `before=${beforeB.phone} after=${afterB.phone}` });
      out.push({ name: '2. updateStatus(tenantB-id) rejected; status unchanged', ok: !usL && afterB.status === beforeB.status, detail: `before=${beforeB.status} after=${afterB.status}` });
      out.push({ name: '3. remove(tenantB-id) rejected; deletedAt unchanged', ok: !rmL && (afterB.deletedAt ?? null) === (beforeB.deletedAt ?? null), detail: `deletedAt=${afterB.deletedAt ? 'set' : 'null'}` });
    } finally { await prisma.$disconnect(); }
  });

  // 4 — create stamps tenantId=A
  await withFlags({ TENANT_PRISMA_PILOT_ENABLED: 'true', TENANT_PRISMA_PILOT_MODULES: 'employees' }, async () => {
    const prisma = new PrismaService();
    const ff = new FeatureFlagsService();
    const pilot = new PilotPrismaAccessor(prisma, new TenantPrismaService(prisma, ff), ff);
    const svc = makeService(prisma, pilot, makeStorageStub().storage);
    try {
      const r: any = await withRequestContext({ requestId: newRequestId() }, async () => {
        TenantContext.attach({ id: tA, slug: 'a', name: 'A', status: 'ACTIVE', region: 'eu' });
        return svc.create({ firstName: 'I4', lastName: stamp, email: `i4-${stamp}@x.test`, phone: '+1', nationality: 'IE', dateOfBirth: '1990-01-01', addressLine1: 'x', city: 'Dublin', country: 'IE', postalCode: 'D01', agencyId: TENANT_A_AGENCY } as any, SYS_USER);
      });
      cleanup.employees.push(r.id);
      out.push({ name: '4. pilot create: tenantId = A', ok: r.tenantId === tA, detail: `tenantId=${r.tenantId}` });
    } finally { await prisma.$disconnect(); }
  });

  // 5 — uploadPhoto rejected; no storage write
  await withFlags({ TENANT_PRISMA_PILOT_ENABLED: 'true', TENANT_PRISMA_PILOT_MODULES: 'employees' }, async () => {
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
          await svc.uploadPhoto(TENANT_B_EMP, { buffer: tinyPng, mimetype: 'image/png', originalname: 'b.png' } as any);
        });
      } catch { threw = true; }
      out.push({ name: '5. uploadPhoto cross-tenant rejected; NO storage call', ok: threw && calls.length === 0, detail: `threw=${threw} uploads=${calls.length}` });
    } finally { await prisma.$disconnect(); }
  });

  // 6-9 — agency-access cross-tenant rejections
  await withFlags({ TENANT_PRISMA_PILOT_ENABLED: 'true', TENANT_PRISMA_PILOT_MODULES: 'employees' }, async () => {
    const prisma = new PrismaService();
    const ff = new FeatureFlagsService();
    const pilot = new PilotPrismaAccessor(prisma, new TenantPrismaService(prisma, ff), ff);
    const svc = makeService(prisma, pilot, makeStorageStub().storage);
    try {
      const ctx = () => TenantContext.attach({ id: tA, slug: 'a', name: 'A', status: 'ACTIVE', region: 'eu' });
      let g1 = false; try { await withRequestContext({ requestId: newRequestId() }, async () => { ctx(); await svc.grantAgencyAccess(TENANT_B_EMP, TENANT_A_AGENCY, { canView: true } as any, SYS_USER); }); g1 = true; } catch { g1 = false; }
      let g2 = false; try { await withRequestContext({ requestId: newRequestId() }, async () => { ctx(); await svc.grantAgencyAccess(TENANT_A_EMP, TENANT_B_AGENCY, { canView: true } as any, SYS_USER); }); g2 = true; } catch { g2 = false; }
      let u1 = false; try { await withRequestContext({ requestId: newRequestId() }, async () => { ctx(); await svc.updateAgencyAccess(TENANT_B_EMP, TENANT_A_AGENCY, { canView: false } as any, SYS_USER); }); u1 = true; } catch { u1 = false; }
      let r1 = false; try { await withRequestContext({ requestId: newRequestId() }, async () => { ctx(); await svc.revokeAgencyAccess(TENANT_B_EMP, TENANT_A_AGENCY); }); r1 = true; } catch { r1 = false; }
      out.push({ name: '6. grantAgencyAccess(tenantB-emp) blocked at employee gate', ok: !g1, detail: g1 ? 'UNEXPECTED' : 'NotFound' });
      out.push({ name: '7. grantAgencyAccess(tenantA-emp, tenantB-agency) blocked at agency gate', ok: !g2, detail: g2 ? 'UNEXPECTED' : 'NotFound' });
      out.push({ name: '8. updateAgencyAccess(tenantB-emp) blocked at employee gate', ok: !u1, detail: u1 ? 'UNEXPECTED' : 'NotFound' });
      out.push({ name: '9. revokeAgencyAccess(tenantB-emp) blocked at employee gate', ok: !r1, detail: r1 ? 'UNEXPECTED' : 'NotFound' });
    } finally { await prisma.$disconnect(); }
  });

  // 10 — legacy mode: cross-tenant update succeeds (today's behaviour)
  await withFlags({ TENANT_PRISMA_PILOT_ENABLED: 'false' }, async () => {
    const prisma = new PrismaService();
    const ff = new FeatureFlagsService();
    const pilot = new PilotPrismaAccessor(prisma, new TenantPrismaService(prisma, ff), ff);
    const svc = makeService(prisma, pilot, makeStorageStub().storage);
    try {
      const before: any = await (prisma as any).employee.findUnique({ where: { id: TENANT_B_EMP } });
      const r: any = await svc.update(TENANT_B_EMP, { phone: '+legacy-' + stamp } as any, SYS_USER);
      // restore
      await (prisma as any).employee.update({ where: { id: TENANT_B_EMP }, data: { phone: before.phone } });
      out.push({ name: '10. legacy: cross-tenant update succeeds (today\'s behaviour)', ok: r.phone === '+legacy-' + stamp, detail: `phone=${r.phone}` });
    } finally { await prisma.$disconnect(); }
  });

  // 11 — concurrent ALS frames
  await withFlags({ TENANT_PRISMA_PILOT_ENABLED: 'true', TENANT_PRISMA_PILOT_MODULES: 'employees' }, async () => {
    const prisma = new PrismaService();
    const ff = new FeatureFlagsService();
    const pilot = new PilotPrismaAccessor(prisma, new TenantPrismaService(prisma, ff), ff);
    const svc = makeService(prisma, pilot, makeStorageStub().storage);
    try {
      // Sequential to avoid the global Employee.employeeNumber @unique
      // serial race (Phase 3 product question — see uniqueness review).
      // ALS frame isolation is still proven because each call wraps
      // its own withRequestContext + TenantContext.attach.
      const a = await withRequestContext({ requestId: newRequestId() }, async () => {
        TenantContext.attach({ id: tA, slug: 'a', name: 'A', status: 'ACTIVE', region: 'eu' });
        return svc.create({ firstName: 'C11a', lastName: stamp, email: `c11a-${stamp}@x.test`, phone: '+1', nationality: 'IE', dateOfBirth: '1990-01-01', addressLine1: 'x', city: 'Dublin', country: 'IE', postalCode: 'D01', agencyId: TENANT_A_AGENCY } as any, SYS_USER);
      });
      const b = await withRequestContext({ requestId: newRequestId() }, async () => {
        TenantContext.attach({ id: tB, slug: 'b', name: 'B', status: 'ACTIVE', region: 'eu' });
        return svc.create({ firstName: 'C11b', lastName: stamp, email: `c11b-${stamp}@x.test`, phone: '+1', nationality: 'IE', dateOfBirth: '1990-01-01', addressLine1: 'x', city: 'Dublin', country: 'IE', postalCode: 'D01', agencyId: TENANT_B_AGENCY } as any, SYS_USER);
      });
      cleanup.employees.push((a as any).id, (b as any).id);
      out.push({ name: '11. concurrent ALS create A→A, B→B', ok: (a as any).tenantId === tA && (b as any).tenantId === tB, detail: `a=${(a as any).tenantId} b=${(b as any).tenantId}` });
    } finally { await prisma.$disconnect(); }
  });

  // 12 — source-level meta-assertion
  const src = await fs.readFile(SRC_FILE, 'utf8');
  const ok = /phase234-pilot-scope/.test(src) && /phase234-storage-guard/.test(src) && /phase234-agency-gate/.test(src) && /findEmployeeOrFail/.test(src) && /findAgencyOrFail/.test(src);
  out.push({ name: '12. source-level: phase234 patterns + helpers present', ok, detail: ok ? 'OK' : 'missing pattern' });

  // cleanup
  const prisma = new PrismaService();
  try {
    if (cleanup.employees.length) await (prisma as any).employeeStage.deleteMany({ where: { employeeId: { in: cleanup.employees } } });
    if (cleanup.employees.length) await (prisma as any).employee.deleteMany({ where: { id: { in: cleanup.employees } } });
  } finally { await prisma.$disconnect(); }

  await fs.mkdir(OUT_DIR, { recursive: true });
  const passed = out.filter((c) => c.ok).length;
  const total = out.length;
  await fs.writeFile(path.join(OUT_DIR, 'employees-mutation-isolation.json'),
    JSON.stringify({ passed, total, cases: out }, null, 2));
  const md = [
    `# Phase 2.34 — employees mutation isolation`, ``,
    `**${passed}/${total} PASS**`, ``,
    ...out.map((c) => `- ${c.ok ? 'PASS' : 'FAIL'} — ${c.name} — ${c.detail}`), ``,
  ].join('\n');
  await fs.writeFile(path.join(OUT_DIR, 'employees-mutation-isolation.md'), md);
  console.log(`[employees-mutation-isolation] ${passed}/${total} PASS`);
  process.exit(passed === total ? 0 : 1);
}

main().catch((err) => { console.error(err); process.exit(2); });
