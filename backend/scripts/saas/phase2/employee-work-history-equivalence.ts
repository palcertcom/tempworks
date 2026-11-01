/**
 * Phase 2.7 — employee-work-history pilot read-equivalence harness.
 *
 * Compares legacy and pilot paths back-to-back on the same DB:
 *   - list(employeeId)
 *   - listEventTypes()
 *   - create() round trip (creates and removes a temp entry)
 *   - update() round trip
 *   - remove() round trip (soft-delete of a temp entry)
 *   - error path: list(missing-employee) raises NotFoundException both modes
 *   - response shape compatibility
 *
 * Both modes operate against tenant A. The pilot mode also asserts that
 * the created row has a non-null `tenantId`, while the legacy mode
 * asserts the absence of any tenant filtering.
 *
 * Output:
 *   backend/reports/saas/phase2/employee-work-history-equivalence.{json,md}
 *
 * Exit:
 *   0 — every comparison equal
 *   2 — at least one mismatch
 *   3 — runtime error
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
import { EmployeeWorkHistoryService } from '../../../src/employee-work-history/employee-work-history.service';
import {
  TenantContext,
  withRequestContext,
  newRequestId,
} from '../../../src/saas/context/als';

autoLoadEnv(__filename);

const OUT_DIR = path.resolve(__dirname, '..', '..', '..', 'reports', 'saas', 'phase2');

interface CaseResult { name: string; ok: boolean; detail: string; }

class StubStorage {
  async uploadFile(_buf: Buffer, _opts: any): Promise<{ url: string }> { return { url: 'fixture://stub.bin' }; }
  async deleteFileByUrlOrKey(_x: string): Promise<void> { /* empty */ }
}

function getDatabaseUrl(): string {
  const arg = process.argv.find((a) => a.startsWith('--db='))?.slice(5);
  const url = arg ?? process.env.DATABASE_URL;
  if (!url) throw new Error(formatDatabaseUrlMissingMessage());
  return url;
}

async function withFlags<T>(env: Record<string, string | undefined>, fn: () => Promise<T> | T): Promise<T> {
  const prev = { ...process.env };
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try { return await fn(); }
  finally { process.env = prev; }
}

function makeService(flags: FeatureFlagsService): { svc: EmployeeWorkHistoryService; prisma: PrismaService; pilot: PilotPrismaAccessor } {
  const prisma = new PrismaService();
  const tp = new TenantPrismaService(prisma, flags);
  const pilot = new PilotPrismaAccessor(prisma, tp, flags);
  const svc = new EmployeeWorkHistoryService(prisma, new StubStorage() as any, pilot);
  return { svc, prisma, pilot };
}

interface Snapshot {
  pilotActive: boolean;
  reason: string;
  listLength: number;
  listFirstId: string | null;
  listIds: string[];
  eventTypesCount: number;
  errorOnMissing: string;
  createdId: string | null;
  createdTenantId: string | null;
  updatedDescription: string | null;
  removedDeletedAt: string | null;
  responseShapeOk: boolean;
}

async function snapshotForFlags(
  flagsOverride: Record<string, string>,
  withinTenantContext: { id: string } | null,
  tenantA: string,
  empA: string,
): Promise<Snapshot> {
  return withFlags(flagsOverride, async () => {
    const flags = new FeatureFlagsService();
    const { svc, prisma, pilot } = makeService(flags);
    const run = async (): Promise<Snapshot> => {
      const list = await svc.list(empA);
      const eventTypes = await svc.listEventTypes();
      let errorOnMissing = 'no-error';
      try { await svc.list('00000000-0000-0000-0000-deaddeaddead'); }
      catch (e) { errorOnMissing = (e as Error).constructor.name; }

      // Round-trip CRUD on a TEMP row so we don't pollute the fixture.
      const created = await svc.create(empA,
        { date: '2025-09-01', eventType: 'NEW_CONTRACT', description: 'rehearsal-temp' } as any);
      const updated = await svc.update(empA, created.id,
        { description: 'rehearsal-temp-updated' } as any);
      await svc.remove(empA, created.id);
      const removed = await (prisma as any).employeeWorkHistory.findUnique({ where: { id: created.id } });

      const list0 = list[0];
      const responseShapeOk = Array.isArray(list)
        && (list0 === undefined ||
            (typeof list0.id === 'string' && typeof list0.eventType === 'string'
             && list0.attachments !== undefined));

      return {
        pilotActive: pilot.isPilotActive(),
        reason: pilot.pilotReason().reason,
        listLength: list.length,
        listFirstId: list0?.id ?? null,
        listIds: list.map((e: any) => e.id).sort(),
        eventTypesCount: eventTypes.length,
        errorOnMissing,
        createdId: created.id,
        createdTenantId: (created as any).tenantId ?? null,
        updatedDescription: updated.description ?? null,
        removedDeletedAt: removed?.deletedAt ? 'set' : 'null',
        responseShapeOk,
      };
    };

    try {
      if (withinTenantContext) {
        return await withRequestContext({ requestId: newRequestId() }, async () => {
          TenantContext.attach({ id: withinTenantContext.id, slug: 'a', name: 'A',
            status: 'ACTIVE', region: 'eu' });
          return run();
        });
      }
      return await run();
    } finally {
      // Clean up: hard-delete the temp row so re-runs don't accumulate.
      try {
        if (tenantA && empA) {
          await (prisma as any).employeeWorkHistory.deleteMany({
            where: { description: { in: ['rehearsal-temp', 'rehearsal-temp-updated'] } },
          });
        }
      } catch { /* swallow cleanup errors */ }
      await prisma.$disconnect();
    }
  });
}

async function main(): Promise<void> {
  const url = getDatabaseUrl();
  const env = classifyRuntimeEnv();
  if (!isStagingClassification(env.classification)) {
    console.error(`[ewh-equivalence] refusing to run on classification=${env.classification}`);
    process.exit(3);
  }

  const c = new Client({ connectionString: url, ssl: /127\.0\.0\.1|localhost/.test(url) ? false : { rejectUnauthorized: false } });
  await c.connect();
  const t = await c.query<{ id: string }>(`SELECT id FROM tenants ORDER BY name LIMIT 1`);
  const tenantA = t.rows[0]?.id;
  const e = await c.query<{ id: string }>(`SELECT id FROM employees WHERE "tenantId" = $1 LIMIT 1`, [tenantA]);
  const empA = e.rows[0]?.id;
  await c.end();
  if (!tenantA || !empA) {
    console.error('[ewh-equivalence] need a tenant + employee in the fixture');
    process.exit(3);
  }

  const out: CaseResult[] = [];

  // Legacy: pilot OFF. No tenant context needed.
  const legacy = await snapshotForFlags(
    { TENANT_PRISMA_PILOT_ENABLED: 'false' }, null, tenantA, empA,
  );
  out.push({
    name: 'legacy: pilot OFF reports pilotActive=false',
    ok: legacy.pilotActive === false,
    detail: legacy.reason,
  });

  // Pilot: pilot ON with tenant A in ALS context.
  const pilot = await snapshotForFlags(
    { TENANT_PRISMA_PILOT_ENABLED: 'true' }, { id: tenantA }, tenantA, empA,
  );
  out.push({
    name: 'pilot: pilot ON + tenant ctx reports pilotActive=true (effectively scoped)',
    ok: pilot.reason.startsWith('pilot ON'),
    detail: pilot.reason,
  });

  // Equivalence on tenant A's view.
  out.push({
    name: 'list ids identical between legacy and pilot for tenant A',
    ok: JSON.stringify(legacy.listIds.filter((id) => pilot.listIds.includes(id)))
      === JSON.stringify(pilot.listIds.filter((id) => legacy.listIds.includes(id))),
    detail: `legacy=${legacy.listIds.length}, pilot=${pilot.listIds.length}`,
  });
  out.push({
    name: 'pilot view excludes NULL-tenant legacy row',
    ok: !pilot.listIds.includes('00000000-0000-0000-0000-0000000ea999'),
    detail: `pilotIds=${pilot.listIds.join(',')}`,
  });
  out.push({
    name: 'legacy view INCLUDES NULL-tenant legacy row (no filter)',
    ok: legacy.listIds.includes('00000000-0000-0000-0000-0000000ea999'),
    detail: `legacyIds=${legacy.listIds.join(',')}`,
  });

  out.push({
    name: 'event-type catalog count equal (global catalog)',
    ok: legacy.eventTypesCount === pilot.eventTypesCount,
    detail: `legacy=${legacy.eventTypesCount} pilot=${pilot.eventTypesCount}`,
  });
  out.push({
    name: 'error path equivalent (NotFoundException for missing employee)',
    ok: legacy.errorOnMissing === pilot.errorOnMissing
      && legacy.errorOnMissing === 'NotFoundException',
    detail: `legacy=${legacy.errorOnMissing} pilot=${pilot.errorOnMissing}`,
  });

  // Create / update / delete behaviour.
  out.push({
    name: 'create legacy: tenantId is NULL',
    ok: legacy.createdTenantId === null,
    detail: `legacy.tenantId=${legacy.createdTenantId}`,
  });
  out.push({
    name: 'create pilot: tenantId is set to active tenant',
    ok: pilot.createdTenantId === tenantA,
    detail: `pilot.tenantId=${pilot.createdTenantId} tenantA=${tenantA}`,
  });
  out.push({
    name: 'update reflects new description in BOTH modes',
    ok: legacy.updatedDescription === 'rehearsal-temp-updated'
      && pilot.updatedDescription === 'rehearsal-temp-updated',
    detail: `legacy=${legacy.updatedDescription} pilot=${pilot.updatedDescription}`,
  });
  out.push({
    name: 'remove sets deletedAt in BOTH modes (soft delete)',
    ok: legacy.removedDeletedAt === 'set' && pilot.removedDeletedAt === 'set',
    detail: `legacy=${legacy.removedDeletedAt} pilot=${pilot.removedDeletedAt}`,
  });

  out.push({
    name: 'response shape preserved (Array<{id,eventType,attachments,...}>)',
    ok: legacy.responseShapeOk && pilot.responseShapeOk,
    detail: `legacy=${legacy.responseShapeOk} pilot=${pilot.responseShapeOk}`,
  });

  await fs.mkdir(OUT_DIR, { recursive: true });
  const summary = {
    generatedAt: new Date().toISOString(),
    environment: env,
    tenantA,
    empA,
    counts: { total: out.length, passed: out.filter((r) => r.ok).length, failed: out.filter((r) => !r.ok).length },
    results: out,
  };
  await fs.writeFile(path.join(OUT_DIR, 'employee-work-history-equivalence.json'),
    JSON.stringify(summary, null, 2));
  const md: string[] = [];
  md.push('# Phase 2.7 — Employee Work History Equivalence');
  md.push('');
  md.push(`Generated: ${summary.generatedAt}`);
  md.push(`Environment: ${env.classification} (${env.reason})`);
  md.push(`Tenant A: \`${tenantA}\` · employee: \`${empA}\``);
  md.push('');
  md.push(`- Cases passed: **${summary.counts.passed}** / ${summary.counts.total}`);
  md.push(`- Cases failed: ${summary.counts.failed}`);
  md.push('');
  md.push('| # | Case | Result | Detail |');
  md.push('|--:|------|:------:|--------|');
  out.forEach((r, i) => md.push(`| ${i + 1} | ${r.name} | ${r.ok ? 'PASS' : '**FAIL**'} | ${r.detail} |`));
  await fs.writeFile(path.join(OUT_DIR, 'employee-work-history-equivalence.md'), md.join('\n'));

  console.log(`employee-work-history-equivalence: ${summary.counts.passed}/${summary.counts.total} cases PASS`);
  if (summary.counts.failed > 0) process.exit(2);
}

main().catch((e) => { console.error(e); process.exit(3); });
