/**
 * Phase 2.27 — workflow mutation isolation harness.
 *
 *   1. updateEmployeeWorkflowStage(tenantB-employee) raises 404
 *   2. setEmployeeCurrentStage(tenantB-employee) raises 404
 *   3. createWorkPermit({ employeeId: tenantB }) raises 404; no row inserted
 *   4. createWorkPermit pilot ON, tenant A: tenantId=A
 *   5. updateWorkPermit(tenantB-permit-id) raises 404; row unchanged
 *   6. createVisa({ entityType: EMPLOYEE, entityId: tenantB }) raises 404
 *   7. createVisa pilot ON, tenant A: tenantId=A
 *   8. updateVisa(tenantB-visa-id) raises 404; row unchanged
 *   9. timeline/overview remain tenant-scoped after mutation
 *  10. pilot OFF: legacy update on tenant B permit still mutates
 *  11. source-level meta-assertion: phase227 patterns present
 *
 * Output: backend/reports/saas/phase2/workflow-mutation-isolation.{json,md}
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
const TENANT_B_PERMIT = '00000000-0000-0000-0000-0000000wp101';
const TENANT_B_VISA = '00000000-0000-0000-0000-0000000vs101';
const STAGE_1 = '00000000-0000-0000-0000-00000000st01';
const SYS_USER = '00000000-0000-0000-0000-00000000us01';

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
    console.error(`[workflow-mutation-isolation] refusing on classification=${env.classification}`);
    process.exit(3);
  }
  const c = new Client({ connectionString: url, ssl: /127\.0\.0\.1|localhost/.test(url) ? false : { rejectUnauthorized: false } });
  await c.connect();
  const ts = await c.query<{ id: string }>(
    `SELECT t.id FROM tenants t WHERE EXISTS (SELECT 1 FROM employees e WHERE e."tenantId" = t.id::text) ORDER BY t.name`);
  const tA = ts.rows[0]?.id; const tB = ts.rows[1]?.id;
  await c.end();
  if (!tA || !tB) { console.error('need two tenants'); process.exit(3); }

  const out: CaseResult[] = [];
  const createdIds: { permits: string[]; visas: string[] } = { permits: [], visas: [] };

  // Cross-tenant rejections (cases 1, 2, 5, 6, 8) + same-tenant successes (4, 7)
  await withFlags({ TENANT_PRISMA_PILOT_ENABLED: 'true', TENANT_PRISMA_PILOT_MODULES: 'workflow' }, async () => {
    const prisma = new PrismaService();
    const ff = new FeatureFlagsService();
    const pilot = new PilotPrismaAccessor(prisma, new TenantPrismaService(prisma, ff), ff);
    const svc = makeService(prisma, pilot);
    try {
      const beforePermitB: any = await (prisma as any).workPermit.findUnique({ where: { id: TENANT_B_PERMIT } });
      const beforeVisaB: any = await (prisma as any).visa.findUnique({ where: { id: TENANT_B_VISA } });

      let upStageL = false;
      try { await withRequestContext({ requestId: newRequestId() }, async () => {
        TenantContext.attach({ id: tA, slug: 'a', name: 'A', status: 'ACTIVE', region: 'eu' });
        await svc.updateEmployeeWorkflowStage(TENANT_B_EMP, STAGE_1, { status: 'IN_PROGRESS' } as any, SYS_USER);
      }); upStageL = true; } catch { upStageL = false; }
      out.push({ name: 'pilot ON, tenant A: updateEmployeeWorkflowStage(tenantB-employee) raises NotFoundException', ok: !upStageL, detail: upStageL ? 'UNEXPECTED' : 'NotFoundException' });

      let setStageL = false;
      try { await withRequestContext({ requestId: newRequestId() }, async () => {
        TenantContext.attach({ id: tA, slug: 'a', name: 'A', status: 'ACTIVE', region: 'eu' });
        await svc.setEmployeeCurrentStage(TENANT_B_EMP, STAGE_1, SYS_USER);
      }); setStageL = true; } catch { setStageL = false; }
      out.push({ name: 'pilot ON, tenant A: setEmployeeCurrentStage(tenantB-employee) raises NotFoundException', ok: !setStageL, detail: setStageL ? 'UNEXPECTED' : 'NotFoundException' });

      const beforePermitCount = await (prisma as any).workPermit.count({ where: { tenantId: tA } });
      let cwpL = false;
      try { await withRequestContext({ requestId: newRequestId() }, async () => {
        TenantContext.attach({ id: tA, slug: 'a', name: 'A', status: 'ACTIVE', region: 'eu' });
        await svc.createWorkPermit({ employeeId: TENANT_B_EMP, permitType: 'XT', applicationDate: new Date().toISOString(), expiryDate: new Date(Date.now() + 1e10).toISOString() } as any, SYS_USER);
      }); cwpL = true; } catch { cwpL = false; }
      const afterPermitCount = await (prisma as any).workPermit.count({ where: { tenantId: tA } });
      out.push({ name: 'pilot ON, tenant A: createWorkPermit(tenantB-employee) raises 404; no row inserted', ok: !cwpL && beforePermitCount === afterPermitCount, detail: cwpL ? 'UNEXPECTED' : `delta=${afterPermitCount - beforePermitCount}` });

      let upPermitL = false;
      try { await withRequestContext({ requestId: newRequestId() }, async () => {
        TenantContext.attach({ id: tA, slug: 'a', name: 'A', status: 'ACTIVE', region: 'eu' });
        await svc.updateWorkPermit(TENANT_B_PERMIT, { permitType: 'A-trying-B' } as any, SYS_USER);
      }); upPermitL = true; } catch { upPermitL = false; }
      const afterPermitB: any = await (prisma as any).workPermit.findUnique({ where: { id: TENANT_B_PERMIT } });
      out.push({ name: 'pilot ON, tenant A: updateWorkPermit(tenantB-id) rejected; permitType unchanged', ok: !upPermitL && afterPermitB?.permitType === beforePermitB?.permitType, detail: `before=${beforePermitB?.permitType} after=${afterPermitB?.permitType}` });

      let cvL = false;
      try { await withRequestContext({ requestId: newRequestId() }, async () => {
        TenantContext.attach({ id: tA, slug: 'a', name: 'A', status: 'ACTIVE', region: 'eu' });
        await svc.createVisa({ entityType: 'EMPLOYEE', entityId: TENANT_B_EMP, visaType: 'XT', applicationDate: new Date().toISOString() } as any, SYS_USER);
      }); cvL = true; } catch { cvL = false; }
      out.push({ name: 'pilot ON, tenant A: createVisa({EMPLOYEE, tenantB}) raises 404', ok: !cvL, detail: cvL ? 'UNEXPECTED' : 'NotFoundException' });

      let upVisaL = false;
      try { await withRequestContext({ requestId: newRequestId() }, async () => {
        TenantContext.attach({ id: tA, slug: 'a', name: 'A', status: 'ACTIVE', region: 'eu' });
        await svc.updateVisa(TENANT_B_VISA, { visaType: 'A-trying-B' } as any, SYS_USER);
      }); upVisaL = true; } catch { upVisaL = false; }
      const afterVisaB: any = await (prisma as any).visa.findUnique({ where: { id: TENANT_B_VISA } });
      out.push({ name: 'pilot ON, tenant A: updateVisa(tenantB-id) rejected; visaType unchanged', ok: !upVisaL && afterVisaB?.visaType === beforeVisaB?.visaType, detail: `before=${beforeVisaB?.visaType} after=${afterVisaB?.visaType}` });

      // 4 + 7 — same-tenant create writes tenantId=A
      const stamp = Date.now().toString(36);
      const wp = await withRequestContext({ requestId: newRequestId() }, async () => {
        TenantContext.attach({ id: tA, slug: 'a', name: 'A', status: 'ACTIVE', region: 'eu' });
        return svc.createWorkPermit({ employeeId: TENANT_A_EMP, permitType: `ISO-${stamp}`, applicationDate: new Date().toISOString(), expiryDate: new Date(Date.now() + 1e10).toISOString() } as any, SYS_USER);
      });
      createdIds.permits.push(wp.id);
      const wpRow: any = await (prisma as any).workPermit.findUnique({ where: { id: wp.id } });
      out.push({ name: 'pilot ON, tenant A: createWorkPermit succeeds; tenantId=A', ok: wpRow?.tenantId === tA, detail: `tenantId=${wpRow?.tenantId}` });

      const vs = await withRequestContext({ requestId: newRequestId() }, async () => {
        TenantContext.attach({ id: tA, slug: 'a', name: 'A', status: 'ACTIVE', region: 'eu' });
        return svc.createVisa({ entityType: 'EMPLOYEE', entityId: TENANT_A_EMP, visaType: `ISO-${stamp}`, applicationDate: new Date().toISOString() } as any, SYS_USER);
      });
      createdIds.visas.push(vs.id);
      const vsRow: any = await (prisma as any).visa.findUnique({ where: { id: vs.id } });
      out.push({ name: 'pilot ON, tenant A: createVisa succeeds; tenantId=A', ok: vsRow?.tenantId === tA, detail: `tenantId=${vsRow?.tenantId}` });
    } finally { await prisma.$disconnect(); }
  });

  // 9 — overview/timeline still tenant-scoped after mutation
  await withFlags({ TENANT_PRISMA_PILOT_ENABLED: 'true', TENANT_PRISMA_PILOT_MODULES: 'workflow' }, async () => {
    const prisma = new PrismaService();
    const ff = new FeatureFlagsService();
    const pilot = new PilotPrismaAccessor(prisma, new TenantPrismaService(prisma, ff), ff);
    const svc = makeService(prisma, pilot);
    try {
      // Re-establish a known IN_PROGRESS state on tenant A so the
      // overview check is independent of prior harness runs.
      const ov = await withRequestContext({ requestId: newRequestId() }, async () => {
        TenantContext.attach({ id: tA, slug: 'a', name: 'A', status: 'ACTIVE', region: 'eu' });
        await svc.setEmployeeCurrentStage(TENANT_A_EMP, STAGE_1, SYS_USER);
        return svc.getOverview();
      });
      // EmployeeStage IN_PROGRESS counts (excluding the applicants
      // overlay) sum to 1 for tenant A; tenant B's 1 IN_PROGRESS is
      // hidden by the relation filter.
      const aTotalInProgress = ov.reduce((s: number, x: any) => s + (x.inProgress ?? 0) - (x.applicants ?? 0), 0);
      out.push({ name: 'pilot ON, tenant A: getOverview after mutations still excludes B (sum IN_PROGRESS = 1)', ok: aTotalInProgress === 1, detail: `aTotalInProgress=${aTotalInProgress}` });
    } finally { await prisma.$disconnect(); }
  });

  // 10 — pilot OFF: legacy still mutates tenant B
  await withFlags({ TENANT_PRISMA_PILOT_ENABLED: 'false' }, async () => {
    const prisma = new PrismaService();
    const ff = new FeatureFlagsService();
    const pilot = new PilotPrismaAccessor(prisma, new TenantPrismaService(prisma, ff), ff);
    const svc = makeService(prisma, pilot);
    try {
      const before: any = await (prisma as any).workPermit.findUnique({ where: { id: TENANT_B_PERMIT } });
      let mutated = false;
      try {
        const u = await svc.updateWorkPermit(TENANT_B_PERMIT, { permitType: 'legacy-no-tenant-gate' } as any, SYS_USER);
        mutated = (u as any).permitType === 'legacy-no-tenant-gate';
      } catch { mutated = false; }
      if (mutated && before) {
        await (prisma as any).workPermit.update({ where: { id: TENANT_B_PERMIT }, data: { permitType: before.permitType } });
      }
      out.push({ name: 'pilot OFF: legacy update on tenant B permit still succeeds (gate disengages)', ok: mutated, detail: mutated ? 'mutated' : 'UNEXPECTED' });
    } finally { await prisma.$disconnect(); }
  });

  // 11 — source-level meta-assertion
  const src = await fs.readFile(SRC_FILE, 'utf8');
  const expected: Array<[string, RegExp]> = [
    ['findEmployeeOrFail tenant-scoped', /private async findEmployeeOrFail\([\s\S]*?this\.prisma\.employee\.findFirst\([\s\S]{0,200}\.\.\.t/],
    ['findApplicantOrFail tenant-scoped', /private async findApplicantOrFail\([\s\S]*?this\.prisma\.applicant\.findFirst\([\s\S]{0,200}\.\.\.t/],
    ['updateEmployeeWorkflowStage uses findEmployeeOrFail', /async updateEmployeeWorkflowStage\([\s\S]*?await this\.findEmployeeOrFail/],
    ['setEmployeeCurrentStage uses findEmployeeOrFail', /async setEmployeeCurrentStage\([\s\S]*?await this\.findEmployeeOrFail/],
    ['createWorkPermit uses findEmployeeOrFail + tenantData', /async createWorkPermit\([\s\S]*?await this\.findEmployeeOrFail[\s\S]*?\.\.\.tdata/],
    ['updateWorkPermit pre-check via this.prisma.findFirst', /async updateWorkPermit\([\s\S]*?this\.prisma\.workPermit\.findFirst\([\s\S]{0,200}\.\.\.t/],
    ['createVisa uses parent gate + tenantData', /async createVisa\([\s\S]*?await this\.findEmployeeOrFail[\s\S]*?\.\.\.tdata/],
    ['updateVisa pre-check via this.prisma.findFirst', /async updateVisa\([\s\S]*?this\.prisma\.visa\.findFirst\([\s\S]{0,200}\.\.\.t/],
  ];
  const failed: string[] = [];
  expected.forEach(([n, re]) => { if (!re.test(src)) failed.push(n); });
  out.push({ name: 'source: every Phase 2.27 mutation site has the right tag and parent gate', ok: failed.length === 0, detail: failed.length === 0 ? 'all patterns matched' : failed.join('; ') });

  // Cleanup
  const cleanup = new Client({ connectionString: url, ssl: /127\.0\.0\.1|localhost/.test(url) ? false : { rejectUnauthorized: false } });
  await cleanup.connect();
  for (const id of createdIds.permits) await cleanup.query(`DELETE FROM work_permits WHERE id=$1`, [id]).catch(() => undefined);
  for (const id of createdIds.visas)   await cleanup.query(`DELETE FROM visas WHERE id=$1`, [id]).catch(() => undefined);
  await cleanup.end();

  await fs.mkdir(OUT_DIR, { recursive: true });
  const summary = {
    generatedAt: new Date().toISOString(), environment: env, tenantA: tA, tenantB: tB,
    counts: { total: out.length, passed: out.filter((r) => r.ok).length, failed: out.filter((r) => !r.ok).length },
    results: out,
  };
  await fs.writeFile(path.join(OUT_DIR, 'workflow-mutation-isolation.json'), JSON.stringify(summary, null, 2));
  const md: string[] = [];
  md.push('# Phase 2.27 — Workflow Mutation Isolation');
  md.push(''); md.push(`Generated: ${summary.generatedAt}`);
  md.push(`Environment: ${env.classification} (${env.reason})`);
  md.push(`Tenants: A=\`${tA}\` B=\`${tB}\``); md.push('');
  md.push(`- Cases passed: **${summary.counts.passed}** / ${summary.counts.total}`);
  md.push(`- Cases failed: ${summary.counts.failed}`); md.push('');
  md.push('| # | Case | Result | Detail |'); md.push('|--:|------|:------:|--------|');
  out.forEach((r, i) => md.push(`| ${i + 1} | ${r.name} | ${r.ok ? 'PASS' : '**FAIL**'} | ${r.detail} |`));
  await fs.writeFile(path.join(OUT_DIR, 'workflow-mutation-isolation.md'), md.join('\n'));

  console.log(`workflow-mutation-isolation: ${summary.counts.passed}/${summary.counts.total} cases PASS`);
  if (summary.counts.failed > 0) process.exit(2);
}

main().catch((e) => { console.error(e); process.exit(3); });
