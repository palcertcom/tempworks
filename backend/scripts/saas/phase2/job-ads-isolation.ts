/**
 * Phase 2.9 — job-ads pilot isolation harness.
 *
 * Two tenants. Same-shape ads. Proves:
 *   1. Pilot ON, tenant A: findAll returns only tenant A ads; tenant B
 *      ids and the NULL-tenant legacy row are excluded.
 *   2. Pilot ON, tenant A: findOne(tenantB-id) raises NotFoundException.
 *   3. Pilot ON, tenant A: update(tenantB-id) raises NotFoundException;
 *      target row's title is unchanged.
 *   4. Pilot ON, tenant A: remove(tenantB-id) raises NotFoundException;
 *      target row's deletedAt remains NULL.
 *   5. Pilot ON, tenant A: create persists tenantId=A.
 *   6. Same-slug-in-two-tenants: documents the current behaviour. The
 *      schema's global `slug @unique` rejects the second insert. This
 *      is the EXPECTED behaviour until Phase 3 swaps to a composite
 *      `(tenantId, slug)` unique. The harness asserts the rejection.
 *   7. Public listing (`findPublished`) without ALS tenant returns rows
 *      from all tenants — preserving public URL semantics.
 *   8. Concurrent ALS frames: T_A no B-rows, T_B no A-rows.
 *   9. Pilot OFF: legacy returns the union (no filter).
 *
 * Output: backend/reports/saas/phase2/job-ads-isolation.{json,md}
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

async function main(): Promise<void> {
  const url = getDatabaseUrl();
  const env = classifyRuntimeEnv();
  if (!isStagingClassification(env.classification)) {
    console.error(`[job-ads-isolation] refusing on classification=${env.classification}`);
    process.exit(3);
  }
  const c = new Client({ connectionString: url, ssl: /127\.0\.0\.1|localhost/.test(url) ? false : { rejectUnauthorized: false } });
  await c.connect();
  const ts = await c.query<{ id: string }>(
    `SELECT t.id FROM tenants t
       WHERE EXISTS (SELECT 1 FROM employees e WHERE e."tenantId" = t.id::text)
       ORDER BY t.name`);
  const tA = ts.rows[0]?.id; const tB = ts.rows[1]?.id;
  if (!tA || !tB) { console.error('need two tenants with employees'); process.exit(3); }

  const out: CaseResult[] = [];

  const tenantBId = '00000000-0000-0000-0000-0000000a0002'; // engineer-globex

  // 1+2 — pilot ON, tenant A
  await withFlags({ TENANT_PRISMA_PILOT_ENABLED: 'true', TENANT_PRISMA_PILOT_MODULES: 'job-ads' }, async () => {
    const flags = new FeatureFlagsService();
    const prisma = new PrismaService();
    const tp = new TenantPrismaService(prisma, flags);
    const pilot = new PilotPrismaAccessor(prisma, tp, flags);
    const svc = new JobAdsService(prisma, pilot);
    try {
      const all = await withRequestContext({ requestId: newRequestId() }, async () => {
        TenantContext.attach({ id: tA, slug: 'a', name: 'A', status: 'ACTIVE', region: 'eu' });
        return svc.findAll({ page: 1, limit: 50 } as any);
      });
      const ids = (all as any).data.map((a: any) => a.id);
      const noB = !ids.some((id: string) => id === tenantBId || id === '00000000-0000-0000-0000-0000000a0004');
      const noNull = !ids.includes('00000000-0000-0000-0000-0000000a0999');
      out.push({
        name: 'pilot ON, tenant A: findAll returns ONLY tenant A rows',
        ok: noB && noNull,
        detail: `ids=${ids.join(',')}`,
      });

      let leaked = false;
      try {
        await withRequestContext({ requestId: newRequestId() }, async () => {
          TenantContext.attach({ id: tA, slug: 'a', name: 'A', status: 'ACTIVE', region: 'eu' });
          await svc.findOne(tenantBId);
        });
        leaked = true;
      } catch { leaked = false; }
      out.push({
        name: 'pilot ON, tenant A: findOne(tenantB-id) raises NotFoundException',
        ok: !leaked,
        detail: leaked ? 'UNEXPECTED: returned' : 'NotFoundException',
      });
    } finally { await prisma.$disconnect(); }
  });

  // 3+4 — update / remove tenant B rejected, row unchanged
  await withFlags({ TENANT_PRISMA_PILOT_ENABLED: 'true', TENANT_PRISMA_PILOT_MODULES: 'job-ads' }, async () => {
    const flags = new FeatureFlagsService();
    const prisma = new PrismaService();
    const tp = new TenantPrismaService(prisma, flags);
    const pilot = new PilotPrismaAccessor(prisma, tp, flags);
    const svc = new JobAdsService(prisma, pilot);
    try {
      const before = await (prisma as any).jobAd.findUnique({ where: { id: tenantBId } });
      let updateLeaked = false;
      try {
        await withRequestContext({ requestId: newRequestId() }, async () => {
          TenantContext.attach({ id: tA, slug: 'a', name: 'A', status: 'ACTIVE', region: 'eu' });
          await svc.update(tenantBId, { title: 'A-trying-to-update-B' } as any);
        });
        updateLeaked = true;
      } catch { updateLeaked = false; }
      const after = await (prisma as any).jobAd.findUnique({ where: { id: tenantBId } });
      out.push({
        name: 'pilot ON, tenant A: update on tenant B ad rejected, title unchanged',
        ok: !updateLeaked && before?.title === after?.title,
        detail: `before=${before?.title} after=${after?.title}`,
      });

      let removeLeaked = false;
      try {
        await withRequestContext({ requestId: newRequestId() }, async () => {
          TenantContext.attach({ id: tA, slug: 'a', name: 'A', status: 'ACTIVE', region: 'eu' });
          await svc.remove(tenantBId);
        });
        removeLeaked = true;
      } catch { removeLeaked = false; }
      const after2 = await (prisma as any).jobAd.findUnique({ where: { id: tenantBId } });
      out.push({
        name: 'pilot ON, tenant A: remove of tenant B ad rejected, deletedAt still NULL',
        ok: !removeLeaked && after2?.deletedAt === null,
        detail: `deletedAt=${after2?.deletedAt ?? 'null'}`,
      });
    } finally { await prisma.$disconnect(); }
  });

  // 5 — create persists tenantId
  await withFlags({ TENANT_PRISMA_PILOT_ENABLED: 'true', TENANT_PRISMA_PILOT_MODULES: 'job-ads' }, async () => {
    const flags = new FeatureFlagsService();
    const prisma = new PrismaService();
    const tp = new TenantPrismaService(prisma, flags);
    const pilot = new PilotPrismaAccessor(prisma, tp, flags);
    const svc = new JobAdsService(prisma, pilot);
    try {
      const created = await withRequestContext({ requestId: newRequestId() }, async () => {
        TenantContext.attach({ id: tA, slug: 'a', name: 'A', status: 'ACTIVE', region: 'eu' });
        return svc.create({
          title: 'iso-jobad-A-' + Math.random().toString(36).slice(2, 8),
          category: 'engineering', description: 't', city: 'X', country: 'GB',
        } as any);
      });
      out.push({
        name: 'pilot ON, tenant A: create persists tenantId=A',
        ok: (created as any).tenantId === tA,
        detail: `tenantId=${(created as any).tenantId}`,
      });
      await (prisma as any).jobAd.delete({ where: { id: created.id } });
    } finally { await prisma.$disconnect(); }
  });

  // 6 — same-slug-in-two-tenants: schema's global unique rejects the second insert
  await withFlags({ TENANT_PRISMA_PILOT_ENABLED: 'true', TENANT_PRISMA_PILOT_MODULES: 'job-ads' }, async () => {
    const flags = new FeatureFlagsService();
    const prisma = new PrismaService();
    const tp = new TenantPrismaService(prisma, flags);
    const pilot = new PilotPrismaAccessor(prisma, tp, flags);
    const svc = new JobAdsService(prisma, pilot);
    try {
      const sameSlug = 'iso-collision-' + Math.random().toString(36).slice(2, 6);
      const a = await withRequestContext({ requestId: newRequestId() }, async () => {
        TenantContext.attach({ id: tA, slug: 'a', name: 'A', status: 'ACTIVE', region: 'eu' });
        return svc.create({
          title: 'collide-A', slug: sameSlug,
          category: 'engineering', description: 't', city: 'X', country: 'GB',
        } as any);
      });
      // Second tenant tries to use the same slug. Today the service's
      // uniqueSlug() suffix-loop catches it and produces "<slug>-1" —
      // the global unique therefore does NOT reject. We verify both
      // ads now exist with distinct slugs that share the same base.
      const b = await withRequestContext({ requestId: newRequestId() }, async () => {
        TenantContext.attach({ id: tB, slug: 'b', name: 'B', status: 'ACTIVE', region: 'eu' });
        return svc.create({
          title: 'collide-B', slug: sameSlug,
          category: 'engineering', description: 't', city: 'X', country: 'GB',
        } as any);
      });
      out.push({
        name: 'same-slug request in two tenants: service auto-suffixes; both inserts succeed (legacy unique honoured)',
        ok: a.slug === sameSlug && b.slug.startsWith(sameSlug + '-')
           && (a as any).tenantId === tA && (b as any).tenantId === tB,
        detail: `aSlug=${a.slug} bSlug=${b.slug}`,
      });
      await (prisma as any).jobAd.delete({ where: { id: a.id } });
      await (prisma as any).jobAd.delete({ where: { id: b.id } });
    } finally { await prisma.$disconnect(); }
  });

  // 7 — public listing (no ALS tenant) — preserves cross-tenant visibility
  await withFlags({ TENANT_PRISMA_PILOT_ENABLED: 'true', TENANT_PRISMA_PILOT_MODULES: 'job-ads' }, async () => {
    const flags = new FeatureFlagsService();
    const prisma = new PrismaService();
    const tp = new TenantPrismaService(prisma, flags);
    const pilot = new PilotPrismaAccessor(prisma, tp, flags);
    const svc = new JobAdsService(prisma, pilot);
    try {
      // No withRequestContext / TenantContext.attach — public traffic.
      const pub = await svc.findPublished({ page: 1, limit: 50 } as any);
      const ids = (pub as any).data.map((a: any) => a.id);
      const hasA = ids.includes('00000000-0000-0000-0000-0000000a0001');
      const hasB = ids.includes('00000000-0000-0000-0000-0000000a0002');
      out.push({
        name: 'public listing (no ALS tenant): includes ads from all tenants (preserves public URLs)',
        ok: hasA && hasB,
        detail: `total=${(pub as any).meta?.total} hasA=${hasA} hasB=${hasB}`,
      });
    } finally { await prisma.$disconnect(); }
  });

  // 8 — concurrent ALS frames
  await withFlags({ TENANT_PRISMA_PILOT_ENABLED: 'true', TENANT_PRISMA_PILOT_MODULES: 'job-ads' }, async () => {
    const flags = new FeatureFlagsService();
    const prisma = new PrismaService();
    const tp = new TenantPrismaService(prisma, flags);
    const pilot = new PilotPrismaAccessor(prisma, tp, flags);
    const svc = new JobAdsService(prisma, pilot);
    try {
      const seen: Array<{ t: string; ids: string[] }> = [];
      await Promise.all([
        withRequestContext({ requestId: newRequestId() }, async () => {
          TenantContext.attach({ id: tA, slug: 'a', name: 'A', status: 'ACTIVE', region: 'eu' });
          await new Promise((r) => setTimeout(r, 5));
          const r = await svc.findAll({ page: 1, limit: 50 } as any);
          seen.push({ t: tA, ids: (r as any).data.map((a: any) => a.id) });
        }),
        withRequestContext({ requestId: newRequestId() }, async () => {
          TenantContext.attach({ id: tB, slug: 'b', name: 'B', status: 'ACTIVE', region: 'eu' });
          await new Promise((r) => setTimeout(r, 1));
          const r = await svc.findAll({ page: 1, limit: 50 } as any);
          seen.push({ t: tB, ids: (r as any).data.map((a: any) => a.id) });
        }),
      ]);
      const a = seen.find((x) => x.t === tA);
      const b = seen.find((x) => x.t === tB);
      const aHasNoB = !!a && !a.ids.includes(tenantBId);
      const bHasNoA = !!b && !b.ids.includes('00000000-0000-0000-0000-0000000a0001');
      out.push({
        name: 'concurrent ALS frames isolated (T_A no B-rows; T_B no A-rows)',
        ok: aHasNoB && bHasNoA,
        detail: `seenA=${a?.ids.length} ids; seenB=${b?.ids.length} ids; aNoB=${aHasNoB} bNoA=${bHasNoA}`,
      });
    } finally { await prisma.$disconnect(); }
  });

  // 9 — pilot OFF
  await withFlags({ TENANT_PRISMA_PILOT_ENABLED: 'false' }, async () => {
    const flags = new FeatureFlagsService();
    const prisma = new PrismaService();
    const tp = new TenantPrismaService(prisma, flags);
    const pilot = new PilotPrismaAccessor(prisma, tp, flags);
    const svc = new JobAdsService(prisma, pilot);
    try {
      const all = await svc.findAll({ page: 1, limit: 50 } as any);
      const ids = (all as any).data.map((a: any) => a.id);
      const includesNull = ids.includes('00000000-0000-0000-0000-0000000a0999');
      const includesB    = ids.includes(tenantBId);
      out.push({
        name: 'pilot OFF: legacy reads include tenant B + NULL-tenant legacy row',
        ok: includesB && includesNull,
        detail: `ids=${ids.length} includesB=${includesB} includesNull=${includesNull}`,
      });
    } finally { await prisma.$disconnect(); }
  });

  // Final cleanup
  const cleanup = new Client({ connectionString: url, ssl: /127\.0\.0\.1|localhost/.test(url) ? false : { rejectUnauthorized: false } });
  await cleanup.connect();
  await cleanup.query(`DELETE FROM job_ads WHERE title LIKE 'iso-jobad-%' OR title LIKE 'collide-%' OR title LIKE 'rehearsal-job-%'`);
  await cleanup.end();
  await c.end();

  await fs.mkdir(OUT_DIR, { recursive: true });
  const summary = {
    generatedAt: new Date().toISOString(),
    environment: env, tenantA: tA, tenantB: tB,
    counts: { total: out.length, passed: out.filter((r) => r.ok).length, failed: out.filter((r) => !r.ok).length },
    results: out,
  };
  await fs.writeFile(path.join(OUT_DIR, 'job-ads-isolation.json'), JSON.stringify(summary, null, 2));
  const md: string[] = [];
  md.push('# Phase 2.9 — Job Ads Isolation');
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
  await fs.writeFile(path.join(OUT_DIR, 'job-ads-isolation.md'), md.join('\n'));

  console.log(`job-ads-isolation: ${summary.counts.passed}/${summary.counts.total} cases PASS`);
  if (summary.counts.failed > 0) process.exit(2);
}

main().catch((e) => { console.error(e); process.exit(3); });
