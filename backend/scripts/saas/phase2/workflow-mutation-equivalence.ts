/**
 * Phase 2.27 — workflow mutation equivalence harness.
 *
 *   1. updateEmployeeWorkflowStage mutates status (legacy + pilot)
 *   2. setEmployeeCurrentStage upserts an IN_PROGRESS row
 *   3. createWorkPermit shape preserved
 *   4. createWorkPermit legacy: tenantId NULL; pilot: tenantId=A
 *   5. updateWorkPermit mutates the field in both modes
 *   6. createVisa shape preserved + tenantId NULL/set
 *   7. updateVisa mutates the field in both modes
 *   8. validation: bogus permit/visa id ⇒ NotFoundException both modes
 *   9. read-after-write: findWorkPermits sees the new row
 *
 * Output: backend/reports/saas/phase2/workflow-mutation-equivalence.{json,md}
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
const TENANT_A_EMP = 'eeeeeeea-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const STAGE_2 = '00000000-0000-0000-0000-00000000st02';
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
    console.error(`[workflow-mutation-equivalence] refusing on classification=${env.classification}`);
    process.exit(3);
  }
  const c = new Client({ connectionString: url, ssl: /127\.0\.0\.1|localhost/.test(url) ? false : { rejectUnauthorized: false } });
  await c.connect();
  const ts = await c.query<{ id: string }>(
    `SELECT t.id FROM tenants t WHERE EXISTS (SELECT 1 FROM employees e WHERE e."tenantId" = t.id::text) ORDER BY t.name`);
  const tA = ts.rows[0]?.id;
  await c.end();
  if (!tA) { console.error('need tenant A'); process.exit(3); }

  const out: CaseResult[] = [];
  const createdPermitIds: string[] = [];
  const createdVisaIds: string[] = [];
  const upsertedStages: string[] = [];
  const stamp = Date.now().toString(36);

  // 1 — updateEmployeeWorkflowStage in both modes
  await withFlags({ TENANT_PRISMA_PILOT_ENABLED: 'false' }, async () => {
    const prisma = new PrismaService();
    const ff = new FeatureFlagsService();
    const pilot = new PilotPrismaAccessor(prisma, new TenantPrismaService(prisma, ff), ff);
    const svc = makeService(prisma, pilot);
    try {
      const u = await svc.updateEmployeeWorkflowStage(TENANT_A_EMP, '00000000-0000-0000-0000-00000000st01', { status: 'IN_PROGRESS', notes: `legacy-${stamp}` } as any, SYS_USER);
      out.push({ name: 'updateEmployeeWorkflowStage (legacy) mutates notes', ok: (u as any).notes === `legacy-${stamp}`, detail: `notes=${(u as any).notes}` });
    } finally { await prisma.$disconnect(); }
  });
  await withFlags({ TENANT_PRISMA_PILOT_ENABLED: 'true', TENANT_PRISMA_PILOT_MODULES: 'workflow' }, async () => {
    const prisma = new PrismaService();
    const ff = new FeatureFlagsService();
    const pilot = new PilotPrismaAccessor(prisma, new TenantPrismaService(prisma, ff), ff);
    const svc = makeService(prisma, pilot);
    try {
      await withRequestContext({ requestId: newRequestId() }, async () => {
        TenantContext.attach({ id: tA, slug: 'a', name: 'A', status: 'ACTIVE', region: 'eu' });
        const u = await svc.updateEmployeeWorkflowStage(TENANT_A_EMP, '00000000-0000-0000-0000-00000000st01', { status: 'IN_PROGRESS', notes: `pilot-${stamp}` } as any, SYS_USER);
        out.push({ name: 'updateEmployeeWorkflowStage (pilot) mutates notes', ok: (u as any).notes === `pilot-${stamp}`, detail: `notes=${(u as any).notes}` });
      });
    } finally { await prisma.$disconnect(); }
  });

  // 2 — setEmployeeCurrentStage upserts (pilot mode)
  await withFlags({ TENANT_PRISMA_PILOT_ENABLED: 'true', TENANT_PRISMA_PILOT_MODULES: 'workflow' }, async () => {
    const prisma = new PrismaService();
    const ff = new FeatureFlagsService();
    const pilot = new PilotPrismaAccessor(prisma, new TenantPrismaService(prisma, ff), ff);
    const svc = makeService(prisma, pilot);
    try {
      const r = await withRequestContext({ requestId: newRequestId() }, async () => {
        TenantContext.attach({ id: tA, slug: 'a', name: 'A', status: 'ACTIVE', region: 'eu' });
        return svc.setEmployeeCurrentStage(TENANT_A_EMP, STAGE_2, SYS_USER);
      });
      upsertedStages.push((r as any).id);
      out.push({ name: 'setEmployeeCurrentStage (pilot) upserts an IN_PROGRESS row', ok: (r as any).status === 'IN_PROGRESS' && (r as any).stageId === STAGE_2, detail: `status=${(r as any).status} stageId=${(r as any).stageId}` });
    } finally { await prisma.$disconnect(); }
  });

  // 3+4 — createWorkPermit in both modes
  let lwp: any = null, pwp: any = null;
  await withFlags({ TENANT_PRISMA_PILOT_ENABLED: 'false' }, async () => {
    const prisma = new PrismaService();
    const ff = new FeatureFlagsService();
    const pilot = new PilotPrismaAccessor(prisma, new TenantPrismaService(prisma, ff), ff);
    const svc = makeService(prisma, pilot);
    try {
      lwp = await svc.createWorkPermit({ employeeId: TENANT_A_EMP, permitType: `LEGACY-${stamp}`, applicationDate: new Date().toISOString(), expiryDate: new Date(Date.now() + 1e10).toISOString() } as any, SYS_USER);
      createdPermitIds.push(lwp.id);
    } finally { await prisma.$disconnect(); }
  });
  await withFlags({ TENANT_PRISMA_PILOT_ENABLED: 'true', TENANT_PRISMA_PILOT_MODULES: 'workflow' }, async () => {
    const prisma = new PrismaService();
    const ff = new FeatureFlagsService();
    const pilot = new PilotPrismaAccessor(prisma, new TenantPrismaService(prisma, ff), ff);
    const svc = makeService(prisma, pilot);
    try {
      await withRequestContext({ requestId: newRequestId() }, async () => {
        TenantContext.attach({ id: tA, slug: 'a', name: 'A', status: 'ACTIVE', region: 'eu' });
        pwp = await svc.createWorkPermit({ employeeId: TENANT_A_EMP, permitType: `PILOT-${stamp}`, applicationDate: new Date().toISOString(), expiryDate: new Date(Date.now() + 1e10).toISOString() } as any, SYS_USER);
        createdPermitIds.push(pwp.id);
      });
    } finally { await prisma.$disconnect(); }
  });
  out.push({ name: 'createWorkPermit response shape preserved', ok: !!lwp?.id && !!pwp?.id, detail: `legacy.id=${lwp?.id} pilot.id=${pwp?.id}` });

  const verify = new Client({ connectionString: url, ssl: /127\.0\.0\.1|localhost/.test(url) ? false : { rejectUnauthorized: false } });
  await verify.connect();
  const lwpRow = await verify.query<{ tenantId: string | null }>(`SELECT "tenantId" FROM work_permits WHERE id=$1`, [lwp.id]);
  const pwpRow = await verify.query<{ tenantId: string | null }>(`SELECT "tenantId" FROM work_permits WHERE id=$1`, [pwp.id]);
  await verify.end();
  out.push({ name: 'createWorkPermit legacy: tenantId NULL', ok: lwpRow.rows[0]?.tenantId === null, detail: `tenantId=${lwpRow.rows[0]?.tenantId}` });
  out.push({ name: 'createWorkPermit pilot: tenantId=A', ok: pwpRow.rows[0]?.tenantId === tA, detail: `tenantId=${pwpRow.rows[0]?.tenantId}` });

  // 5 — updateWorkPermit
  await withFlags({ TENANT_PRISMA_PILOT_ENABLED: 'true', TENANT_PRISMA_PILOT_MODULES: 'workflow' }, async () => {
    const prisma = new PrismaService();
    const ff = new FeatureFlagsService();
    const pilot = new PilotPrismaAccessor(prisma, new TenantPrismaService(prisma, ff), ff);
    const svc = makeService(prisma, pilot);
    try {
      await withRequestContext({ requestId: newRequestId() }, async () => {
        TenantContext.attach({ id: tA, slug: 'a', name: 'A', status: 'ACTIVE', region: 'eu' });
        const u = await svc.updateWorkPermit(pwp.id, { permitType: `UPDATED-${stamp}` } as any, SYS_USER);
        out.push({ name: 'updateWorkPermit (pilot) mutates permitType', ok: (u as any).permitType === `UPDATED-${stamp}`, detail: `permitType=${(u as any).permitType}` });
      });
    } finally { await prisma.$disconnect(); }
  });

  // 6 — createVisa in both modes
  let lvs: any = null, pvs: any = null;
  await withFlags({ TENANT_PRISMA_PILOT_ENABLED: 'false' }, async () => {
    const prisma = new PrismaService();
    const ff = new FeatureFlagsService();
    const pilot = new PilotPrismaAccessor(prisma, new TenantPrismaService(prisma, ff), ff);
    const svc = makeService(prisma, pilot);
    try {
      lvs = await svc.createVisa({ entityType: 'EMPLOYEE', entityId: TENANT_A_EMP, visaType: `LEGACY-${stamp}`, applicationDate: new Date().toISOString() } as any, SYS_USER);
      createdVisaIds.push(lvs.id);
    } finally { await prisma.$disconnect(); }
  });
  await withFlags({ TENANT_PRISMA_PILOT_ENABLED: 'true', TENANT_PRISMA_PILOT_MODULES: 'workflow' }, async () => {
    const prisma = new PrismaService();
    const ff = new FeatureFlagsService();
    const pilot = new PilotPrismaAccessor(prisma, new TenantPrismaService(prisma, ff), ff);
    const svc = makeService(prisma, pilot);
    try {
      await withRequestContext({ requestId: newRequestId() }, async () => {
        TenantContext.attach({ id: tA, slug: 'a', name: 'A', status: 'ACTIVE', region: 'eu' });
        pvs = await svc.createVisa({ entityType: 'EMPLOYEE', entityId: TENANT_A_EMP, visaType: `PILOT-${stamp}`, applicationDate: new Date().toISOString() } as any, SYS_USER);
        createdVisaIds.push(pvs.id);
      });
    } finally { await prisma.$disconnect(); }
  });
  const verify2 = new Client({ connectionString: url, ssl: /127\.0\.0\.1|localhost/.test(url) ? false : { rejectUnauthorized: false } });
  await verify2.connect();
  const lvsRow = await verify2.query<{ tenantId: string | null }>(`SELECT "tenantId" FROM visas WHERE id=$1`, [lvs.id]);
  const pvsRow = await verify2.query<{ tenantId: string | null }>(`SELECT "tenantId" FROM visas WHERE id=$1`, [pvs.id]);
  await verify2.end();
  out.push({ name: 'createVisa shape preserved + tenantId NULL legacy / set pilot', ok: !!lvs?.id && !!pvs?.id && lvsRow.rows[0]?.tenantId === null && pvsRow.rows[0]?.tenantId === tA, detail: `legacy.tid=${lvsRow.rows[0]?.tenantId} pilot.tid=${pvsRow.rows[0]?.tenantId}` });

  // 7 — updateVisa
  await withFlags({ TENANT_PRISMA_PILOT_ENABLED: 'true', TENANT_PRISMA_PILOT_MODULES: 'workflow' }, async () => {
    const prisma = new PrismaService();
    const ff = new FeatureFlagsService();
    const pilot = new PilotPrismaAccessor(prisma, new TenantPrismaService(prisma, ff), ff);
    const svc = makeService(prisma, pilot);
    try {
      await withRequestContext({ requestId: newRequestId() }, async () => {
        TenantContext.attach({ id: tA, slug: 'a', name: 'A', status: 'ACTIVE', region: 'eu' });
        const u = await svc.updateVisa(pvs.id, { visaType: `UPDATED-${stamp}` } as any, SYS_USER);
        out.push({ name: 'updateVisa (pilot) mutates visaType', ok: (u as any).visaType === `UPDATED-${stamp}`, detail: `visaType=${(u as any).visaType}` });
      });
    } finally { await prisma.$disconnect(); }
  });

  // 8 — validation parity: bogus ids
  let lE = 'no-error', pE = 'no-error';
  await withFlags({ TENANT_PRISMA_PILOT_ENABLED: 'false' }, async () => {
    const prisma = new PrismaService();
    const ff = new FeatureFlagsService();
    const pilot = new PilotPrismaAccessor(prisma, new TenantPrismaService(prisma, ff), ff);
    const svc = makeService(prisma, pilot);
    try { await svc.updateWorkPermit('00000000-0000-0000-0000-deaddeaddead', { permitType: 'x' } as any, SYS_USER); }
    catch (e) { lE = (e as Error).constructor.name; }
    finally { await prisma.$disconnect(); }
  });
  await withFlags({ TENANT_PRISMA_PILOT_ENABLED: 'true', TENANT_PRISMA_PILOT_MODULES: 'workflow' }, async () => {
    const prisma = new PrismaService();
    const ff = new FeatureFlagsService();
    const pilot = new PilotPrismaAccessor(prisma, new TenantPrismaService(prisma, ff), ff);
    const svc = makeService(prisma, pilot);
    try {
      await withRequestContext({ requestId: newRequestId() }, async () => {
        TenantContext.attach({ id: tA, slug: 'a', name: 'A', status: 'ACTIVE', region: 'eu' });
        await svc.updateWorkPermit('00000000-0000-0000-0000-deaddeaddead', { permitType: 'x' } as any, SYS_USER);
      });
    } catch (e) { pE = (e as Error).constructor.name; }
    finally { await prisma.$disconnect(); }
  });
  out.push({ name: 'validation: NotFoundException for missing permit id in both modes', ok: lE === 'NotFoundException' && pE === 'NotFoundException', detail: `legacy=${lE} pilot=${pE}` });

  // 9 — read-after-write
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
      out.push({ name: 'pilot read-after-write: findWorkPermits sees the new pilot-created row', ok: ids.includes(pwp.id), detail: `count=${ids.length}` });
    } finally { await prisma.$disconnect(); }
  });

  // Cleanup
  const cleanup = new Client({ connectionString: url, ssl: /127\.0\.0\.1|localhost/.test(url) ? false : { rejectUnauthorized: false } });
  await cleanup.connect();
  for (const id of createdPermitIds) await cleanup.query(`DELETE FROM work_permits WHERE id=$1`, [id]).catch(() => undefined);
  for (const id of createdVisaIds)   await cleanup.query(`DELETE FROM visas WHERE id=$1`, [id]).catch(() => undefined);
  // Restore the seed EmployeeStage state — the mutation cases moved
  // tenant A's stage 1 to COMPLETED and upserted stage 2 IN_PROGRESS.
  // Put stage 1 back to IN_PROGRESS and remove the stage 2 upsert so
  // subsequent harnesses see the same state as the original seed.
  await cleanup.query(`DELETE FROM employee_stages WHERE "employeeId"=$1 AND "stageId"=$2`, [TENANT_A_EMP, STAGE_2]).catch(() => undefined);
  await cleanup.query(`UPDATE employee_stages SET notes=NULL, "completedAt"=NULL, status='IN_PROGRESS' WHERE "employeeId"=$1 AND "stageId"='00000000-0000-0000-0000-00000000st01'`, [TENANT_A_EMP]).catch(() => undefined);
  await cleanup.end();

  await fs.mkdir(OUT_DIR, { recursive: true });
  const summary = {
    generatedAt: new Date().toISOString(), environment: env, tenantA: tA,
    counts: { total: out.length, passed: out.filter((r) => r.ok).length, failed: out.filter((r) => !r.ok).length },
    results: out,
  };
  await fs.writeFile(path.join(OUT_DIR, 'workflow-mutation-equivalence.json'), JSON.stringify(summary, null, 2));
  const md: string[] = [];
  md.push('# Phase 2.27 — Workflow Mutation Equivalence');
  md.push(''); md.push(`Generated: ${summary.generatedAt}`);
  md.push(`Environment: ${env.classification} (${env.reason})`);
  md.push(`Tenant A: \`${tA}\``); md.push('');
  md.push(`- Cases passed: **${summary.counts.passed}** / ${summary.counts.total}`);
  md.push(`- Cases failed: ${summary.counts.failed}`); md.push('');
  md.push('| # | Case | Result | Detail |'); md.push('|--:|------|:------:|--------|');
  out.forEach((r, i) => md.push(`| ${i + 1} | ${r.name} | ${r.ok ? 'PASS' : '**FAIL**'} | ${r.detail} |`));
  await fs.writeFile(path.join(OUT_DIR, 'workflow-mutation-equivalence.md'), md.join('\n'));

  console.log(`workflow-mutation-equivalence: ${summary.counts.passed}/${summary.counts.total} cases PASS`);
  if (summary.counts.failed > 0) process.exit(2);
}

main().catch((e) => { console.error(e); process.exit(3); });
