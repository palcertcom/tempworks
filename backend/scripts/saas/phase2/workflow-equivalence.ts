/**
 * Phase 2.26 — workflow pilot read-equivalence harness.
 *
 *   1. getStages: legacy + pilot return identical row count (global catalog)
 *   2. getOverview: pilot per-stage counts <= legacy counts
 *   3. getAnalytics.totalEmployees: pilot <= legacy
 *   4. getTimeline(tenantA-employee-id): both modes resolve same id
 *   5. error path: NotFoundException for missing employee id
 *   6. getStageDetails on a global stage: catalog identical, applicants/employees scoped
 *   7. findWorkPermits: pilot total <= legacy total
 *   8. findVisas: pilot total <= legacy total
 *   9. response shape preserved
 *
 * Output: backend/reports/saas/phase2/workflow-equivalence.{json,md}
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
import { WorkflowService } from '../../../src/workflow/workflow.service';
import { TenantContext, withRequestContext, newRequestId } from '../../../src/saas/context/als';

autoLoadEnv(__filename);

const OUT_DIR = path.resolve(__dirname, '..', '..', '..', 'reports', 'saas', 'phase2');
interface CaseResult { name: string; ok: boolean; detail: string; }
const TENANT_A_EMPLOYEE = 'eeeeeeea-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const STAGE_ID = '00000000-0000-0000-0000-00000000st01';

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

function makeService(prisma: PrismaService, pilot: PilotPrismaAccessor): WorkflowService {
  return new WorkflowService(prisma, pilot, new TenantAuditLogService(prisma, new FeatureFlagsService()));
}

interface Snap {
  pilotActive: boolean;
  reason: string;
  stagesCount: number;
  overviewFirstStageInProgress: number;
  totalEmployees: number;
  timelineEmpId: string | null;
  errOnMissing: string;
  detailApplicantsCount: number;
  detailEmployeesCount: number;
  workPermitsTotal: number;
  visasTotal: number;
  shapeOk: boolean;
}

async function snap(flags: Record<string, string | undefined>, ctx: { id: string } | null): Promise<Snap> {
  return withFlags(flags, async () => {
    const ff = new FeatureFlagsService();
    const prisma = new PrismaService();
    const tp = new TenantPrismaService(prisma, ff);
    const pilot = new PilotPrismaAccessor(prisma, tp, ff);
    const svc = makeService(prisma, pilot);
    const run = async (): Promise<Snap> => {
      const stages = await svc.getStages();
      const overview = await svc.getOverview();
      const analytics = await svc.getAnalytics();
      let timelineEmpId: string | null = null;
      try { timelineEmpId = (await svc.getTimeline(TENANT_A_EMPLOYEE)).employee.id; } catch { timelineEmpId = null; }
      let errOnMissing = 'no-error';
      try { await svc.getTimeline('00000000-0000-0000-0000-deaddeaddead'); }
      catch (e) { errOnMissing = (e as Error).constructor.name; }
      const details = await svc.getStageDetails(STAGE_ID);
      const wp = await svc.findWorkPermits({ page: 1, limit: 50 } as any);
      const vs = await svc.findVisas({ page: 1, limit: 50 } as any);

      const stage1 = overview.find((o: any) => o.id === STAGE_ID);
      const shapeOk = Array.isArray(stages) && Array.isArray(overview) && Array.isArray((wp as any).data);
      return {
        pilotActive: pilot.isPilotActive(),
        reason: pilot.pilotReason().reason,
        stagesCount: stages.length,
        overviewFirstStageInProgress: stage1?.inProgress ?? 0,
        totalEmployees: analytics.totalEmployees,
        timelineEmpId,
        errOnMissing,
        detailApplicantsCount: details.stats.applicantsCount,
        detailEmployeesCount: details.stats.employeesCount,
        workPermitsTotal: (wp as any).meta?.total ?? 0,
        visasTotal: (vs as any).meta?.total ?? 0,
        shapeOk,
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
    } finally { await prisma.$disconnect(); }
  });
}

async function main(): Promise<void> {
  const url = getDatabaseUrl();
  const env = classifyRuntimeEnv();
  if (!isStagingClassification(env.classification)) {
    console.error(`[workflow-equivalence] refusing on classification=${env.classification}`);
    process.exit(3);
  }
  const c = new Client({ connectionString: url, ssl: /127\.0\.0\.1|localhost/.test(url) ? false : { rejectUnauthorized: false } });
  await c.connect();
  const ts = await c.query<{ id: string }>(
    `SELECT t.id FROM tenants t WHERE EXISTS (SELECT 1 FROM employees e WHERE e."tenantId" = t.id::text) ORDER BY t.name`);
  const tA = ts.rows[0]?.id;
  await c.end();
  if (!tA) { console.error('need tenant A with employees'); process.exit(3); }

  const out: CaseResult[] = [];
  const legacy = await snap({ TENANT_PRISMA_PILOT_ENABLED: 'false' }, null);
  const pilot  = await snap({ TENANT_PRISMA_PILOT_ENABLED: 'true', TENANT_PRISMA_PILOT_MODULES: 'workflow' }, { id: tA });

  out.push({ name: 'legacy: pilot OFF reports pilotActive=false', ok: !legacy.pilotActive, detail: legacy.reason });
  out.push({ name: 'pilot: pilot ON + workflow allow-list ⇒ pilotActive=true', ok: pilot.pilotActive && pilot.reason.startsWith('pilot ON'), detail: pilot.reason });
  out.push({ name: 'getStages: catalog identical in both modes', ok: legacy.stagesCount === pilot.stagesCount && pilot.stagesCount > 0, detail: `legacy=${legacy.stagesCount} pilot=${pilot.stagesCount}` });
  out.push({ name: 'getOverview: pilot first-stage inProgress count <= legacy', ok: pilot.overviewFirstStageInProgress <= legacy.overviewFirstStageInProgress && pilot.overviewFirstStageInProgress > 0, detail: `legacy=${legacy.overviewFirstStageInProgress} pilot=${pilot.overviewFirstStageInProgress}` });
  out.push({ name: 'getAnalytics.totalEmployees: pilot <= legacy', ok: pilot.totalEmployees <= legacy.totalEmployees && pilot.totalEmployees > 0, detail: `legacy=${legacy.totalEmployees} pilot=${pilot.totalEmployees}` });
  out.push({ name: 'getTimeline: legacy + pilot resolve the tenant A employee id', ok: legacy.timelineEmpId === TENANT_A_EMPLOYEE && pilot.timelineEmpId === TENANT_A_EMPLOYEE, detail: `legacy=${legacy.timelineEmpId} pilot=${pilot.timelineEmpId}` });
  out.push({ name: 'error path: NotFoundException for missing employee id in both modes', ok: legacy.errOnMissing === 'NotFoundException' && pilot.errOnMissing === 'NotFoundException', detail: `legacy=${legacy.errOnMissing} pilot=${pilot.errOnMissing}` });
  out.push({ name: 'getStageDetails: pilot employee count <= legacy (tenant filter)', ok: pilot.detailEmployeesCount <= legacy.detailEmployeesCount, detail: `legacy=${legacy.detailEmployeesCount} pilot=${pilot.detailEmployeesCount}` });
  out.push({ name: 'findWorkPermits: pilot total <= legacy total', ok: pilot.workPermitsTotal <= legacy.workPermitsTotal && pilot.workPermitsTotal > 0, detail: `legacy=${legacy.workPermitsTotal} pilot=${pilot.workPermitsTotal}` });
  out.push({ name: 'findVisas: pilot total <= legacy total', ok: pilot.visasTotal <= legacy.visasTotal && pilot.visasTotal > 0, detail: `legacy=${legacy.visasTotal} pilot=${pilot.visasTotal}` });
  out.push({ name: 'response shape preserved', ok: legacy.shapeOk && pilot.shapeOk, detail: `legacy=${legacy.shapeOk} pilot=${pilot.shapeOk}` });

  await fs.mkdir(OUT_DIR, { recursive: true });
  const summary = {
    generatedAt: new Date().toISOString(), environment: env, tenantA: tA,
    legacy, pilot,
    counts: { total: out.length, passed: out.filter((r) => r.ok).length, failed: out.filter((r) => !r.ok).length },
    results: out,
  };
  await fs.writeFile(path.join(OUT_DIR, 'workflow-equivalence.json'), JSON.stringify(summary, null, 2));
  const md: string[] = [];
  md.push('# Phase 2.26 — Workflow Equivalence');
  md.push(''); md.push(`Generated: ${summary.generatedAt}`);
  md.push(`Environment: ${env.classification} (${env.reason})`);
  md.push(`Tenant A: \`${tA}\``); md.push('');
  md.push(`- Cases passed: **${summary.counts.passed}** / ${summary.counts.total}`);
  md.push(`- Cases failed: ${summary.counts.failed}`); md.push('');
  md.push('| # | Case | Result | Detail |'); md.push('|--:|------|:------:|--------|');
  out.forEach((r, i) => md.push(`| ${i + 1} | ${r.name} | ${r.ok ? 'PASS' : '**FAIL**'} | ${r.detail} |`));
  await fs.writeFile(path.join(OUT_DIR, 'workflow-equivalence.md'), md.join('\n'));

  console.log(`workflow-equivalence: ${summary.counts.passed}/${summary.counts.total} cases PASS`);
  if (summary.counts.failed > 0) process.exit(2);
}

main().catch((e) => { console.error(e); process.exit(3); });
