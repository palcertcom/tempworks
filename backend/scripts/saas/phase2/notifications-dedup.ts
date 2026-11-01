/**
 * Phase 2.45 — per-recipient notification dedup harness.
 *
 *   1. NOTIFICATION_DEDUP_ENABLED=false: legacy duplicates created
 *   2. NOTIFICATION_DEDUP_ENABLED=true:  second identical notif suppressed
 *   3. dedup does NOT suppress same event for a different user (same tenant)
 *   4. dedup does NOT suppress same event for same user in a different tenant
 *   5. dedup does NOT suppress different event types for same user
 *   6. dedup window respected: row outside window does not suppress new one
 *   7. tenant A dedup query does not see tenant B rows
 *   8. NULL-tenant legacy rows do not suppress tenant-scoped notifications
 *   9. compliance coupling with dedup ON: first tick creates; second suppresses
 *  10. compliance scheduler health includes notifyDeduped counter
 *  11. missing tenant context refuses safely (assertTenantForFanout)
 *  12. concurrent fan-outs in different tenants remain isolated
 *
 * Output: backend/reports/saas/phase2/notifications-dedup.{json,md}
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
import { TenantAuditLogService } from '../../../src/saas/audit/tenant-audit-log.service';
import { NotificationsService } from '../../../src/notifications/notifications.service';
import { ComplianceService } from '../../../src/compliance/compliance.service';
import { ComplianceScheduler } from '../../../src/compliance/compliance.scheduler';
import { TenantContext, withRequestContext, newRequestId } from '../../../src/saas/context/als';

autoLoadEnv(__filename);

const OUT_DIR = path.resolve(__dirname, '..', '..', '..', 'reports', 'saas', 'phase2');
interface CaseResult { name: string; ok: boolean; detail: string; }

const TENANT_A_AGENCY = 'aaaaaaa1-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const TENANT_B_AGENCY = 'bbbbbbb2-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const USER_A_REC = '00000000-0000-0000-0000-00000000us03'; // Recruiter A
const USER_A_CO  = '00000000-0000-0000-0000-00000000us05'; // Compliance Officer A
const USER_B_REC = '00000000-0000-0000-0000-00000000us04'; // Recruiter B
const USER_B_CO  = '00000000-0000-0000-0000-00000000us06'; // Compliance Officer B

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

function makeStack(opts: { withCompliance?: boolean } = {}) {
  const prisma = new PrismaService();
  const flags = new FeatureFlagsService();
  const pilot = new PilotPrismaAccessor(prisma, new TenantPrismaService(prisma, flags), flags);
  const audit = new TenantAuditLogService(prisma, flags);
  const notifications = new NotificationsService(prisma, pilot, flags);
  const svc = new ComplianceService(prisma, pilot, audit, flags, notifications);
  const scheduler = new ComplianceScheduler(svc, flags);
  return { prisma, flags, pilot, notifications, svc, scheduler };
}

const PILOT_ON = { TENANT_PRISMA_PILOT_ENABLED: 'true', TENANT_PRISMA_PILOT_MODULES: 'compliance,notifications' };
const FANOUT_ON = { TENANT_AWARE_JOBS_ENABLED: 'true', TENANT_JOB_FANOUT_ENABLED: 'true' };
const DEDUP_ON = { NOTIFICATION_DEDUP_ENABLED: 'true' };
const DEDUP_OFF = { NOTIFICATION_DEDUP_ENABLED: 'false' };

const REL = 'TestEntity';
const REL_ID_A = 'tick:phase245-A';
const REL_ID_B = 'tick:phase245-B';

async function clean(prisma: PrismaService): Promise<void> {
  await (prisma as any).notification.deleteMany({
    where: { relatedEntity: REL, relatedEntityId: { in: [REL_ID_A, REL_ID_B] } },
  });
}

async function main(): Promise<void> {
  const url = getDatabaseUrl();
  const env = classifyRuntimeEnv();
  if (!isStagingClassification(env.classification)) {
    console.error(`[notifications-dedup] refusing on classification=${env.classification}`);
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

  // 1 — flag off: duplicates created
  await withFlags({ ...FANOUT_ON, ...DEDUP_OFF }, async () => {
    const s = makeStack();
    try {
      await clean(s.prisma);
      const r1 = await withRequestContext({ requestId: newRequestId() }, async () => {
        TenantContext.attach({ id: tA, slug: 'a', name: 'A', status: 'ACTIVE', region: 'eu' });
        return s.notifications.notifyUsersByRoles(['Recruiter'], 'document.uploaded' as any, 'Hello', 'msg', REL, REL_ID_A);
      });
      const r2 = await withRequestContext({ requestId: newRequestId() }, async () => {
        TenantContext.attach({ id: tA, slug: 'a', name: 'A', status: 'ACTIVE', region: 'eu' });
        return s.notifications.notifyUsersByRoles(['Recruiter'], 'document.uploaded' as any, 'Hello', 'msg', REL, REL_ID_A);
      });
      const count = await (s.prisma as any).notification.count({
        where: { relatedEntity: REL, relatedEntityId: REL_ID_A, userId: USER_A_REC, tenantId: tA },
      });
      out.push({ name: '1. flag off: duplicates still created (legacy)', ok: r1.created === 1 && r2.created === 1 && r2.deduped === 0 && count === 2, detail: `r1=${JSON.stringify(r1)} r2=${JSON.stringify(r2)} count=${count}` });
      await clean(s.prisma);
    } finally { await s.prisma.$disconnect(); }
  });

  // 2 — flag on: second identical suppressed
  await withFlags({ ...FANOUT_ON, ...DEDUP_ON }, async () => {
    const s = makeStack();
    try {
      await clean(s.prisma);
      const r1 = await withRequestContext({ requestId: newRequestId() }, async () => {
        TenantContext.attach({ id: tA, slug: 'a', name: 'A', status: 'ACTIVE', region: 'eu' });
        return s.notifications.notifyUsersByRoles(['Recruiter'], 'document.uploaded' as any, 'Hello', 'msg', REL, REL_ID_A);
      });
      const r2 = await withRequestContext({ requestId: newRequestId() }, async () => {
        TenantContext.attach({ id: tA, slug: 'a', name: 'A', status: 'ACTIVE', region: 'eu' });
        return s.notifications.notifyUsersByRoles(['Recruiter'], 'document.uploaded' as any, 'Hello', 'msg', REL, REL_ID_A);
      });
      const count = await (s.prisma as any).notification.count({
        where: { relatedEntity: REL, relatedEntityId: REL_ID_A, userId: USER_A_REC, tenantId: tA },
      });
      out.push({ name: '2. flag on: second identical suppressed', ok: r1.created === 1 && r2.created === 0 && r2.deduped === 1 && count === 1, detail: `r1=${JSON.stringify(r1)} r2=${JSON.stringify(r2)} count=${count}` });
      await clean(s.prisma);
    } finally { await s.prisma.$disconnect(); }
  });

  // 3 — different user (same tenant): NOT suppressed
  await withFlags({ ...FANOUT_ON, ...DEDUP_ON }, async () => {
    const s = makeStack();
    try {
      await clean(s.prisma);
      // Send to Recruiter, then again to Compliance Officer (different role/user) for the same relatedEntityId.
      const r1 = await withRequestContext({ requestId: newRequestId() }, async () => {
        TenantContext.attach({ id: tA, slug: 'a', name: 'A', status: 'ACTIVE', region: 'eu' });
        return s.notifications.notifyUsersByRoles(['Recruiter'], 'document.uploaded' as any, 'Hello', 'msg', REL, REL_ID_A);
      });
      const r2 = await withRequestContext({ requestId: newRequestId() }, async () => {
        TenantContext.attach({ id: tA, slug: 'a', name: 'A', status: 'ACTIVE', region: 'eu' });
        return s.notifications.notifyUsersByRoles(['Compliance Officer'], 'document.uploaded' as any, 'Hello', 'msg', REL, REL_ID_A);
      });
      const totalA = await (s.prisma as any).notification.count({ where: { relatedEntity: REL, relatedEntityId: REL_ID_A, tenantId: tA } });
      out.push({ name: '3. dedup does NOT suppress different user same tenant', ok: r1.created === 1 && r2.created === 1 && totalA === 2, detail: `r1=${JSON.stringify(r1)} r2=${JSON.stringify(r2)} totalA=${totalA}` });
      await clean(s.prisma);
    } finally { await s.prisma.$disconnect(); }
  });

  // 4 — same user-equivalent role in DIFFERENT tenant: NOT suppressed
  await withFlags({ ...FANOUT_ON, ...DEDUP_ON }, async () => {
    const s = makeStack();
    try {
      await clean(s.prisma);
      const r1 = await withRequestContext({ requestId: newRequestId() }, async () => {
        TenantContext.attach({ id: tA, slug: 'a', name: 'A', status: 'ACTIVE', region: 'eu' });
        return s.notifications.notifyUsersByRoles(['Recruiter'], 'document.uploaded' as any, 'Hello', 'msg', REL, REL_ID_A);
      });
      const r2 = await withRequestContext({ requestId: newRequestId() }, async () => {
        TenantContext.attach({ id: tB, slug: 'b', name: 'B', status: 'ACTIVE', region: 'eu' });
        return s.notifications.notifyUsersByRoles(['Recruiter'], 'document.uploaded' as any, 'Hello', 'msg', REL, REL_ID_A);
      });
      const aCount = await (s.prisma as any).notification.count({ where: { tenantId: tA, relatedEntity: REL, relatedEntityId: REL_ID_A } });
      const bCount = await (s.prisma as any).notification.count({ where: { tenantId: tB, relatedEntity: REL, relatedEntityId: REL_ID_A } });
      out.push({ name: '4. dedup does NOT cross tenants', ok: r1.created === 1 && r2.created === 1 && aCount === 1 && bCount === 1, detail: `aCount=${aCount} bCount=${bCount}` });
      await clean(s.prisma);
    } finally { await s.prisma.$disconnect(); }
  });

  // 5 — different event type: NOT suppressed
  await withFlags({ ...FANOUT_ON, ...DEDUP_ON }, async () => {
    const s = makeStack();
    try {
      await clean(s.prisma);
      // DOCUMENT_UPLOADED → 'DOCUMENT_EXPIRY' type;
      // FINANCIAL_HIGH_BALANCE → 'WARNING' type. Different types ⇒ no dedup.
      const r1 = await withRequestContext({ requestId: newRequestId() }, async () => {
        TenantContext.attach({ id: tA, slug: 'a', name: 'A', status: 'ACTIVE', region: 'eu' });
        return s.notifications.notifyUsersByRoles(['Recruiter'], 'DOCUMENT_UPLOADED' as any, 'Hello', 'msg', REL, REL_ID_A);
      });
      const r2 = await withRequestContext({ requestId: newRequestId() }, async () => {
        TenantContext.attach({ id: tA, slug: 'a', name: 'A', status: 'ACTIVE', region: 'eu' });
        return s.notifications.notifyUsersByRoles(['Recruiter'], 'FINANCIAL_HIGH_BALANCE' as any, 'Hello', 'msg', REL, REL_ID_A);
      });
      const total = await (s.prisma as any).notification.count({ where: { tenantId: tA, relatedEntity: REL, relatedEntityId: REL_ID_A } });
      out.push({ name: '5. dedup does NOT suppress different event type', ok: r1.created === 1 && r2.created === 1 && total === 2, detail: `r1=${JSON.stringify(r1)} r2=${JSON.stringify(r2)} total=${total}` });
      await clean(s.prisma);
    } finally { await s.prisma.$disconnect(); }
  });

  // 6 — window respected: row older than window does not suppress
  await withFlags({ ...FANOUT_ON, ...DEDUP_ON, NOTIFICATION_DEDUP_WINDOW_MINUTES: '1' }, async () => {
    const s = makeStack();
    try {
      await clean(s.prisma);
      // Seed an OLD row directly (createdAt = 2 hours ago) to simulate "outside the 1-minute window".
      await (s.prisma as any).notification.create({
        data: {
          userId: USER_A_REC,
          title: 'Hello', message: 'msg', type: 'INFO', channel: 'in_app',
          relatedEntity: REL, relatedEntityId: REL_ID_A, tenantId: tA,
          createdAt: new Date(Date.now() - 2 * 60 * 60 * 1000),
        },
      });
      const r = await withRequestContext({ requestId: newRequestId() }, async () => {
        TenantContext.attach({ id: tA, slug: 'a', name: 'A', status: 'ACTIVE', region: 'eu' });
        return s.notifications.notifyUsersByRoles(['Recruiter'], 'document.uploaded' as any, 'Hello', 'msg', REL, REL_ID_A);
      });
      const total = await (s.prisma as any).notification.count({ where: { tenantId: tA, relatedEntity: REL, relatedEntityId: REL_ID_A } });
      out.push({ name: '6. window respected: old row outside window does not suppress', ok: r.created === 1 && total === 2, detail: `r=${JSON.stringify(r)} total=${total}` });
      await clean(s.prisma);
    } finally { await s.prisma.$disconnect(); }
  });

  // 7 — tenant A dedup query does not see tenant B rows
  await withFlags({ ...FANOUT_ON, ...DEDUP_ON }, async () => {
    const s = makeStack();
    try {
      await clean(s.prisma);
      // Pre-seed an existing tenant-B row that "looks identical" to what tenant A is about to send.
      await (s.prisma as any).notification.create({
        data: {
          userId: USER_B_REC,
          title: 'Hello', message: 'msg', type: 'INFO', channel: 'in_app',
          relatedEntity: REL, relatedEntityId: REL_ID_A, tenantId: tB,
        },
      });
      const r = await withRequestContext({ requestId: newRequestId() }, async () => {
        TenantContext.attach({ id: tA, slug: 'a', name: 'A', status: 'ACTIVE', region: 'eu' });
        return s.notifications.notifyUsersByRoles(['Recruiter'], 'document.uploaded' as any, 'Hello', 'msg', REL, REL_ID_A);
      });
      const aCount = await (s.prisma as any).notification.count({ where: { tenantId: tA, relatedEntity: REL, relatedEntityId: REL_ID_A } });
      out.push({ name: '7. tenant A dedup does NOT see tenant B rows', ok: r.created === 1 && aCount === 1, detail: `r=${JSON.stringify(r)} aCount=${aCount}` });
      await clean(s.prisma);
    } finally { await s.prisma.$disconnect(); }
  });

  // 8 — NULL-tenant legacy rows do not suppress
  await withFlags({ ...FANOUT_ON, ...DEDUP_ON }, async () => {
    const s = makeStack();
    try {
      await clean(s.prisma);
      await (s.prisma as any).notification.create({
        data: {
          userId: USER_A_REC,
          title: 'Hello', message: 'msg', type: 'INFO', channel: 'in_app',
          relatedEntity: REL, relatedEntityId: REL_ID_A, tenantId: null,
        },
      });
      const r = await withRequestContext({ requestId: newRequestId() }, async () => {
        TenantContext.attach({ id: tA, slug: 'a', name: 'A', status: 'ACTIVE', region: 'eu' });
        return s.notifications.notifyUsersByRoles(['Recruiter'], 'document.uploaded' as any, 'Hello', 'msg', REL, REL_ID_A);
      });
      const aCount = await (s.prisma as any).notification.count({ where: { tenantId: tA, relatedEntity: REL, relatedEntityId: REL_ID_A } });
      out.push({ name: '8. NULL-tenant legacy row does NOT suppress tenant-scoped notification', ok: r.created === 1 && aCount === 1, detail: `r=${JSON.stringify(r)} aCount=${aCount}` });
      await clean(s.prisma);
    } finally { await s.prisma.$disconnect(); }
  });

  // 9 — compliance coupling with dedup ON: first tick creates; second suppresses
  await withFlags({ ...PILOT_ON, ...FANOUT_ON, ...DEDUP_ON, COMPLIANCE_NOTIFY_ON_ALERT: 'true' }, async () => {
    const s = makeStack();
    try {
      // Force notify path with total=1 on every call so coupling fires
      // both ticks; the second tick's notification is suppressed by dedup.
      (s.svc as any).generateAlerts = async () => ({ message: 'fake', total: 1 });
      // Tick 1
      const r1: any = await s.svc.generateAlertsForTenant(tA);
      // Tick 2 (immediate)
      const r2: any = await s.svc.generateAlertsForTenant(tA);
      out.push({ name: '9. compliance coupling: first tick creates, second tick deduped', ok: r1.notify?.notified === 1 && r2.notify?.notified === 0 && r2.notify?.deduped === 1, detail: `t1=${JSON.stringify(r1.notify)} t2=${JSON.stringify(r2.notify)}` });
      // cleanup any 'tick:<tA>' rows
      await (s.prisma as any).notification.deleteMany({ where: { relatedEntity: 'ComplianceAlert', relatedEntityId: `tick:${tA}` } });
    } finally { await s.prisma.$disconnect(); }
  });

  // 10 — scheduler health summary includes notifyDeduped counter
  await withFlags({ ...PILOT_ON, ...FANOUT_ON, ...DEDUP_ON, COMPLIANCE_NOTIFY_ON_ALERT: 'true', COMPLIANCE_ALERT_SCHEDULER_ENABLED: 'true' }, async () => {
    const s = makeStack();
    try {
      // Force two ticks where notify fires (total=1) so the second is deduped.
      const orig = (s.svc as any).generateAlerts.bind(s.svc);
      let calls = 0;
      (s.svc as any).generateAlerts = async () => {
        calls++;
        return { message: 'fake', total: 1 };
      };
      // First scheduler run (creates notification)
      await s.scheduler.runScheduledComplianceAlertGeneration();
      // Second run (notification suppressed by dedup → notify.deduped >= 1 → notifyDeduped > 0)
      const r2 = await s.scheduler.runScheduledComplianceAlertGeneration();
      const h = r2.health!;
      out.push({ name: '10. scheduler health includes notifyDeduped counter', ok: typeof h.notifyDeduped === 'number' && h.notifyDeduped >= 1, detail: `health=${JSON.stringify({ status: h.status, notifyDeduped: h.notifyDeduped, notifySucceeded: h.notifySucceeded })}` });
      // cleanup
      await (s.prisma as any).notification.deleteMany({ where: { relatedEntity: 'ComplianceAlert', relatedEntityId: { startsWith: 'tick:' } } });
    } finally { await s.prisma.$disconnect(); }
  });

  // 11 — missing tenant context refuses safely
  await withFlags({ ...FANOUT_ON, ...DEDUP_ON }, async () => {
    const s = makeStack();
    try {
      // No withRequestContext → no ALS → assertTenantForFanout throws.
      let threw = false;
      try {
        await s.notifications.notifyUsersByRoles(['Recruiter'], 'document.uploaded' as any, 'X', 'Y', REL, REL_ID_A);
      } catch { threw = true; }
      out.push({ name: '11. missing tenant context refuses safely (assertTenantForFanout)', ok: threw, detail: threw ? 'threw' : 'UNEXPECTED' });
    } finally { await s.prisma.$disconnect(); }
  });

  // 12 — concurrent fan-outs in different tenants remain isolated
  await withFlags({ ...FANOUT_ON, ...DEDUP_ON }, async () => {
    const s = makeStack();
    try {
      await clean(s.prisma);
      const [a, b] = await Promise.all([
        withRequestContext({ requestId: newRequestId() }, async () => {
          TenantContext.attach({ id: tA, slug: 'a', name: 'A', status: 'ACTIVE', region: 'eu' });
          return s.notifications.notifyUsersByRoles(['Recruiter'], 'document.uploaded' as any, 'A', 'a', REL, REL_ID_A);
        }),
        withRequestContext({ requestId: newRequestId() }, async () => {
          TenantContext.attach({ id: tB, slug: 'b', name: 'B', status: 'ACTIVE', region: 'eu' });
          return s.notifications.notifyUsersByRoles(['Recruiter'], 'document.uploaded' as any, 'B', 'b', REL, REL_ID_B);
        }),
      ]);
      const aCount = await (s.prisma as any).notification.count({ where: { tenantId: tA, relatedEntity: REL, relatedEntityId: REL_ID_A } });
      const bCount = await (s.prisma as any).notification.count({ where: { tenantId: tB, relatedEntity: REL, relatedEntityId: REL_ID_B } });
      out.push({ name: '12. concurrent tenant fan-outs remain isolated', ok: a.created === 1 && b.created === 1 && aCount === 1 && bCount === 1, detail: `a=${JSON.stringify(a)} b=${JSON.stringify(b)}` });
      await clean(s.prisma);
    } finally { await s.prisma.$disconnect(); }
  });

  await fs.mkdir(OUT_DIR, { recursive: true });
  const passed = out.filter((c) => c.ok).length;
  const total = out.length;
  await fs.writeFile(path.join(OUT_DIR, 'notifications-dedup.json'),
    JSON.stringify({ passed, total, cases: out }, null, 2));
  const md = [
    `# Phase 2.45 — per-recipient notification dedup`, ``,
    `**${passed}/${total} PASS**`, ``,
    ...out.map((c) => `- ${c.ok ? 'PASS' : 'FAIL'} — ${c.name} — ${c.detail}`), ``,
  ].join('\n');
  await fs.writeFile(path.join(OUT_DIR, 'notifications-dedup.md'), md);
  console.log(`[notifications-dedup] ${passed}/${total} PASS`);
  process.exit(passed === total ? 0 : 1);
}

main().catch((err) => { console.error(err); process.exit(2); });
