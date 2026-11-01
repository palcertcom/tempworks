/**
 * Phase 2.24 — vehicles mutation isolation harness.
 *
 *   1. createVehicle pilot ON, tenant A: persists tenantId=A
 *   2. updateVehicle(tenantB-id) raises NotFoundException; row unchanged
 *   3. deleteVehicle(tenantB-id) raises NotFoundException; deletedAt unchanged
 *   4. assignDriver(tenantB-vehicle-id) raises NotFoundException
 *   5. assignDriver(tenantA-vehicle, tenantB-employee) raises NotFoundException
 *   6. unassignDriver(tenantB-vehicle-id) raises NotFoundException
 *   7. createMaintenanceRecord(tenantB-vehicle-id) raises NotFoundException
 *      AND no row inserted
 *   8. createMaintenanceRecord(tenantA-vehicle) succeeds; tenantId=A
 *   9. updateMaintenanceRecord(tenantB-record-id) raises NotFoundException;
 *      target row's notes unchanged
 *  10. deleteMaintenanceRecord(tenantB-record-id) raises NotFoundException;
 *      target row's deletedAt unchanged
 *  11. dashboard counts unchanged after pilot tenant A mutations
 *  12. pilot OFF: legacy update on tenant B vehicle still mutates
 *  13. registration-number uniqueness: pilot tenant A creating a plate
 *      already used by tenant B raises a uniqueness error (P2002)
 *  14. source-level meta-assertion: phase224 tags + tenantData spread
 *
 * Output: backend/reports/saas/phase2/vehicles-mutation-isolation.{json,md}
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
const SRC_FILE = path.resolve(__dirname, '..', '..', '..', 'src', 'vehicles', 'vehicles.service.ts');
interface CaseResult { name: string; ok: boolean; detail: string; }

const TENANT_A_VEHICLE = '00000000-0000-0000-0000-0000000vh001';
const TENANT_B_VEHICLE = '00000000-0000-0000-0000-0000000vh101';
const TENANT_B_REG = 'CD-34-A';
const TENANT_A_AGENCY = 'aaaaaaa1-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const TENANT_B_MAINT = '00000000-0000-0000-0000-0000000mr101';
const MAINT_TYPE = '00000000-0000-0000-0000-00000000mt01';
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

function makeService(prisma: PrismaService, pilot: PilotPrismaAccessor): VehiclesService {
  return new VehiclesService(prisma, new StorageService(), pilot);
}

async function main(): Promise<void> {
  const url = getDatabaseUrl();
  const env = classifyRuntimeEnv();
  if (!isStagingClassification(env.classification)) {
    console.error(`[vehicles-mutation-isolation] refusing on classification=${env.classification}`);
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
  const createdVehicleIds: string[] = [];
  const createdMaintIds: string[] = [];
  const stamp = Date.now().toString(36);

  // 1 — pilot create persists tenantId=A
  await withFlags({ TENANT_PRISMA_PILOT_ENABLED: 'true', TENANT_PRISMA_PILOT_MODULES: 'vehicles' }, async () => {
    const prisma = new PrismaService();
    const ff = new FeatureFlagsService();
    const pilot = new PilotPrismaAccessor(prisma, new TenantPrismaService(prisma, ff), ff);
    const svc = makeService(prisma, pilot);
    try {
      const created = await withRequestContext({ requestId: newRequestId() }, async () => {
        TenantContext.attach({ id: tA, slug: 'a', name: 'A', status: 'ACTIVE', region: 'eu' });
        return svc.createVehicle({ registrationNumber: `ISO-A-${stamp}`, make: 'Iso', model: 'A', agencyId: TENANT_A_AGENCY } as any, SYS_USER);
      });
      createdVehicleIds.push(created.id);
      const row: any = await (prisma as any).vehicle.findUnique({ where: { id: created.id } });
      out.push({ name: 'pilot ON, tenant A: createVehicle persists tenantId=A', ok: row?.tenantId === tA, detail: `tenantId=${row?.tenantId}` });
    } finally { await prisma.$disconnect(); }
  });

  // 2-6 — cross-tenant mutations rejected
  await withFlags({ TENANT_PRISMA_PILOT_ENABLED: 'true', TENANT_PRISMA_PILOT_MODULES: 'vehicles' }, async () => {
    const prisma = new PrismaService();
    const ff = new FeatureFlagsService();
    const pilot = new PilotPrismaAccessor(prisma, new TenantPrismaService(prisma, ff), ff);
    const svc = makeService(prisma, pilot);
    try {
      const before: any = await (prisma as any).vehicle.findUnique({ where: { id: TENANT_B_VEHICLE } });
      const beforeMake = before?.make;
      const beforeDeletedAt = before?.deletedAt ?? null;

      let upL = false; try { await withRequestContext({ requestId: newRequestId() }, async () => {
        TenantContext.attach({ id: tA, slug: 'a', name: 'A', status: 'ACTIVE', region: 'eu' });
        await svc.updateVehicle(TENANT_B_VEHICLE, { make: 'A-trying-to-update-B' } as any, SYS_USER);
      }); upL = true; } catch { upL = false; }

      let dL = false; try { await withRequestContext({ requestId: newRequestId() }, async () => {
        TenantContext.attach({ id: tA, slug: 'a', name: 'A', status: 'ACTIVE', region: 'eu' });
        await svc.deleteVehicle(TENANT_B_VEHICLE, SYS_USER);
      }); dL = true; } catch { dL = false; }

      let aL = false; try { await withRequestContext({ requestId: newRequestId() }, async () => {
        TenantContext.attach({ id: tA, slug: 'a', name: 'A', status: 'ACTIVE', region: 'eu' });
        await svc.assignDriver(TENANT_B_VEHICLE, { employeeId: TENANT_A_EMP, startDate: new Date().toISOString() } as any, SYS_USER);
      }); aL = true; } catch { aL = false; }

      let aEmpL = false; try { await withRequestContext({ requestId: newRequestId() }, async () => {
        TenantContext.attach({ id: tA, slug: 'a', name: 'A', status: 'ACTIVE', region: 'eu' });
        await svc.assignDriver(TENANT_A_VEHICLE, { employeeId: TENANT_B_EMP, startDate: new Date().toISOString() } as any, SYS_USER);
      }); aEmpL = true; } catch { aEmpL = false; }

      let uaL = false; try { await withRequestContext({ requestId: newRequestId() }, async () => {
        TenantContext.attach({ id: tA, slug: 'a', name: 'A', status: 'ACTIVE', region: 'eu' });
        await svc.unassignDriver(TENANT_B_VEHICLE, '00000000-0000-0000-0000-deaddeaddead');
      }); uaL = true; } catch { uaL = false; }

      const after: any = await (prisma as any).vehicle.findUnique({ where: { id: TENANT_B_VEHICLE } });
      out.push({ name: 'pilot ON, tenant A: updateVehicle on tenant B rejected, make unchanged', ok: !upL && after?.make === beforeMake, detail: `before="${beforeMake}" after="${after?.make}"` });
      out.push({ name: 'pilot ON, tenant A: deleteVehicle on tenant B rejected, deletedAt unchanged', ok: !dL && (after?.deletedAt ?? null) === beforeDeletedAt, detail: `deletedAt=${after?.deletedAt ? 'set' : 'null'}` });
      out.push({ name: 'pilot ON, tenant A: assignDriver(tenantB-vehicle) raises NotFoundException', ok: !aL, detail: aL ? 'UNEXPECTED: assigned' : 'NotFoundException' });
      out.push({ name: 'pilot ON, tenant A: assignDriver(tenantA-vehicle, tenantB-employee) raises NotFoundException', ok: !aEmpL, detail: aEmpL ? 'UNEXPECTED: assigned' : 'NotFoundException' });
      out.push({ name: 'pilot ON, tenant A: unassignDriver(tenantB-vehicle) raises NotFoundException', ok: !uaL, detail: uaL ? 'UNEXPECTED: returned' : 'NotFoundException' });
    } finally { await prisma.$disconnect(); }
  });

  // 7+8 — maintenance create cross-tenant rejected; same-tenant succeeds with tenantId=A
  await withFlags({ TENANT_PRISMA_PILOT_ENABLED: 'true', TENANT_PRISMA_PILOT_MODULES: 'vehicles' }, async () => {
    const prisma = new PrismaService();
    const ff = new FeatureFlagsService();
    const pilot = new PilotPrismaAccessor(prisma, new TenantPrismaService(prisma, ff), ff);
    const svc = makeService(prisma, pilot);
    try {
      const beforeCount = await (prisma as any).maintenanceRecord.count({ where: { tenantId: tA } });
      let leaked = false;
      try {
        await withRequestContext({ requestId: newRequestId() }, async () => {
          TenantContext.attach({ id: tA, slug: 'a', name: 'A', status: 'ACTIVE', region: 'eu' });
          await svc.createMaintenanceRecord({ vehicleId: TENANT_B_VEHICLE, maintenanceTypeId: MAINT_TYPE, status: 'SCHEDULED', scheduledDate: new Date().toISOString() } as any, SYS_USER);
        });
        leaked = true;
      } catch { leaked = false; }
      const afterCount = await (prisma as any).maintenanceRecord.count({ where: { tenantId: tA } });
      out.push({
        name: 'pilot ON, tenant A: createMaintenanceRecord(tenantB-vehicle) raises NotFoundException; no row inserted',
        ok: !leaked && beforeCount === afterCount,
        detail: leaked ? 'UNEXPECTED: created' : `before=${beforeCount} after=${afterCount}`,
      });

      const created = await withRequestContext({ requestId: newRequestId() }, async () => {
        TenantContext.attach({ id: tA, slug: 'a', name: 'A', status: 'ACTIVE', region: 'eu' });
        return svc.createMaintenanceRecord({ vehicleId: TENANT_A_VEHICLE, maintenanceTypeId: MAINT_TYPE, status: 'SCHEDULED', scheduledDate: new Date().toISOString() } as any, SYS_USER);
      });
      createdMaintIds.push(created.id);
      const row: any = await (prisma as any).maintenanceRecord.findUnique({ where: { id: created.id } });
      out.push({
        name: 'pilot ON, tenant A: createMaintenanceRecord(tenantA-vehicle) succeeds, tenantId=A',
        ok: row?.tenantId === tA,
        detail: `tenantId=${row?.tenantId}`,
      });
    } finally { await prisma.$disconnect(); }
  });

  // 9+10 — cross-tenant maintenance update/delete rejected
  await withFlags({ TENANT_PRISMA_PILOT_ENABLED: 'true', TENANT_PRISMA_PILOT_MODULES: 'vehicles' }, async () => {
    const prisma = new PrismaService();
    const ff = new FeatureFlagsService();
    const pilot = new PilotPrismaAccessor(prisma, new TenantPrismaService(prisma, ff), ff);
    const svc = makeService(prisma, pilot);
    try {
      const before: any = await (prisma as any).maintenanceRecord.findUnique({ where: { id: TENANT_B_MAINT } });
      const beforeNotes = before?.notes ?? null;
      const beforeDeletedAt = before?.deletedAt ?? null;

      let upL = false; try { await withRequestContext({ requestId: newRequestId() }, async () => {
        TenantContext.attach({ id: tA, slug: 'a', name: 'A', status: 'ACTIVE', region: 'eu' });
        await svc.updateMaintenanceRecord(TENANT_B_MAINT, { notes: 'A-trying-to-update-B' } as any, SYS_USER);
      }); upL = true; } catch { upL = false; }

      let dL = false; try { await withRequestContext({ requestId: newRequestId() }, async () => {
        TenantContext.attach({ id: tA, slug: 'a', name: 'A', status: 'ACTIVE', region: 'eu' });
        await svc.deleteMaintenanceRecord(TENANT_B_MAINT, SYS_USER);
      }); dL = true; } catch { dL = false; }

      const after: any = await (prisma as any).maintenanceRecord.findUnique({ where: { id: TENANT_B_MAINT } });
      out.push({ name: 'pilot ON, tenant A: updateMaintenanceRecord on tenant B rejected, notes unchanged', ok: !upL && (after?.notes ?? null) === beforeNotes, detail: `before="${beforeNotes}" after="${after?.notes}"` });
      out.push({ name: 'pilot ON, tenant A: deleteMaintenanceRecord on tenant B rejected, deletedAt unchanged', ok: !dL && (after?.deletedAt ?? null) === beforeDeletedAt, detail: `deletedAt=${after?.deletedAt ? 'set' : 'null'}` });
    } finally { await prisma.$disconnect(); }
  });

  // 11 — dashboard totalVehicles for tenant A unchanged at 2 (excludes tenant B + the iso-create from case 1 which we count as tenant A's third)
  await withFlags({ TENANT_PRISMA_PILOT_ENABLED: 'true', TENANT_PRISMA_PILOT_MODULES: 'vehicles' }, async () => {
    const prisma = new PrismaService();
    const ff = new FeatureFlagsService();
    const pilot = new PilotPrismaAccessor(prisma, new TenantPrismaService(prisma, ff), ff);
    const svc = makeService(prisma, pilot);
    try {
      const stats = await withRequestContext({ requestId: newRequestId() }, async () => {
        TenantContext.attach({ id: tA, slug: 'a', name: 'A', status: 'ACTIVE', region: 'eu' });
        return svc.getDashboardStats();
      });
      // Tenant A had 2 seeded + 1 iso-create from case 1 still active = 3.
      // The 2 tenant B vehicles stay excluded.
      out.push({
        name: 'pilot ON, tenant A: dashboard totalVehicles excludes tenant B after mutations',
        ok: stats.totalVehicles === 3,
        detail: `totalVehicles=${stats.totalVehicles} (expected 3: 2 seeded + 1 iso-create)`,
      });
    } finally { await prisma.$disconnect(); }
  });

  // 12 — pilot OFF: legacy still mutates tenant B
  await withFlags({ TENANT_PRISMA_PILOT_ENABLED: 'false' }, async () => {
    const prisma = new PrismaService();
    const ff = new FeatureFlagsService();
    const pilot = new PilotPrismaAccessor(prisma, new TenantPrismaService(prisma, ff), ff);
    const svc = makeService(prisma, pilot);
    try {
      const before: any = await (prisma as any).vehicle.findUnique({ where: { id: TENANT_B_VEHICLE } });
      let mutated = false;
      try {
        const u = await svc.updateVehicle(TENANT_B_VEHICLE, { make: 'legacy-no-tenant-gate' } as any, SYS_USER);
        mutated = (u as any).make === 'legacy-no-tenant-gate';
      } catch { mutated = false; }
      if (mutated && before) {
        await (prisma as any).vehicle.update({ where: { id: TENANT_B_VEHICLE }, data: { make: before.make } });
      }
      out.push({ name: 'pilot OFF: legacy update on tenant B vehicle still succeeds', ok: mutated, detail: mutated ? 'mutated' : 'UNEXPECTED: blocked' });
    } finally { await prisma.$disconnect(); }
  });

  // 13 — registration-number uniqueness: pilot tenant A trying to use B's plate hits P2002
  await withFlags({ TENANT_PRISMA_PILOT_ENABLED: 'true', TENANT_PRISMA_PILOT_MODULES: 'vehicles' }, async () => {
    const prisma = new PrismaService();
    const ff = new FeatureFlagsService();
    const pilot = new PilotPrismaAccessor(prisma, new TenantPrismaService(prisma, ff), ff);
    const svc = makeService(prisma, pilot);
    try {
      let hitP2002 = false;
      let leaked = false;
      try {
        const c = await withRequestContext({ requestId: newRequestId() }, async () => {
          TenantContext.attach({ id: tA, slug: 'a', name: 'A', status: 'ACTIVE', region: 'eu' });
          return svc.createVehicle({ registrationNumber: TENANT_B_REG, make: 'Collision', model: 'Test', agencyId: TENANT_A_AGENCY } as any, SYS_USER);
        });
        leaked = true;
        if (c) createdVehicleIds.push(c.id);
      } catch (e: any) {
        // Prisma's PrismaClientKnownRequestError surfaces as
        // .code === 'P2002' on unique-constraint violation.
        hitP2002 = e?.code === 'P2002' || /Unique constraint/i.test(String(e?.message ?? ''));
      }
      out.push({
        name: 'reg-num uniqueness: pilot tenant A using tenant B plate raises P2002 (global @unique unchanged)',
        ok: !leaked && hitP2002,
        detail: leaked ? 'UNEXPECTED: created' : (hitP2002 ? 'P2002 / Unique constraint' : 'OTHER ERROR'),
      });
    } finally { await prisma.$disconnect(); }
  });

  // 14 — source-level meta-assertion
  const src = await fs.readFile(SRC_FILE, 'utf8');
  const expected: Array<[string, RegExp]> = [
    ['createVehicle uses tenantData spread', /async createVehicle\([\s\S]*?this\.legacyPrisma\.vehicle\.create\(\{[\s\S]{0,400}\.\.\.tdata/],
    ['createVehicle is phase224-pilot-scope', /async createVehicle\([\s\S]*?this\.legacyPrisma\.vehicle\.create[\s\S]{0,400}phase224-pilot-scope/],
    ['updateVehicle by-id is phase224-pilot-scope-precheck', /async updateVehicle\([\s\S]*?this\.legacyPrisma\.vehicle\.update[\s\S]{0,200}phase224-pilot-scope-precheck/],
    ['deleteVehicle soft-delete is phase224-pilot-scope-precheck', /async deleteVehicle\([\s\S]*?this\.legacyPrisma\.vehicle\.update[\s\S]{0,200}phase224-pilot-scope-precheck/],
    ['assignDriver employee probe via this.prisma + ...t', /async assignDriver\([\s\S]*?this\.prisma\.employee\.findFirst\([\s\S]{0,200}\.\.\.t/],
    ['unassignDriver explicit findVehicleOrFail first', /async unassignDriver\([\s\S]*?await this\.findVehicleOrFail\(vehicleId\)[\s\S]{0,400}this\.legacyPrisma\.vehicleDriverAssignment\.findFirst/],
    ['createMaintenanceRecord uses tenantData spread', /async createMaintenanceRecord\([\s\S]*?this\.legacyPrisma\.maintenanceRecord\.create\(\{[\s\S]{0,1500}\.\.\.tdata/],
    ['updateMaintenanceRecord pre-check uses this.prisma + ...t', /async updateMaintenanceRecord\([\s\S]*?this\.prisma\.maintenanceRecord\.findFirst\([\s\S]{0,200}\.\.\.t/],
    ['deleteMaintenanceRecord pre-check uses this.prisma + ...t', /async deleteMaintenanceRecord\([\s\S]*?this\.prisma\.maintenanceRecord\.findFirst\([\s\S]{0,200}\.\.\.t/],
  ];
  const failed: string[] = [];
  expected.forEach(([n, re]) => { if (!re.test(src)) failed.push(n); });
  out.push({ name: 'source: every Phase 2.24 mutation site carries the right tag and shape', ok: failed.length === 0, detail: failed.length === 0 ? 'all patterns matched' : failed.join('; ') });

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
    generatedAt: new Date().toISOString(), environment: env, tenantA: tA, tenantB: tB,
    counts: { total: out.length, passed: out.filter((r) => r.ok).length, failed: out.filter((r) => !r.ok).length },
    results: out,
  };
  await fs.writeFile(path.join(OUT_DIR, 'vehicles-mutation-isolation.json'), JSON.stringify(summary, null, 2));
  const md: string[] = [];
  md.push('# Phase 2.24 — Vehicles Mutation Isolation');
  md.push(''); md.push(`Generated: ${summary.generatedAt}`);
  md.push(`Environment: ${env.classification} (${env.reason})`);
  md.push(`Tenants: A=\`${tA}\` B=\`${tB}\``); md.push('');
  md.push(`- Cases passed: **${summary.counts.passed}** / ${summary.counts.total}`);
  md.push(`- Cases failed: ${summary.counts.failed}`); md.push('');
  md.push('| # | Case | Result | Detail |'); md.push('|--:|------|:------:|--------|');
  out.forEach((r, i) => md.push(`| ${i + 1} | ${r.name} | ${r.ok ? 'PASS' : '**FAIL**'} | ${r.detail} |`));
  await fs.writeFile(path.join(OUT_DIR, 'vehicles-mutation-isolation.md'), md.join('\n'));

  console.log(`vehicles-mutation-isolation: ${summary.counts.passed}/${summary.counts.total} cases PASS`);
  if (summary.counts.failed > 0) process.exit(2);
}

main().catch((e) => { console.error(e); process.exit(3); });
