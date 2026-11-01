/**
 * Phase 2.26 — workflow pilot isolation harness.
 *
 *   1. getStages: BOTH tenants see the same global catalog rows
 *   2. getOverview: tenant A counts exclude tenant B EmployeeStages
 *   3. getOverview: tenant B counts exclude tenant A EmployeeStages
 *   4. getAnalytics: tenant A totalEmployees excludes tenant B
 *   5. getTimeline(tenantB-employee-id) raises NotFoundException
 *   6. getStageDetails: tenant A doesn't see tenant B employees in the stage
 *   7. findWorkPermits: tenant A sees only A
 *   8. findVisas: tenant A sees only A
 *   9. concurrent ALS frames isolated
 *  10. pilot OFF: legacy returns the union
 *  11. source-level meta-assertion: every mutation method sources legacyPrisma
 *
 * Output: backend/reports/saas/phase2/workflow-isolation.{json,md}
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
const SRC_FILE = path.resolve(__dirname, '..', '..', '..', 'src', 'workflow', 'workflow.service.ts');
interface CaseResult { name: string; ok: boolean; detail: string; }

const TENANT_A_EMP = 'eeeeeeea-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const TENANT_B_EMP = 'eeeeeeeb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
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

async function main(): Promise<void> {
  const url = getDatabaseUrl();
  const env = classifyRuntimeEnv();
  if (!isStagingClassification(env.classification)) {
    console.error(`[workflow-isolation] refusing on classification=${env.classification}`);
    process.exit(3);
  }
  const c = new Client({ connectionString: url, ssl: /127\.0\.0\.1|localhost/.test(url) ? false : { rejectUnauthorized: false } });
  await c.connect();
  const ts = await c.query<{ id: string }>(
    `SELECT t.id FROM tenants t WHERE EXISTS (SELECT 1 FROM employees e WHERE e."tenantId" = t.id::text) ORDER BY t.name`);
  const tA = ts.rows[0]?.id; const tB = ts.rows[1]?.id;
  await c.end();
  if (!tA || !tB) { console.error('need two tenants with employees'); process.exit(3); }

  const out: CaseResult[] = [];

  // 1 — global catalog identical
  await withFlags({ TENANT_PRISMA_PILOT_ENABLED: 'true', TENANT_PRISMA_PILOT_MODULES: 'workflow' }, async () => {
    const prisma = new PrismaService();
    const ff = new FeatureFlagsService();
    const pilot = new PilotPrismaAccessor(prisma, new TenantPrismaService(prisma, ff), ff);
    const svc = makeService(prisma, pilot);
    try {
      const aStages = await withRequestContext({ requestId: newRequestId() }, async () => {
        TenantContext.attach({ id: tA, slug: 'a', name: 'A', status: 'ACTIVE', region: 'eu' });
        return svc.getStages();
      });
      const bStages = await withRequestContext({ requestId: newRequestId() }, async () => {
        TenantContext.attach({ id: tB, slug: 'b', name: 'B', status: 'ACTIVE', region: 'eu' });
        return svc.getStages();
      });
      const aIds = aStages.map((s: any) => s.id).sort();
      const bIds = bStages.map((s: any) => s.id).sort();
      out.push({
        name: 'getStages: BOTH tenants see the same global catalog (StageTemplate is global)',
        ok: aStages.length > 0 && JSON.stringify(aIds) === JSON.stringify(bIds),
        detail: `aCount=${aStages.length} bCount=${bStages.length}`,
      });
    } finally { await prisma.$disconnect(); }
  });

  // 2+3 — getOverview per-stage counts tenant-scoped via relation filter
  await withFlags({ TENANT_PRISMA_PILOT_ENABLED: 'true', TENANT_PRISMA_PILOT_MODULES: 'workflow' }, async () => {
    const prisma = new PrismaService();
    const ff = new FeatureFlagsService();
    const pilot = new PilotPrismaAccessor(prisma, new TenantPrismaService(prisma, ff), ff);
    const svc = makeService(prisma, pilot);
    try {
      const aOverview = await withRequestContext({ requestId: newRequestId() }, async () => {
        TenantContext.attach({ id: tA, slug: 'a', name: 'A', status: 'ACTIVE', region: 'eu' });
        return svc.getOverview();
      });
      const bOverview = await withRequestContext({ requestId: newRequestId() }, async () => {
        TenantContext.attach({ id: tB, slug: 'b', name: 'B', status: 'ACTIVE', region: 'eu' });
        return svc.getOverview();
      });
      const aStage1 = aOverview.find((s: any) => s.id === STAGE_ID);
      const bStage1 = bOverview.find((s: any) => s.id === STAGE_ID);
      // Tenant A seeded 1 IN_PROGRESS, tenant B seeded 1 IN_PROGRESS.
      // Each tenant should see exactly 1 in their own overview.
      out.push({
        name: 'getOverview tenant A: stage 1 inProgress count = 1 (excludes B)',
        ok: aStage1?.inProgress === 1,
        detail: `inProgress=${aStage1?.inProgress}`,
      });
      out.push({
        name: 'getOverview tenant B: stage 1 inProgress count = 1 (excludes A)',
        ok: bStage1?.inProgress === 1,
        detail: `inProgress=${bStage1?.inProgress}`,
      });
    } finally { await prisma.$disconnect(); }
  });

  // 4 — getAnalytics totalEmployees excludes other tenant
  await withFlags({ TENANT_PRISMA_PILOT_ENABLED: 'true', TENANT_PRISMA_PILOT_MODULES: 'workflow' }, async () => {
    const prisma = new PrismaService();
    const ff = new FeatureFlagsService();
    const pilot = new PilotPrismaAccessor(prisma, new TenantPrismaService(prisma, ff), ff);
    const svc = makeService(prisma, pilot);
    try {
      const aAnalytics = await withRequestContext({ requestId: newRequestId() }, async () => {
        TenantContext.attach({ id: tA, slug: 'a', name: 'A', status: 'ACTIVE', region: 'eu' });
        return svc.getAnalytics();
      });
      // Tenant A has 1 employee.
      out.push({
        name: 'getAnalytics tenant A: totalEmployees = 1 (excludes B)',
        ok: aAnalytics.totalEmployees === 1,
        detail: `totalEmployees=${aAnalytics.totalEmployees}`,
      });
    } finally { await prisma.$disconnect(); }
  });

  // 5 — getTimeline cross-tenant rejected
  await withFlags({ TENANT_PRISMA_PILOT_ENABLED: 'true', TENANT_PRISMA_PILOT_MODULES: 'workflow' }, async () => {
    const prisma = new PrismaService();
    const ff = new FeatureFlagsService();
    const pilot = new PilotPrismaAccessor(prisma, new TenantPrismaService(prisma, ff), ff);
    const svc = makeService(prisma, pilot);
    try {
      let leaked = false;
      try {
        await withRequestContext({ requestId: newRequestId() }, async () => {
          TenantContext.attach({ id: tA, slug: 'a', name: 'A', status: 'ACTIVE', region: 'eu' });
          await svc.getTimeline(TENANT_B_EMP);
        });
        leaked = true;
      } catch { leaked = false; }
      out.push({
        name: 'pilot ON, tenant A: getTimeline(tenantB-employee-id) raises NotFoundException',
        ok: !leaked,
        detail: leaked ? 'UNEXPECTED: returned' : 'NotFoundException',
      });
    } finally { await prisma.$disconnect(); }
  });

  // 6 — getStageDetails tenant A doesn't see tenant B employees
  await withFlags({ TENANT_PRISMA_PILOT_ENABLED: 'true', TENANT_PRISMA_PILOT_MODULES: 'workflow' }, async () => {
    const prisma = new PrismaService();
    const ff = new FeatureFlagsService();
    const pilot = new PilotPrismaAccessor(prisma, new TenantPrismaService(prisma, ff), ff);
    const svc = makeService(prisma, pilot);
    try {
      const det = await withRequestContext({ requestId: newRequestId() }, async () => {
        TenantContext.attach({ id: tA, slug: 'a', name: 'A', status: 'ACTIVE', region: 'eu' });
        return svc.getStageDetails(STAGE_ID);
      });
      const empIds = (det as any).employees.map((e: any) => e.id);
      out.push({
        name: 'pilot ON, tenant A: getStageDetails employees exclude tenant B',
        ok: !empIds.includes(TENANT_B_EMP),
        detail: `count=${empIds.length} hasB=${empIds.includes(TENANT_B_EMP)}`,
      });
    } finally { await prisma.$disconnect(); }
  });

  // 7 — findWorkPermits tenant A sees only A
  await withFlags({ TENANT_PRISMA_PILOT_ENABLED: 'true', TENANT_PRISMA_PILOT_MODULES: 'workflow' }, async () => {
    const prisma = new PrismaService();
    const ff = new FeatureFlagsService();
    const pilot = new PilotPrismaAccessor(prisma, new TenantPrismaService(prisma, ff), ff);
    const svc = makeService(prisma, pilot);
    try {
      const r = await withRequestContext({ requestId: newRequestId() }, async () => {
        TenantContext.attach({ id: tA, slug: 'a', name: 'A', status: 'ACTIVE', region: 'eu' });
        return svc.findWorkPermits({ page: 1, limit: 50 } as any);
      });
      const ids = (r as any).data.map((p: any) => p.id);
      out.push({
        name: 'pilot ON, tenant A: findWorkPermits returns ONLY tenant A',
        ok: ids.length === 1 && ids[0] === '00000000-0000-0000-0000-0000000wp001',
        detail: `count=${ids.length} ids=${ids.join(',')}`,
      });
    } finally { await prisma.$disconnect(); }
  });

  // 8 — findVisas tenant A sees only A
  await withFlags({ TENANT_PRISMA_PILOT_ENABLED: 'true', TENANT_PRISMA_PILOT_MODULES: 'workflow' }, async () => {
    const prisma = new PrismaService();
    const ff = new FeatureFlagsService();
    const pilot = new PilotPrismaAccessor(prisma, new TenantPrismaService(prisma, ff), ff);
    const svc = makeService(prisma, pilot);
    try {
      const r = await withRequestContext({ requestId: newRequestId() }, async () => {
        TenantContext.attach({ id: tA, slug: 'a', name: 'A', status: 'ACTIVE', region: 'eu' });
        return svc.findVisas({ page: 1, limit: 50 } as any);
      });
      const ids = (r as any).data.map((v: any) => v.id);
      out.push({
        name: 'pilot ON, tenant A: findVisas returns ONLY tenant A',
        ok: ids.length === 1 && ids[0] === '00000000-0000-0000-0000-0000000vs001',
        detail: `count=${ids.length} ids=${ids.join(',')}`,
      });
    } finally { await prisma.$disconnect(); }
  });

  // 9 — concurrent ALS frames isolated
  await withFlags({ TENANT_PRISMA_PILOT_ENABLED: 'true', TENANT_PRISMA_PILOT_MODULES: 'workflow' }, async () => {
    const prisma = new PrismaService();
    const ff = new FeatureFlagsService();
    const pilot = new PilotPrismaAccessor(prisma, new TenantPrismaService(prisma, ff), ff);
    const svc = makeService(prisma, pilot);
    try {
      const seen: Array<{ t: string; total: number }> = [];
      await Promise.all([
        withRequestContext({ requestId: newRequestId() }, async () => {
          TenantContext.attach({ id: tA, slug: 'a', name: 'A', status: 'ACTIVE', region: 'eu' });
          await new Promise((r) => setTimeout(r, 5));
          const a = await svc.getAnalytics();
          seen.push({ t: tA, total: a.totalEmployees });
        }),
        withRequestContext({ requestId: newRequestId() }, async () => {
          TenantContext.attach({ id: tB, slug: 'b', name: 'B', status: 'ACTIVE', region: 'eu' });
          await new Promise((r) => setTimeout(r, 1));
          const a = await svc.getAnalytics();
          seen.push({ t: tB, total: a.totalEmployees });
        }),
      ]);
      const a = seen.find((x) => x.t === tA);
      const b = seen.find((x) => x.t === tB);
      out.push({
        name: 'concurrent ALS frames isolated (each sees their own totalEmployees=1)',
        ok: a?.total === 1 && b?.total === 1,
        detail: `aTotal=${a?.total} bTotal=${b?.total}`,
      });
    } finally { await prisma.$disconnect(); }
  });

  // 10 — pilot OFF: legacy returns the union
  await withFlags({ TENANT_PRISMA_PILOT_ENABLED: 'false' }, async () => {
    const prisma = new PrismaService();
    const ff = new FeatureFlagsService();
    const pilot = new PilotPrismaAccessor(prisma, new TenantPrismaService(prisma, ff), ff);
    const svc = makeService(prisma, pilot);
    try {
      const a = await svc.getAnalytics();
      const wp = await svc.findWorkPermits({ page: 1, limit: 50 } as any);
      // Legacy mode: totalEmployees = 2 (A+B), workPermits = 2 (A+B).
      out.push({
        name: 'pilot OFF: legacy aggregates include both tenants (totalEmployees=2, workPermits=2)',
        ok: a.totalEmployees === 2 && (wp as any).meta?.total === 2,
        detail: `totalEmployees=${a.totalEmployees} workPermits=${(wp as any).meta?.total}`,
      });
    } finally { await prisma.$disconnect(); }
  });

  // 11 — source-level meta-assertion
  const src = await fs.readFile(SRC_FILE, 'utf8');
  const expected: Array<[string, RegExp]> = [
    ['updateEmployeeWorkflowStage uses legacyPrisma', /async updateEmployeeWorkflowStage\([\s\S]*?this\.legacyPrisma\.employeeStage\.update/],
    ['setEmployeeCurrentStage uses legacyPrisma', /async setEmployeeCurrentStage\([\s\S]*?this\.legacyPrisma\.employeeStage\.upsert/],
    ['createWorkPermit uses legacyPrisma', /async createWorkPermit\([\s\S]*?this\.legacyPrisma\.workPermit\.create/],
    ['updateWorkPermit uses legacyPrisma', /async updateWorkPermit\([\s\S]*?this\.legacyPrisma\.workPermit\.update/],
    ['createVisa uses legacyPrisma', /async createVisa\([\s\S]*?this\.legacyPrisma\.visa\.create/],
    ['updateVisa uses legacyPrisma', /async updateVisa\([\s\S]*?this\.legacyPrisma\.visa\.update/],
    ['getOverview uses employee.tenantId relation filter', /async getOverview\([\s\S]*?employee: \{ tenantId/],
    ['getAnalytics uses employee.tenantId relation filter', /async getAnalytics\([\s\S]*?employee: \{ tenantId/],
    ['getTimeline migrated to findFirst with tenant predicate', /async getTimeline\([\s\S]*?this\.prisma\.employee\.findFirst\([\s\S]{0,200}\.\.\.t/],
  ];
  const failed: string[] = [];
  expected.forEach(([n, re]) => { if (!re.test(src)) failed.push(n); });
  out.push({
    name: 'source: every Phase 2.26 mutation uses legacyPrisma; reads use relation filter / tenantWhere',
    ok: failed.length === 0,
    detail: failed.length === 0 ? 'all patterns matched' : failed.join('; '),
  });

  await fs.mkdir(OUT_DIR, { recursive: true });
  const summary = {
    generatedAt: new Date().toISOString(), environment: env, tenantA: tA, tenantB: tB,
    counts: { total: out.length, passed: out.filter((r) => r.ok).length, failed: out.filter((r) => !r.ok).length },
    results: out,
  };
  await fs.writeFile(path.join(OUT_DIR, 'workflow-isolation.json'), JSON.stringify(summary, null, 2));
  const md: string[] = [];
  md.push('# Phase 2.26 — Workflow Isolation');
  md.push(''); md.push(`Generated: ${summary.generatedAt}`);
  md.push(`Environment: ${env.classification} (${env.reason})`);
  md.push(`Tenants: A=\`${tA}\` B=\`${tB}\``); md.push('');
  md.push(`- Cases passed: **${summary.counts.passed}** / ${summary.counts.total}`);
  md.push(`- Cases failed: ${summary.counts.failed}`); md.push('');
  md.push('| # | Case | Result | Detail |'); md.push('|--:|------|:------:|--------|');
  out.forEach((r, i) => md.push(`| ${i + 1} | ${r.name} | ${r.ok ? 'PASS' : '**FAIL**'} | ${r.detail} |`));
  await fs.writeFile(path.join(OUT_DIR, 'workflow-isolation.md'), md.join('\n'));

  console.log(`workflow-isolation: ${summary.counts.passed}/${summary.counts.total} cases PASS`);
  if (summary.counts.failed > 0) process.exit(2);
}

main().catch((e) => { console.error(e); process.exit(3); });
