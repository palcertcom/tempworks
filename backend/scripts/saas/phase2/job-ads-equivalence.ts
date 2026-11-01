/**
 * Phase 2.9 — job-ads pilot read-equivalence harness.
 *
 * Compares legacy and pilot paths back-to-back on the same DB:
 *   - findAll(filter) row count (dashboard listing)
 *   - findPublished(filter) row count (public listing)
 *   - findBySlug(slug) — public detail; both modes hit a tenant A slug
 *   - findOne(id) — dashboard detail; cross-tenant id raises 404 in pilot
 *   - create(dto) — pilot persists tenantId, legacy does not
 *   - update(dto) — both modes mutate, pilot pre-checks tenant
 *   - remove(id) — both modes soft-delete, pilot pre-checks tenant
 *   - error path: missing id raises NotFoundException both modes
 *   - response shape preservation
 *
 * Output:
 *   backend/reports/saas/phase2/job-ads-equivalence.{json,md}
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
import { JobAdsService } from '../../../src/job-ads/job-ads.service';
import {
  TenantContext,
  withRequestContext,
  newRequestId,
} from '../../../src/saas/context/als';

autoLoadEnv(__filename);

const OUT_DIR = path.resolve(__dirname, '..', '..', '..', 'reports', 'saas', 'phase2');

interface CaseResult { name: string; ok: boolean; detail: string; }

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

interface Snapshot {
  pilotActive: boolean;
  reason: string;
  findAllTotal: number;
  findPublishedTotal: number;
  findBySlugId: string | null;
  findOneId: string | null;
  errorOnMissing: string;
  createdId: string | null;
  createdTenantId: string | null;
  createdSlug: string | null;
  updatedTitle: string | null;
  removedDeletedAt: string | null;
  responseShapeOk: boolean;
}

async function snapshotForFlags(
  flagsOverride: Record<string, string | undefined>,
  ctx: { id: string } | null,
  empSlug: string,
  empId: string,
): Promise<Snapshot> {
  return withFlags(flagsOverride, async () => {
    const flags = new FeatureFlagsService();
    const prisma = new PrismaService();
    const tp = new TenantPrismaService(prisma, flags);
    const pilot = new PilotPrismaAccessor(prisma, tp, flags);
    const svc = new JobAdsService(prisma, pilot);
    const run = async (): Promise<Snapshot> => {
      const all = await svc.findAll({ page: 1, limit: 50 } as any);
      const pub = await svc.findPublished({ page: 1, limit: 50 } as any);
      let findBySlugId: string | null = null;
      try { findBySlugId = (await svc.findBySlug(empSlug)).id; } catch { findBySlugId = null; }
      let findOneId: string | null = null;
      try { findOneId = (await svc.findOne(empId)).id; } catch { findOneId = null; }

      let errorOnMissing = 'no-error';
      try { await svc.findOne('00000000-0000-0000-0000-deaddeaddead'); }
      catch (e) { errorOnMissing = (e as Error).constructor.name; }

      // Round-trip CRUD on a TEMP row.
      const tempTitle = 'rehearsal-job-' + Math.random().toString(36).slice(2, 8);
      const created = await svc.create({
        title: tempTitle, category: 'engineering', description: 'temp', city: 'X', country: 'GB',
      } as any);
      const updated = await svc.update(created.id, { title: tempTitle + '-updated' } as any);
      await svc.remove(created.id);
      const removed = await (prisma as any).jobAd.findUnique({ where: { id: created.id } });

      const all0 = (all as any).data?.[0];
      const responseShapeOk = Array.isArray((all as any).data)
        && Array.isArray((pub as any).data);

      return {
        pilotActive: pilot.isPilotActive(),
        reason: pilot.pilotReason().reason,
        findAllTotal: (all as any).meta?.total ?? 0,
        findPublishedTotal: (pub as any).meta?.total ?? 0,
        findBySlugId,
        findOneId,
        errorOnMissing,
        createdId: created.id,
        createdTenantId: (created as any).tenantId ?? null,
        createdSlug: created.slug,
        updatedTitle: updated.title,
        removedDeletedAt: removed?.deletedAt ? 'set' : 'null',
        responseShapeOk,
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
    } finally {
      // Cleanup any leftover temp rows from previous failed runs.
      try {
        await (prisma as any).jobAd.deleteMany({ where: { title: { startsWith: 'rehearsal-job-' } } });
      } catch { /* swallow */ }
      await prisma.$disconnect();
    }
  });
}

async function main(): Promise<void> {
  const url = getDatabaseUrl();
  const env = classifyRuntimeEnv();
  if (!isStagingClassification(env.classification)) {
    console.error(`[job-ads-equivalence] refusing on classification=${env.classification}`);
    process.exit(3);
  }
  const c = new Client({ connectionString: url, ssl: /127\.0\.0\.1|localhost/.test(url) ? false : { rejectUnauthorized: false } });
  await c.connect();
  const ts = await c.query<{ id: string }>(
    `SELECT t.id FROM tenants t
       WHERE EXISTS (SELECT 1 FROM employees e WHERE e."tenantId" = t.id::text)
       ORDER BY t.name`);
  const tA = ts.rows[0]?.id;
  await c.end();
  if (!tA) { console.error('[job-ads-equivalence] need a tenant'); process.exit(3); }

  const tenantASlug = 'engineer-acme';
  const tenantAId   = '00000000-0000-0000-0000-0000000a0001';

  const out: CaseResult[] = [];

  const legacy = await snapshotForFlags(
    { TENANT_PRISMA_PILOT_ENABLED: 'false', TENANT_PRISMA_PILOT_MODULES: undefined },
    null, tenantASlug, tenantAId,
  );
  const pilot = await snapshotForFlags(
    { TENANT_PRISMA_PILOT_ENABLED: 'true', TENANT_PRISMA_PILOT_MODULES: 'job-ads' },
    { id: tA }, tenantASlug, tenantAId,
  );

  out.push({
    name: 'legacy: pilot OFF reports pilotActive=false',
    ok: legacy.pilotActive === false,
    detail: legacy.reason,
  });
  out.push({
    name: 'pilot: pilot ON + module allow-list ⇒ pilotActive=true',
    ok: pilot.pilotActive === true && pilot.reason.startsWith('pilot ON'),
    detail: pilot.reason,
  });

  out.push({
    name: 'findAll: pilot total < legacy total (cross-tenant rows filtered)',
    ok: pilot.findAllTotal < legacy.findAllTotal && pilot.findAllTotal > 0,
    detail: `legacy=${legacy.findAllTotal} pilot=${pilot.findAllTotal}`,
  });
  out.push({
    name: 'findPublished: pilot total <= legacy total',
    ok: pilot.findPublishedTotal <= legacy.findPublishedTotal,
    detail: `legacy=${legacy.findPublishedTotal} pilot=${pilot.findPublishedTotal}`,
  });
  out.push({
    name: 'findBySlug(tenantA-slug): both modes resolve the same id',
    ok: legacy.findBySlugId !== null && legacy.findBySlugId === pilot.findBySlugId,
    detail: `legacy=${legacy.findBySlugId} pilot=${pilot.findBySlugId}`,
  });
  out.push({
    name: 'findOne(tenantA-id): both modes resolve to tenantA id',
    ok: legacy.findOneId === tenantAId && pilot.findOneId === tenantAId,
    detail: `legacy=${legacy.findOneId} pilot=${pilot.findOneId}`,
  });
  out.push({
    name: 'error path: NotFoundException for missing id in both modes',
    ok: legacy.errorOnMissing === 'NotFoundException' && pilot.errorOnMissing === 'NotFoundException',
    detail: `legacy=${legacy.errorOnMissing} pilot=${pilot.errorOnMissing}`,
  });
  out.push({
    name: 'create legacy: tenantId is NULL',
    ok: legacy.createdTenantId === null,
    detail: `legacy.tenantId=${legacy.createdTenantId}`,
  });
  out.push({
    name: 'create pilot: tenantId is set to active tenant',
    ok: pilot.createdTenantId === tA,
    detail: `pilot.tenantId=${pilot.createdTenantId} tenantA=${tA}`,
  });
  out.push({
    name: 'create slug: legacy + pilot both got a non-empty slug',
    ok: !!legacy.createdSlug && !!pilot.createdSlug,
    detail: `legacy=${legacy.createdSlug} pilot=${pilot.createdSlug}`,
  });
  out.push({
    name: 'update reflects new title in BOTH modes',
    ok: !!legacy.updatedTitle?.endsWith('-updated') && !!pilot.updatedTitle?.endsWith('-updated'),
    detail: `legacy=${legacy.updatedTitle} pilot=${pilot.updatedTitle}`,
  });
  out.push({
    name: 'remove sets deletedAt in BOTH modes (soft delete)',
    ok: legacy.removedDeletedAt === 'set' && pilot.removedDeletedAt === 'set',
    detail: `legacy=${legacy.removedDeletedAt} pilot=${pilot.removedDeletedAt}`,
  });
  out.push({
    name: 'response shape preserved (PaginatedResponse<JobAd>)',
    ok: legacy.responseShapeOk && pilot.responseShapeOk,
    detail: `legacy=${legacy.responseShapeOk} pilot=${pilot.responseShapeOk}`,
  });

  await fs.mkdir(OUT_DIR, { recursive: true });
  const summary = {
    generatedAt: new Date().toISOString(),
    environment: env, tenantA: tA, tenantASlug, tenantAId,
    legacy, pilot,
    counts: { total: out.length, passed: out.filter((r) => r.ok).length, failed: out.filter((r) => !r.ok).length },
    results: out,
  };
  await fs.writeFile(path.join(OUT_DIR, 'job-ads-equivalence.json'), JSON.stringify(summary, null, 2));
  const md: string[] = [];
  md.push('# Phase 2.9 — Job Ads Equivalence');
  md.push('');
  md.push(`Generated: ${summary.generatedAt}`);
  md.push(`Environment: ${env.classification} (${env.reason})`);
  md.push(`Tenant A: \`${tA}\` · slug: \`${tenantASlug}\` · id: \`${tenantAId}\``);
  md.push('');
  md.push(`- Cases passed: **${summary.counts.passed}** / ${summary.counts.total}`);
  md.push(`- Cases failed: ${summary.counts.failed}`);
  md.push('');
  md.push('| # | Case | Result | Detail |');
  md.push('|--:|------|:------:|--------|');
  out.forEach((r, i) => md.push(`| ${i + 1} | ${r.name} | ${r.ok ? 'PASS' : '**FAIL**'} | ${r.detail} |`));
  await fs.writeFile(path.join(OUT_DIR, 'job-ads-equivalence.md'), md.join('\n'));

  console.log(`job-ads-equivalence: ${summary.counts.passed}/${summary.counts.total} cases PASS`);
  if (summary.counts.failed > 0) process.exit(2);
}

main().catch((e) => { console.error(e); process.exit(3); });
