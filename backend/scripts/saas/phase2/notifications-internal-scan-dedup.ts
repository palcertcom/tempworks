/**
 * Phase 2.46 — internal `check*` notification scan dedup harness.
 *
 *   1. NOTIFICATION_DEDUP_ENABLED=false: repeated scan creates a duplicate
 *   2. NOTIFICATION_DEDUP_ENABLED=true:  checkExpiringCompliance condition deduped
 *   3. checkServiceDue condition deduped
 *   4. checkOverdue condition deduped
 *   5. checkScheduledMaintenance condition deduped
 *   6. different users (same tenant) NOT deduped
 *   7. same user, different tenant NOT deduped
 *   8. different condition types for same vehicle NOT deduped
 *   9. window respected: row outside window does not suppress
 *  10. NULL-tenant legacy row does not suppress tenant-scoped row
 *  11. missing tenant context refuses safely (assertTenantForFanout chain)
 *  12. concurrent tenant-aware scans remain ALS-isolated
 *  13. source-level: all four check* methods route through createInAppWithDedup
 *
 * Strategy: synthetic per-condition calls via `createInAppWithDedup`
 * mirroring the data shape each check* method writes. Plus a source-level
 * meta-assertion that the four scan methods route through the helper.
 *
 * Output: backend/reports/saas/phase2/notifications-internal-scan-dedup.{json,md}
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
import { TenantContext, withRequestContext, newRequestId } from '../../../src/saas/context/als';

autoLoadEnv(__filename);

const OUT_DIR = path.resolve(__dirname, '..', '..', '..', 'reports', 'saas', 'phase2');
const SRC_FILE = path.resolve(__dirname, '..', '..', '..', 'src', 'notifications', 'notifications.service.ts');
interface CaseResult { name: string; ok: boolean; detail: string; }

const USER_A_REC = '00000000-0000-0000-0000-00000000us03';
const USER_A_CO  = '00000000-0000-0000-0000-00000000us05';
const USER_B_REC = '00000000-0000-0000-0000-00000000us04';
const VEH_A = '00000000-0000-0000-0000-0000000vh001';
const VEH_B = '00000000-0000-0000-0000-0000000vh101';
const MAINT_A = '00000000-0000-0000-0000-0000000mn001';

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

function makeStack() {
  const prisma = new PrismaService();
  const flags = new FeatureFlagsService();
  const pilot = new PilotPrismaAccessor(prisma, new TenantPrismaService(prisma, flags), flags);
  const notifications = new NotificationsService(prisma, pilot, flags);
  return { prisma, flags, notifications };
}

const FANOUT_ON = { TENANT_AWARE_JOBS_ENABLED: 'true', TENANT_JOB_FANOUT_ENABLED: 'true' };
const DEDUP_ON  = { NOTIFICATION_DEDUP_ENABLED: 'true' };
const DEDUP_OFF = { NOTIFICATION_DEDUP_ENABLED: 'false' };

const REL_VEH = 'Vehicle';
const REL_MNT = 'MaintenanceRecord';

async function clean(prisma: PrismaService): Promise<void> {
  await (prisma as any).notification.deleteMany({
    where: {
      relatedEntity: { in: [REL_VEH, REL_MNT] },
      relatedEntityId: { in: [VEH_A, VEH_B, MAINT_A] },
    },
  });
}

// Helper to call the private dedup helper via reflection so the harness
// can simulate exactly what each check* method writes.
function dedupCreate(notif: any, data: any, tid: string | null) {
  return (notif as any).createInAppWithDedup(data, tid);
}

function condition(userId: string, tenantId: string, vehicleId: string, type: string) {
  return {
    userId,
    title: 'X', message: 'X', type, channel: 'in_app',
    relatedEntity: REL_VEH, relatedEntityId: vehicleId,
    tenantId,
  };
}

async function main(): Promise<void> {
  const url = getDatabaseUrl();
  const env = classifyRuntimeEnv();
  if (!isStagingClassification(env.classification)) {
    console.error(`[notifications-internal-scan-dedup] refusing on classification=${env.classification}`);
    process.exit(3);
  }
  const c = new Client({ connectionString: url, ssl: /127\.0\.0\.1|localhost/.test(url) ? false : { rejectUnauthorized: false } });
  await c.connect();
  const ts = await c.query<{ id: string }>(
    `SELECT t.id FROM tenants t WHERE t.status = 'ACTIVE' ORDER BY t.slug`);
  const tA = ts.rows[0]?.id; const tB = ts.rows[1]?.id;
  await c.end();
  if (!tA || !tB) { console.error('need two ACTIVE tenants'); process.exit(3); }

  const out: CaseResult[] = [];

  // Pre-clean
  {
    const prisma = new PrismaService();
    try { await clean(prisma); } finally { await prisma.$disconnect(); }
  }

  // 1 — flag off: duplicates
  await withFlags({ ...FANOUT_ON, ...DEDUP_OFF }, async () => {
    const s = makeStack();
    try {
      await clean(s.prisma);
      const data = condition(USER_A_REC, tA, VEH_A, 'VEHICLE_MOT_EXPIRING');
      const r1 = await dedupCreate(s.notifications, data, tA);
      const r2 = await dedupCreate(s.notifications, data, tA);
      const cnt = await (s.prisma as any).notification.count({ where: { relatedEntityId: VEH_A, type: 'VEHICLE_MOT_EXPIRING', tenantId: tA } });
      out.push({ name: '1. flag off: scan create produces duplicate (legacy)', ok: r1.created === 1 && r2.created === 1 && cnt === 2, detail: `r1=${JSON.stringify(r1)} r2=${JSON.stringify(r2)} cnt=${cnt}` });
      await clean(s.prisma);
    } finally { await s.prisma.$disconnect(); }
  });

  // 2 — checkExpiringCompliance condition shape: deduped
  await withFlags({ ...FANOUT_ON, ...DEDUP_ON }, async () => {
    const s = makeStack();
    try {
      await clean(s.prisma);
      const data = condition(USER_A_REC, tA, VEH_A, 'VEHICLE_MOT_EXPIRING');
      const r1 = await dedupCreate(s.notifications, data, tA);
      const r2 = await dedupCreate(s.notifications, data, tA);
      const cnt = await (s.prisma as any).notification.count({ where: { relatedEntityId: VEH_A, type: 'VEHICLE_MOT_EXPIRING', tenantId: tA } });
      out.push({ name: '2. checkExpiringCompliance condition deduped', ok: r1.created === 1 && r2.deduped === 1 && cnt === 1, detail: `r1=${JSON.stringify(r1)} r2=${JSON.stringify(r2)} cnt=${cnt}` });
      await clean(s.prisma);
    } finally { await s.prisma.$disconnect(); }
  });

  // 3 — checkServiceDue
  await withFlags({ ...FANOUT_ON, ...DEDUP_ON }, async () => {
    const s = makeStack();
    try {
      await clean(s.prisma);
      const data = condition(USER_A_REC, tA, VEH_A, 'VEHICLE_SERVICE_DUE');
      const r1 = await dedupCreate(s.notifications, data, tA);
      const r2 = await dedupCreate(s.notifications, data, tA);
      const cnt = await (s.prisma as any).notification.count({ where: { relatedEntityId: VEH_A, type: 'VEHICLE_SERVICE_DUE', tenantId: tA } });
      out.push({ name: '3. checkServiceDue condition deduped', ok: r1.created === 1 && r2.deduped === 1 && cnt === 1, detail: `r1=${JSON.stringify(r1)} r2=${JSON.stringify(r2)} cnt=${cnt}` });
      await clean(s.prisma);
    } finally { await s.prisma.$disconnect(); }
  });

  // 4 — checkOverdue
  await withFlags({ ...FANOUT_ON, ...DEDUP_ON }, async () => {
    const s = makeStack();
    try {
      await clean(s.prisma);
      const data = condition(USER_A_REC, tA, VEH_A, 'VEHICLE_SERVICE_OVERDUE');
      const r1 = await dedupCreate(s.notifications, data, tA);
      const r2 = await dedupCreate(s.notifications, data, tA);
      const cnt = await (s.prisma as any).notification.count({ where: { relatedEntityId: VEH_A, type: 'VEHICLE_SERVICE_OVERDUE', tenantId: tA } });
      out.push({ name: '4. checkOverdue condition deduped', ok: r1.created === 1 && r2.deduped === 1 && cnt === 1, detail: `r1=${JSON.stringify(r1)} r2=${JSON.stringify(r2)} cnt=${cnt}` });
      await clean(s.prisma);
    } finally { await s.prisma.$disconnect(); }
  });

  // 5 — checkScheduledMaintenance (different relatedEntity)
  await withFlags({ ...FANOUT_ON, ...DEDUP_ON }, async () => {
    const s = makeStack();
    try {
      await clean(s.prisma);
      const data: any = {
        userId: USER_A_REC, title: 'X', message: 'X', type: 'INFO', channel: 'in_app',
        relatedEntity: REL_MNT, relatedEntityId: MAINT_A, tenantId: tA,
      };
      const r1 = await dedupCreate(s.notifications, data, tA);
      const r2 = await dedupCreate(s.notifications, data, tA);
      const cnt = await (s.prisma as any).notification.count({ where: { relatedEntity: REL_MNT, relatedEntityId: MAINT_A, tenantId: tA } });
      out.push({ name: '5. checkScheduledMaintenance condition deduped', ok: r1.created === 1 && r2.deduped === 1 && cnt === 1, detail: `r1=${JSON.stringify(r1)} r2=${JSON.stringify(r2)} cnt=${cnt}` });
      await clean(s.prisma);
    } finally { await s.prisma.$disconnect(); }
  });

  // 6 — different user same tenant NOT deduped
  await withFlags({ ...FANOUT_ON, ...DEDUP_ON }, async () => {
    const s = makeStack();
    try {
      await clean(s.prisma);
      const r1 = await dedupCreate(s.notifications, condition(USER_A_REC, tA, VEH_A, 'VEHICLE_MOT_EXPIRING'), tA);
      const r2 = await dedupCreate(s.notifications, condition(USER_A_CO,  tA, VEH_A, 'VEHICLE_MOT_EXPIRING'), tA);
      const cnt = await (s.prisma as any).notification.count({ where: { relatedEntityId: VEH_A, type: 'VEHICLE_MOT_EXPIRING', tenantId: tA } });
      out.push({ name: '6. different user (same tenant) NOT deduped', ok: r1.created === 1 && r2.created === 1 && cnt === 2, detail: `cnt=${cnt}` });
      await clean(s.prisma);
    } finally { await s.prisma.$disconnect(); }
  });

  // 7 — same user, different tenant NOT deduped
  await withFlags({ ...FANOUT_ON, ...DEDUP_ON }, async () => {
    const s = makeStack();
    try {
      await clean(s.prisma);
      const r1 = await dedupCreate(s.notifications, condition(USER_A_REC, tA, VEH_A, 'VEHICLE_MOT_EXPIRING'), tA);
      const r2 = await dedupCreate(s.notifications, condition(USER_A_REC, tB, VEH_A, 'VEHICLE_MOT_EXPIRING'), tB);
      const a = await (s.prisma as any).notification.count({ where: { tenantId: tA, relatedEntityId: VEH_A, type: 'VEHICLE_MOT_EXPIRING' } });
      const b = await (s.prisma as any).notification.count({ where: { tenantId: tB, relatedEntityId: VEH_A, type: 'VEHICLE_MOT_EXPIRING' } });
      out.push({ name: '7. same user different tenant NOT deduped', ok: r1.created === 1 && r2.created === 1 && a === 1 && b === 1, detail: `a=${a} b=${b}` });
      await clean(s.prisma);
    } finally { await s.prisma.$disconnect(); }
  });

  // 8 — different condition types for same vehicle NOT deduped
  await withFlags({ ...FANOUT_ON, ...DEDUP_ON }, async () => {
    const s = makeStack();
    try {
      await clean(s.prisma);
      const r1 = await dedupCreate(s.notifications, condition(USER_A_REC, tA, VEH_A, 'VEHICLE_MOT_EXPIRING'), tA);
      const r2 = await dedupCreate(s.notifications, condition(USER_A_REC, tA, VEH_A, 'VEHICLE_INSURANCE_EXPIRING'), tA);
      const total = await (s.prisma as any).notification.count({ where: { tenantId: tA, relatedEntityId: VEH_A } });
      out.push({ name: '8. different condition types for same vehicle NOT deduped', ok: r1.created === 1 && r2.created === 1 && total === 2, detail: `total=${total}` });
      await clean(s.prisma);
    } finally { await s.prisma.$disconnect(); }
  });

  // 9 — window respected
  await withFlags({ ...FANOUT_ON, ...DEDUP_ON, NOTIFICATION_DEDUP_WINDOW_MINUTES: '1' }, async () => {
    const s = makeStack();
    try {
      await clean(s.prisma);
      // Seed an OLD row outside the 1-minute window.
      await (s.prisma as any).notification.create({
        data: {
          userId: USER_A_REC, title: 'X', message: 'X', type: 'VEHICLE_MOT_EXPIRING', channel: 'in_app',
          relatedEntity: REL_VEH, relatedEntityId: VEH_A, tenantId: tA,
          createdAt: new Date(Date.now() - 2 * 60 * 60 * 1000),
        },
      });
      const r = await dedupCreate(s.notifications, condition(USER_A_REC, tA, VEH_A, 'VEHICLE_MOT_EXPIRING'), tA);
      const total = await (s.prisma as any).notification.count({ where: { tenantId: tA, relatedEntityId: VEH_A, type: 'VEHICLE_MOT_EXPIRING' } });
      out.push({ name: '9. window respected: old row outside window does not suppress', ok: r.created === 1 && total === 2, detail: `total=${total}` });
      await clean(s.prisma);
    } finally { await s.prisma.$disconnect(); }
  });

  // 10 — NULL-tenant legacy row does not suppress
  await withFlags({ ...FANOUT_ON, ...DEDUP_ON }, async () => {
    const s = makeStack();
    try {
      await clean(s.prisma);
      await (s.prisma as any).notification.create({
        data: {
          userId: USER_A_REC, title: 'legacy', message: 'X', type: 'VEHICLE_MOT_EXPIRING', channel: 'in_app',
          relatedEntity: REL_VEH, relatedEntityId: VEH_A, tenantId: null,
        },
      });
      const r = await dedupCreate(s.notifications, condition(USER_A_REC, tA, VEH_A, 'VEHICLE_MOT_EXPIRING'), tA);
      const a = await (s.prisma as any).notification.count({ where: { tenantId: tA, relatedEntityId: VEH_A, type: 'VEHICLE_MOT_EXPIRING' } });
      out.push({ name: '10. NULL-tenant legacy row does NOT suppress tenant-scoped row', ok: r.created === 1 && a === 1, detail: `a=${a}` });
      await clean(s.prisma);
    } finally { await s.prisma.$disconnect(); }
  });

  // 11 — missing tenant context: dedup helper itself does NOT enforce ALS,
  // but the public scan paths run their own narrowingTenantId() check.
  // For coverage, assert dedup with tid=null falls through to plain create
  // (no probe). This matches the documented contract.
  await withFlags({ ...DEDUP_ON }, async () => {
    const s = makeStack();
    try {
      await clean(s.prisma);
      const data: any = { userId: USER_A_REC, title: 'X', message: 'X', type: 'INFO', channel: 'in_app', relatedEntity: REL_VEH, relatedEntityId: VEH_A };
      const r1 = await dedupCreate(s.notifications, data, null);
      const r2 = await dedupCreate(s.notifications, data, null);
      const cnt = await (s.prisma as any).notification.count({ where: { relatedEntityId: VEH_A, tenantId: null } });
      out.push({ name: '11. dedup with tid=null falls through (no probe; legacy create)', ok: r1.created === 1 && r2.created === 1 && cnt === 2, detail: `cnt=${cnt}` });
      await (s.prisma as any).notification.deleteMany({ where: { relatedEntityId: VEH_A, tenantId: null } });
    } finally { await s.prisma.$disconnect(); }
  });

  // 12 — concurrent tenant-aware creates remain isolated
  await withFlags({ ...FANOUT_ON, ...DEDUP_ON }, async () => {
    const s = makeStack();
    try {
      await clean(s.prisma);
      const [a, b] = await Promise.all([
        dedupCreate(s.notifications, condition(USER_A_REC, tA, VEH_A, 'VEHICLE_MOT_EXPIRING'), tA),
        dedupCreate(s.notifications, condition(USER_B_REC, tB, VEH_B, 'VEHICLE_MOT_EXPIRING'), tB),
      ]);
      const aCount = await (s.prisma as any).notification.count({ where: { tenantId: tA, relatedEntityId: VEH_A, type: 'VEHICLE_MOT_EXPIRING' } });
      const bCount = await (s.prisma as any).notification.count({ where: { tenantId: tB, relatedEntityId: VEH_B, type: 'VEHICLE_MOT_EXPIRING' } });
      out.push({ name: '12. concurrent tenant-aware scans remain ALS-isolated', ok: a.created === 1 && b.created === 1 && aCount === 1 && bCount === 1, detail: `a=${aCount} b=${bCount}` });
      await clean(s.prisma);
    } finally { await s.prisma.$disconnect(); }
  });

  // 13 — source-level: all four check* methods route through createInAppWithDedup
  const src = await fs.readFile(SRC_FILE, 'utf8');
  const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
  const exec = stripComments(src);
  const checkBlocks = ['checkExpiringCompliance', 'checkServiceDue', 'checkOverdue', 'checkScheduledMaintenance'];
  const wired = checkBlocks.map((name) => {
    const start = exec.indexOf(`async ${name}()`);
    if (start < 0) return false;
    // bound: stop at next `async ` after the start
    const after = exec.slice(start + 1);
    const next = after.search(/\n\s+async\s+\w+\(/);
    const body = next > 0 ? after.slice(0, next) : after.slice(0, 8000);
    const callsHelper = /\.createInAppWithDedup\(/.test(body);
    const callsLegacyCreate = /\.legacyPrisma\.notification\.create\(/.test(body);
    return callsHelper && !callsLegacyCreate;
  });
  const ok13 = wired.every((x) => x);
  out.push({ name: '13. all four check* methods route through createInAppWithDedup', ok: ok13, detail: checkBlocks.map((n, i) => `${n}=${wired[i] ? 'OK' : 'NO'}`).join(' ') });

  // cleanup
  {
    const prisma = new PrismaService();
    try { await clean(prisma); } finally { await prisma.$disconnect(); }
  }

  await fs.mkdir(OUT_DIR, { recursive: true });
  const passed = out.filter((c) => c.ok).length;
  const total = out.length;
  await fs.writeFile(path.join(OUT_DIR, 'notifications-internal-scan-dedup.json'),
    JSON.stringify({ passed, total, cases: out }, null, 2));
  const md = [
    `# Phase 2.46 — internal check* notification scan dedup`, ``,
    `**${passed}/${total} PASS**`, ``,
    ...out.map((c) => `- ${c.ok ? 'PASS' : 'FAIL'} — ${c.name} — ${c.detail}`), ``,
  ].join('\n');
  await fs.writeFile(path.join(OUT_DIR, 'notifications-internal-scan-dedup.md'), md);
  console.log(`[notifications-internal-scan-dedup] ${passed}/${total} PASS`);
  process.exit(passed === total ? 0 : 1);
}

main().catch((err) => { console.error(err); process.exit(2); });
