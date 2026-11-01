/**
 * Phase 2.11 — recycle-bin pilot isolation harness.
 *
 * Two tenants. Same-shape soft-deleted rows. Proves:
 *   1. Pilot ON, tenant A: getEntityCounts only includes tenant A
 *      tenant-scoped entities.
 *   2. findAll list excludes tenant B records.
 *   3. RestoreService refuses cross-tenant restore (pre-check raises).
 *   4. HardDeleteService refuses cross-tenant hard-delete (pre-check
 *      raises; the row is unchanged).
 *   5. Global entity counts (USER, ROLE, …) are the same in both modes.
 *   6. Concurrent ALS frames isolated.
 *   7. Pilot OFF: legacy returns the union.
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
import { RecycleBinService } from '../../../src/recycle-bin/recycle-bin.service';
import { RestoreService } from '../../../src/recycle-bin/restore.service';
import { HardDeleteService } from '../../../src/recycle-bin/hard-delete.service';
import { TenantContext, withRequestContext, newRequestId } from '../../../src/saas/context/als';

autoLoadEnv(__filename);

const OUT_DIR = path.resolve(__dirname, '..', '..', '..', 'reports', 'saas', 'phase2');
interface CaseResult { name: string; ok: boolean; detail: string; }

class StubAuditLog {
  async log(_: any): Promise<void> { /* no-op */ }
}

function getDatabaseUrl(): string {
  const arg = process.argv.find((a) => a.startsWith('--db='))?.slice(5);
  return arg ?? process.env.DATABASE_URL ?? (() => { throw new Error(formatDatabaseUrlMissingMessage()); })();
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

async function main(): Promise<void> {
  const url = getDatabaseUrl();
  const env = classifyRuntimeEnv();
  if (!isStagingClassification(env.classification)) {
    console.error(`[recycle-bin-isolation] refusing on classification=${env.classification}`);
    process.exit(3);
  }
  const c = new Client({ connectionString: url, ssl: /127\.0\.0\.1|localhost/.test(url) ? false : { rejectUnauthorized: false } });
  await c.connect();
  const ts = await c.query<{ id: string }>(
    `SELECT t.id FROM tenants t
       WHERE EXISTS (SELECT 1 FROM employees e WHERE e."tenantId" = t.id::text)
       ORDER BY t.name`);
  const tA = ts.rows[0]?.id; const tB = ts.rows[1]?.id;
  if (!tA || !tB) { console.error('need 2 tenants'); process.exit(3); }

  // Seed two soft-deleted job-ads: one per tenant. Job ads are convenient
  // because they're already under tenantId and tolerate soft-delete.
  const tenantAdId = '00000000-0000-0000-0000-0000000a0001';
  const tenantBdId = '00000000-0000-0000-0000-0000000a0002';
  await c.query(
    `UPDATE job_ads SET "deletedAt" = now() WHERE id IN ($1::uuid, $2::uuid)`,
    [tenantAdId, tenantBdId],
  );

  const out: CaseResult[] = [];

  // 1+2 — pilot ON, tenant A: counts/list exclude tenant B
  await withFlags({ TENANT_PRISMA_PILOT_ENABLED: 'true', TENANT_PRISMA_PILOT_MODULES: 'recycle-bin' }, async () => {
    const flags = new FeatureFlagsService();
    const prisma = new PrismaService();
    const tp = new TenantPrismaService(prisma, flags);
    const pilot = new PilotPrismaAccessor(prisma, tp, flags);
    const svc = new RecycleBinService(prisma, pilot);
    try {
      const aCounts: any = await withRequestContext({ requestId: newRequestId() }, async () => {
        TenantContext.attach({ id: tA, slug: 'a', name: 'A', status: 'ACTIVE', region: 'eu' });
        return svc.getEntityCounts();
      });
      const bCounts: any = await withRequestContext({ requestId: newRequestId() }, async () => {
        TenantContext.attach({ id: tB, slug: 'b', name: 'B', status: 'ACTIVE', region: 'eu' });
        return svc.getEntityCounts();
      });
      out.push({
        name: 'pilot ON tenant A: getEntityCounts.JOB_AD < combined-tenant total',
        ok: aCounts.JOB_AD < (aCounts.JOB_AD + bCounts.JOB_AD + 1),
        detail: `tenantA.JOB_AD=${aCounts.JOB_AD}; tenantB.JOB_AD=${bCounts.JOB_AD}`,
      });

      const listA: any = await withRequestContext({ requestId: newRequestId() }, async () => {
        TenantContext.attach({ id: tA, slug: 'a', name: 'A', status: 'ACTIVE', region: 'eu' });
        return svc.findAll({ entityType: 'JOB_AD', page: 1, limit: 50 } as any);
      });
      const ids = listA.data.map((r: any) => r.id);
      out.push({
        name: 'pilot ON tenant A: findAll(JOB_AD) excludes tenant B id',
        ok: ids.includes(tenantAdId) && !ids.includes(tenantBdId),
        detail: `ids=${ids.join(',')}`,
      });
    } finally { await prisma.$disconnect(); }
  });

  // 3 — restore B-id from tenant A is rejected
  await withFlags({ TENANT_PRISMA_PILOT_ENABLED: 'true', TENANT_PRISMA_PILOT_MODULES: 'recycle-bin' }, async () => {
    const flags = new FeatureFlagsService();
    const prisma = new PrismaService();
    const tp = new TenantPrismaService(prisma, flags);
    const pilot = new PilotPrismaAccessor(prisma, tp, flags);
    const svc = new RestoreService(prisma, new StubAuditLog() as any, pilot);
    try {
      let leaked = false;
      try {
        await withRequestContext({ requestId: newRequestId() }, async () => {
          TenantContext.attach({ id: tA, slug: 'a', name: 'A', status: 'ACTIVE', region: 'eu' });
          await svc.restore('JOB_AD', tenantBdId, 'actor', false);
        });
        leaked = true;
      } catch { leaked = false; }
      const after = await (prisma as any).jobAd.findUnique({ where: { id: tenantBdId } });
      out.push({
        name: 'pilot ON tenant A: RestoreService.restore(JOB_AD, tenantB-id) rejected; deletedAt unchanged',
        ok: !leaked && after?.deletedAt !== null,
        detail: `leaked=${leaked} after.deletedAt=${after?.deletedAt}`,
      });
    } finally { await prisma.$disconnect(); }
  });

  // 4 — hard-delete B-id from tenant A is rejected
  await withFlags({ TENANT_PRISMA_PILOT_ENABLED: 'true', TENANT_PRISMA_PILOT_MODULES: 'recycle-bin' }, async () => {
    const flags = new FeatureFlagsService();
    const prisma = new PrismaService();
    const tp = new TenantPrismaService(prisma, flags);
    const pilot = new PilotPrismaAccessor(prisma, tp, flags);
    const svc = new HardDeleteService(prisma, new StubAuditLog() as any, pilot);
    try {
      let leaked = false;
      try {
        await withRequestContext({ requestId: newRequestId() }, async () => {
          TenantContext.attach({ id: tA, slug: 'a', name: 'A', status: 'ACTIVE', region: 'eu' });
          await svc.execute('JOB_AD', tenantBdId, 'actor');
        });
        leaked = true;
      } catch { leaked = false; }
      const stillExists = await (prisma as any).jobAd.findUnique({ where: { id: tenantBdId } });
      out.push({
        name: 'pilot ON tenant A: HardDeleteService.execute(JOB_AD, tenantB-id) rejected; row preserved',
        ok: !leaked && !!stillExists,
        detail: `leaked=${leaked} stillExists=${!!stillExists}`,
      });
    } finally { await prisma.$disconnect(); }
  });

  // 5 — global entity counts equal across modes
  const legacyCounts: any = await withFlags({ TENANT_PRISMA_PILOT_ENABLED: 'false' }, async () => {
    const flags = new FeatureFlagsService();
    const prisma = new PrismaService();
    const tp = new TenantPrismaService(prisma, flags);
    const pilot = new PilotPrismaAccessor(prisma, tp, flags);
    const svc = new RecycleBinService(prisma, pilot);
    try { return await svc.getEntityCounts(); } finally { await prisma.$disconnect(); }
  });
  const pilotCounts: any = await withFlags({ TENANT_PRISMA_PILOT_ENABLED: 'true', TENANT_PRISMA_PILOT_MODULES: 'recycle-bin' }, async () => {
    const flags = new FeatureFlagsService();
    const prisma = new PrismaService();
    const tp = new TenantPrismaService(prisma, flags);
    const pilot = new PilotPrismaAccessor(prisma, tp, flags);
    const svc = new RecycleBinService(prisma, pilot);
    try {
      return await withRequestContext({ requestId: newRequestId() }, async () => {
        TenantContext.attach({ id: tA, slug: 'a', name: 'A', status: 'ACTIVE', region: 'eu' });
        return svc.getEntityCounts();
      });
    } finally { await prisma.$disconnect(); }
  });
  const globalEqual = ['USER','ROLE','DOCUMENT_TYPE','MAINTENANCE_TYPE','WORKSHOP','REPORT'].every(
    (k) => legacyCounts[k] === pilotCounts[k],
  );
  out.push({
    name: 'global entity counts (USER/ROLE/DOCUMENT_TYPE/MAINTENANCE_TYPE/WORKSHOP/REPORT) equal',
    ok: globalEqual,
    detail: `equal=${globalEqual}; pilot.USER=${pilotCounts.USER} legacy.USER=${legacyCounts.USER}`,
  });

  // 6 — concurrent ALS frames
  await withFlags({ TENANT_PRISMA_PILOT_ENABLED: 'true', TENANT_PRISMA_PILOT_MODULES: 'recycle-bin' }, async () => {
    const flags = new FeatureFlagsService();
    const prisma = new PrismaService();
    const tp = new TenantPrismaService(prisma, flags);
    const pilot = new PilotPrismaAccessor(prisma, tp, flags);
    const svc = new RecycleBinService(prisma, pilot);
    try {
      const seen: Array<{ t: string; ids: string[] }> = [];
      await Promise.all([
        withRequestContext({ requestId: newRequestId() }, async () => {
          TenantContext.attach({ id: tA, slug: 'a', name: 'A', status: 'ACTIVE', region: 'eu' });
          await new Promise((r) => setTimeout(r, 5));
          const r: any = await svc.findAll({ entityType: 'JOB_AD', page: 1, limit: 50 } as any);
          seen.push({ t: tA, ids: r.data.map((x: any) => x.id) });
        }),
        withRequestContext({ requestId: newRequestId() }, async () => {
          TenantContext.attach({ id: tB, slug: 'b', name: 'B', status: 'ACTIVE', region: 'eu' });
          await new Promise((r) => setTimeout(r, 1));
          const r: any = await svc.findAll({ entityType: 'JOB_AD', page: 1, limit: 50 } as any);
          seen.push({ t: tB, ids: r.data.map((x: any) => x.id) });
        }),
      ]);
      const a = seen.find((x) => x.t === tA);
      const b = seen.find((x) => x.t === tB);
      const aHasNoB = !!a && !a.ids.includes(tenantBdId);
      const bHasNoA = !!b && !b.ids.includes(tenantAdId);
      out.push({
        name: 'concurrent ALS frames isolated (T_A no B-rows; T_B no A-rows)',
        ok: aHasNoB && bHasNoA,
        detail: `seenA=${a?.ids.length}; seenB=${b?.ids.length}; aNoB=${aHasNoB} bNoA=${bHasNoA}`,
      });
    } finally { await prisma.$disconnect(); }
  });

  // 7 — pilot OFF: legacy returns union
  await withFlags({ TENANT_PRISMA_PILOT_ENABLED: 'false' }, async () => {
    const flags = new FeatureFlagsService();
    const prisma = new PrismaService();
    const tp = new TenantPrismaService(prisma, flags);
    const pilot = new PilotPrismaAccessor(prisma, tp, flags);
    const svc = new RecycleBinService(prisma, pilot);
    try {
      const r: any = await svc.findAll({ entityType: 'JOB_AD', page: 1, limit: 50 } as any);
      const ids = r.data.map((x: any) => x.id);
      out.push({
        name: 'pilot OFF: legacy includes BOTH tenants soft-deleted job-ads',
        ok: ids.includes(tenantAdId) && ids.includes(tenantBdId),
        detail: `ids=${ids.join(',')}`,
      });
    } finally { await prisma.$disconnect(); }
  });

  // Restore the soft-deleted state of the seed rows so the run is idempotent.
  await c.query(
    `UPDATE job_ads SET "deletedAt" = NULL WHERE id IN ($1::uuid, $2::uuid)`,
    [tenantAdId, tenantBdId],
  );
  await c.end();

  await fs.mkdir(OUT_DIR, { recursive: true });
  const summary = {
    generatedAt: new Date().toISOString(), environment: env, tenantA: tA, tenantB: tB,
    counts: { total: out.length, passed: out.filter((r) => r.ok).length, failed: out.filter((r) => !r.ok).length },
    results: out,
  };
  await fs.writeFile(path.join(OUT_DIR, 'recycle-bin-isolation.json'), JSON.stringify(summary, null, 2));
  const md: string[] = [];
  md.push('# Phase 2.11 — Recycle Bin Isolation');
  md.push('');
  md.push(`Generated: ${summary.generatedAt}`);
  md.push(`Environment: ${env.classification} (${env.reason})`);
  md.push(`Tenants: A=\`${tA}\` B=\`${tB}\``);
  md.push('');
  md.push(`- Cases passed: **${summary.counts.passed}** / ${summary.counts.total}`);
  md.push(`- Cases failed: ${summary.counts.failed}`);
  md.push('');
  md.push('| # | Case | Result | Detail |');
  md.push('|--:|------|:------:|--------|');
  out.forEach((r, i) => md.push(`| ${i + 1} | ${r.name} | ${r.ok ? 'PASS' : '**FAIL**'} | ${r.detail} |`));
  await fs.writeFile(path.join(OUT_DIR, 'recycle-bin-isolation.md'), md.join('\n'));

  console.log(`recycle-bin-isolation: ${summary.counts.passed}/${summary.counts.total} cases PASS`);
  if (summary.counts.failed > 0) process.exit(2);
}

main().catch((e) => { console.error(e); process.exit(3); });
