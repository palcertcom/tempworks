/**
 * Phase 2.25 — vehicles storage isolation harness.
 *
 *   1. STORAGE GUARD: pilot ON, tenant A addDocument(tenantB-vehicle)
 *      raises NotFoundException; 0 storage uploads; 0 row inserted.
 *   2. Pilot ON, tenant A addDocument(tenantA-vehicle) succeeds;
 *      tenantId=A; 1 storage upload.
 *   3. Pilot ON, tenant A updateDocument(tenantB-vehicle, tenantB-doc)
 *      raises NotFoundException; target row's name unchanged.
 *   4. Pilot ON, tenant A deleteDocument(tenantB-vehicle, tenantB-doc)
 *      raises NotFoundException; deletedAt unchanged.
 *   5. Pilot OFF: legacy update on tenant B doc still mutates.
 *   6. Concurrent ALS frames: T_A and T_B isolated for addDocument.
 *   7. addMaintenanceAttachment (stub) still throws BadRequestException
 *      (DEFERRED documented).
 *   8. Source-level meta-assertion: every Phase 2.25 site has the
 *      right tag + parent gate.
 *
 * Output: backend/reports/saas/phase2/vehicles-storage-isolation.{json,md}
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
const SRC_FILE = path.resolve(__dirname, '..', '..', '..', 'src', 'vehicles', 'vehicles.service.ts');
interface CaseResult { name: string; ok: boolean; detail: string; }

const TENANT_A_VEHICLE = '00000000-0000-0000-0000-0000000vh001';
const TENANT_B_VEHICLE = '00000000-0000-0000-0000-0000000vh101';
const TENANT_B_DOC = '00000000-0000-0000-0000-0000000vd101';
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

const fileFix: any = { buffer: Buffer.from('x'), originalname: 'iso.pdf', mimetype: 'application/pdf', size: 1 };

async function main(): Promise<void> {
  const url = getDatabaseUrl();
  const env = classifyRuntimeEnv();
  if (!isStagingClassification(env.classification)) {
    console.error(`[vehicles-storage-isolation] refusing on classification=${env.classification}`);
    process.exit(3);
  }
  const c = new Client({ connectionString: url, ssl: /127\.0\.0\.1|localhost/.test(url) ? false : { rejectUnauthorized: false } });
  await c.connect();
  const ts = await c.query<{ id: string }>(
    `SELECT t.id FROM tenants t WHERE EXISTS (SELECT 1 FROM vehicles v WHERE v."tenantId" = t.id::text) ORDER BY t.name`);
  const tA = ts.rows[0]?.id; const tB = ts.rows[1]?.id;
  await c.end();
  if (!tA || !tB) { console.error('need two tenants with vehicles'); process.exit(3); }

  const out: CaseResult[] = [];
  const createdIds: string[] = [];

  // 1 — STORAGE GUARD: cross-tenant addDocument raises BEFORE upload
  await withFlags({ TENANT_PRISMA_PILOT_ENABLED: 'true', TENANT_PRISMA_PILOT_MODULES: 'vehicles' }, async () => {
    const prisma = new PrismaService();
    const ff = new FeatureFlagsService();
    const pilot = new PilotPrismaAccessor(prisma, new TenantPrismaService(prisma, ff), ff);
    const counters = { uploads: 0 };
    const svc = makeService(prisma, pilot, counters);
    try {
      const beforeCount = await (prisma as any).vehicleDocument.count({ where: { tenantId: tB } });
      let leaked = false; let errName = '';
      try {
        await withRequestContext({ requestId: newRequestId() }, async () => {
          TenantContext.attach({ id: tA, slug: 'a', name: 'A', status: 'ACTIVE', region: 'eu' });
          await svc.addDocument(TENANT_B_VEHICLE, { name: 'cross-tenant', documentType: 'MOT' } as any, SYS_USER, fileFix);
        });
        leaked = true;
      } catch (e) { errName = (e as Error).constructor.name; }
      const afterCount = await (prisma as any).vehicleDocument.count({ where: { tenantId: tB } });
      out.push({
        name: 'STORAGE GUARD: cross-tenant addDocument raises NotFoundException; 0 uploads; 0 rows inserted',
        ok: !leaked && errName === 'NotFoundException' && counters.uploads === 0 && beforeCount === afterCount,
        detail: leaked ? 'UNEXPECTED: created' : `err=${errName} uploads=${counters.uploads} dbDelta=${afterCount - beforeCount}`,
      });
    } finally { await prisma.$disconnect(); }
  });

  // 2 — same-tenant addDocument succeeds
  await withFlags({ TENANT_PRISMA_PILOT_ENABLED: 'true', TENANT_PRISMA_PILOT_MODULES: 'vehicles' }, async () => {
    const prisma = new PrismaService();
    const ff = new FeatureFlagsService();
    const pilot = new PilotPrismaAccessor(prisma, new TenantPrismaService(prisma, ff), ff);
    const counters = { uploads: 0 };
    const svc = makeService(prisma, pilot, counters);
    try {
      const created = await withRequestContext({ requestId: newRequestId() }, async () => {
        TenantContext.attach({ id: tA, slug: 'a', name: 'A', status: 'ACTIVE', region: 'eu' });
        return svc.addDocument(TENANT_A_VEHICLE, { name: 'iso-doc-A', documentType: 'MOT' } as any, SYS_USER, fileFix);
      });
      createdIds.push((created as any).id);
      const row: any = await (prisma as any).vehicleDocument.findUnique({ where: { id: (created as any).id } });
      out.push({
        name: 'pilot ON, tenant A: addDocument(tenantA-vehicle) succeeds; tenantId=A; 1 storage upload',
        ok: row?.tenantId === tA && counters.uploads === 1,
        detail: `tenantId=${row?.tenantId} uploads=${counters.uploads}`,
      });
    } finally { await prisma.$disconnect(); }
  });

  // 3 — cross-tenant updateDocument rejected
  await withFlags({ TENANT_PRISMA_PILOT_ENABLED: 'true', TENANT_PRISMA_PILOT_MODULES: 'vehicles' }, async () => {
    const prisma = new PrismaService();
    const ff = new FeatureFlagsService();
    const pilot = new PilotPrismaAccessor(prisma, new TenantPrismaService(prisma, ff), ff);
    const svc = makeService(prisma, pilot, { uploads: 0 });
    try {
      const before: any = await (prisma as any).vehicleDocument.findUnique({ where: { id: TENANT_B_DOC } });
      const beforeName = before?.name;
      let leaked = false;
      try {
        await withRequestContext({ requestId: newRequestId() }, async () => {
          TenantContext.attach({ id: tA, slug: 'a', name: 'A', status: 'ACTIVE', region: 'eu' });
          await svc.updateDocument(TENANT_B_VEHICLE, TENANT_B_DOC, { name: 'A-trying-to-update-B' } as any);
        });
        leaked = true;
      } catch { leaked = false; }
      const after: any = await (prisma as any).vehicleDocument.findUnique({ where: { id: TENANT_B_DOC } });
      out.push({
        name: 'pilot ON, tenant A: updateDocument(tenantB-vehicle, tenantB-doc) rejected; name unchanged',
        ok: !leaked && after?.name === beforeName,
        detail: `before="${beforeName}" after="${after?.name}"`,
      });
    } finally { await prisma.$disconnect(); }
  });

  // 4 — cross-tenant deleteDocument rejected
  await withFlags({ TENANT_PRISMA_PILOT_ENABLED: 'true', TENANT_PRISMA_PILOT_MODULES: 'vehicles' }, async () => {
    const prisma = new PrismaService();
    const ff = new FeatureFlagsService();
    const pilot = new PilotPrismaAccessor(prisma, new TenantPrismaService(prisma, ff), ff);
    const svc = makeService(prisma, pilot, { uploads: 0 });
    try {
      const before: any = await (prisma as any).vehicleDocument.findUnique({ where: { id: TENANT_B_DOC } });
      const beforeDeletedAt = before?.deletedAt ?? null;
      let leaked = false;
      try {
        await withRequestContext({ requestId: newRequestId() }, async () => {
          TenantContext.attach({ id: tA, slug: 'a', name: 'A', status: 'ACTIVE', region: 'eu' });
          await svc.deleteDocument(TENANT_B_VEHICLE, TENANT_B_DOC, SYS_USER);
        });
        leaked = true;
      } catch { leaked = false; }
      const after: any = await (prisma as any).vehicleDocument.findUnique({ where: { id: TENANT_B_DOC } });
      out.push({
        name: 'pilot ON, tenant A: deleteDocument(tenantB-vehicle, tenantB-doc) rejected; deletedAt unchanged',
        ok: !leaked && (after?.deletedAt ?? null) === beforeDeletedAt,
        detail: `deletedAt=${after?.deletedAt ? 'set' : 'null'}`,
      });
    } finally { await prisma.$disconnect(); }
  });

  // 5 — pilot OFF: legacy still mutates
  await withFlags({ TENANT_PRISMA_PILOT_ENABLED: 'false' }, async () => {
    const prisma = new PrismaService();
    const ff = new FeatureFlagsService();
    const pilot = new PilotPrismaAccessor(prisma, new TenantPrismaService(prisma, ff), ff);
    const svc = makeService(prisma, pilot, { uploads: 0 });
    try {
      const before: any = await (prisma as any).vehicleDocument.findUnique({ where: { id: TENANT_B_DOC } });
      let mutated = false;
      try {
        const u = await svc.updateDocument(TENANT_B_VEHICLE, TENANT_B_DOC, { name: 'legacy-no-tenant-gate' } as any);
        mutated = (u as any).name === 'legacy-no-tenant-gate';
      } catch { mutated = false; }
      if (mutated && before) {
        await (prisma as any).vehicleDocument.update({ where: { id: TENANT_B_DOC }, data: { name: before.name } });
      }
      out.push({ name: 'pilot OFF: legacy update on tenant B doc still succeeds', ok: mutated, detail: mutated ? 'mutated' : 'UNEXPECTED: blocked' });
    } finally { await prisma.$disconnect(); }
  });

  // 6 — concurrent ALS frames isolated
  await withFlags({ TENANT_PRISMA_PILOT_ENABLED: 'true', TENANT_PRISMA_PILOT_MODULES: 'vehicles' }, async () => {
    const prisma = new PrismaService();
    const ff = new FeatureFlagsService();
    const pilot = new PilotPrismaAccessor(prisma, new TenantPrismaService(prisma, ff), ff);
    const counters = { uploads: 0 };
    const svc = makeService(prisma, pilot, counters);
    try {
      const seen: Array<{ t: string; tenantId: string | null; err?: string }> = [];
      await Promise.all([
        withRequestContext({ requestId: newRequestId() }, async () => {
          TenantContext.attach({ id: tA, slug: 'a', name: 'A', status: 'ACTIVE', region: 'eu' });
          await new Promise((r) => setTimeout(r, 5));
          const r = await svc.addDocument(TENANT_A_VEHICLE, { name: 'concurrent-A', documentType: 'MOT' } as any, SYS_USER, fileFix);
          createdIds.push((r as any).id);
          const row: any = await (prisma as any).vehicleDocument.findUnique({ where: { id: (r as any).id } });
          seen.push({ t: tA, tenantId: row?.tenantId ?? null });
        }),
        withRequestContext({ requestId: newRequestId() }, async () => {
          TenantContext.attach({ id: tB, slug: 'b', name: 'B', status: 'ACTIVE', region: 'eu' });
          await new Promise((r) => setTimeout(r, 1));
          try {
            const r = await svc.addDocument(TENANT_A_VEHICLE, { name: 'concurrent-B-trying-A', documentType: 'MOT' } as any, SYS_USER, fileFix);
            createdIds.push((r as any).id);
            seen.push({ t: tB, tenantId: 'WROTE' });
          } catch (e) { seen.push({ t: tB, tenantId: null, err: (e as Error).constructor.name }); }
        }),
      ]);
      const a = seen.find((x) => x.t === tA);
      const b = seen.find((x) => x.t === tB);
      out.push({
        name: 'concurrent ALS frames isolated: T_A doc gets tenantId=A; T_B trying to add to A vehicle is rejected',
        ok: a?.tenantId === tA && b?.err === 'NotFoundException',
        detail: `aTenant=${a?.tenantId} bResult=${b?.err ?? b?.tenantId}`,
      });
    } finally { await prisma.$disconnect(); }
  });

  // 7 — addMaintenanceAttachment stub still throws (DEFERRED)
  await withFlags({ TENANT_PRISMA_PILOT_ENABLED: 'true', TENANT_PRISMA_PILOT_MODULES: 'vehicles' }, async () => {
    const prisma = new PrismaService();
    const ff = new FeatureFlagsService();
    const pilot = new PilotPrismaAccessor(prisma, new TenantPrismaService(prisma, ff), ff);
    const svc = makeService(prisma, pilot, { uploads: 0 });
    try {
      let errName = '';
      try { await (svc as any).addMaintenanceAttachment('00000000-0000-0000-0000-000000000000', fileFix, 'cert', SYS_USER); }
      catch (e) { errName = (e as Error).constructor.name; }
      out.push({
        name: 'addMaintenanceAttachment (stub) still throws BadRequestException — DEFERRED until migration',
        ok: errName === 'BadRequestException',
        detail: `err=${errName}`,
      });
    } finally { await prisma.$disconnect(); }
  });

  // 8 — source-level meta-assertion
  const src = await fs.readFile(SRC_FILE, 'utf8');
  const expected: Array<[string, RegExp]> = [
    ['addDocument: findVehicleOrFail BEFORE storage.uploadFile', /async addDocument\([\s\S]*?await this\.findVehicleOrFail\(vehicleId\)[\s\S]*?storage\.uploadFile/],
    ['addDocument: tenantData spread on the vehicleDocument.create', /async addDocument\([\s\S]*?vehicleDocument\.create\([\s\S]{0,400}\.\.\.tdata/],
    ['addDocument: phase225-pilot-scope tag on the create', /async addDocument\([\s\S]*?vehicleDocument\.create[\s\S]{0,400}phase225-pilot-scope/],
    ['updateDocument: explicit findVehicleOrFail first', /async updateDocument\([\s\S]*?await this\.findVehicleOrFail\(vehicleId\)/],
    ['updateDocument: phase225-pilot-scope-precheck on by-id update', /async updateDocument\([\s\S]*?vehicleDocument\.update[\s\S]{0,400}phase225-pilot-scope-precheck/],
    ['deleteDocument: explicit findVehicleOrFail first', /async deleteDocument\([\s\S]*?await this\.findVehicleOrFail\(vehicleId\)/],
    ['deleteDocument: phase225-pilot-scope-precheck on soft-delete', /async deleteDocument\([\s\S]*?vehicleDocument as any\)\.update[\s\S]{0,400}phase225-pilot-scope-precheck/],
  ];
  const failed: string[] = [];
  expected.forEach(([n, re]) => { if (!re.test(src)) failed.push(n); });
  out.push({
    name: 'source: every Phase 2.25 storage site has the right tag and parent gate',
    ok: failed.length === 0,
    detail: failed.length === 0 ? 'all patterns matched' : failed.join('; '),
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
    generatedAt: new Date().toISOString(), environment: env, tenantA: tA, tenantB: tB,
    counts: { total: out.length, passed: out.filter((r) => r.ok).length, failed: out.filter((r) => !r.ok).length },
    results: out,
  };
  await fs.writeFile(path.join(OUT_DIR, 'vehicles-storage-isolation.json'), JSON.stringify(summary, null, 2));
  const md: string[] = [];
  md.push('# Phase 2.25 — Vehicles Storage Isolation');
  md.push(''); md.push(`Generated: ${summary.generatedAt}`);
  md.push(`Environment: ${env.classification} (${env.reason})`);
  md.push(`Tenants: A=\`${tA}\` B=\`${tB}\``); md.push('');
  md.push(`- Cases passed: **${summary.counts.passed}** / ${summary.counts.total}`);
  md.push(`- Cases failed: ${summary.counts.failed}`); md.push('');
  md.push('| # | Case | Result | Detail |'); md.push('|--:|------|:------:|--------|');
  out.forEach((r, i) => md.push(`| ${i + 1} | ${r.name} | ${r.ok ? 'PASS' : '**FAIL**'} | ${r.detail} |`));
  await fs.writeFile(path.join(OUT_DIR, 'vehicles-storage-isolation.md'), md.join('\n'));

  console.log(`vehicles-storage-isolation: ${summary.counts.passed}/${summary.counts.total} cases PASS`);
  if (summary.counts.failed > 0) process.exit(2);
}

main().catch((e) => { console.error(e); process.exit(3); });
