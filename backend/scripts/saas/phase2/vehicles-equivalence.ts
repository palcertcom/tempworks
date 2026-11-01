/**
 * Phase 2.23 — vehicles pilot read-equivalence harness.
 *
 *   1. listVehicles total: pilot <= legacy
 *   2. getVehicle(tenantA-id): both modes resolve same id
 *   3. getMaintenanceRecord(tenantA-id): both modes resolve same id
 *   4. listMaintenanceRecords total: pilot <= legacy
 *   5. getDashboardStats: pilot totals <= legacy totals
 *   6. error path: NotFoundException for missing vehicle id
 *   7. listMaintenanceTypes: global catalog identical in both modes
 *   8. listWorkshops: global catalog identical in both modes
 *   9. response shape preserved
 *
 * Output: backend/reports/saas/phase2/vehicles-equivalence.{json,md}
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
const TENANT_A_VEHICLE_ID = '00000000-0000-0000-0000-0000000vh001';
const TENANT_A_MAINT_ID = '00000000-0000-0000-0000-0000000mr001';

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
  const storage = new StorageService();
  return new VehiclesService(prisma, storage, pilot);
}

interface Snap {
  pilotActive: boolean;
  reason: string;
  listTotal: number;
  vehicleId: string | null;
  maintId: string | null;
  errOnMissing: string;
  maintTotal: number;
  dashboardTotal: number;
  txTypeCount: number;
  workshopCount: number;
  shapeOk: boolean;
}

async function snap(flags: Record<string, string | undefined>, ctx: { id: string } | null): Promise<Snap> {
  return withFlags(flags, async () => {
    const ff = new FeatureFlagsService();
    const prisma = new PrismaService();
    const tp = new TenantPrismaService(prisma, ff);
    const pilot = new PilotPrismaAccessor(prisma, tp, ff);
    const svc = makeService(prisma, pilot);
    const run = async (): Promise<Snap> => {
      const list = await svc.listVehicles({} as any);
      let vehicleId: string | null = null;
      try { vehicleId = (await svc.getVehicle(TENANT_A_VEHICLE_ID)).id; } catch { vehicleId = null; }
      let maintId: string | null = null;
      try { maintId = (await svc.getMaintenanceRecord(TENANT_A_MAINT_ID)).id; } catch { maintId = null; }
      let errOnMissing = 'no-error';
      try { await svc.getVehicle('00000000-0000-0000-0000-deaddeaddead'); }
      catch (e) { errOnMissing = (e as Error).constructor.name; }
      const maint = await svc.listMaintenanceRecords({} as any);
      const dash = await svc.getDashboardStats();
      const tx = await svc.listMaintenanceTypes();
      const ws = await svc.listWorkshops();
      const shapeOk = Array.isArray((list as any).data) && typeof (list as any).total === 'number';
      return {
        pilotActive: pilot.isPilotActive(),
        reason: pilot.pilotReason().reason,
        listTotal: (list as any).total,
        vehicleId,
        maintId,
        errOnMissing,
        maintTotal: (maint as any).total,
        dashboardTotal: dash.totalVehicles,
        txTypeCount: tx.length,
        workshopCount: ws.length,
        shapeOk,
      };
    };
    try {
      if (ctx) {
        return await withRequestContext({ requestId: newRequestId() }, async () => {
          TenantContext.attach({ id: ctx.id, slug: 'a', name: 'A', status: 'ACTIVE', region: 'eu' });
          return run();
        });
      }
      return await run();
    } finally { await prisma.$disconnect(); }
  });
}

async function main(): Promise<void> {
  const url = getDatabaseUrl();
  const env = classifyRuntimeEnv();
  if (!isStagingClassification(env.classification)) {
    console.error(`[vehicles-equivalence] refusing on classification=${env.classification}`);
    process.exit(3);
  }
  const c = new Client({ connectionString: url, ssl: /127\.0\.0\.1|localhost/.test(url) ? false : { rejectUnauthorized: false } });
  await c.connect();
  const ts = await c.query<{ id: string }>(
    `SELECT t.id FROM tenants t WHERE EXISTS (SELECT 1 FROM vehicles v WHERE v."tenantId" = t.id::text) ORDER BY t.name`);
  const tA = ts.rows[0]?.id;
  await c.end();
  if (!tA) { console.error('need tenant A with vehicles'); process.exit(3); }

  const out: CaseResult[] = [];
  const legacy = await snap({ TENANT_PRISMA_PILOT_ENABLED: 'false' }, null);
  const pilot  = await snap({ TENANT_PRISMA_PILOT_ENABLED: 'true', TENANT_PRISMA_PILOT_MODULES: 'vehicles' }, { id: tA });

  out.push({ name: 'legacy: pilot OFF reports pilotActive=false', ok: !legacy.pilotActive, detail: legacy.reason });
  out.push({ name: 'pilot: pilot ON + vehicles allow-list ⇒ pilotActive=true', ok: pilot.pilotActive && pilot.reason.startsWith('pilot ON'), detail: pilot.reason });
  out.push({ name: 'listVehicles: pilot total <= legacy total (tenant filter applies)', ok: pilot.listTotal <= legacy.listTotal && pilot.listTotal > 0, detail: `legacy=${legacy.listTotal} pilot=${pilot.listTotal}` });
  out.push({ name: 'getVehicle: legacy + pilot resolve the tenant A vehicle id', ok: legacy.vehicleId === TENANT_A_VEHICLE_ID && pilot.vehicleId === TENANT_A_VEHICLE_ID, detail: `legacy=${legacy.vehicleId} pilot=${pilot.vehicleId}` });
  out.push({ name: 'getMaintenanceRecord: legacy + pilot resolve the tenant A record id', ok: legacy.maintId === TENANT_A_MAINT_ID && pilot.maintId === TENANT_A_MAINT_ID, detail: `legacy=${legacy.maintId} pilot=${pilot.maintId}` });
  out.push({ name: 'error path: NotFoundException for missing vehicle id in both modes', ok: legacy.errOnMissing === 'NotFoundException' && pilot.errOnMissing === 'NotFoundException', detail: `legacy=${legacy.errOnMissing} pilot=${pilot.errOnMissing}` });
  out.push({ name: 'listMaintenanceRecords: pilot total <= legacy total', ok: pilot.maintTotal <= legacy.maintTotal && pilot.maintTotal > 0, detail: `legacy=${legacy.maintTotal} pilot=${pilot.maintTotal}` });
  out.push({ name: 'getDashboardStats.totalVehicles: pilot <= legacy', ok: pilot.dashboardTotal <= legacy.dashboardTotal && pilot.dashboardTotal > 0, detail: `legacy=${legacy.dashboardTotal} pilot=${pilot.dashboardTotal}` });
  out.push({ name: 'listMaintenanceTypes: global catalog identical in both modes', ok: legacy.txTypeCount === pilot.txTypeCount && pilot.txTypeCount > 0, detail: `legacy=${legacy.txTypeCount} pilot=${pilot.txTypeCount}` });
  out.push({ name: 'listWorkshops: global catalog identical in both modes', ok: legacy.workshopCount === pilot.workshopCount, detail: `legacy=${legacy.workshopCount} pilot=${pilot.workshopCount}` });
  out.push({ name: 'response shape preserved', ok: legacy.shapeOk && pilot.shapeOk, detail: `legacy=${legacy.shapeOk} pilot=${pilot.shapeOk}` });

  await fs.mkdir(OUT_DIR, { recursive: true });
  const summary = {
    generatedAt: new Date().toISOString(), environment: env, tenantA: tA,
    legacy, pilot,
    counts: { total: out.length, passed: out.filter((r) => r.ok).length, failed: out.filter((r) => !r.ok).length },
    results: out,
  };
  await fs.writeFile(path.join(OUT_DIR, 'vehicles-equivalence.json'), JSON.stringify(summary, null, 2));
  const md: string[] = [];
  md.push('# Phase 2.23 — Vehicles Equivalence');
  md.push(''); md.push(`Generated: ${summary.generatedAt}`);
  md.push(`Environment: ${env.classification} (${env.reason})`);
  md.push(`Tenant A: \`${tA}\``); md.push('');
  md.push(`- Cases passed: **${summary.counts.passed}** / ${summary.counts.total}`);
  md.push(`- Cases failed: ${summary.counts.failed}`); md.push('');
  md.push('| # | Case | Result | Detail |'); md.push('|--:|------|:------:|--------|');
  out.forEach((r, i) => md.push(`| ${i + 1} | ${r.name} | ${r.ok ? 'PASS' : '**FAIL**'} | ${r.detail} |`));
  await fs.writeFile(path.join(OUT_DIR, 'vehicles-equivalence.md'), md.join('\n'));

  console.log(`vehicles-equivalence: ${summary.counts.passed}/${summary.counts.total} cases PASS`);
  if (summary.counts.failed > 0) process.exit(2);
}

main().catch((e) => { console.error(e); process.exit(3); });
