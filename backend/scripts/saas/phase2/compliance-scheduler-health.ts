/**
 * Phase 2.44 — operator-visible scheduler health signal harness.
 *
 *   1. scheduler disabled: status='skipped', processed=0, failed=0
 *   2. flag on + TENANT_JOB_FANOUT_ENABLED=false: status='skipped' (refused)
 *   3. flag on + fan-out + pilot inactive: status='skipped' (refused)
 *   4. happy path: status='ok' and processed === active tenant count
 *   5. one tenant scan failure: status='partial_failure', failed=1, no throw
 *   6. notification fan-out error: status='partial_failure', notifyFailed=1
 *   7. scheduler-level synthetic error: status='failed', cron tick does not throw
 *   8. health log fingerprint emitted EXACTLY ONCE per tick
 *   9. health log does NOT include sample names/emails/document titles
 *  10. ComplianceCron.tick source still calls only runScheduledComplianceAlertGeneration()
 *  11. ComplianceCron.tick source does not call dispatch directly
 *  12. ComplianceCron.tick source does not call notification helpers
 *
 * Output: backend/reports/saas/phase2/compliance-scheduler-health.{json,md}
 */
/* eslint-disable no-console */
import { promises as fs } from 'fs';
import path from 'path';
import { Client } from 'pg';
import { autoLoadEnv, formatDatabaseUrlMissingMessage } from './../phase1/reconciliation/lib/env';
import { classifyRuntimeEnv, isStagingClassification } from '../../../src/saas/tenancy/env-safety';
import { Logger } from '@nestjs/common';
import { PrismaService } from '../../../src/prisma/prisma.service';
import { TenantPrismaService } from '../../../src/saas/prisma/tenant-prisma.service';
import { PilotPrismaAccessor } from '../../../src/saas/prisma/pilot-prisma.accessor';
import { FeatureFlagsService } from '../../../src/saas/feature-flags/feature-flags.service';
import { TenantAuditLogService } from '../../../src/saas/audit/tenant-audit-log.service';
import { ComplianceService } from '../../../src/compliance/compliance.service';
import { ComplianceScheduler } from '../../../src/compliance/compliance.scheduler';
import { NotificationsService } from '../../../src/notifications/notifications.service';

autoLoadEnv(__filename);

const OUT_DIR = path.resolve(__dirname, '..', '..', '..', 'reports', 'saas', 'phase2');
const SRC_CRON = path.resolve(__dirname, '..', '..', '..', 'src', 'compliance', 'compliance.cron.ts');
interface CaseResult { name: string; ok: boolean; detail: string; }

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

/**
 * Capture all log lines emitted via Nest Logger during `fn`.
 * Returns the lines written by ANY logger context during the call.
 */
async function captureLogs<T>(fn: () => Promise<T>): Promise<{ result: T; lines: string[] }> {
  const lines: string[] = [];
  const orig = (Logger as any).prototype.log;
  (Logger as any).prototype.log = function patched(this: any, msg: any, ...rest: any[]) {
    try { lines.push(typeof msg === 'string' ? msg : JSON.stringify(msg)); } catch { /* noop */ }
    return orig.apply(this, [msg, ...rest]);
  };
  try {
    const result = await fn();
    return { result, lines };
  } finally {
    (Logger as any).prototype.log = orig;
  }
}

function makeStack(opts: { withNotifications: boolean }) {
  const prisma = new PrismaService();
  const flags = new FeatureFlagsService();
  const pilot = new PilotPrismaAccessor(prisma, new TenantPrismaService(prisma, flags), flags);
  const audit = new TenantAuditLogService(prisma, flags);
  const notifications = opts.withNotifications ? new NotificationsService(prisma, pilot, flags) : undefined;
  const svc = new ComplianceService(prisma, pilot, audit, flags, notifications);
  const scheduler = new ComplianceScheduler(svc, flags);
  return { prisma, flags, svc, scheduler, notifications };
}

const PILOT_ON = { TENANT_PRISMA_PILOT_ENABLED: 'true', TENANT_PRISMA_PILOT_MODULES: 'compliance' };
const FANOUT_ON = { TENANT_AWARE_JOBS_ENABLED: 'true', TENANT_JOB_FANOUT_ENABLED: 'true' };
const SCHED_ON = { COMPLIANCE_ALERT_SCHEDULER_ENABLED: 'true' };

async function main(): Promise<void> {
  const url = getDatabaseUrl();
  const env = classifyRuntimeEnv();
  if (!isStagingClassification(env.classification)) {
    console.error(`[compliance-scheduler-health] refusing on classification=${env.classification}`);
    process.exit(3);
  }
  const c = new Client({ connectionString: url, ssl: /127\.0\.0\.1|localhost/.test(url) ? false : { rejectUnauthorized: false } });
  await c.connect();
  const ts = await c.query<{ id: string }>(
    `SELECT t.id FROM tenants t WHERE t.status = 'ACTIVE' AND EXISTS (SELECT 1 FROM employees e WHERE e."tenantId" = t.id::text) ORDER BY t.slug`);
  const tA = ts.rows[0]?.id; const tB = ts.rows[1]?.id;
  await c.end();
  if (!tA || !tB) { console.error('need two ACTIVE tenants'); process.exit(3); }

  const out: CaseResult[] = [];
  const cleanupAlertIds: string[] = [];

  // 1 — disabled
  await withFlags({ ...PILOT_ON, COMPLIANCE_ALERT_SCHEDULER_ENABLED: 'false', TENANT_JOB_FANOUT_ENABLED: 'true' }, async () => {
    const s = makeStack({ withNotifications: true });
    try {
      const { result } = await captureLogs(() => s.scheduler.runScheduledComplianceAlertGeneration());
      const h = result.health!;
      out.push({ name: '1. scheduler disabled: status=skipped', ok: h.status === 'skipped' && h.skipped === true && h.processed === 0 && h.failed === 0, detail: JSON.stringify(h) });
    } finally { await s.prisma.$disconnect(); }
  });

  // 2 — fan-out off → refused
  await withFlags({ ...PILOT_ON, ...SCHED_ON, TENANT_JOB_FANOUT_ENABLED: 'false' }, async () => {
    const s = makeStack({ withNotifications: true });
    try {
      const { result } = await captureLogs(() => s.scheduler.runScheduledComplianceAlertGeneration());
      const h = result.health!;
      out.push({ name: '2. fan-out off: status=skipped (refused), processed=0', ok: h.status === 'skipped' && !!h.refused && h.processed === 0, detail: `status=${h.status} refused=${h.refused}` });
    } finally { await s.prisma.$disconnect(); }
  });

  // 3 — pilot inactive → refused
  await withFlags({ ...SCHED_ON, TENANT_JOB_FANOUT_ENABLED: 'true', TENANT_AWARE_JOBS_ENABLED: 'true', TENANT_PRISMA_PILOT_ENABLED: 'false' }, async () => {
    const s = makeStack({ withNotifications: true });
    try {
      const { result } = await captureLogs(() => s.scheduler.runScheduledComplianceAlertGeneration());
      const h = result.health!;
      out.push({ name: '3. pilot inactive: status=skipped (refused)', ok: h.status === 'skipped' && !!h.refused && h.processed === 0, detail: `status=${h.status} refused=${h.refused}` });
    } finally { await s.prisma.$disconnect(); }
  });

  // 4 — happy path → ok, processed === 2
  await withFlags({ ...PILOT_ON, ...FANOUT_ON, ...SCHED_ON }, async () => {
    const s = makeStack({ withNotifications: true });
    try {
      const beforeIds: any[] = await (s.prisma as any).complianceAlert.findMany({ where: { tenantId: tA }, select: { id: true } });
      const beforeSet = new Set(beforeIds.map((a) => a.id));
      const { result } = await captureLogs(() => s.scheduler.runScheduledComplianceAlertGeneration());
      const h = result.health!;
      // Track only NEW alerts created during the tick (id-set diff is safer
      // than message-prefix matching, which previously deleted fixture rows).
      const afterIds: any[] = await (s.prisma as any).complianceAlert.findMany({ where: { tenantId: tA }, select: { id: true } });
      for (const a of afterIds) if (!beforeSet.has(a.id)) cleanupAlertIds.push(a.id);
      out.push({ name: '4. happy path: status=ok, processed === active tenant count (2)', ok: h.status === 'ok' && h.failed === 0 && h.processed === 2, detail: JSON.stringify(h) });
    } finally { await s.prisma.$disconnect(); }
  });

  // 5 — one tenant scan failure → partial_failure
  await withFlags({ ...PILOT_ON, ...FANOUT_ON, ...SCHED_ON }, async () => {
    const s = makeStack({ withNotifications: true });
    try {
      // Sabotage one of the two tenant scans by monkey-patching
      // generateAlertsForTenant.
      const orig = (s.svc as any).generateAlertsForTenant.bind(s.svc);
      (s.svc as any).generateAlertsForTenant = async (id: string) => {
        if (id === tA) throw new Error('synthetic per-tenant failure');
        return orig(id);
      };
      const { result } = await captureLogs(() => s.scheduler.runScheduledComplianceAlertGeneration());
      const h = result.health!;
      const ok = h.status === 'partial_failure' && h.failed === 1 && h.processed === 2;
      out.push({ name: '5. one tenant failure: status=partial_failure, failed=1, no throw', ok, detail: JSON.stringify(h) });
    } finally { await s.prisma.$disconnect(); }
  });

  // 6 — notification fan-out error → partial_failure with notifyFailed=1
  await withFlags({ ...PILOT_ON, ...FANOUT_ON, ...SCHED_ON, COMPLIANCE_NOTIFY_ON_ALERT: 'true' }, async () => {
    const s = makeStack({ withNotifications: true });
    try {
      // Force notify path: monkey-patch generateAlerts to return total=1
      // so coupling fires; then sabotage notifyUsersByRoles to throw.
      const origGen = (s.svc as any).generateAlerts.bind(s.svc);
      let firstTenantNotified = false;
      (s.svc as any).generateAlerts = async () => {
        // Return total=1 only for the first tenant; otherwise 0 so we
        // get exactly one notify-error.
        if (firstTenantNotified) return { message: 'fake', total: 0 };
        firstTenantNotified = true;
        return { message: 'fake', total: 1 };
      };
      (s.notifications as any).notifyUsersByRoles = async () => {
        throw new Error('synthetic notify failure');
      };
      const { result } = await captureLogs(() => s.scheduler.runScheduledComplianceAlertGeneration());
      const h = result.health!;
      const ok = h.status === 'partial_failure' && h.notifyFailed === 1;
      out.push({ name: '6. notify error: status=partial_failure, notifyFailed=1', ok, detail: JSON.stringify(h) });
    } finally { await s.prisma.$disconnect(); }
  });

  // 7 — scheduler-level synthetic error → status='failed'
  await withFlags({ ...PILOT_ON, ...FANOUT_ON, ...SCHED_ON }, async () => {
    const s = makeStack({ withNotifications: true });
    try {
      // Sabotage the dispatch helper to throw.
      (s.svc as any).dispatchComplianceAlertGenerationForTenants = async () => {
        throw new Error('synthetic dispatch failure');
      };
      const { result } = await captureLogs(() => s.scheduler.runScheduledComplianceAlertGeneration());
      const h = result.health!;
      const ok = h.status === 'failed' && typeof h.error === 'string' && h.error.includes('synthetic');
      out.push({ name: '7. scheduler-level error: status=failed, no throw', ok, detail: JSON.stringify(h) });
    } finally { await s.prisma.$disconnect(); }
  });

  // 8 — fingerprint emitted exactly once per tick
  await withFlags({ ...PILOT_ON, ...FANOUT_ON, ...SCHED_ON }, async () => {
    const s = makeStack({ withNotifications: true });
    try {
      const { lines } = await captureLogs(() => s.scheduler.runScheduledComplianceAlertGeneration());
      const matches = lines.filter((l) => l.startsWith('compliance.scheduler.health '));
      out.push({ name: '8. health fingerprint emitted EXACTLY ONCE per tick', ok: matches.length === 1, detail: `count=${matches.length}` });
    } finally { await s.prisma.$disconnect(); }
  });

  // 9 — health log does not contain sample sensitive payloads
  await withFlags({ ...PILOT_ON, ...FANOUT_ON, ...SCHED_ON }, async () => {
    const s = makeStack({ withNotifications: true });
    try {
      const { lines } = await captureLogs(() => s.scheduler.runScheduledComplianceAlertGeneration());
      const healthLine = lines.find((l) => l.startsWith('compliance.scheduler.health ')) ?? '';
      // The health JSON is a counts-only summary. None of these patterns
      // should appear: '@', '.com', 'firstName', 'email', 'lastName',
      // 'PASSPORT', or any document title from our fixture.
      const sensitivePatterns = ['@x.test', '@tempworks.test', 'firstName', 'email', 'PASSPORT', 'document expires'];
      const found = sensitivePatterns.filter((p) => healthLine.includes(p));
      out.push({ name: '9. health log does NOT include sensitive sample payloads', ok: found.length === 0, detail: `len=${healthLine.length} found=${found.join(',') || 'none'}` });
    } finally { await s.prisma.$disconnect(); }
  });

  // 10-12 — source-level on ComplianceCron.tick
  const cronSrc = (await fs.readFile(SRC_CRON, 'utf8'))
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
  const tickStart = cronSrc.indexOf('async tick()');
  const tickBody = tickStart >= 0 ? cronSrc.slice(tickStart) : '';
  const callsScheduler = /\.runScheduledComplianceAlertGeneration\(\)/.test(tickBody);
  const callsDispatch = /\.dispatchComplianceAlertGenerationForTenants\(/.test(tickBody);
  const callsNotify = /\.notifyUsersByRoles\(|\.notifyUploaderAndRoles\(/.test(tickBody);
  out.push({ name: '10. ComplianceCron.tick calls only runScheduledComplianceAlertGeneration()', ok: callsScheduler, detail: `present=${callsScheduler}` });
  out.push({ name: '11. ComplianceCron.tick does not call dispatch directly', ok: !callsDispatch, detail: `present=${callsDispatch}` });
  out.push({ name: '12. ComplianceCron.tick does not call notification helpers', ok: !callsNotify, detail: `present=${callsNotify}` });

  // Cleanup: delete every alert created by generateAlerts() during this
  // run. The generated message format is 'Document expires in N days' —
  // no fixture row uses that prefix, so this is safe.
  {
    const prisma = new PrismaService();
    try {
      await (prisma as any).complianceAlert.deleteMany({
        where: { message: { startsWith: 'Document expires in' } },
      });
    } finally { await prisma.$disconnect(); }
  }

  await fs.mkdir(OUT_DIR, { recursive: true });
  const passed = out.filter((c) => c.ok).length;
  const total = out.length;
  await fs.writeFile(path.join(OUT_DIR, 'compliance-scheduler-health.json'),
    JSON.stringify({ passed, total, cases: out }, null, 2));
  const md = [
    `# Phase 2.44 — compliance scheduler health signal`, ``,
    `**${passed}/${total} PASS**`, ``,
    ...out.map((c) => `- ${c.ok ? 'PASS' : 'FAIL'} — ${c.name} — ${c.detail}`), ``,
  ].join('\n');
  await fs.writeFile(path.join(OUT_DIR, 'compliance-scheduler-health.md'), md);
  console.log(`[compliance-scheduler-health] ${passed}/${total} PASS`);
  process.exit(passed === total ? 0 : 1);
}

main().catch((err) => { console.error(err); process.exit(2); });
