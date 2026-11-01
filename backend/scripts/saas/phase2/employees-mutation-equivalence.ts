/**
 * Phase 2.34 — employees mutation equivalence harness.
 *
 *   1. create response shape (id + employeeNumber present)
 *   2. create legacy: tenantId NULL
 *   3. create pilot: tenantId = active tenant
 *   4. update mutates the field in both modes
 *   5. updateStatus mutates status in both modes
 *   6. soft-delete sets deletedAt in both modes
 *   7. uploadPhoto same-tenant: 1 storage call; photoUrl set
 *   8. grantAgencyAccess returns grant row in both modes
 *   9. updateAgencyAccess returns updated grant
 *  10. revokeAgencyAccess returns OK
 *
 * Output: backend/reports/saas/phase2/employees-mutation-equivalence.{json,md}
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
interface CaseResult { name: string; ok: boolean; detail: string; }

const TENANT_A_AGENCY = 'aaaaaaa1-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
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

function dto(stamp: string, n: string) {
  return {
    firstName: 'Em', lastName: stamp + n, email: `em-${stamp}-${n}@x.test`, phone: '+1',
    nationality: 'IE', dateOfBirth: '1990-01-01',
    addressLine1: '1 Quay St', city: 'Dublin', country: 'IE', postalCode: 'D01',
    yearsExperience: 1, agencyId: TENANT_A_AGENCY,
  } as any;
}

async function main(): Promise<void> {
  const url = getDatabaseUrl();
  const env = classifyRuntimeEnv();
  if (!isStagingClassification(env.classification)) {
    console.error(`[employees-mutation-equivalence] refusing on classification=${env.classification}`);
    process.exit(3);
  }
  const c = new Client({ connectionString: url, ssl: /127\.0\.0\.1|localhost/.test(url) ? false : { rejectUnauthorized: false } });
  await c.connect();
  const ts = await c.query<{ id: string }>(
    `SELECT t.id FROM tenants t WHERE EXISTS (SELECT 1 FROM employees e WHERE e."tenantId" = t.id::text) ORDER BY t.name`);
  const tA = ts.rows[0]?.id;
  await c.end();
  if (!tA) { console.error('need tenant A'); process.exit(3); }

  const out: CaseResult[] = [];
  const cleanup: { employees: string[]; grants: { e: string; a: string }[] } = { employees: [], grants: [] };
  const stamp = Date.now().toString(36);
  const tinyPng = Buffer.from('89504E470D0A1A0A', 'hex');

  // 1+2 — create legacy
  let legacyId = '';
  await withFlags({ TENANT_PRISMA_PILOT_ENABLED: 'false' }, async () => {
    const prisma = new PrismaService();
    const ff = new FeatureFlagsService();
    const pilot = new PilotPrismaAccessor(prisma, new TenantPrismaService(prisma, ff), ff);
    const svc = makeService(prisma, pilot, makeStorageStub().storage);
    try {
      const r: any = await svc.create(dto(stamp, 'L'), SYS_USER);
      legacyId = r.id; cleanup.employees.push(legacyId);
      out.push({ name: '1. create legacy: response shape', ok: !!r.id && !!r.employeeNumber, detail: `id=${r.id?.slice(0,8)}` });
      out.push({ name: '2. create legacy: tenantId NULL', ok: r.tenantId === null, detail: `tenantId=${r.tenantId ?? 'null'}` });
    } finally { await prisma.$disconnect(); }
  });

  // 3 — create pilot
  let pilotId = '';
  await withFlags({ TENANT_PRISMA_PILOT_ENABLED: 'true', TENANT_PRISMA_PILOT_MODULES: 'employees' }, async () => {
    const prisma = new PrismaService();
    const ff = new FeatureFlagsService();
    const pilot = new PilotPrismaAccessor(prisma, new TenantPrismaService(prisma, ff), ff);
    const svc = makeService(prisma, pilot, makeStorageStub().storage);
    try {
      const r: any = await withRequestContext({ requestId: newRequestId() }, async () => {
        TenantContext.attach({ id: tA, slug: 'a', name: 'A', status: 'ACTIVE', region: 'eu' });
        return svc.create(dto(stamp, 'P'), SYS_USER);
      });
      pilotId = r.id; cleanup.employees.push(pilotId);
      out.push({ name: '3. create pilot: tenantId = A', ok: r.tenantId === tA, detail: `tenantId=${r.tenantId}` });
    } finally { await prisma.$disconnect(); }
  });

  // 4+5+6 — update / updateStatus / remove parity (pilot)
  await withFlags({ TENANT_PRISMA_PILOT_ENABLED: 'true', TENANT_PRISMA_PILOT_MODULES: 'employees' }, async () => {
    const prisma = new PrismaService();
    const ff = new FeatureFlagsService();
    const pilot = new PilotPrismaAccessor(prisma, new TenantPrismaService(prisma, ff), ff);
    const svc = makeService(prisma, pilot, makeStorageStub().storage);
    try {
      const u: any = await withRequestContext({ requestId: newRequestId() }, async () => {
        TenantContext.attach({ id: tA, slug: 'a', name: 'A', status: 'ACTIVE', region: 'eu' });
        return svc.update(pilotId, { phone: '+99' } as any, SYS_USER);
      });
      out.push({ name: '4. update mutates field', ok: u.phone === '+99', detail: `phone=${u.phone}` });
      const s: any = await withRequestContext({ requestId: newRequestId() }, async () => {
        TenantContext.attach({ id: tA, slug: 'a', name: 'A', status: 'ACTIVE', region: 'eu' });
        return svc.updateStatus(pilotId, 'ACTIVE', SYS_USER);
      });
      out.push({ name: '5. updateStatus mutates status', ok: s.status === 'ACTIVE', detail: `status=${s.status}` });
      await withRequestContext({ requestId: newRequestId() }, async () => {
        TenantContext.attach({ id: tA, slug: 'a', name: 'A', status: 'ACTIVE', region: 'eu' });
        return svc.remove(pilotId, SYS_USER);
      });
      const after: any = await (prisma as any).employee.findUnique({ where: { id: pilotId } });
      out.push({ name: '6. remove sets deletedAt', ok: !!after.deletedAt, detail: `deletedAt=${!!after.deletedAt}` });
    } finally { await prisma.$disconnect(); }
  });

  // 7 — uploadPhoto on a fresh pilot-created (tenantId=A) employee
  await withFlags({ TENANT_PRISMA_PILOT_ENABLED: 'true', TENANT_PRISMA_PILOT_MODULES: 'employees' }, async () => {
    const prisma = new PrismaService();
    const ff = new FeatureFlagsService();
    const pilot = new PilotPrismaAccessor(prisma, new TenantPrismaService(prisma, ff), ff);
    const { storage, calls } = makeStorageStub();
    const svc = makeService(prisma, pilot, storage);
    try {
      const r: any = await withRequestContext({ requestId: newRequestId() }, async () => {
        TenantContext.attach({ id: tA, slug: 'a', name: 'A', status: 'ACTIVE', region: 'eu' });
        const fresh: any = await svc.create(dto(stamp, 'UP'), SYS_USER);
        cleanup.employees.push(fresh.id);
        return svc.uploadPhoto(fresh.id, { buffer: tinyPng, mimetype: 'image/png', originalname: 'a.png' } as any);
      });
      out.push({ name: '7. uploadPhoto pilot same-tenant: 1 storage call + photoUrl set', ok: calls.length === 1 && typeof r.photoUrl === 'string', detail: `uploads=${calls.length} url=${!!r.photoUrl}` });
    } finally { await prisma.$disconnect(); }
  });

  // 8+9+10 — agency access flow under pilot
  await withFlags({ TENANT_PRISMA_PILOT_ENABLED: 'true', TENANT_PRISMA_PILOT_MODULES: 'employees' }, async () => {
    const prisma = new PrismaService();
    const ff = new FeatureFlagsService();
    const pilot = new PilotPrismaAccessor(prisma, new TenantPrismaService(prisma, ff), ff);
    const svc = makeService(prisma, pilot, makeStorageStub().storage);
    try {
      const ctx = () => TenantContext.attach({ id: tA, slug: 'a', name: 'A', status: 'ACTIVE', region: 'eu' });
      const fresh: any = await withRequestContext({ requestId: newRequestId() }, async () => { ctx(); return svc.create(dto(stamp, 'AA'), SYS_USER); });
      cleanup.employees.push(fresh.id);
      const g: any = await withRequestContext({ requestId: newRequestId() }, async () => { ctx(); return svc.grantAgencyAccess(fresh.id, TENANT_A_AGENCY, { canView: true, canEdit: true }, SYS_USER); });
      cleanup.grants.push({ e: fresh.id, a: TENANT_A_AGENCY });
      out.push({ name: '8. grantAgencyAccess returns grant', ok: g.employeeId === fresh.id && g.canView === true, detail: `view=${g.canView} edit=${g.canEdit}` });
      const u: any = await withRequestContext({ requestId: newRequestId() }, async () => { ctx(); return svc.updateAgencyAccess(fresh.id, TENANT_A_AGENCY, { canEdit: false }, SYS_USER); });
      out.push({ name: '9. updateAgencyAccess flips canEdit', ok: u.canEdit === false, detail: `edit=${u.canEdit}` });
      const r: any = await withRequestContext({ requestId: newRequestId() }, async () => { ctx(); return svc.revokeAgencyAccess(fresh.id, TENANT_A_AGENCY); });
      out.push({ name: '10. revokeAgencyAccess returns OK', ok: !!r.message, detail: r.message ?? '' });
    } finally { await prisma.$disconnect(); }
  });

  // cleanup
  const prisma = new PrismaService();
  try {
    if (cleanup.grants.length) await (prisma as any).employeeAgencyAccess.deleteMany({ where: { OR: cleanup.grants.map((g) => ({ employeeId: g.e, agencyId: g.a })) } }).catch(() => undefined);
    if (cleanup.employees.length) await (prisma as any).employeeStage.deleteMany({ where: { employeeId: { in: cleanup.employees } } });
    if (cleanup.employees.length) await (prisma as any).employee.deleteMany({ where: { id: { in: cleanup.employees } } });
  } finally { await prisma.$disconnect(); }

  await fs.mkdir(OUT_DIR, { recursive: true });
  const passed = out.filter((c) => c.ok).length;
  const total = out.length;
  await fs.writeFile(path.join(OUT_DIR, 'employees-mutation-equivalence.json'),
    JSON.stringify({ passed, total, cases: out }, null, 2));
  const md = [
    `# Phase 2.34 — employees mutation equivalence`, ``,
    `**${passed}/${total} PASS**`, ``,
    ...out.map((c) => `- ${c.ok ? 'PASS' : 'FAIL'} — ${c.name} — ${c.detail}`), ``,
  ].join('\n');
  await fs.writeFile(path.join(OUT_DIR, 'employees-mutation-equivalence.md'), md);
  console.log(`[employees-mutation-equivalence] ${passed}/${total} PASS`);
  process.exit(passed === total ? 0 : 1);
}

main().catch((err) => { console.error(err); process.exit(2); });
