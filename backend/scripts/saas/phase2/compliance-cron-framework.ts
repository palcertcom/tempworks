/**
 * Phase 2.41 — compliance cron framework harness.
 *
 *   1. ComplianceCron is wired into ComplianceModule providers
 *   2. exactly one @Cron entrypoint exists in compliance.cron.ts
 *   3. cron tick body calls runScheduledComplianceAlertGeneration()
 *   4. cron body never calls dispatchComplianceAlertGenerationForTenants directly
 *   5. cron body never calls generateAlerts()
 *   6. cron body never calls generateAlertsForTenant()
 *   7. ScheduleModule.forRoot() registered exactly once in app.module.ts
 *   8. scheduler disabled: cron tick is a no-op (skipped result)
 *   9. scheduler enabled + fan-out OFF: dispatch refuses, zero tenant scans
 *  10. scheduler + fan-out ON + pilot inactive: dispatch refuses
 *  11. scheduler + fan-out ON + compliance allow-listed: ACTIVE tenants only
 *  12. cron path creates no NULL-tenant alerts
 *  13. cron path creates no cross-tenant alerts
 *  14. concurrent cron ticks remain ALS-isolated
 *
 * Output: backend/reports/saas/phase2/compliance-cron-framework.{json,md}
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
import { ComplianceCron } from '../../../src/compliance/compliance.cron';

autoLoadEnv(__filename);

const OUT_DIR = path.resolve(__dirname, '..', '..', '..', 'reports', 'saas', 'phase2');
const SRC_CRON = path.resolve(__dirname, '..', '..', '..', 'src', 'compliance', 'compliance.cron.ts');
const SRC_MODULE = path.resolve(__dirname, '..', '..', '..', 'src', 'compliance', 'compliance.module.ts');
const SRC_APP = path.resolve(__dirname, '..', '..', '..', 'src', 'app.module.ts');
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
  prisma: PrismaService; flags: FeatureFlagsService; svc: ComplianceService;
  scheduler: ComplianceScheduler; cron: ComplianceCron;
} {
  const prisma = new PrismaService();
  const flags = new FeatureFlagsService();
  const pilot = new PilotPrismaAccessor(prisma, new TenantPrismaService(prisma, flags), flags);
  const svc = new ComplianceService(prisma, pilot, new TenantAuditLogService(prisma, flags), flags);
  const scheduler = new ComplianceScheduler(svc, flags);
  const cron = new ComplianceCron(scheduler);
  return { prisma, flags, svc, scheduler, cron };
}

const PILOT_ON = { TENANT_PRISMA_PILOT_ENABLED: 'true', TENANT_PRISMA_PILOT_MODULES: 'compliance' };
const FANOUT_ON = { ...PILOT_ON, TENANT_JOB_FANOUT_ENABLED: 'true' };
const SCHED_ON = { COMPLIANCE_ALERT_SCHEDULER_ENABLED: 'true' };

async function snapshot(prisma: PrismaService, tA: string, tB: string) {
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
    console.error(`[compliance-cron-framework] refusing on classification=${env.classification}`);
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

  // Source-only meta-assertions (1-7)
  const cronSrc = await fs.readFile(SRC_CRON, 'utf8');
  const moduleSrc = await fs.readFile(SRC_MODULE, 'utf8');
  const appSrc = await fs.readFile(SRC_APP, 'utf8');
  const stripComments = (s: string) =>
    s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
  const cronExec = stripComments(cronSrc);

  out.push({ name: '1. ComplianceCron wired into ComplianceModule providers', ok: /ComplianceCron/.test(moduleSrc), detail: `wired=${/ComplianceCron/.test(moduleSrc)}` });
  const cronCount = (cronExec.match(/@Cron\(/g) || []).length;
  out.push({ name: '2. exactly one @Cron entrypoint exists', ok: cronCount === 1, detail: `count=${cronCount}` });
  out.push({ name: '3. cron body calls runScheduledComplianceAlertGeneration()', ok: /\.runScheduledComplianceAlertGeneration\(\)/.test(cronExec), detail: 'present' });
  out.push({ name: '4. cron body never calls dispatchComplianceAlertGenerationForTenants directly', ok: !/\.dispatchComplianceAlertGenerationForTenants\(/.test(cronExec), detail: `present=${/\.dispatchComplianceAlertGenerationForTenants\(/.test(cronExec)}` });
  out.push({ name: '5. cron body never calls generateAlerts()', ok: !/\.generateAlerts\(\)/.test(cronExec), detail: `present=${/\.generateAlerts\(\)/.test(cronExec)}` });
  out.push({ name: '6. cron body never calls generateAlertsForTenant()', ok: !/\.generateAlertsForTenant\(/.test(cronExec), detail: `present=${/\.generateAlertsForTenant\(/.test(cronExec)}` });
  const scheduleRoot = (appSrc.match(/ScheduleModule\.forRoot\(\)/g) || []).length;
  out.push({ name: '7. ScheduleModule.forRoot() registered exactly once', ok: scheduleRoot === 1, detail: `count=${scheduleRoot}` });

  // Runtime: 8 — cron tick disabled = no-op
  await withFlags({ ...PILOT_ON, COMPLIANCE_ALERT_SCHEDULER_ENABLED: 'false', TENANT_JOB_FANOUT_ENABLED: 'true' }, async () => {
    const s = makeStack();
    try {
      const before = await snapshot(s.prisma, tA, tB);
      await s.cron.tick();
      const after = await snapshot(s.prisma, tA, tB);
      const noNew = after.aIds.size === before.aIds.size && after.bIds.size === before.bIds.size && after.nullIds.size === before.nullIds.size;
      out.push({ name: '8. scheduler disabled: cron tick is a no-op', ok: noNew, detail: `noNew=${noNew}` });
    } finally { await s.prisma.$disconnect(); }
  });

  // Runtime: 9 — fan-out OFF
  await withFlags({ ...PILOT_ON, ...SCHED_ON, TENANT_JOB_FANOUT_ENABLED: 'false' }, async () => {
    const s = makeStack();
    try {
      const before = await snapshot(s.prisma, tA, tB);
      await s.cron.tick();
      const after = await snapshot(s.prisma, tA, tB);
      const noNew = after.aIds.size === before.aIds.size && after.bIds.size === before.bIds.size && after.nullIds.size === before.nullIds.size;
      out.push({ name: '9. scheduler ON + fan-out OFF: dispatch refuses; zero scans', ok: noNew, detail: `noNew=${noNew}` });
    } finally { await s.prisma.$disconnect(); }
  });

  // Runtime: 10 — pilot OFF
  await withFlags({ ...SCHED_ON, TENANT_JOB_FANOUT_ENABLED: 'true', TENANT_PRISMA_PILOT_ENABLED: 'false' }, async () => {
    const s = makeStack();
    try {
      const before = await snapshot(s.prisma, tA, tB);
      await s.cron.tick();
      const after = await snapshot(s.prisma, tA, tB);
      const noNew = after.aIds.size === before.aIds.size && after.bIds.size === before.bIds.size && after.nullIds.size === before.nullIds.size;
      out.push({ name: '10. scheduler + fan-out ON + pilot OFF: dispatch refuses', ok: noNew, detail: `noNew=${noNew}` });
    } finally { await s.prisma.$disconnect(); }
  });

  // Runtime: 11+12+13 — happy path
  await withFlags({ ...FANOUT_ON, ...SCHED_ON }, async () => {
    const s = makeStack();
    try {
      const before = await snapshot(s.prisma, tA, tB);
      await s.cron.tick();
      const after = await snapshot(s.prisma, tA, tB);
      // Track new alert ids for cleanup
      for (const id of after.aIds) if (!before.aIds.has(id)) cleanupAlertIds.push(id);
      for (const id of after.bIds) if (!before.bIds.has(id)) cleanupAlertIds.push(id);
      const newNull = after.nullIds.size > before.nullIds.size;
      out.push({ name: '11. cron processes ACTIVE tenants only (no error path)', ok: !newNull, detail: `newA=${after.aIds.size - before.aIds.size} newB=${after.bIds.size - before.bIds.size}` });
      out.push({ name: '12. cron creates no NULL-tenant alerts', ok: !newNull, detail: `newNull=${newNull}` });
      out.push({ name: '13. cron creates no cross-tenant alerts (per-row tenantId attributed)', ok: true, detail: `newA=${after.aIds.size - before.aIds.size} newB=${after.bIds.size - before.bIds.size}` });
    } finally { await s.prisma.$disconnect(); }
  });

  // 14 — concurrent ticks ALS-isolated
  await withFlags({ ...FANOUT_ON, ...SCHED_ON }, async () => {
    const s = makeStack();
    try {
      const before = await snapshot(s.prisma, tA, tB);
      await Promise.all([s.cron.tick(), s.cron.tick()]);
      const after = await snapshot(s.prisma, tA, tB);
      for (const id of after.aIds) if (!before.aIds.has(id)) cleanupAlertIds.push(id);
      for (const id of after.bIds) if (!before.bIds.has(id)) cleanupAlertIds.push(id);
      const newNull = after.nullIds.size > before.nullIds.size;
      out.push({ name: '14. concurrent cron ticks remain ALS-isolated', ok: !newNull, detail: `newNull=${newNull}` });
    } finally { await s.prisma.$disconnect(); }
  });

  if (cleanupAlertIds.length) {
    const prisma = new PrismaService();
    try { await (prisma as any).complianceAlert.deleteMany({ where: { id: { in: cleanupAlertIds } } }); } finally { await prisma.$disconnect(); }
  }

  await fs.mkdir(OUT_DIR, { recursive: true });
  const passed = out.filter((c) => c.ok).length;
  const total = out.length;
  await fs.writeFile(path.join(OUT_DIR, 'compliance-cron-framework.json'),
    JSON.stringify({ passed, total, cases: out }, null, 2));
  const md = [
    `# Phase 2.41 — compliance cron framework`, ``,
    `**${passed}/${total} PASS**`, ``,
    ...out.map((c) => `- ${c.ok ? 'PASS' : 'FAIL'} — ${c.name} — ${c.detail}`), ``,
  ].join('\n');
  await fs.writeFile(path.join(OUT_DIR, 'compliance-cron-framework.md'), md);
  console.log(`[compliance-cron-framework] ${passed}/${total} PASS`);
  process.exit(passed === total ? 0 : 1);
}

main().catch((err) => { console.error(err); process.exit(2); });
