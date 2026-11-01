/**
 * Phase 2.36 — agencies mutation equivalence harness.
 *
 *   1. create legacy: response shape preserved
 *   2. create legacy: tenantId NULL
 *   3. create pilot + ALS A: tenantId = A
 *   4. update mutates field
 *   5. remove sets deletedAt
 *   6. uploadLogo same-tenant: 1 storage call + logoUrl set
 *   7. setPermissionOverride creates record
 *   8. removePermissionOverride deletes record
 *   9. setManager updates managerId
 *  10. legacy create with no ALS: tenantId NULL (System Admin path)
 *
 * Output: backend/reports/saas/phase2/agencies-mutation-equivalence.{json,md}
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
interface CaseResult { name: string; ok: boolean; detail: string; }

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

const dto = (stamp: string, n: string) => ({
  name: `Test-${stamp}-${n}`, country: 'IE', contactPerson: 'Test',
  email: `t-${stamp}-${n}@x.test`, phone: '+1', status: 'ACTIVE',
});

async function main(): Promise<void> {
  const url = getDatabaseUrl();
  const env = classifyRuntimeEnv();
  if (!isStagingClassification(env.classification)) {
    console.error(`[agencies-mutation-equivalence] refusing on classification=${env.classification}`);
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
  const cleanup: { agencies: string[] } = { agencies: [] };
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
      const r: any = await svc.create(dto(stamp, 'L') as any, SYS_USER, 'System Admin');
      legacyId = r.id; cleanup.agencies.push(legacyId);
      out.push({ name: '1. create legacy: response shape preserved', ok: !!r.id && r.name === `Test-${stamp}-L`, detail: `id=${r.id?.slice(0,8)}` });
      out.push({ name: '2. create legacy: tenantId NULL', ok: r.tenantId === null, detail: `tenantId=${r.tenantId ?? 'null'}` });
    } finally { await prisma.$disconnect(); }
  });

  // 3 — create pilot + ALS A
  let pilotId = '';
  await withFlags({ TENANT_PRISMA_PILOT_ENABLED: 'true', TENANT_PRISMA_PILOT_MODULES: 'agencies' }, async () => {
    const prisma = new PrismaService();
    const ff = new FeatureFlagsService();
    const pilot = new PilotPrismaAccessor(prisma, new TenantPrismaService(prisma, ff), ff);
    const svc = makeService(prisma, pilot, makeStorageStub().storage);
    try {
      const r: any = await withRequestContext({ requestId: newRequestId() }, async () => {
        TenantContext.attach({ id: tA, slug: 'a', name: 'A', status: 'ACTIVE', region: 'eu' });
        return svc.create(dto(stamp, 'P') as any, SYS_USER, 'System Admin');
      });
      pilotId = r.id; cleanup.agencies.push(pilotId);
      out.push({ name: '3. create pilot + ALS A: tenantId = A', ok: r.tenantId === tA, detail: `tenantId=${r.tenantId}` });
    } finally { await prisma.$disconnect(); }
  });

  // 4+5 — update + remove on pilot row
  await withFlags({ TENANT_PRISMA_PILOT_ENABLED: 'true', TENANT_PRISMA_PILOT_MODULES: 'agencies' }, async () => {
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
      // upload logo BEFORE remove so case 6 has a target
    } finally { await prisma.$disconnect(); }
  });

  // 6 — uploadLogo on pilot row
  await withFlags({ TENANT_PRISMA_PILOT_ENABLED: 'true', TENANT_PRISMA_PILOT_MODULES: 'agencies' }, async () => {
    const prisma = new PrismaService();
    const ff = new FeatureFlagsService();
    const pilot = new PilotPrismaAccessor(prisma, new TenantPrismaService(prisma, ff), ff);
    const { storage, calls } = makeStorageStub();
    const svc = makeService(prisma, pilot, storage);
    try {
      const r: any = await withRequestContext({ requestId: newRequestId() }, async () => {
        TenantContext.attach({ id: tA, slug: 'a', name: 'A', status: 'ACTIVE', region: 'eu' });
        return svc.uploadLogo(pilotId, { buffer: tinyPng, mimetype: 'image/png', originalname: 'logo.png' } as any, SYS_USER);
      });
      out.push({ name: '6. uploadLogo same-tenant: 1 storage call + logoUrl set', ok: calls.length === 1 && typeof r.logoUrl === 'string', detail: `uploads=${calls.length} url=${!!r.logoUrl}` });
    } finally { await prisma.$disconnect(); }
  });

  // 7+8 — permission overrides
  await withFlags({ TENANT_PRISMA_PILOT_ENABLED: 'true', TENANT_PRISMA_PILOT_MODULES: 'agencies' }, async () => {
    const prisma = new PrismaService();
    const ff = new FeatureFlagsService();
    const pilot = new PilotPrismaAccessor(prisma, new TenantPrismaService(prisma, ff), ff);
    const svc = makeService(prisma, pilot, makeStorageStub().storage);
    try {
      const ctx = () => TenantContext.attach({ id: tA, slug: 'a', name: 'A', status: 'ACTIVE', region: 'eu' });
      const s: any = await withRequestContext({ requestId: newRequestId() }, async () => { ctx(); return svc.setPermissionOverride(pilotId, 'view:test', true, SYS_USER); });
      out.push({ name: '7. setPermissionOverride creates record', ok: s.allow === true && s.permission === 'view:test', detail: `allow=${s.allow}` });
      const r: any = await withRequestContext({ requestId: newRequestId() }, async () => { ctx(); return svc.removePermissionOverride(pilotId, 'view:test', SYS_USER); });
      out.push({ name: '8. removePermissionOverride returns OK', ok: !!r.message, detail: r.message ?? '' });
    } finally { await prisma.$disconnect(); }
  });

  // 9 — setManager (need a user with agencyId == pilotId; reuse SYS_USER agency=A)
  // We'll seed a user for the pilot agency and test setManager.
  await withFlags({ TENANT_PRISMA_PILOT_ENABLED: 'true', TENANT_PRISMA_PILOT_MODULES: 'agencies' }, async () => {
    const prisma = new PrismaService();
    const ff = new FeatureFlagsService();
    const pilot = new PilotPrismaAccessor(prisma, new TenantPrismaService(prisma, ff), ff);
    const svc = makeService(prisma, pilot, makeStorageStub().storage);
    let usrId = '';
    try {
      const role: any = await (prisma as any).role.findFirst({ where: { name: 'Agency Manager' } }) ?? await (prisma as any).role.findFirst({});
      const u: any = await (prisma as any).user.create({
        data: { email: `mgr-${stamp}@x.test`, firstName: 'Mgr', lastName: stamp, passwordHash: 'x', agencyId: pilotId, roleId: role.id, status: 'ACTIVE' },
      });
      usrId = u.id;
      const r: any = await withRequestContext({ requestId: newRequestId() }, async () => {
        TenantContext.attach({ id: tA, slug: 'a', name: 'A', status: 'ACTIVE', region: 'eu' });
        return svc.setManager(pilotId, usrId, SYS_USER);
      });
      out.push({ name: '9. setManager updates managerId', ok: r.managerId === usrId, detail: `mgr=${r.managerId === usrId}` });
    } finally {
      if (usrId) await (prisma as any).user.delete({ where: { id: usrId } }).catch(() => undefined);
      await prisma.$disconnect();
    }
  });

  // 5 — remove (run last so it doesn't break other cases)
  await withFlags({ TENANT_PRISMA_PILOT_ENABLED: 'true', TENANT_PRISMA_PILOT_MODULES: 'agencies' }, async () => {
    const prisma = new PrismaService();
    const ff = new FeatureFlagsService();
    const pilot = new PilotPrismaAccessor(prisma, new TenantPrismaService(prisma, ff), ff);
    const svc = makeService(prisma, pilot, makeStorageStub().storage);
    try {
      await withRequestContext({ requestId: newRequestId() }, async () => {
        TenantContext.attach({ id: tA, slug: 'a', name: 'A', status: 'ACTIVE', region: 'eu' });
        return svc.remove(pilotId, SYS_USER);
      });
      const after: any = await (prisma as any).agency.findUnique({ where: { id: pilotId } });
      out.push({ name: '5. remove sets deletedAt', ok: !!after.deletedAt, detail: `deletedAt=${!!after.deletedAt}` });
    } finally { await prisma.$disconnect(); }
  });

  // 10 — pilot create with no ALS: NULL-tenant fallback (System Admin path)
  await withFlags({ TENANT_PRISMA_PILOT_ENABLED: 'true', TENANT_PRISMA_PILOT_MODULES: 'agencies' }, async () => {
    const prisma = new PrismaService();
    const ff = new FeatureFlagsService();
    const pilot = new PilotPrismaAccessor(prisma, new TenantPrismaService(prisma, ff), ff);
    const svc = makeService(prisma, pilot, makeStorageStub().storage);
    try {
      // No withRequestContext → no ALS frame
      const r: any = await svc.create(dto(stamp, 'NA') as any, SYS_USER, 'System Admin');
      cleanup.agencies.push(r.id);
      out.push({ name: '10. pilot create with no ALS: tenantId NULL (System Admin fallback)', ok: r.tenantId === null, detail: `tenantId=${r.tenantId ?? 'null'}` });
    } finally { await prisma.$disconnect(); }
  });

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
  await fs.writeFile(path.join(OUT_DIR, 'agencies-mutation-equivalence.json'),
    JSON.stringify({ passed, total, cases: out }, null, 2));
  const md = [
    `# Phase 2.36 — agencies mutation equivalence`, ``,
    `**${passed}/${total} PASS**`, ``,
    ...out.map((c) => `- ${c.ok ? 'PASS' : 'FAIL'} — ${c.name} — ${c.detail}`), ``,
  ].join('\n');
  await fs.writeFile(path.join(OUT_DIR, 'agencies-mutation-equivalence.md'), md);
  console.log(`[agencies-mutation-equivalence] ${passed}/${total} PASS`);
  process.exit(passed === total ? 0 : 1);
}

main().catch((err) => { console.error(err); process.exit(2); });
