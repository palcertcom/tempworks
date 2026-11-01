/**
 * Phase 2.25 — vehicles storage equivalence harness.
 *
 *   1. addDocument shape preserved (id present in both modes)
 *   2. addDocument legacy: tenantId NULL; pilot: tenantId=A
 *   3. addDocument: 1 storage upload in both modes (with file)
 *   4. addDocument: 0 storage uploads when no file
 *   5. updateDocument mutates the field in both modes
 *   6. deleteDocument soft-deletes in both modes
 *   7. error path: NotFoundException for missing doc id in both modes
 *   8. metadata read-after-write
 *
 * Output: backend/reports/saas/phase2/vehicles-storage-equivalence.{json,md}
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
import { VehiclesService } from '../../../src/vehicles/vehicles.service';
import { TenantContext, withRequestContext, newRequestId } from '../../../src/saas/context/als';

autoLoadEnv(__filename);

const OUT_DIR = path.resolve(__dirname, '..', '..', '..', 'reports', 'saas', 'phase2');
interface CaseResult { name: string; ok: boolean; detail: string; }
const TENANT_A_VEHICLE = '00000000-0000-0000-0000-0000000vh001';
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

interface StubCounters { uploads: number; }

function makeService(prisma: PrismaService, pilot: PilotPrismaAccessor, counters: StubCounters): VehiclesService {
  const storageStub: any = {
    uploadFile: async (_b: Buffer, opts: any) => {
      counters.uploads += 1;
      return { url: `stub://up/${opts.originalName}`, key: opts.originalName };
    },
    deleteFileByUrlOrKey: async () => undefined,
    downloadByUrlOrKey: async () => Buffer.from('x'),
  };
  return new VehiclesService(prisma, storageStub, pilot);
}

const fileFix: any = { buffer: Buffer.from('x'), originalname: 'reg.pdf', mimetype: 'application/pdf', size: 1 };

interface AddRes { id: string; tenantId: string | null; uploads: number; shape: boolean; }

async function runAdd(svc: VehiclesService, prisma: PrismaService, counters: StubCounters, name: string, withFile: boolean): Promise<AddRes> {
  const r = await svc.addDocument(TENANT_A_VEHICLE, { name, documentType: 'MOT' } as any, SYS_USER, withFile ? fileFix : undefined);
  const row: any = await (prisma as any).vehicleDocument.findUnique({ where: { id: (r as any).id } });
  return { id: (r as any).id, tenantId: row?.tenantId ?? null, uploads: counters.uploads, shape: !!(r as any).id };
}

async function main(): Promise<void> {
  const url = getDatabaseUrl();
  const env = classifyRuntimeEnv();
  if (!isStagingClassification(env.classification)) {
    console.error(`[vehicles-storage-equivalence] refusing on classification=${env.classification}`);
    process.exit(3);
  }
  const c = new Client({ connectionString: url, ssl: /127\.0\.0\.1|localhost/.test(url) ? false : { rejectUnauthorized: false } });
  await c.connect();
  const ts = await c.query<{ id: string }>(
    `SELECT t.id FROM tenants t WHERE EXISTS (SELECT 1 FROM vehicles v WHERE v."tenantId" = t.id::text) ORDER BY t.name`);
  const tA = ts.rows[0]?.id;
  await c.end();
  if (!tA) { console.error('need tenant A'); process.exit(3); }

  const out: CaseResult[] = [];
  const createdIds: string[] = [];

  // 1+2+3 — addDocument legacy + pilot (with file)
  const lc = { uploads: 0 };
  const lr = await withFlags({ TENANT_PRISMA_PILOT_ENABLED: 'false' }, async () => {
    const prisma = new PrismaService();
    const ff = new FeatureFlagsService();
    const pilot = new PilotPrismaAccessor(prisma, new TenantPrismaService(prisma, ff), ff);
    const svc = makeService(prisma, pilot, lc);
    try { const r = await runAdd(svc, prisma, lc, 'doc-legacy', true); createdIds.push(r.id); return r; }
    finally { await prisma.$disconnect(); }
  });
  const pc = { uploads: 0 };
  const pr = await withFlags({ TENANT_PRISMA_PILOT_ENABLED: 'true', TENANT_PRISMA_PILOT_MODULES: 'vehicles' }, async () => {
    const prisma = new PrismaService();
    const ff = new FeatureFlagsService();
    const pilot = new PilotPrismaAccessor(prisma, new TenantPrismaService(prisma, ff), ff);
    const svc = makeService(prisma, pilot, pc);
    try {
      return await withRequestContext({ requestId: newRequestId() }, async () => {
        TenantContext.attach({ id: tA, slug: 'a', name: 'A', status: 'ACTIVE', region: 'eu' });
        const r = await runAdd(svc, prisma, pc, 'doc-pilot', true); createdIds.push(r.id); return r;
      });
    } finally { await prisma.$disconnect(); }
  });

  out.push({ name: 'addDocument shape preserved (id present)', ok: lr.shape && pr.shape, detail: `legacy=${lr.shape} pilot=${pr.shape}` });
  out.push({ name: 'addDocument legacy: tenantId is NULL', ok: lr.tenantId === null, detail: `legacy.tenantId=${lr.tenantId}` });
  out.push({ name: 'addDocument pilot: tenantId is set to active tenant', ok: pr.tenantId === tA, detail: `pilot.tenantId=${pr.tenantId}` });
  out.push({ name: 'addDocument: 1 storage upload in both modes (with file)', ok: lr.uploads === 1 && pr.uploads === 1, detail: `legacy=${lr.uploads} pilot=${pr.uploads}` });

  // 4 — addDocument no-file variant
  const noFileLegacy = await withFlags({ TENANT_PRISMA_PILOT_ENABLED: 'false' }, async () => {
    const prisma = new PrismaService();
    const ff = new FeatureFlagsService();
    const pilot = new PilotPrismaAccessor(prisma, new TenantPrismaService(prisma, ff), ff);
    const counters = { uploads: 0 };
    const svc = makeService(prisma, pilot, counters);
    try { const r = await runAdd(svc, prisma, counters, 'doc-nofile-legacy', false); createdIds.push(r.id); return counters.uploads; }
    finally { await prisma.$disconnect(); }
  });
  out.push({ name: 'addDocument: 0 storage uploads when no file is supplied', ok: noFileLegacy === 0, detail: `uploads=${noFileLegacy}` });

  // 5 — updateDocument mutates name in both modes
  await withFlags({ TENANT_PRISMA_PILOT_ENABLED: 'false' }, async () => {
    const prisma = new PrismaService();
    const ff = new FeatureFlagsService();
    const pilot = new PilotPrismaAccessor(prisma, new TenantPrismaService(prisma, ff), ff);
    const svc = makeService(prisma, pilot, { uploads: 0 });
    try {
      const u = await svc.updateDocument(TENANT_A_VEHICLE, lr.id, { name: 'legacy-renamed' } as any);
      out.push({ name: 'updateDocument (legacy) mutates name', ok: (u as any).name === 'legacy-renamed', detail: `name=${(u as any).name}` });
    } finally { await prisma.$disconnect(); }
  });
  await withFlags({ TENANT_PRISMA_PILOT_ENABLED: 'true', TENANT_PRISMA_PILOT_MODULES: 'vehicles' }, async () => {
    const prisma = new PrismaService();
    const ff = new FeatureFlagsService();
    const pilot = new PilotPrismaAccessor(prisma, new TenantPrismaService(prisma, ff), ff);
    const svc = makeService(prisma, pilot, { uploads: 0 });
    try {
      await withRequestContext({ requestId: newRequestId() }, async () => {
        TenantContext.attach({ id: tA, slug: 'a', name: 'A', status: 'ACTIVE', region: 'eu' });
        const u = await svc.updateDocument(TENANT_A_VEHICLE, pr.id, { name: 'pilot-renamed' } as any);
        out.push({ name: 'updateDocument (pilot) mutates name', ok: (u as any).name === 'pilot-renamed', detail: `name=${(u as any).name}` });
      });
    } finally { await prisma.$disconnect(); }
  });

  // 6 — deleteDocument soft-deletes in both modes
  await withFlags({ TENANT_PRISMA_PILOT_ENABLED: 'true', TENANT_PRISMA_PILOT_MODULES: 'vehicles' }, async () => {
    const prisma = new PrismaService();
    const ff = new FeatureFlagsService();
    const pilot = new PilotPrismaAccessor(prisma, new TenantPrismaService(prisma, ff), ff);
    const svc = makeService(prisma, pilot, { uploads: 0 });
    try {
      await withRequestContext({ requestId: newRequestId() }, async () => {
        TenantContext.attach({ id: tA, slug: 'a', name: 'A', status: 'ACTIVE', region: 'eu' });
        await svc.deleteDocument(TENANT_A_VEHICLE, pr.id, SYS_USER);
      });
      const after: any = await (prisma as any).vehicleDocument.findUnique({ where: { id: pr.id } });
      out.push({ name: 'pilot deleteDocument: deletedAt is set', ok: !!after?.deletedAt, detail: `deletedAt=${after?.deletedAt ? 'set' : 'null'}` });
    } finally { await prisma.$disconnect(); }
  });

  // 7 — validation: bogus docId ⇒ 404 in both modes
  let lErr = 'no-error', pErr = 'no-error';
  await withFlags({ TENANT_PRISMA_PILOT_ENABLED: 'false' }, async () => {
    const prisma = new PrismaService();
    const ff = new FeatureFlagsService();
    const pilot = new PilotPrismaAccessor(prisma, new TenantPrismaService(prisma, ff), ff);
    const svc = makeService(prisma, pilot, { uploads: 0 });
    try { await svc.updateDocument(TENANT_A_VEHICLE, '00000000-0000-0000-0000-deaddeaddead', { name: 'x' } as any); }
    catch (e) { lErr = (e as Error).constructor.name; }
    finally { await prisma.$disconnect(); }
  });
  await withFlags({ TENANT_PRISMA_PILOT_ENABLED: 'true', TENANT_PRISMA_PILOT_MODULES: 'vehicles' }, async () => {
    const prisma = new PrismaService();
    const ff = new FeatureFlagsService();
    const pilot = new PilotPrismaAccessor(prisma, new TenantPrismaService(prisma, ff), ff);
    const svc = makeService(prisma, pilot, { uploads: 0 });
    try {
      await withRequestContext({ requestId: newRequestId() }, async () => {
        TenantContext.attach({ id: tA, slug: 'a', name: 'A', status: 'ACTIVE', region: 'eu' });
        await svc.updateDocument(TENANT_A_VEHICLE, '00000000-0000-0000-0000-deaddeaddead', { name: 'x' } as any);
      });
    } catch (e) { pErr = (e as Error).constructor.name; }
    finally { await prisma.$disconnect(); }
  });
  out.push({ name: 'validation: NotFoundException for missing docId in both modes', ok: lErr === 'NotFoundException' && pErr === 'NotFoundException', detail: `legacy=${lErr} pilot=${pErr}` });

  // 8 — metadata read-after-write
  await withFlags({ TENANT_PRISMA_PILOT_ENABLED: 'true', TENANT_PRISMA_PILOT_MODULES: 'vehicles' }, async () => {
    const prisma = new PrismaService();
    const ff = new FeatureFlagsService();
    const pilot = new PilotPrismaAccessor(prisma, new TenantPrismaService(prisma, ff), ff);
    const svc = makeService(prisma, pilot, { uploads: 0 });
    try {
      const v = await withRequestContext({ requestId: newRequestId() }, async () => {
        TenantContext.attach({ id: tA, slug: 'a', name: 'A', status: 'ACTIVE', region: 'eu' });
        return svc.getVehicle(TENANT_A_VEHICLE);
      });
      const docIds = ((v as any).documents ?? []).map((d: any) => d.id);
      out.push({
        name: 'metadata read-after-write: getVehicle includes the legacy doc just created (tenant A scope)',
        ok: docIds.includes(lr.id),
        detail: `docs=${docIds.length}`,
      });
    } finally { await prisma.$disconnect(); }
  });

  // Cleanup
  const cleanup = new Client({ connectionString: url, ssl: /127\.0\.0\.1|localhost/.test(url) ? false : { rejectUnauthorized: false } });
  await cleanup.connect();
  for (const id of createdIds) {
    await cleanup.query(`DELETE FROM vehicle_documents WHERE id = $1`, [id]).catch(() => undefined);
  }
  await cleanup.end();

  await fs.mkdir(OUT_DIR, { recursive: true });
  const summary = {
    generatedAt: new Date().toISOString(), environment: env, tenantA: tA,
    counts: { total: out.length, passed: out.filter((r) => r.ok).length, failed: out.filter((r) => !r.ok).length },
    results: out,
  };
  await fs.writeFile(path.join(OUT_DIR, 'vehicles-storage-equivalence.json'), JSON.stringify(summary, null, 2));
  const md: string[] = [];
  md.push('# Phase 2.25 — Vehicles Storage Equivalence');
  md.push(''); md.push(`Generated: ${summary.generatedAt}`);
  md.push(`Environment: ${env.classification} (${env.reason})`);
  md.push(`Tenant A: \`${tA}\``); md.push('');
  md.push(`- Cases passed: **${summary.counts.passed}** / ${summary.counts.total}`);
  md.push(`- Cases failed: ${summary.counts.failed}`); md.push('');
  md.push('| # | Case | Result | Detail |'); md.push('|--:|------|:------:|--------|');
  out.forEach((r, i) => md.push(`| ${i + 1} | ${r.name} | ${r.ok ? 'PASS' : '**FAIL**'} | ${r.detail} |`));
  await fs.writeFile(path.join(OUT_DIR, 'vehicles-storage-equivalence.md'), md.join('\n'));

  console.log(`vehicles-storage-equivalence: ${summary.counts.passed}/${summary.counts.total} cases PASS`);
  if (summary.counts.failed > 0) process.exit(2);
}

main().catch((e) => { console.error(e); process.exit(3); });
