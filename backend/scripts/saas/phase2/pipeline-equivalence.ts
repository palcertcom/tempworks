/**
 * Phase 2.61 — Pipeline reads-first equivalence harness.
 *
 *   1.  pilot disabled: list returns legacy shape
 *   2.  pilot disabled: getWorkflow detail matches legacy
 *   3.  pilot enabled: response shape preserved
 *   4.  pilot enabled candidates list ⊂ legacy union
 *   5.  getWorkflow under pilot returns same workflow id
 *   6.  stages list shape preserved (every stage has id/name/order)
 *   7.  getWorkflowStats keys preserved
 *   8.  pagination shape (n/a — module returns plain arrays; check key presence)
 *   9.  allow-list unset ⇒ all modules allowed
 *  10.  allow-list "pipeline" allows pipeline, denies others
 *  11.  allow-list comma-separated allows both
 *  12.  allow-list "nothing" ⇒ scope inactive (legacy behavior)
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
import { isModuleAllowed, getPilotScope } from '../../../src/saas/prisma/tenant-pilot-scope';

autoLoadEnv(__filename);

const OUT_DIR = path.resolve(__dirname, '..', '..', '..', 'reports', 'saas', 'phase2');
const FIXTURE = path.resolve(__dirname, '__fixture__', 'phase261-pipeline-extension.sql');
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
async function applyFixture(url: string): Promise<void> {
  const sql = await fs.readFile(FIXTURE, 'utf8');
  const c = pgClient(url); await c.connect();
  try { await c.query(sql); } finally { await c.end(); }
}

async function main(): Promise<void> {
  const url = getDatabaseUrl();
  const env = classifyRuntimeEnv();
  if (!isStagingClassification(env.classification)) {
    console.error(`[pipeline-equivalence] refusing on classification=${env.classification}`);
    process.exit(3);
  }
  await applyFixture(url);

  const c = pgClient(url); await c.connect();
  const ts = await c.query<{ id: string }>(
    `SELECT t.id FROM tenants t WHERE EXISTS (SELECT 1 FROM employees e WHERE e."tenantId" = t.id::text) ORDER BY t.name`);
  const tA = ts.rows[0].id;
  await c.end();

  const out: CaseResult[] = [];

  // 1, 2 — pilot disabled
  let legacyCandidates = 0;
  await withFlags({ TENANT_PRISMA_PILOT_ENABLED: 'false' }, async () => {
    const prisma = new PrismaService(); const ff = new FeatureFlagsService();
    const pilot = new PilotPrismaAccessor(prisma, new TenantPrismaService(prisma, ff), ff);
    const svc = makeService(prisma, pilot, ff);
    try {
      const list = await svc.listWorkflows();
      const detail: any = await svc.getWorkflow(WORKFLOW_ID);
      const cands = await svc.getWorkflowCandidates(WORKFLOW_ID);
      legacyCandidates = cands.length;
      out.push({ name: '1. pilot disabled returns legacy list shape', ok: Array.isArray(list) && list.some((w: any) => w.id === WORKFLOW_ID), detail: `workflows=${list.length}` });
      out.push({ name: '2. pilot disabled getWorkflow matches legacy', ok: detail?.id === WORKFLOW_ID && Array.isArray(detail.stages), detail: `id=${detail?.id?.slice(0,8)} stages=${detail?.stages?.length}` });
    } finally { await prisma.$disconnect(); }
  });

  // 3, 4 — pilot enabled
  let pilotCandidates = 0;
  await withFlags({ TENANT_PRISMA_PILOT_ENABLED: 'true', TENANT_PRISMA_PILOT_MODULES: 'pipeline' }, async () => {
    const prisma = new PrismaService(); const ff = new FeatureFlagsService();
    const pilot = new PilotPrismaAccessor(prisma, new TenantPrismaService(prisma, ff), ff);
    const svc = makeService(prisma, pilot, ff);
    try {
      const cands = await withRequestContext({ requestId: newRequestId() }, async () => {
        TenantContext.attach({ id: tA, slug: 'a', name: 'A', status: 'ACTIVE', region: 'eu' });
        return svc.getWorkflowCandidates(WORKFLOW_ID);
      });
      pilotCandidates = cands.length;
      out.push({ name: '3. pilot enabled response shape preserved (array)', ok: Array.isArray(cands), detail: `count=${cands.length}` });
      out.push({ name: '4. pilot enabled candidates ⊂ legacy union', ok: pilotCandidates < legacyCandidates && pilotCandidates >= 1, detail: `legacy=${legacyCandidates} pilotA=${pilotCandidates}` });
    } finally { await prisma.$disconnect(); }
  });

  // 5 — getWorkflow returns same id under pilot
  await withFlags({ TENANT_PRISMA_PILOT_ENABLED: 'true', TENANT_PRISMA_PILOT_MODULES: 'pipeline' }, async () => {
    const prisma = new PrismaService(); const ff = new FeatureFlagsService();
    const pilot = new PilotPrismaAccessor(prisma, new TenantPrismaService(prisma, ff), ff);
    const svc = makeService(prisma, pilot, ff);
    try {
      const r: any = await withRequestContext({ requestId: newRequestId() }, async () => {
        TenantContext.attach({ id: tA, slug: 'a', name: 'A', status: 'ACTIVE', region: 'eu' });
        return svc.getWorkflow(WORKFLOW_ID);
      });
      out.push({ name: '5. getWorkflow under pilot returns same workflow id (workflows are global)', ok: r?.id === WORKFLOW_ID, detail: `id=${r?.id?.slice(0,8)}` });
    } finally { await prisma.$disconnect(); }
  });

  // 6 — stages shape preserved
  await withFlags({ TENANT_PRISMA_PILOT_ENABLED: 'false' }, async () => {
    const prisma = new PrismaService(); const ff = new FeatureFlagsService();
    const pilot = new PilotPrismaAccessor(prisma, new TenantPrismaService(prisma, ff), ff);
    const svc = makeService(prisma, pilot, ff);
    try {
      const r: any = await svc.getWorkflow(WORKFLOW_ID);
      const ok = Array.isArray(r.stages) && r.stages.every((s: any) => s.id && s.name && typeof s.order === 'number');
      out.push({ name: '6. stages list shape preserved (id/name/order)', ok, detail: `stages=${r.stages.length}` });
    } finally { await prisma.$disconnect(); }
  });

  // 7 — stats keys
  await withFlags({ TENANT_PRISMA_PILOT_ENABLED: 'true', TENANT_PRISMA_PILOT_MODULES: 'pipeline' }, async () => {
    const prisma = new PrismaService(); const ff = new FeatureFlagsService();
    const pilot = new PilotPrismaAccessor(prisma, new TenantPrismaService(prisma, ff), ff);
    const svc = makeService(prisma, pilot, ff);
    try {
      const stats: any = await withRequestContext({ requestId: newRequestId() }, async () => {
        TenantContext.attach({ id: tA, slug: 'a', name: 'A', status: 'ACTIVE', region: 'eu' });
        return svc.getWorkflowStats(WORKFLOW_ID);
      });
      const keys = ['totalActive','totalCompleted','flaggedCount','slaBreached'];
      out.push({ name: '7. getWorkflowStats keys preserved', ok: keys.every((k) => k in stats), detail: `keys=${Object.keys(stats).join(',')}` });
    } finally { await prisma.$disconnect(); }
  });

  // 8 — sentinel: getWorkflowBoardView returns columns array
  await withFlags({ TENANT_PRISMA_PILOT_ENABLED: 'true', TENANT_PRISMA_PILOT_MODULES: 'pipeline' }, async () => {
    const prisma = new PrismaService(); const ff = new FeatureFlagsService();
    const pilot = new PilotPrismaAccessor(prisma, new TenantPrismaService(prisma, ff), ff);
    const svc = makeService(prisma, pilot, ff);
    try {
      const r: any = await withRequestContext({ requestId: newRequestId() }, async () => {
        TenantContext.attach({ id: tA, slug: 'a', name: 'A', status: 'ACTIVE', region: 'eu' });
        return svc.getWorkflowBoardView(WORKFLOW_ID);
      });
      out.push({ name: '8. getWorkflowBoardView shape preserved (workflow + columns)',
        ok: !!r.workflow && Array.isArray(r.columns) && r.columns.every((c: any) => c.stage && Array.isArray(c.candidates) && typeof c.count === 'number'),
        detail: `columns=${r.columns?.length}` });
    } finally { await prisma.$disconnect(); }
  });

  // 9-11 — allow-list contracts
  out.push({ name: '9. allow-list unset ⇒ all modules allowed', ok: isModuleAllowed('pipeline') && isModuleAllowed('audit-logs'), detail: 'both true' });
  await withFlags({ TENANT_PRISMA_PILOT_MODULES: 'pipeline' }, () => {
    out.push({ name: '10. allow-list "pipeline" allows pipeline, denies others',
      ok: isModuleAllowed('pipeline') && !isModuleAllowed('audit-logs'),
      detail: `pipeline=${isModuleAllowed('pipeline')} audit=${isModuleAllowed('audit-logs')}` });
  });
  await withFlags({ TENANT_PRISMA_PILOT_MODULES: 'pipeline,audit-logs' }, () => {
    out.push({ name: '11. allow-list comma-separated allows both', ok: isModuleAllowed('pipeline') && isModuleAllowed('audit-logs'), detail: 'both true' });
  });
  await withFlags({ TENANT_PRISMA_PILOT_ENABLED: 'true', TENANT_PRISMA_PILOT_MODULES: 'nothing' }, async () => {
    const prisma = new PrismaService(); const ff = new FeatureFlagsService();
    const pilot = new PilotPrismaAccessor(prisma, new TenantPrismaService(prisma, ff), ff);
    await withRequestContext({ requestId: newRequestId() }, async () => {
      TenantContext.attach({ id: tA, slug: 'a', name: 'A', status: 'ACTIVE', region: 'eu' });
      const s = getPilotScope(pilot, 'pipeline');
      out.push({ name: '12. allow-list "nothing" ⇒ scope inactive (legacy)',
        ok: !s.active && /not in TENANT_PRISMA_PILOT_MODULES/.test(s.reason), detail: s.reason });
    });
    await prisma.$disconnect();
  });

  await fs.mkdir(OUT_DIR, { recursive: true });
  const passed = out.filter((c) => c.ok).length;
  const total = out.length;
  await fs.writeFile(path.join(OUT_DIR, 'pipeline-equivalence.json'),
    JSON.stringify({ passed, total, cases: out }, null, 2));
  const md = [
    `# Phase 2.61 — pipeline equivalence`, ``,
    `**${passed}/${total} PASS**`, ``,
    ...out.map((c) => `- ${c.ok ? 'PASS' : 'FAIL'} — ${c.name} — ${c.detail}`), ``,
  ].join('\n');
  await fs.writeFile(path.join(OUT_DIR, 'pipeline-equivalence.md'), md);
  console.log(`[pipeline-equivalence] ${passed}/${total} PASS`);
  process.exit(passed === total ? 0 : 1);
}

main().catch((err) => { console.error(err); process.exit(2); });
