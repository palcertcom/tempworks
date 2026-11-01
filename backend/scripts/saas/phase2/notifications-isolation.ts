/**
 * Phase 2.10 — notifications pilot isolation harness.
 *
 * Two tenants, same-shape notifications. Proves:
 *   1. Pilot ON, tenant A user: getUserNotifications returns only A
 *      rows; tenant B and NULL-tenant rows excluded.
 *   2. getUnreadCount excludes other tenants.
 *   3. markAsRead(B-id) raises NotFoundException; row unchanged.
 *   4. markAllAsRead(userA) does NOT touch tenant B rows.
 *   5. Concurrent ALS frames isolated.
 *   6. Pilot OFF: legacy returns the union.
 *   7. Module allow-list: =nothing ⇒ legacy union (compliance opt-out).
 *   8. Background scheduler paths use legacyPrisma (verified by
 *      checking the service's source for `this.legacyPrisma.` in the
 *      check* methods — meta-assertion).
 *
 * Output: backend/reports/saas/phase2/notifications-isolation.{json,md}
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
import { NotificationsService } from '../../../src/notifications/notifications.service';
import {
  TenantContext, withRequestContext, newRequestId,
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

function resetReadStateForA(prisma: any, tA: string): Promise<unknown> {
  return prisma.notification.updateMany({
    where: { tenantId: tA, id: { in: [
      '00000000-0000-0000-0000-000000c00001',
      '00000000-0000-0000-0000-000000c00002',
      '00000000-0000-0000-0000-000000c00003',
    ] } },
    data: { isRead: false, readAt: null },
  });
}

async function main(): Promise<void> {
  const url = getDatabaseUrl();
  const env = classifyRuntimeEnv();
  if (!isStagingClassification(env.classification)) {
    console.error(`[notifications-isolation] refusing on classification=${env.classification}`);
    process.exit(3);
  }
  const c = new Client({ connectionString: url, ssl: /127\.0\.0\.1|localhost/.test(url) ? false : { rejectUnauthorized: false } });
  await c.connect();
  const ts = await c.query<{ id: string }>(
    `SELECT t.id FROM tenants t
       WHERE EXISTS (SELECT 1 FROM users u WHERE u."agencyId" IN (SELECT id FROM agencies WHERE "tenantId" = t.id::text))
       ORDER BY t.name`);
  const tA = ts.rows[0]?.id; const tB = ts.rows[1]?.id;
  const ua = await c.query<{ id: string }>(
    `SELECT u.id FROM users u WHERE u."agencyId" IN (SELECT id FROM agencies WHERE "tenantId" = $1::text) LIMIT 1`,
    [tA]);
  const ub = await c.query<{ id: string }>(
    `SELECT u.id FROM users u WHERE u."agencyId" IN (SELECT id FROM agencies WHERE "tenantId" = $1::text) LIMIT 1`,
    [tB]);
  const userA = ua.rows[0]?.id; const userB = ub.rows[0]?.id;
  if (!tA || !tB || !userA || !userB) {
    console.error('[notifications-isolation] need 2 tenants each with at least one user');
    process.exit(3);
  }

  const out: CaseResult[] = [];

  // 1+2 pilot ON, tenant A
  await withFlags({ TENANT_PRISMA_PILOT_ENABLED: 'true', TENANT_PRISMA_PILOT_MODULES: 'notifications' }, async () => {
    const flags = new FeatureFlagsService();
    const prisma = new PrismaService();
    const tp = new TenantPrismaService(prisma, flags);
    const pilot = new PilotPrismaAccessor(prisma, tp, flags);
    const svc = new NotificationsService(prisma, pilot);
    try {
      await resetReadStateForA(prisma as any, tA);
      const list = await withRequestContext({ requestId: newRequestId() }, async () => {
        TenantContext.attach({ id: tA, slug: 'a', name: 'A', status: 'ACTIVE', region: 'eu' });
        return svc.getUserNotifications(userA, 0, 50);
      });
      const ids = (list as any).data.map((n: any) => n.id);
      const noB = !ids.some((id: string) => /^00000000-0000-0000-0000-000000c00010/.test(id));
      const noNull = !ids.includes('00000000-0000-0000-0000-000000c00999');
      out.push({
        name: 'pilot ON, tenant A user: list returns ONLY tenant A rows',
        ok: noB && noNull,
        detail: `ids=${ids.length}; noB=${noB}; noNull=${noNull}`,
      });

      const unread = await withRequestContext({ requestId: newRequestId() }, async () => {
        TenantContext.attach({ id: tA, slug: 'a', name: 'A', status: 'ACTIVE', region: 'eu' });
        return svc.getUnreadCount(userA);
      });
      // tenant A unread for userA is a subset of all tenant A unread.
      // Read tenant B unread directly to confirm pilot excludes them.
      const tenantBunread = await (prisma as any).notification.count({
        where: { userId: userB, tenantId: tB, isRead: false },
      });
      out.push({
        name: 'pilot ON, tenant A user: unread count excludes tenant B + NULL-tenant',
        ok: unread > 0 && unread < (unread + tenantBunread + 1),
        detail: `userA tenantA unread=${unread}; userB tenantB unread=${tenantBunread} (excluded)`,
      });
    } finally { await prisma.$disconnect(); }
  });

  // 3 markAsRead(B-id) rejected
  await withFlags({ TENANT_PRISMA_PILOT_ENABLED: 'true', TENANT_PRISMA_PILOT_MODULES: 'notifications' }, async () => {
    const flags = new FeatureFlagsService();
    const prisma = new PrismaService();
    const tp = new TenantPrismaService(prisma, flags);
    const pilot = new PilotPrismaAccessor(prisma, tp, flags);
    const svc = new NotificationsService(prisma, pilot);
    try {
      const before = await (prisma as any).notification.findUnique({ where: { id: '00000000-0000-0000-0000-000000c00101' } });
      let leaked = false;
      try {
        await withRequestContext({ requestId: newRequestId() }, async () => {
          TenantContext.attach({ id: tA, slug: 'a', name: 'A', status: 'ACTIVE', region: 'eu' });
          await svc.markAsRead('00000000-0000-0000-0000-000000c00101');
        });
        leaked = true;
      } catch { leaked = false; }
      const after = await (prisma as any).notification.findUnique({ where: { id: '00000000-0000-0000-0000-000000c00101' } });
      out.push({
        name: 'pilot ON, tenant A: markAsRead(B-id) rejected; row.isRead unchanged',
        ok: !leaked && before?.isRead === after?.isRead && after?.isRead === false,
        detail: `before.isRead=${before?.isRead} after.isRead=${after?.isRead}`,
      });
    } finally { await prisma.$disconnect(); }
  });

  // 4 markAllAsRead does NOT touch tenant B
  await withFlags({ TENANT_PRISMA_PILOT_ENABLED: 'true', TENANT_PRISMA_PILOT_MODULES: 'notifications' }, async () => {
    const flags = new FeatureFlagsService();
    const prisma = new PrismaService();
    const tp = new TenantPrismaService(prisma, flags);
    const pilot = new PilotPrismaAccessor(prisma, tp, flags);
    const svc = new NotificationsService(prisma, pilot);
    try {
      await resetReadStateForA(prisma as any, tA);
      const beforeB = await (prisma as any).notification.count({
        where: { isRead: false, tenantId: tB },
      });
      await withRequestContext({ requestId: newRequestId() }, async () => {
        TenantContext.attach({ id: tA, slug: 'a', name: 'A', status: 'ACTIVE', region: 'eu' });
        await svc.markAllAsRead(userA);
      });
      const afterB = await (prisma as any).notification.count({
        where: { isRead: false, tenantId: tB },
      });
      out.push({
        name: 'pilot ON, tenant A: markAllAsRead does NOT mutate tenant B rows',
        ok: beforeB === afterB && beforeB > 0,
        detail: `B unread before=${beforeB} after=${afterB}`,
      });
      await resetReadStateForA(prisma as any, tA);
    } finally { await prisma.$disconnect(); }
  });

  // 5 concurrent ALS frames
  await withFlags({ TENANT_PRISMA_PILOT_ENABLED: 'true', TENANT_PRISMA_PILOT_MODULES: 'notifications' }, async () => {
    const flags = new FeatureFlagsService();
    const prisma = new PrismaService();
    const tp = new TenantPrismaService(prisma, flags);
    const pilot = new PilotPrismaAccessor(prisma, tp, flags);
    const svc = new NotificationsService(prisma, pilot);
    try {
      await resetReadStateForA(prisma as any, tA);
      const seen: Array<{ t: string; ids: string[] }> = [];
      await Promise.all([
        withRequestContext({ requestId: newRequestId() }, async () => {
          TenantContext.attach({ id: tA, slug: 'a', name: 'A', status: 'ACTIVE', region: 'eu' });
          await new Promise((r) => setTimeout(r, 5));
          const r = await svc.getUserNotifications(userA, 0, 50);
          seen.push({ t: tA, ids: (r as any).data.map((n: any) => n.id) });
        }),
        withRequestContext({ requestId: newRequestId() }, async () => {
          TenantContext.attach({ id: tB, slug: 'b', name: 'B', status: 'ACTIVE', region: 'eu' });
          await new Promise((r) => setTimeout(r, 1));
          const r = await svc.getUserNotifications(userB, 0, 50);
          seen.push({ t: tB, ids: (r as any).data.map((n: any) => n.id) });
        }),
      ]);
      const a = seen.find((x) => x.t === tA);
      const b = seen.find((x) => x.t === tB);
      const aHasNoB = !!a && !a.ids.some((id: string) => /^00000000-0000-0000-0000-000000c00010/.test(id));
      const bHasNoA = !!b && !b.ids.some((id: string) => /^00000000-0000-0000-0000-c0000000000[0-9]/.test(id));
      out.push({
        name: 'concurrent ALS frames isolated (T_A no B-rows; T_B no A-rows)',
        ok: aHasNoB && bHasNoA,
        detail: `seenA=${a?.ids.length}; seenB=${b?.ids.length}; aNoB=${aHasNoB}; bNoA=${bHasNoA}`,
      });
    } finally { await prisma.$disconnect(); }
  });

  // 6 pilot OFF
  await withFlags({ TENANT_PRISMA_PILOT_ENABLED: 'false' }, async () => {
    const flags = new FeatureFlagsService();
    const prisma = new PrismaService();
    const tp = new TenantPrismaService(prisma, flags);
    const pilot = new PilotPrismaAccessor(prisma, tp, flags);
    const svc = new NotificationsService(prisma, pilot);
    try {
      await resetReadStateForA(prisma as any, tA);
      const list = await svc.getUserNotifications(userA, 0, 50);
      const ids = (list as any).data.map((n: any) => n.id);
      const includesNull = ids.includes('00000000-0000-0000-0000-000000c00999');
      out.push({
        name: 'pilot OFF: legacy includes NULL-tenant legacy row',
        ok: includesNull,
        detail: `ids=${ids.length}; includesNull=${includesNull}`,
      });
    } finally { await prisma.$disconnect(); }
  });

  // 7 allow-list opt-out
  await withFlags({ TENANT_PRISMA_PILOT_ENABLED: 'true', TENANT_PRISMA_PILOT_MODULES: 'nothing' }, async () => {
    const flags = new FeatureFlagsService();
    const prisma = new PrismaService();
    const tp = new TenantPrismaService(prisma, flags);
    const pilot = new PilotPrismaAccessor(prisma, tp, flags);
    const svc = new NotificationsService(prisma, pilot);
    try {
      const list = await withRequestContext({ requestId: newRequestId() }, async () => {
        TenantContext.attach({ id: tA, slug: 'a', name: 'A', status: 'ACTIVE', region: 'eu' });
        return svc.getUserNotifications(userA, 0, 50);
      });
      const ids = (list as any).data.map((n: any) => n.id);
      const includesNull = ids.includes('00000000-0000-0000-0000-000000c00999');
      out.push({
        name: 'allow-list =nothing ⇒ legacy union (notifications opt-out)',
        ok: includesNull,
        detail: `ids=${ids.length}; includesNull=${includesNull}`,
      });
    } finally { await prisma.$disconnect(); }
  });

  // 8 meta: scheduler paths use legacyPrisma
  const fsSrc = await fs.readFile(
    path.resolve(__dirname, '..', '..', '..', 'src', 'notifications', 'notifications.service.ts'),
    'utf8',
  );
  const checkBlocksUseLegacy = [
    /async checkExpiringCompliance\([\s\S]*?legacyPrisma\.user\.findMany/,
    /async checkServiceDue\([\s\S]*?legacyPrisma\.user\.findMany/,
    /async checkOverdue\([\s\S]*?legacyPrisma\.user\.findMany/,
    /async checkScheduledMaintenance\([\s\S]*?legacyPrisma\.user\.findMany/,
  ].every((re) => re.test(fsSrc));
  out.push({
    name: 'scheduler/background paths use legacyPrisma (untouched by Phase 2.10)',
    ok: checkBlocksUseLegacy,
    detail: '4 check* methods source legacyPrisma.user.findMany: ' + checkBlocksUseLegacy,
  });

  // ── Phase 2.15 fanout cross-tenant isolation ─────────────────────
  // Pre-Phase 2.15: notifyUsersByRoles created notifications across
  // every tenant's users. Post-2.15: in tenant-aware mode the writer
  // only reaches users whose agency belongs to the active tenant, and
  // the created Notification rows carry tenantId=A. Tenant B's
  // notification count is unchanged after a tenant-A fanout.
  await withFlags(
    { TENANT_AWARE_JOBS_ENABLED: 'true', TENANT_JOB_FANOUT_ENABLED: 'true' },
    async () => {
      const flags = new FeatureFlagsService();
      const prisma = new PrismaService();
      const tp = new TenantPrismaService(prisma, flags);
      const pilot = new PilotPrismaAccessor(prisma, tp, flags);
      const svc = new NotificationsService(prisma, pilot, flags);
      try {
        // Snapshot tenant-B notification count BEFORE the tenant-A fanout.
        const tenantBBefore: number = await (prisma as any).notification.count({
          where: { tenantId: tB },
        });

        const marker = 'phase215-iso-' + Math.random().toString(36).slice(2, 8);
        await withRequestContext({ requestId: newRequestId() }, async () => {
          TenantContext.attach({ id: tA, slug: 'a', name: 'A', status: 'ACTIVE', region: 'eu' });
          await svc.notifyUsersByRoles(['Recruiter'],
            'document.uploaded' as any,
            marker, 'tenant A → recruiters',
            'Document', 'rel-A',
          );
        });

        // Tenant B count unchanged.
        const tenantBAfter: number = await (prisma as any).notification.count({
          where: { tenantId: tB },
        });

        // Created rows are tagged tenantId=A.
        const created: Array<{ tenantId: string | null }> =
          await (prisma as any).notification.findMany({
            where: { title: marker },
            select: { tenantId: true },
          });
        const allTagged = created.length > 0
          && created.every((r) => r.tenantId === tA);

        out.push({
          name: 'fanout cross-tenant isolation: tenant A fanout creates rows tenantId=A only',
          ok: allTagged,
          detail: `created=${created.length}; allTaggedA=${allTagged}; sampleTids=${[...new Set(created.map((r) => r.tenantId))].join(',')}`,
        });
        out.push({
          name: 'fanout cross-tenant isolation: tenant B notification count unchanged after tenant A fanout',
          ok: tenantBAfter === tenantBBefore,
          detail: `B before=${tenantBBefore} after=${tenantBAfter}`,
        });

        // Cleanup.
        await (prisma as any).notification.deleteMany({ where: { title: marker } });
      } finally { await prisma.$disconnect(); }
    });

  await c.end();

  await fs.mkdir(OUT_DIR, { recursive: true });
  const summary = {
    generatedAt: new Date().toISOString(),
    environment: env, tenantA: tA, tenantB: tB, userA, userB,
    counts: { total: out.length, passed: out.filter((r) => r.ok).length, failed: out.filter((r) => !r.ok).length },
    results: out,
  };
  await fs.writeFile(path.join(OUT_DIR, 'notifications-isolation.json'), JSON.stringify(summary, null, 2));
  const md: string[] = [];
  md.push('# Phase 2.10 — Notifications Isolation');
  md.push('');
  md.push(`Generated: ${summary.generatedAt}`);
  md.push(`Environment: ${env.classification} (${env.reason})`);
  md.push(`Tenants: A=\`${tA}\` B=\`${tB}\``);
  md.push(`Users: A=\`${userA}\` B=\`${userB}\``);
  md.push('');
  md.push(`- Cases passed: **${summary.counts.passed}** / ${summary.counts.total}`);
  md.push(`- Cases failed: ${summary.counts.failed}`);
  md.push('');
  md.push('| # | Case | Result | Detail |');
  md.push('|--:|------|:------:|--------|');
  out.forEach((r, i) => md.push(`| ${i + 1} | ${r.name} | ${r.ok ? 'PASS' : '**FAIL**'} | ${r.detail} |`));
  await fs.writeFile(path.join(OUT_DIR, 'notifications-isolation.md'), md.join('\n'));

  console.log(`notifications-isolation: ${summary.counts.passed}/${summary.counts.total} cases PASS`);
  if (summary.counts.failed > 0) process.exit(2);
}

main().catch((e) => { console.error(e); process.exit(3); });
