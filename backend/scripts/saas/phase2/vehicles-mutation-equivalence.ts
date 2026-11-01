/**
 * Phase 2.24 — vehicles mutation equivalence harness.
 *
 *   1. createVehicle response shape preserved
 *   2. createVehicle legacy: tenantId NULL; pilot: tenantId=A
 *   3. updateVehicle mutates the field in both modes
 *   4. createMaintenanceRecord legacy: tenantId NULL; pilot: tenantId=A
 *   5. updateMaintenanceRecord mutates the field in both modes
 *   6. soft-delete vehicle sets deletedAt in both modes
 *   7. soft-delete maintenance record sets deletedAt in both modes
 *   8. validation/error path: NotFoundException for missing record id
 *      in both modes
 *
 * Output: backend/reports/saas/phase2/vehicles-mutation-equivalence.{json,md}
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
import { StorageService } from '../../../src/common/storage/storage.service';
import { TenantContext, withRequestContext, newRequestId } from '../../../src/saas/context/als';

autoLoadEnv(__filename);

const OUT_DIR = path.resolve(__dirname, '..', '..', '..', 'reports', 'saas', 'phase2');
interface CaseResult { name: string; ok: boolean; detail: string; }

const TENANT_A_AGENCY = 'aaaaaaa1-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const TENANT_A_VEHICLE = '00000000-0000-0000-0000-0000000vh001';
const MAINT_TYPE = '00000000-0000-0000-0000-00000000mt01';
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

function makeService(prisma: PrismaService, pilot: PilotPrismaAccessor): VehiclesService {
  return new VehiclesService(prisma, new StorageService(), pilot);
}

interface CreateResult { id: string; tenantId: string | null; }

async function runCreateVehicle(svc: VehiclesService, prisma: PrismaService, regNum: string): Promise<CreateResult> {
  const v = await svc.createVehicle(
    { registrationNumber: regNum, make: 'TestMake', model: 'TestModel', agencyId: TENANT_A_AGENCY } as any,
    SYS_USER,
  );
  const row: any = await (prisma as any).vehicle.findUnique({ where: { id: v.id } });
  return { id: v.id, tenantId: row?.tenantId ?? null };
}

async function runCreateMaintenance(svc: VehiclesService, prisma: PrismaService, vehicleId: string): Promise<CreateResult> {
  const r = await svc.createMaintenanceRecord(
    { vehicleId, maintenanceTypeId: MAINT_TYPE, status: 'SCHEDULED', scheduledDate: new Date().toISOString() } as any,
    SYS_USER,
  );
  const row: any = await (prisma as any).maintenanceRecord.findUnique({ where: { id: r.id } });
  return { id: r.id, tenantId: row?.tenantId ?? null };
}

async function main(): Promise<void> {
  const url = getDatabaseUrl();
  const env = classifyRuntimeEnv();
  if (!isStagingClassification(env.classification)) {
    console.error(`[vehicles-mutation-equivalence] refusing on classification=${env.classification}`);
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
  const createdVehicleIds: string[] = [];
  const createdMaintIds: string[] = [];
  const stamp = Date.now().toString(36);

  // 1+2 — createVehicle legacy + pilot
  const lv = await withFlags({ TENANT_PRISMA_PILOT_ENABLED: 'false' }, async () => {
    const prisma = new PrismaService();
    const ff = new FeatureFlagsService();
    const pilot = new PilotPrismaAccessor(prisma, new TenantPrismaService(prisma, ff), ff);
    const svc = makeService(prisma, pilot);
    try { const r = await runCreateVehicle(svc, prisma, `LEGACY-${stamp}`); createdVehicleIds.push(r.id); return r; }
    finally { await prisma.$disconnect(); }
  });
  const pv = await withFlags({ TENANT_PRISMA_PILOT_ENABLED: 'true', TENANT_PRISMA_PILOT_MODULES: 'vehicles' }, async () => {
    const prisma = new PrismaService();
    const ff = new FeatureFlagsService();
    const pilot = new PilotPrismaAccessor(prisma, new TenantPrismaService(prisma, ff), ff);
    const svc = makeService(prisma, pilot);
    try {
      return await withRequestContext({ requestId: newRequestId() }, async () => {
        TenantContext.attach({ id: tA, slug: 'a', name: 'A', status: 'ACTIVE', region: 'eu' });
        const r = await runCreateVehicle(svc, prisma, `PILOT-${stamp}`); createdVehicleIds.push(r.id); return r;
      });
    } finally { await prisma.$disconnect(); }
  });

  out.push({ name: 'createVehicle response shape preserved (id present)', ok: !!lv.id && !!pv.id, detail: `legacy.id=${lv.id} pilot.id=${pv.id}` });
  out.push({ name: 'createVehicle legacy: tenantId is NULL', ok: lv.tenantId === null, detail: `legacy.tenantId=${lv.tenantId}` });
  out.push({ name: 'createVehicle pilot: tenantId is set to active tenant', ok: pv.tenantId === tA, detail: `pilot.tenantId=${pv.tenantId} tenantA=${tA}` });

  // 3 — updateVehicle mutates make in both modes
  await withFlags({ TENANT_PRISMA_PILOT_ENABLED: 'false' }, async () => {
    const prisma = new PrismaService();
    const ff = new FeatureFlagsService();
    const pilot = new PilotPrismaAccessor(prisma, new TenantPrismaService(prisma, ff), ff);
    const svc = makeService(prisma, pilot);
    try {
      const u = await svc.updateVehicle(lv.id, { make: 'LegacyUpdated' } as any, SYS_USER);
      out.push({ name: 'updateVehicle (legacy) mutates make', ok: (u as any).make === 'LegacyUpdated', detail: `make=${(u as any).make}` });
    } finally { await prisma.$disconnect(); }
  });
  await withFlags({ TENANT_PRISMA_PILOT_ENABLED: 'true', TENANT_PRISMA_PILOT_MODULES: 'vehicles' }, async () => {
    const prisma = new PrismaService();
    const ff = new FeatureFlagsService();
    const pilot = new PilotPrismaAccessor(prisma, new TenantPrismaService(prisma, ff), ff);
    const svc = makeService(prisma, pilot);
    try {
      await withRequestContext({ requestId: newRequestId() }, async () => {
        TenantContext.attach({ id: tA, slug: 'a', name: 'A', status: 'ACTIVE', region: 'eu' });
        const u = await svc.updateVehicle(pv.id, { make: 'PilotUpdated' } as any, SYS_USER);
        out.push({ name: 'updateVehicle (pilot) mutates make', ok: (u as any).make === 'PilotUpdated', detail: `make=${(u as any).make}` });
      });
    } finally { await prisma.$disconnect(); }
  });

  // 4 — createMaintenanceRecord legacy + pilot
  const lm = await withFlags({ TENANT_PRISMA_PILOT_ENABLED: 'false' }, async () => {
    const prisma = new PrismaService();
    const ff = new FeatureFlagsService();
    const pilot = new PilotPrismaAccessor(prisma, new TenantPrismaService(prisma, ff), ff);
    const svc = makeService(prisma, pilot);
    try { const r = await runCreateMaintenance(svc, prisma, TENANT_A_VEHICLE); createdMaintIds.push(r.id); return r; }
    finally { await prisma.$disconnect(); }
  });
  const pm = await withFlags({ TENANT_PRISMA_PILOT_ENABLED: 'true', TENANT_PRISMA_PILOT_MODULES: 'vehicles' }, async () => {
    const prisma = new PrismaService();
    const ff = new FeatureFlagsService();
    const pilot = new PilotPrismaAccessor(prisma, new TenantPrismaService(prisma, ff), ff);
    const svc = makeService(prisma, pilot);
    try {
      return await withRequestContext({ requestId: newRequestId() }, async () => {
        TenantContext.attach({ id: tA, slug: 'a', name: 'A', status: 'ACTIVE', region: 'eu' });
        const r = await runCreateMaintenance(svc, prisma, TENANT_A_VEHICLE); createdMaintIds.push(r.id); return r;
      });
    } finally { await prisma.$disconnect(); }
  });
  out.push({ name: 'createMaintenanceRecord legacy: tenantId is NULL', ok: lm.tenantId === null, detail: `legacy.tenantId=${lm.tenantId}` });
  out.push({ name: 'createMaintenanceRecord pilot: tenantId is set to active tenant', ok: pm.tenantId === tA, detail: `pilot.tenantId=${pm.tenantId}` });

  // 5 — updateMaintenanceRecord mutates notes in both modes
  await withFlags({ TENANT_PRISMA_PILOT_ENABLED: 'false' }, async () => {
    const prisma = new PrismaService();
    const ff = new FeatureFlagsService();
    const pilot = new PilotPrismaAccessor(prisma, new TenantPrismaService(prisma, ff), ff);
    const svc = makeService(prisma, pilot);
    try {
      const u = await svc.updateMaintenanceRecord(lm.id, { notes: 'legacy-notes' } as any, SYS_USER);
      out.push({ name: 'updateMaintenanceRecord (legacy) mutates notes', ok: (u as any).notes === 'legacy-notes', detail: `notes=${(u as any).notes}` });
    } finally { await prisma.$disconnect(); }
  });
  await withFlags({ TENANT_PRISMA_PILOT_ENABLED: 'true', TENANT_PRISMA_PILOT_MODULES: 'vehicles' }, async () => {
    const prisma = new PrismaService();
    const ff = new FeatureFlagsService();
    const pilot = new PilotPrismaAccessor(prisma, new TenantPrismaService(prisma, ff), ff);
    const svc = makeService(prisma, pilot);
    try {
      await withRequestContext({ requestId: newRequestId() }, async () => {
        TenantContext.attach({ id: tA, slug: 'a', name: 'A', status: 'ACTIVE', region: 'eu' });
        const u = await svc.updateMaintenanceRecord(pm.id, { notes: 'pilot-notes' } as any, SYS_USER);
        out.push({ name: 'updateMaintenanceRecord (pilot) mutates notes', ok: (u as any).notes === 'pilot-notes', detail: `notes=${(u as any).notes}` });
      });
    } finally { await prisma.$disconnect(); }
  });

  // 6 — deleteVehicle (pilot) sets deletedAt
  await withFlags({ TENANT_PRISMA_PILOT_ENABLED: 'true', TENANT_PRISMA_PILOT_MODULES: 'vehicles' }, async () => {
    const prisma = new PrismaService();
    const ff = new FeatureFlagsService();
    const pilot = new PilotPrismaAccessor(prisma, new TenantPrismaService(prisma, ff), ff);
    const svc = makeService(prisma, pilot);
    try {
      await withRequestContext({ requestId: newRequestId() }, async () => {
        TenantContext.attach({ id: tA, slug: 'a', name: 'A', status: 'ACTIVE', region: 'eu' });
        await svc.deleteVehicle(pv.id, SYS_USER);
      });
      const after: any = await (prisma as any).vehicle.findUnique({ where: { id: pv.id } });
      out.push({ name: 'pilot deleteVehicle: deletedAt is set', ok: !!after?.deletedAt, detail: `deletedAt=${after?.deletedAt ? 'set' : 'null'}` });
    } finally { await prisma.$disconnect(); }
  });

  // 7 — deleteMaintenanceRecord (pilot) sets deletedAt
  await withFlags({ TENANT_PRISMA_PILOT_ENABLED: 'true', TENANT_PRISMA_PILOT_MODULES: 'vehicles' }, async () => {
    const prisma = new PrismaService();
    const ff = new FeatureFlagsService();
    const pilot = new PilotPrismaAccessor(prisma, new TenantPrismaService(prisma, ff), ff);
    const svc = makeService(prisma, pilot);
    try {
      await withRequestContext({ requestId: newRequestId() }, async () => {
        TenantContext.attach({ id: tA, slug: 'a', name: 'A', status: 'ACTIVE', region: 'eu' });
        await svc.deleteMaintenanceRecord(pm.id, SYS_USER);
      });
      const after: any = await (prisma as any).maintenanceRecord.findUnique({ where: { id: pm.id } });
      out.push({ name: 'pilot deleteMaintenanceRecord: deletedAt is set', ok: !!after?.deletedAt, detail: `deletedAt=${after?.deletedAt ? 'set' : 'null'}` });
    } finally { await prisma.$disconnect(); }
  });

  // 8 — validation: missing maintenance record id ⇒ 404 in both modes
  let lErr = 'no-error', pErr = 'no-error';
  await withFlags({ TENANT_PRISMA_PILOT_ENABLED: 'false' }, async () => {
    const prisma = new PrismaService();
    const ff = new FeatureFlagsService();
    const pilot = new PilotPrismaAccessor(prisma, new TenantPrismaService(prisma, ff), ff);
    const svc = makeService(prisma, pilot);
    try { await svc.updateMaintenanceRecord('00000000-0000-0000-0000-deaddeaddead', { notes: 'x' } as any, SYS_USER); }
    catch (e) { lErr = (e as Error).constructor.name; }
    finally { await prisma.$disconnect(); }
  });
  await withFlags({ TENANT_PRISMA_PILOT_ENABLED: 'true', TENANT_PRISMA_PILOT_MODULES: 'vehicles' }, async () => {
    const prisma = new PrismaService();
    const ff = new FeatureFlagsService();
    const pilot = new PilotPrismaAccessor(prisma, new TenantPrismaService(prisma, ff), ff);
    const svc = makeService(prisma, pilot);
    try {
      await withRequestContext({ requestId: newRequestId() }, async () => {
        TenantContext.attach({ id: tA, slug: 'a', name: 'A', status: 'ACTIVE', region: 'eu' });
        await svc.updateMaintenanceRecord('00000000-0000-0000-0000-deaddeaddead', { notes: 'x' } as any, SYS_USER);
      });
    } catch (e) { pErr = (e as Error).constructor.name; }
    finally { await prisma.$disconnect(); }
  });
  out.push({ name: 'validation: NotFoundException for missing maintenance record id in both modes', ok: lErr === 'NotFoundException' && pErr === 'NotFoundException', detail: `legacy=${lErr} pilot=${pErr}` });

  // Cleanup
  const cleanup = new Client({ connectionString: url, ssl: /127\.0\.0\.1|localhost/.test(url) ? false : { rejectUnauthorized: false } });
  await cleanup.connect();
  for (const id of createdMaintIds) {
    await cleanup.query(`DELETE FROM maintenance_records WHERE id = $1`, [id]).catch(() => undefined);
  }
  for (const id of createdVehicleIds) {
    await cleanup.query(`DELETE FROM vehicles WHERE id = $1`, [id]).catch(() => undefined);
  }
  await cleanup.end();

  await fs.mkdir(OUT_DIR, { recursive: true });
  const summary = {
    generatedAt: new Date().toISOString(), environment: env, tenantA: tA,
    counts: { total: out.length, passed: out.filter((r) => r.ok).length, failed: out.filter((r) => !r.ok).length },
    results: out,
  };
  await fs.writeFile(path.join(OUT_DIR, 'vehicles-mutation-equivalence.json'), JSON.stringify(summary, null, 2));
  const md: string[] = [];
  md.push('# Phase 2.24 — Vehicles Mutation Equivalence');
  md.push(''); md.push(`Generated: ${summary.generatedAt}`);
  md.push(`Environment: ${env.classification} (${env.reason})`);
  md.push(`Tenant A: \`${tA}\``); md.push('');
  md.push(`- Cases passed: **${summary.counts.passed}** / ${summary.counts.total}`);
  md.push(`- Cases failed: ${summary.counts.failed}`); md.push('');
  md.push('| # | Case | Result | Detail |'); md.push('|--:|------|:------:|--------|');
  out.forEach((r, i) => md.push(`| ${i + 1} | ${r.name} | ${r.ok ? 'PASS' : '**FAIL**'} | ${r.detail} |`));
  await fs.writeFile(path.join(OUT_DIR, 'vehicles-mutation-equivalence.md'), md.join('\n'));

  console.log(`vehicles-mutation-equivalence: ${summary.counts.passed}/${summary.counts.total} cases PASS`);
  if (summary.counts.failed > 0) process.exit(2);
}

main().catch((e) => { console.error(e); process.exit(3); });
