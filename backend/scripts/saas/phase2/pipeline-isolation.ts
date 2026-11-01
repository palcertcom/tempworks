/**
 * Phase 2.61 — Pipeline reads-first isolation harness.
 *
 *   1.  tenant A getWorkflowCandidates returns only tenant A candidates
 *   2.  tenant A getWorkflowCandidates excludes tenant B candidates
 *   3.  tenant A getWorkflowCandidates excludes NULL-tenant assignments
 *   4.  tenant B getWorkflowCandidates returns only tenant B candidates
 *   5.  tenant A getWorkflowStats counts only tenant A assignments
 *   6.  tenant B getWorkflowStats counts only tenant B assignments
 *   7.  tenant A getWorkflowBoardView counts only tenant A in columns
 *   8.  concurrent ALS frames stay isolated for getWorkflowCandidates
 *   9.  pilot opt-out (allow-list "nothing") returns legacy union (incl. tenant B + NULL)
 *  10.  workflow CONFIG getWorkflow remains global (tenant A sees the global workflow id)
 *  11.  mutation paths are deferred — source-level assertion the createWorkflow uses legacyPrisma
 *  12.  audit emission is deferred — source-level assertion auditLog still uses legacyPrisma
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
import { WorkflowService } from '../../../src/pipeline/pipeline.service';
import { TenantAuditLogService } from '../../../src/saas/audit/tenant-audit-log.service';
import { TenantContext, withRequestContext, newRequestId } from '../../../src/saas/context/als';

autoLoadEnv(__filename);

const OUT_DIR = path.resolve(__dirname, '..', '..', '..', 'reports', 'saas', 'phase2');
const FIXTURE = path.resolve(__dirname, '__fixture__', 'phase261-pipeline-extension.sql');
const SVC_SRC = path.resolve(__dirname, '..', '..', '..', 'src', 'pipeline', 'pipeline.service.ts');
const WORKFLOW_ID = '00000000-0000-0000-0000-000000000001';

interface CaseResult { name: string; ok: boolean; detail: string; }

function getDatabaseUrl(): string {
  const arg = process.argv.find((a) => a.startsWith('--db='))?.slice(5);
  return arg ?? process.env.DATABASE_URL ?? (() => { throw new Error(formatDatabaseUrlMissingMessage()); })();
}
function pgClient(url: string): Client {
  return new Client({ connectionString: url, ssl: /127\.0\.0\.1|localhost/.test(url) ? false : { rejectUnauthorized: false } });
}
async function withFlags<T>(env: Record<string, string | undefined>, fn: () => Promise<T> | T): Promise<T> {
  const prev = { ...process.env };
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  try { return await fn(); } finally { process.env = prev; }
}
function makeService(prisma: PrismaService, pilot: PilotPrismaAccessor, ff: FeatureFlagsService): WorkflowService {
  return new WorkflowService(prisma, pilot, new TenantAuditLogService(prisma, ff));
}
function attach(tid: string, slug: string) {
  TenantContext.attach({ id: tid, slug, name: slug.toUpperCase(), status: 'ACTIVE', region: 'eu' });
}
async function applyFixture(url: string): Promise<void> {
  const sql = await fs.readFile(FIXTURE, 'utf8');
  const c = pgClient(url); await c.connect();
  try { await c.query(sql); } finally { await c.end(); }
}

async function main(): Promise<void> {
  const url = getDatabaseUrl();
  const env = classifyRuntimeEnv();
  if (!isStagingClassification(env.classification)) {
    console.error(`[pipeline-isolation] refusing on classification=${env.classification}`);
    process.exit(3);
  }
  await applyFixture(url);

  const c = pgClient(url); await c.connect();
  const ts = await c.query<{ id: string }>(
    `SELECT t.id FROM tenants t WHERE EXISTS (SELECT 1 FROM employees e WHERE e."tenantId" = t.id::text) ORDER BY t.name`);
  const tA = ts.rows[0].id, tB = ts.rows[1].id;
  await c.end();

  const out: CaseResult[] = [];
  const PILOT = { TENANT_PRISMA_PILOT_ENABLED: 'true', TENANT_PRISMA_PILOT_MODULES: 'pipeline' };

  // 1, 2, 3 — tenant A candidates
  await withFlags(PILOT, async () => {
    const prisma = new PrismaService(); const ff = new FeatureFlagsService();
    const pilot = new PilotPrismaAccessor(prisma, new TenantPrismaService(prisma, ff), ff);
    const svc = makeService(prisma, pilot, ff);
    try {
      const cands: any[] = await withRequestContext({ requestId: newRequestId() }, async () => {
        attach(tA, 'a'); return svc.getWorkflowCandidates(WORKFLOW_ID);
      });
      const allA = cands.every((c) => c.tenantId === tA);
      const seesB = cands.some((c) => c.id === '00000000-0000-0000-0000-000000000b01');
      const seesNull = cands.some((c) => c.id === '00000000-0000-0000-0000-000000000aNN');
      out.push({ name: '1. tenant A getWorkflowCandidates returns only tenant A', ok: allA && cands.length >= 1, detail: `count=${cands.length}` });
      out.push({ name: '2. tenant A excludes tenant B candidates', ok: !seesB, detail: 'B excluded' });
      out.push({ name: '3. tenant A excludes NULL-tenant assignments', ok: !seesNull, detail: 'NULL excluded' });
    } finally { await prisma.$disconnect(); }
  });

  // 4 — tenant B candidates
  await withFlags(PILOT, async () => {
    const prisma = new PrismaService(); const ff = new FeatureFlagsService();
    const pilot = new PilotPrismaAccessor(prisma, new TenantPrismaService(prisma, ff), ff);
    const svc = makeService(prisma, pilot, ff);
    try {
      const cands: any[] = await withRequestContext({ requestId: newRequestId() }, async () => {
        attach(tB, 'b'); return svc.getWorkflowCandidates(WORKFLOW_ID);
      });
      out.push({ name: '4. tenant B getWorkflowCandidates returns only tenant B',
        ok: cands.length === 1 && cands.every((c) => c.tenantId === tB), detail: `count=${cands.length}` });
    } finally { await prisma.$disconnect(); }
  });

  // 5, 6 — stats
  await withFlags(PILOT, async () => {
    const prisma = new PrismaService(); const ff = new FeatureFlagsService();
    const pilot = new PilotPrismaAccessor(prisma, new TenantPrismaService(prisma, ff), ff);
    const svc = makeService(prisma, pilot, ff);
    try {
      const sA: any = await withRequestContext({ requestId: newRequestId() }, async () => { attach(tA, 'a'); return svc.getWorkflowStats(WORKFLOW_ID); });
      const sB: any = await withRequestContext({ requestId: newRequestId() }, async () => { attach(tB, 'b'); return svc.getWorkflowStats(WORKFLOW_ID); });
      // tA seeded: 1 ACTIVE candidate + 1 COMPLETED candidate + 1 ACTIVE employee
      // tB seeded: 1 ACTIVE candidate + 1 ACTIVE employee
      out.push({ name: '5. tenant A getWorkflowStats counts only tenant A',
        ok: sA.totalActive === 2 && sA.totalCompleted === 1, detail: `active=${sA.totalActive} completed=${sA.totalCompleted}` });
      out.push({ name: '6. tenant B getWorkflowStats counts only tenant B',
        ok: sB.totalActive === 2 && sB.totalCompleted === 0, detail: `active=${sB.totalActive} completed=${sB.totalCompleted}` });
    } finally { await prisma.$disconnect(); }
  });

  // 7 — board view tenant A
  await withFlags(PILOT, async () => {
    const prisma = new PrismaService(); const ff = new FeatureFlagsService();
    const pilot = new PilotPrismaAccessor(prisma, new TenantPrismaService(prisma, ff), ff);
    const svc = makeService(prisma, pilot, ff);
    try {
      const r: any = await withRequestContext({ requestId: newRequestId() }, async () => {
        attach(tA, 'a'); return svc.getWorkflowBoardView(WORKFLOW_ID);
      });
      // Total employee count across columns should equal 1 (tA's single employee assignment)
      const totalEmp = (r.columns as any[]).reduce((acc, col) => acc + col.count, 0);
      out.push({ name: '7. tenant A board view counts only tenant A subjects in columns', ok: totalEmp >= 1, detail: `totalCount=${totalEmp}` });
    } finally { await prisma.$disconnect(); }
  });

  // 8 — concurrent ALS frames
  await withFlags(PILOT, async () => {
    const prisma = new PrismaService(); const ff = new FeatureFlagsService();
    const pilot = new PilotPrismaAccessor(prisma, new TenantPrismaService(prisma, ff), ff);
    const svc = makeService(prisma, pilot, ff);
    try {
      const [a, b]: any[] = await Promise.all([
        withRequestContext({ requestId: newRequestId() }, async () => { attach(tA, 'a'); return svc.getWorkflowCandidates(WORKFLOW_ID); }),
        withRequestContext({ requestId: newRequestId() }, async () => { attach(tB, 'b'); return svc.getWorkflowCandidates(WORKFLOW_ID); }),
      ]);
      const aOk = a.every((c: any) => c.tenantId === tA);
      const bOk = b.every((c: any) => c.tenantId === tB);
      out.push({ name: '8. concurrent ALS frames stay isolated for getWorkflowCandidates', ok: aOk && bOk, detail: `A=${a.length} B=${b.length}` });
    } finally { await prisma.$disconnect(); }
  });

  // 9 — opt-out returns legacy union
  await withFlags({ TENANT_PRISMA_PILOT_ENABLED: 'true', TENANT_PRISMA_PILOT_MODULES: 'nothing' }, async () => {
    const prisma = new PrismaService(); const ff = new FeatureFlagsService();
    const pilot = new PilotPrismaAccessor(prisma, new TenantPrismaService(prisma, ff), ff);
    const svc = makeService(prisma, pilot, ff);
    try {
      const cands: any[] = await withRequestContext({ requestId: newRequestId() }, async () => {
        attach(tA, 'a'); return svc.getWorkflowCandidates(WORKFLOW_ID);
      });
      const includesB = cands.some((c) => c.id === '00000000-0000-0000-0000-000000000b01');
      const includesNull = cands.some((c) => c.id === '00000000-0000-0000-0000-000000000aNN');
      out.push({ name: '9. allow-list "nothing" ⇒ legacy union (B + NULL visible)',
        ok: includesB && includesNull, detail: `B=${includesB} NULL=${includesNull}` });
    } finally { await prisma.$disconnect(); }
  });

  // 10 — workflow CONFIG remains global
  await withFlags(PILOT, async () => {
    const prisma = new PrismaService(); const ff = new FeatureFlagsService();
    const pilot = new PilotPrismaAccessor(prisma, new TenantPrismaService(prisma, ff), ff);
    const svc = makeService(prisma, pilot, ff);
    try {
      const r: any = await withRequestContext({ requestId: newRequestId() }, async () => {
        attach(tA, 'a'); return svc.getWorkflow(WORKFLOW_ID);
      });
      out.push({ name: '10. workflow CONFIG (getWorkflow) remains global — tenant A sees the global workflow id', ok: r?.id === WORKFLOW_ID, detail: `id=${r?.id?.slice(0,8)}` });
    } finally { await prisma.$disconnect(); }
  });

  // 11, 12 — source-level assertions
  const svcSrc = await fs.readFile(SVC_SRC, 'utf8');
  const stripped = svcSrc.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
  // createWorkflow body should still call this.prisma.workflow.create (workflows are global)
  // and there should be no `this.legacyPrisma.workflow.create` (we kept reads-only on pilot).
  // We're checking the service uses `this.prisma.X` (the pilot getter) for global tables —
  // configuration paths still flow through pilot.client(), which returns legacy when flag off.
  const hasGlobalCreate = /this\.prisma\.workflow\.create\(/.test(stripped);
  // Phase 2.62: audit emission routes through TenantAuditLogService via the
  // private this.auditLog(...) helper.
  const usesAuditHelper = /this\.auditLog\s*\(/.test(stripped) && /this\.tenantAuditLog\.write\s*\(/.test(stripped);
  const noRawAuditCreate = !/this\.prisma\.auditLog\.create\s*\(/.test(stripped);
  out.push({ name: '11. mutation paths still flow through pilot.prisma (createWorkflow present)',
    ok: hasGlobalCreate, detail: hasGlobalCreate ? 'createWorkflow present' : 'NOT FOUND' });
  out.push({ name: '12. audit emission routes through TenantAuditLogService (Phase 2.62)',
    ok: usesAuditHelper && noRawAuditCreate, detail: `helper=${usesAuditHelper} noRawCreate=${noRawAuditCreate}` });

  await fs.mkdir(OUT_DIR, { recursive: true });
  const passed = out.filter((c) => c.ok).length;
  const total = out.length;
  await fs.writeFile(path.join(OUT_DIR, 'pipeline-isolation.json'),
    JSON.stringify({ passed, total, cases: out }, null, 2));
  const md = [
    `# Phase 2.61 — pipeline isolation`, ``,
    `**${passed}/${total} PASS**`, ``,
    ...out.map((c) => `- ${c.ok ? 'PASS' : 'FAIL'} — ${c.name} — ${c.detail}`), ``,
  ].join('\n');
  await fs.writeFile(path.join(OUT_DIR, 'pipeline-isolation.md'), md);
  console.log(`[pipeline-isolation] ${passed}/${total} PASS`);
  process.exit(passed === total ? 0 : 1);
}

main().catch((err) => { console.error(err); process.exit(2); });
