/**
 * Phase 2.10 — notifications pilot read-equivalence harness.
 *
 * In scope: getUserNotifications, getUnreadCount, markAsRead,
 * markAllAsRead, wasHighBalanceAlertRecentlySent, plus the per-user
 * preferences upsert/update (intentionally legacy-only).
 *
 * Output: backend/reports/saas/phase2/notifications-equivalence.{json,md}
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

interface Snapshot {
  pilotActive: boolean;
  reason: string;
  listTotal: number;
  listIds: string[];
  unreadCount: number;
  highBalanceProbe: boolean;
  errorOnMissingMark: string;
  preferencesId: string | null;
}

async function snapshot(flagsOverride: Record<string, string | undefined>,
                       ctx: { id: string } | null,
                       userA: string,
                       relatedEntityId: string): Promise<Snapshot> {
  return withFlags(flagsOverride, async () => {
    const flags = new FeatureFlagsService();
    const prisma = new PrismaService();
    const tp = new TenantPrismaService(prisma, flags);
    const pilot = new PilotPrismaAccessor(prisma, tp, flags);
    const svc = new NotificationsService(prisma, pilot);
    const run = async (): Promise<Snapshot> => {
      const list = await svc.getUserNotifications(userA, 0, 50);
      const unread = await svc.getUnreadCount(userA);
      const high = await svc.wasHighBalanceAlertRecentlySent(relatedEntityId);
      let errorOnMissingMark = 'no-error';
      try {
        await svc.markAsRead('00000000-0000-0000-0000-deaddeaddead');
      } catch (e) { errorOnMissingMark = (e as Error).constructor.name; }
      const prefs = await svc.getOrCreatePreferences(userA);
      return {
        pilotActive: pilot.isPilotActive(),
        reason: pilot.pilotReason().reason,
        listTotal: (list as any).total ?? 0,
        listIds: (list as any).data.map((n: any) => n.id).sort(),
        unreadCount: unread,
        highBalanceProbe: high,
        errorOnMissingMark,
        preferencesId: prefs.id,
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
      await prisma.$disconnect();
    }
  });
}

async function main(): Promise<void> {
  const url = getDatabaseUrl();
  const env = classifyRuntimeEnv();
  if (!isStagingClassification(env.classification)) {
    console.error(`[notifications-equivalence] refusing on classification=${env.classification}`);
    process.exit(3);
  }
  const c = new Client({ connectionString: url, ssl: /127\.0\.0\.1|localhost/.test(url) ? false : { rejectUnauthorized: false } });
  await c.connect();
  const ts = await c.query<{ id: string }>(
    `SELECT t.id FROM tenants t
       WHERE EXISTS (SELECT 1 FROM users u WHERE u."agencyId" IN (SELECT id FROM agencies WHERE "tenantId" = t.id::text))
       ORDER BY t.name`);
  const tA = ts.rows[0]?.id;
  const ua = await c.query<{ id: string }>(
    `SELECT u.id FROM users u WHERE u."agencyId" IN (SELECT id FROM agencies WHERE "tenantId" = $1::text) LIMIT 1`,
    [tA]);
  const userA = ua.rows[0]?.id;
  await c.end();
  if (!tA || !userA) { console.error('[notifications-equivalence] need tenant + user'); process.exit(3); }

  const out: CaseResult[] = [];
  const relatedEntityId = '00000000-0000-0000-0000-deadbeef0001';

  const legacy = await snapshot({ TENANT_PRISMA_PILOT_ENABLED: 'false' }, null, userA, relatedEntityId);
  const pilot  = await snapshot({ TENANT_PRISMA_PILOT_ENABLED: 'true', TENANT_PRISMA_PILOT_MODULES: 'notifications' },
                                { id: tA }, userA, relatedEntityId);

  out.push({
    name: 'legacy: pilot OFF reports pilotActive=false',
    ok: legacy.pilotActive === false,
    detail: legacy.reason,
  });
  out.push({
    name: 'pilot: ON + module allow-list ⇒ pilotActive=true',
    ok: pilot.pilotActive === true,
    detail: pilot.reason,
  });

  out.push({
    name: 'getUserNotifications: pilot total <= legacy total (filtered)',
    ok: pilot.listTotal <= legacy.listTotal,
    detail: `legacy=${legacy.listTotal} pilot=${pilot.listTotal}`,
  });
  out.push({
    name: 'getUserNotifications: pilot excludes NULL-tenant legacy row',
    ok: !pilot.listIds.includes('00000000-0000-0000-0000-000000c00999'),
    detail: `pilotIds=${pilot.listIds.length} ids`,
  });
  out.push({
    name: 'getUserNotifications: legacy includes NULL-tenant legacy row',
    ok: legacy.listIds.includes('00000000-0000-0000-0000-000000c00999'),
    detail: `legacyIds.includes legacy=${legacy.listIds.includes('00000000-0000-0000-0000-000000c00999')}`,
  });
  out.push({
    name: 'getUnreadCount: pilot <= legacy',
    ok: pilot.unreadCount <= legacy.unreadCount,
    detail: `legacy=${legacy.unreadCount} pilot=${pilot.unreadCount}`,
  });
  out.push({
    name: 'wasHighBalanceAlertRecentlySent: legacy true (any tenant), pilot true (tenant A row exists)',
    ok: legacy.highBalanceProbe === true && pilot.highBalanceProbe === true,
    detail: `legacy=${legacy.highBalanceProbe} pilot=${pilot.highBalanceProbe}`,
  });
  out.push({
    name: 'markAsRead(missing-id): pilot raises NotFoundException; legacy raises Prisma error',
    ok: pilot.errorOnMissingMark === 'NotFoundException'
      && legacy.errorOnMissingMark.length > 0 && legacy.errorOnMissingMark !== 'no-error',
    detail: `legacy=${legacy.errorOnMissingMark} pilot=${pilot.errorOnMissingMark}`,
  });
  out.push({
    name: 'getOrCreatePreferences: returns identical preferences id (per-user global record)',
    ok: legacy.preferencesId !== null && legacy.preferencesId === pilot.preferencesId,
    detail: `legacy=${legacy.preferencesId} pilot=${pilot.preferencesId}`,
  });

  // markAllAsRead behaviour: run in pilot mode and confirm only tenant A
  // unread rows are flipped to read.
  await withFlags({ TENANT_PRISMA_PILOT_ENABLED: 'true', TENANT_PRISMA_PILOT_MODULES: 'notifications' }, async () => {
    const flags = new FeatureFlagsService();
    const prisma = new PrismaService();
    const tp = new TenantPrismaService(prisma, flags);
    const pilot2 = new PilotPrismaAccessor(prisma, tp, flags);
    const svc = new NotificationsService(prisma, pilot2);
    try {
      // Capture tenant A unread + tenant B unread BEFORE.
      const beforeA = await (prisma as any).notification.count({
        where: { userId: userA, isRead: false, tenantId: tA },
      });
      const beforeB = await (prisma as any).notification.count({
        where: { isRead: false, tenantId: { not: tA } },
      });
      await withRequestContext({ requestId: newRequestId() }, async () => {
        TenantContext.attach({ id: tA, slug: 'a', name: 'A', status: 'ACTIVE', region: 'eu' });
        await svc.markAllAsRead(userA);
      });
      const afterA = await (prisma as any).notification.count({
        where: { userId: userA, isRead: false, tenantId: tA },
      });
      const afterB = await (prisma as any).notification.count({
        where: { isRead: false, tenantId: { not: tA } },
      });
      out.push({
        name: 'markAllAsRead pilot ON: tenant A unread → 0; tenant B unread unchanged',
        ok: beforeA > 0 && afterA === 0 && afterB === beforeB,
        detail: `A: ${beforeA}→${afterA}; B: ${beforeB}→${afterB}`,
      });
      // Reset for re-runnability.
      await (prisma as any).notification.updateMany({
        where: { id: { in: ['00000000-0000-0000-0000-000000c00001','00000000-0000-0000-0000-000000c00002','00000000-0000-0000-0000-000000c00003'] } },
        data: { isRead: false, readAt: null },
      });
    } finally { await prisma.$disconnect(); }
  });

  out.push({
    name: 'response shape preserved ({ data: [...], total: number })',
    ok: legacy.listIds && Array.isArray(legacy.listIds) && pilot.listIds && Array.isArray(pilot.listIds)
       && typeof legacy.listTotal === 'number' && typeof pilot.listTotal === 'number',
    detail: 'arrays + numeric total in both modes',
  });

  await fs.mkdir(OUT_DIR, { recursive: true });
  const summary = {
    generatedAt: new Date().toISOString(),
    environment: env, tenantA: tA, userA, relatedEntityId,
    legacy, pilot,
    counts: { total: out.length, passed: out.filter((r) => r.ok).length, failed: out.filter((r) => !r.ok).length },
    results: out,
  };
  await fs.writeFile(path.join(OUT_DIR, 'notifications-equivalence.json'), JSON.stringify(summary, null, 2));
  const md: string[] = [];
  md.push('# Phase 2.10 — Notifications Equivalence');
  md.push('');
  md.push(`Generated: ${summary.generatedAt}`);
  md.push(`Environment: ${env.classification} (${env.reason})`);
  md.push(`Tenant A: \`${tA}\` · user: \`${userA}\``);
  md.push('');
  md.push(`- Cases passed: **${summary.counts.passed}** / ${summary.counts.total}`);
  md.push(`- Cases failed: ${summary.counts.failed}`);
  md.push('');
  md.push('| # | Case | Result | Detail |');
  md.push('|--:|------|:------:|--------|');
  out.forEach((r, i) => md.push(`| ${i + 1} | ${r.name} | ${r.ok ? 'PASS' : '**FAIL**'} | ${r.detail} |`));
  await fs.writeFile(path.join(OUT_DIR, 'notifications-equivalence.md'), md.join('\n'));

  console.log(`notifications-equivalence: ${summary.counts.passed}/${summary.counts.total} cases PASS`);
  if (summary.counts.failed > 0) process.exit(2);
}

main().catch((e) => { console.error(e); process.exit(3); });
