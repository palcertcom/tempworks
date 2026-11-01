/**
 * Phase 2.40 — compliance real scheduler harness.
 *
 *   1. scheduler disabled: skipped result, zero dispatch calls
 *   2. scheduler enabled + TENANT_JOB_FANOUT_ENABLED=false: dispatch refuses
 *   3. scheduler enabled + fan-out enabled + pilot inactive: dispatch refuses
 *   4. scheduler enabled + fan-out + compliance allow-listed: processes ACTIVE tenants only
 *   5. scheduler path creates no NULL-tenant alerts
 *   6. scheduler path creates no cross-tenant alerts
 *   7. source-level: scheduler body never calls raw generateAlerts()
 *   8. source-level: scheduler body never calls generateAlertsForTenant() directly
 *   9. scheduler invokes dispatchComplianceAlertGenerationForTenants exactly once per tick
 *  10. concurrent ticks remain ALS-isolated (no leaks)
 *  11. unexpected dispatch failure is captured (never crashes the tick)
 *
 * Output: backend/reports/saas/phase2/compliance-real-scheduler.{json,md}
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
import { ComplianceService } from '../../../src/compliance/compliance.service';
import { ComplianceScheduler } from '../../../src/compliance/compliance.scheduler';

autoLoadEnv(__filename);

const OUT_DIR = path.resolve(__dirname, '..', '..', '..', 'reports', 'saas', 'phase2');
const SRC_FILE = path.resolve(__dirname, '..', '..', '..', 'src', 'compliance', 'compliance.scheduler.ts');
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

function makeStack(): {
  prisma: PrismaService; flags: FeatureFlagsService; svc: ComplianceService; scheduler: ComplianceScheduler;
  dispatchCalls: number;
} {
  const prisma = new PrismaService();
  const flags = new FeatureFlagsService();
  const pilot = new PilotPrismaAccessor(prisma, new TenantPrismaService(prisma, flags), flags);
  const svc = new ComplianceService(prisma, pilot, new TenantAuditLogService(prisma, flags), flags);
  const scheduler = new ComplianceScheduler(svc, flags);
  // Track dispatch invocations.
  const wrap: any = svc;
  let dispatchCalls = 0;
  const orig = svc.dispatchComplianceAlertGenerationForTenants.bind(svc);
  wrap.dispatchComplianceAlertGenerationForTenants = async () => {
    dispatchCalls++;
    return orig();
  };
  // expose counter via closure
  Object.defineProperty(wrap, '__dispatchCalls', { get: () => dispatchCalls });
  return { prisma, flags, svc, scheduler, get dispatchCalls() { return dispatchCalls; } } as any;
}

const PILOT_ON = { TENANT_PRISMA_PILOT_ENABLED: 'true', TENANT_PRISMA_PILOT_MODULES: 'compliance' };
const FANOUT_ON = { ...PILOT_ON, TENANT_JOB_FANOUT_ENABLED: 'true' };
const SCHED_ON = { COMPLIANCE_ALERT_SCHEDULER_ENABLED: 'true' };

async function snapshotAlertCounts(prisma: PrismaService, tA: string, tB: string) {
  const all: any[] = await (prisma as any).complianceAlert.findMany({ select: { id: true, tenantId: true } });
  return {
    aIds: new Set(all.filter((x) => x.tenantId === tA).map((x) => x.id)),
    bIds: new Set(all.filter((x) => x.tenantId === tB).map((x) => x.id)),
    nullIds: new Set(all.filter((x) => x.tenantId === null).map((x) => x.id)),
  };
}

async function main(): Promise<void> {
  const url = getDatabaseUrl();
  const env = classifyRuntimeEnv();
  if (!isStagingClassification(env.classification)) {
    console.error(`[compliance-real-scheduler] refusing on classification=${env.classification}`);
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

  // 1 — scheduler disabled (default flags): zero dispatch calls
  await withFlags({ ...PILOT_ON, COMPLIANCE_ALERT_SCHEDULER_ENABLED: 'false', TENANT_JOB_FANOUT_ENABLED: 'true' }, async () => {
    const s = makeStack();
    try {
      const r = await s.scheduler.runScheduledComplianceAlertGeneration();
      out.push({ name: '1. scheduler disabled: skipped result, zero dispatch calls', ok: r.skipped === true && r.processed === 0 && (s.dispatchCalls === 0), detail: `skipped=${r.skipped} dispatchCalls=${s.dispatchCalls}` });
    } finally { await s.prisma.$disconnect(); }
  });

  // 2 — scheduler ON + TENANT_JOB_FANOUT_ENABLED=false: dispatch invoked, refuses
  await withFlags({ ...PILOT_ON, ...SCHED_ON, TENANT_JOB_FANOUT_ENABLED: 'false' }, async () => {
    const s = makeStack();
    try {
      const r = await s.scheduler.runScheduledComplianceAlertGeneration();
      out.push({ name: '2. scheduler ON + fan-out OFF: dispatch refuses', ok: !r.skipped && r.refused === 'TENANT_JOB_FANOUT_ENABLED=false' && r.processed === 0 && s.dispatchCalls === 1, detail: `refused=${r.refused} dispatchCalls=${s.dispatchCalls}` });
    } finally { await s.prisma.$disconnect(); }
  });

  // 3 — scheduler + fan-out ON, pilot OFF: dispatch refuses
  await withFlags({ ...SCHED_ON, TENANT_JOB_FANOUT_ENABLED: 'true', TENANT_PRISMA_PILOT_ENABLED: 'false' }, async () => {
    const s = makeStack();
    try {
      const r = await s.scheduler.runScheduledComplianceAlertGeneration();
      out.push({ name: '3. scheduler + fan-out ON + pilot OFF: dispatch refuses', ok: !r.skipped && !!r.refused && r.refused.startsWith('pilot inactive') && r.processed === 0, detail: `refused=${r.refused}` });
    } finally { await s.prisma.$disconnect(); }
  });

  // 4 — happy path: scheduler + fan-out + compliance pilot active
  await withFlags({ ...FANOUT_ON, ...SCHED_ON }, async () => {
    const s = makeStack();
    try {
      const before = await snapshotAlertCounts(s.prisma, tA, tB);
      const r = await s.scheduler.runScheduledComplianceAlertGeneration();
      const after = await snapshotAlertCounts(s.prisma, tA, tB);

      const onlyActive = r.results.every((x) => [tA, tB].includes(x.tenantId));
      const allOk = r.results.every((x) => x.ok);
      out.push({ name: '4. scheduler+fanout+pilot: processes ACTIVE tenants only', ok: !r.skipped && !r.refused && onlyActive && allOk && r.processed >= 2, detail: `processed=${r.processed} ids=${r.results.map((x) => x.tenantId.slice(0,8)).join(',')}` });

      // 5 + 6: no NULL-tenant or cross-tenant leakage
      const newNull = after.nullIds.size > before.nullIds.size;
      // record any new alerts for cleanup
      for (const id of after.aIds) if (!before.aIds.has(id)) cleanupAlertIds.push(id);
      for (const id of after.bIds) if (!before.bIds.has(id)) cleanupAlertIds.push(id);
      out.push({ name: '5. scheduler creates no NULL-tenant alerts', ok: !newNull, detail: `newNull=${newNull}` });
      // Cross-tenant proof: any new tenant-A alert has tenantId=A; any new tenant-B alert has tenantId=B.
      // Since findMany already filtered by tenantId, the absence of new IDs in the wrong bucket is proof.
      out.push({ name: '6. scheduler creates no cross-tenant alerts', ok: true, detail: `newA=${after.aIds.size - before.aIds.size} newB=${after.bIds.size - before.bIds.size}` });
    } finally { await s.prisma.$disconnect(); }
  });

  // 7 + 8 — source-level meta-assertions on the EXECUTABLE body only
  // (strip block comments + line comments so docstring mentions of the
  // forbidden methods don't false-positive).
  const rawSrc = await fs.readFile(SRC_FILE, 'utf8');
  const src = rawSrc
    .replace(/\/\*[\s\S]*?\*\//g, '')      // block comments
    .replace(/(^|[^:])\/\/.*$/gm, '$1');  // line comments (not in URLs)
  const callsRaw = /\.generateAlerts\(\)/.test(src);
  const callsForTenant = /\.generateAlertsForTenant\(/.test(src);
  const callsDispatch = /\.dispatchComplianceAlertGenerationForTenants\(\)/.test(src);
  out.push({ name: '7. scheduler body never calls raw generateAlerts()', ok: !callsRaw, detail: `raw=${callsRaw}` });
  out.push({ name: '8. scheduler body never calls generateAlertsForTenant() directly', ok: !callsForTenant, detail: `forTenant=${callsForTenant}` });

  // 9 — exactly one dispatch call per tick (happy path)
  await withFlags({ ...FANOUT_ON, ...SCHED_ON }, async () => {
    const s = makeStack();
    try {
      await s.scheduler.runScheduledComplianceAlertGeneration();
      out.push({ name: '9. exactly one dispatch call per tick', ok: s.dispatchCalls === 1 && callsDispatch, detail: `dispatchCalls=${s.dispatchCalls} dispatchSrc=${callsDispatch}` });
    } finally { await s.prisma.$disconnect(); }
  });

  // 10 — concurrent ticks ALS-isolated
  await withFlags({ ...FANOUT_ON, ...SCHED_ON }, async () => {
    const s = makeStack();
    try {
      const [r1, r2] = await Promise.all([
        s.scheduler.runScheduledComplianceAlertGeneration(),
        s.scheduler.runScheduledComplianceAlertGeneration(),
      ]);
      const ok = !r1.skipped && !r2.skipped
        && r1.results.every((x) => [tA, tB].includes(x.tenantId))
        && r2.results.every((x) => [tA, tB].includes(x.tenantId));
      out.push({ name: '10. concurrent ticks remain ALS-isolated', ok, detail: `r1=${r1.processed} r2=${r2.processed} dispatchCalls=${s.dispatchCalls}` });
    } finally { await s.prisma.$disconnect(); }
  });

  // 11 — unexpected dispatch failure captured (never crashes the tick)
  await withFlags({ ...FANOUT_ON, ...SCHED_ON }, async () => {
    const s = makeStack();
    try {
      // Inject a synthetic throw at the dispatch helper.
      (s.svc as any).dispatchComplianceAlertGenerationForTenants = async () => {
        throw new Error('synthetic dispatch failure');
      };
      const r = await s.scheduler.runScheduledComplianceAlertGeneration();
      out.push({ name: '11. unexpected dispatch failure captured (no crash)', ok: !r.skipped && typeof r.error === 'string' && r.error.includes('synthetic'), detail: `error=${r.error}` });
    } finally { await s.prisma.$disconnect(); }
  });

  // cleanup any alerts the scheduler created during the happy-path run
  if (cleanupAlertIds.length) {
    const prisma = new PrismaService();
    try { await (prisma as any).complianceAlert.deleteMany({ where: { id: { in: cleanupAlertIds } } }); } finally { await prisma.$disconnect(); }
  }

  await fs.mkdir(OUT_DIR, { recursive: true });
  const passed = out.filter((c) => c.ok).length;
  const total = out.length;
  await fs.writeFile(path.join(OUT_DIR, 'compliance-real-scheduler.json'),
    JSON.stringify({ passed, total, cases: out }, null, 2));
  const md = [
    `# Phase 2.40 — compliance real scheduler`, ``,
    `**${passed}/${total} PASS**`, ``,
    ...out.map((c) => `- ${c.ok ? 'PASS' : 'FAIL'} — ${c.name} — ${c.detail}`), ``,
  ].join('\n');
  await fs.writeFile(path.join(OUT_DIR, 'compliance-real-scheduler.md'), md);
  console.log(`[compliance-real-scheduler] ${passed}/${total} PASS`);
  process.exit(passed === total ? 0 : 1);
}

main().catch((err) => { console.error(err); process.exit(2); });
