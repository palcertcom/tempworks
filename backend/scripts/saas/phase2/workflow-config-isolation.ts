/**
 * Phase 2.63 — Workflow config tenant-scope isolation harness.
 *
 *   1.  pilot off: createWorkflow returns row with tenantId=null (legacy)
 *   2.  pilot A: createWorkflow stamps tenantId=A
 *   3.  pilot A: createWorkflow(isDefault=true) flips only OWN-tenant
 *       defaults (B's default flag untouched)
 *   4.  listWorkflows pilot A: returns own + NULL-global (no B rows)
 *   5.  listWorkflows pilot B: returns own + NULL-global (no A rows)
 *   6.  getWorkflow pilot A: own workflow visible
 *   7.  getWorkflow pilot A: NULL-global template visible
 *   8.  getWorkflow pilot A: tenant B workflow → NotFound
 *   9.  updateWorkflow pilot A: NULL-global template → NotFound
 *  10.  updateWorkflow pilot A: tenant B workflow → NotFound
 *  11.  updateWorkflow pilot A: own workflow → success
 *  12.  deleteWorkflow pilot A: NULL-global template → NotFound
 *  13.  archiveWorkflow pilot A: tenant B → NotFound
 *  14.  addStage pilot A: tenant B parent → NotFound + no row inserted
 *  15.  updateStage pilot A: stage in NULL-global → NotFound (template stays untouched)
 *  16.  deleteStage pilot A: stage in NULL-global → NotFound
 *  17.  addAccessUser pilot A: tenant B parent → NotFound
 *  18.  concurrent ALS frames remain isolated for updateWorkflow
 *  19.  source-level: workflowReadWhere / workflowMutateWhere / findMutableWorkflowOrFail
 *       defined; workflowMutateWhere wired into update/archive/delete entry points;
 *       createWorkflow.create spreads tenantData()
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
const SVC_SRC = path.resolve(__dirname, '..', '..', '..', 'src', 'pipeline', 'pipeline.service.ts');

// NULL-tenant "global template" workflow seed (pre-existing from Phase 2.61
// fixture extension — id 00000000-0000-0000-0000-000000000001 with stages
// 011/022 and `tenantId IS NULL`).
const GLOBAL_WF_ID = '00000000-0000-0000-0000-000000000001';
const GLOBAL_STAGE_ID = '00000000-0000-0000-0000-000000000011';

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
function msg(err: any): string { return (err?.message ?? '') + ' ' + JSON.stringify(err?.response ?? ''); }

interface Seed { tA: string; tB: string; wfA: string; wfB: string; stageA: string; stageB: string; }

async function setupSeed(url: string): Promise<Seed> {
  const c = pgClient(url); await c.connect();
  try {
    const ts = await c.query<{ id: string }>(
      `SELECT t.id FROM tenants t WHERE EXISTS (SELECT 1 FROM employees e WHERE e."tenantId" = t.id::text) ORDER BY t.name`);
    const tA = ts.rows[0].id, tB = ts.rows[1].id;
    // Clean prior harness rows for idempotency.
    await c.query(`DELETE FROM workflow_stages WHERE id IN ('00000000-0000-0000-0000-0000000063a1','00000000-0000-0000-0000-0000000063b1')`);
    await c.query(`DELETE FROM workflows WHERE id IN ('00000000-0000-0000-0000-00000000063A','00000000-0000-0000-0000-00000000063B')`);
    await c.query(`
      INSERT INTO workflows (id, name, description, "isDefault", "isPublic", color, status, "tenantId", "createdAt", "updatedAt")
      VALUES
        ('00000000-0000-0000-0000-00000000063A', 'WF-tenantA-63', 'fixture', true,  true, '#111111', 'ACTIVE', $1, now(), now()),
        ('00000000-0000-0000-0000-00000000063B', 'WF-tenantB-63', 'fixture', true,  true, '#222222', 'ACTIVE', $2, now(), now())
      ON CONFLICT (id) DO NOTHING
    `, [tA, tB]);
    await c.query(`
      INSERT INTO workflow_stages (id, "workflowId", name, "order", color, "isActive", "createdAt", "updatedAt")
      VALUES
        ('00000000-0000-0000-0000-0000000063a1', '00000000-0000-0000-0000-00000000063A', 'sA1', 1, '#888', true, now(), now()),
        ('00000000-0000-0000-0000-0000000063b1', '00000000-0000-0000-0000-00000000063B', 'sB1', 1, '#888', true, now(), now())
      ON CONFLICT (id) DO NOTHING
    `);
    return {
      tA, tB,
      wfA: '00000000-0000-0000-0000-00000000063A',
      wfB: '00000000-0000-0000-0000-00000000063B',
      stageA: '00000000-0000-0000-0000-0000000063a1',
      stageB: '00000000-0000-0000-0000-0000000063b1',
    };
  } finally { await c.end(); }
}

const PILOT = { TENANT_PRISMA_PILOT_ENABLED: 'true', TENANT_PRISMA_PILOT_MODULES: 'pipeline' };

async function main(): Promise<void> {
  const url = getDatabaseUrl();
  const env = classifyRuntimeEnv();
  if (!isStagingClassification(env.classification)) {
    console.error(`[workflow-config-isolation] refusing on classification=${env.classification}`);
    process.exit(3);
  }
  const seed = await setupSeed(url);
  const { tA, tB, wfA, wfB, stageA, stageB } = seed;
  const out: CaseResult[] = [];

  // 1 — pilot off: createWorkflow returns row with tenantId=null
  await withFlags({ TENANT_PRISMA_PILOT_ENABLED: 'false' }, async () => {
    const prisma = new PrismaService(); const ff = new FeatureFlagsService();
    const pilot = new PilotPrismaAccessor(prisma, new TenantPrismaService(prisma, ff), ff);
    const svc = makeService(prisma, pilot, ff);
    try {
      const w: any = await svc.createWorkflow({ name: `wf-off-${Date.now()}` } as any, undefined);
      out.push({ name: '1. pilot off: createWorkflow returns row with tenantId=null (legacy)',
        ok: w.tenantId == null, detail: `tenantId=${w.tenantId}` });
      await prisma.workflow.delete({ where: { id: w.id } });
    } finally { await prisma.$disconnect(); }
  });

  // 2 — pilot A: createWorkflow stamps tenantId=A
  await withFlags(PILOT, async () => {
    const prisma = new PrismaService(); const ff = new FeatureFlagsService();
    const pilot = new PilotPrismaAccessor(prisma, new TenantPrismaService(prisma, ff), ff);
    const svc = makeService(prisma, pilot, ff);
    try {
      const w: any = await withRequestContext({ requestId: newRequestId() }, async () => {
        attach(tA, 'a'); return svc.createWorkflow({ name: `wf-pilotA-${Date.now()}` } as any, undefined);
      });
      out.push({ name: '2. pilot A: createWorkflow stamps tenantId=A',
        ok: w.tenantId === tA, detail: `tenantId=${(w.tenantId ?? '').slice(0,8)}` });
      await prisma.workflow.delete({ where: { id: w.id } });
    } finally { await prisma.$disconnect(); }
  });

  // 3 — pilot A: createWorkflow(isDefault=true) flips only OWN-tenant defaults
  await withFlags(PILOT, async () => {
    const prisma = new PrismaService(); const ff = new FeatureFlagsService();
    const pilot = new PilotPrismaAccessor(prisma, new TenantPrismaService(prisma, ff), ff);
    const svc = makeService(prisma, pilot, ff);
    try {
      // Make sure wfA + wfB are both isDefault=true to start
      await prisma.workflow.update({ where: { id: wfA }, data: { isDefault: true } });
      await prisma.workflow.update({ where: { id: wfB }, data: { isDefault: true } });
      const w: any = await withRequestContext({ requestId: newRequestId() }, async () => {
        attach(tA, 'a'); return svc.createWorkflow({ name: `wf-pilotA-dflt-${Date.now()}`, isDefault: true } as any, undefined);
      });
      const a = await prisma.workflow.findUnique({ where: { id: wfA } });
      const b = await prisma.workflow.findUnique({ where: { id: wfB } });
      const ok = a?.isDefault === false && b?.isDefault === true && w.isDefault === true;
      out.push({ name: '3. pilot A: createWorkflow(isDefault=true) flips ONLY own-tenant defaults',
        ok, detail: `A.isDefault=${a?.isDefault} B.isDefault=${b?.isDefault} new=${w.isDefault}` });
      await prisma.workflow.delete({ where: { id: w.id } });
    } finally { await prisma.$disconnect(); }
  });

  // 4 — listWorkflows pilot A: own + NULL-global only
  await withFlags(PILOT, async () => {
    const prisma = new PrismaService(); const ff = new FeatureFlagsService();
    const pilot = new PilotPrismaAccessor(prisma, new TenantPrismaService(prisma, ff), ff);
    const svc = makeService(prisma, pilot, ff);
    try {
      const list: any[] = await withRequestContext({ requestId: newRequestId() }, async () => {
        attach(tA, 'a'); return svc.listWorkflows(true);
      });
      const ids = list.map((w) => w.id);
      const hasA = ids.includes(wfA), hasB = ids.includes(wfB), hasGlobal = ids.includes(GLOBAL_WF_ID);
      out.push({ name: '4. listWorkflows pilot A: own + NULL-global only (no B rows)',
        ok: hasA && !hasB && hasGlobal, detail: `A=${hasA} B=${hasB} global=${hasGlobal}` });
    } finally { await prisma.$disconnect(); }
  });

  // 5 — listWorkflows pilot B: own + NULL-global only
  await withFlags(PILOT, async () => {
    const prisma = new PrismaService(); const ff = new FeatureFlagsService();
    const pilot = new PilotPrismaAccessor(prisma, new TenantPrismaService(prisma, ff), ff);
    const svc = makeService(prisma, pilot, ff);
    try {
      const list: any[] = await withRequestContext({ requestId: newRequestId() }, async () => {
        attach(tB, 'b'); return svc.listWorkflows(true);
      });
      const ids = list.map((w) => w.id);
      const hasA = ids.includes(wfA), hasB = ids.includes(wfB), hasGlobal = ids.includes(GLOBAL_WF_ID);
      out.push({ name: '5. listWorkflows pilot B: own + NULL-global only (no A rows)',
        ok: !hasA && hasB && hasGlobal, detail: `A=${hasA} B=${hasB} global=${hasGlobal}` });
    } finally { await prisma.$disconnect(); }
  });

  // 6 — getWorkflow pilot A: own workflow visible
  await withFlags(PILOT, async () => {
    const prisma = new PrismaService(); const ff = new FeatureFlagsService();
    const pilot = new PilotPrismaAccessor(prisma, new TenantPrismaService(prisma, ff), ff);
    const svc = makeService(prisma, pilot, ff);
    try {
      const w: any = await withRequestContext({ requestId: newRequestId() }, async () => {
        attach(tA, 'a'); return svc.getWorkflow(wfA);
      });
      out.push({ name: '6. getWorkflow pilot A: own workflow visible',
        ok: w?.id === wfA, detail: `id=${w?.id?.slice(0,8)}` });
    } finally { await prisma.$disconnect(); }
  });

  // 7 — getWorkflow pilot A: NULL-global template visible
  await withFlags(PILOT, async () => {
    const prisma = new PrismaService(); const ff = new FeatureFlagsService();
    const pilot = new PilotPrismaAccessor(prisma, new TenantPrismaService(prisma, ff), ff);
    const svc = makeService(prisma, pilot, ff);
    try {
      const w: any = await withRequestContext({ requestId: newRequestId() }, async () => {
        attach(tA, 'a'); return svc.getWorkflow(GLOBAL_WF_ID);
      });
      out.push({ name: '7. getWorkflow pilot A: NULL-global template visible',
        ok: w?.id === GLOBAL_WF_ID, detail: `id=${w?.id?.slice(0,8)}` });
    } finally { await prisma.$disconnect(); }
  });

  // 8 — getWorkflow pilot A: tenant B workflow → NotFound
  await withFlags(PILOT, async () => {
    const prisma = new PrismaService(); const ff = new FeatureFlagsService();
    const pilot = new PilotPrismaAccessor(prisma, new TenantPrismaService(prisma, ff), ff);
    const svc = makeService(prisma, pilot, ff);
    try {
      let threw = false;
      try {
        await withRequestContext({ requestId: newRequestId() }, async () => {
          attach(tA, 'a'); await svc.getWorkflow(wfB);
        });
      } catch (err: any) { threw = /WORKFLOW\.NOT_FOUND|Workflow not found/i.test(msg(err)); }
      out.push({ name: '8. getWorkflow pilot A: tenant B workflow → NotFound', ok: threw, detail: threw ? 'NotFound' : 'UNEXPECTED' });
    } finally { await prisma.$disconnect(); }
  });

  // 9 — updateWorkflow pilot A: NULL-global template → NotFound (refuses global mutation)
  await withFlags(PILOT, async () => {
    const prisma = new PrismaService(); const ff = new FeatureFlagsService();
    const pilot = new PilotPrismaAccessor(prisma, new TenantPrismaService(prisma, ff), ff);
    const svc = makeService(prisma, pilot, ff);
    try {
      let threw = false;
      try {
        await withRequestContext({ requestId: newRequestId() }, async () => {
          attach(tA, 'a'); await svc.updateWorkflow(GLOBAL_WF_ID, { description: 'hacked' } as any, 'actor');
        });
      } catch (err: any) { threw = /WORKFLOW\.NOT_FOUND|Workflow not found/i.test(msg(err)); }
      out.push({ name: '9. updateWorkflow pilot A: NULL-global template refused (NotFound)',
        ok: threw, detail: threw ? 'NotFound' : 'UNEXPECTED' });
    } finally { await prisma.$disconnect(); }
  });

  // 10 — updateWorkflow pilot A: tenant B workflow → NotFound
  await withFlags(PILOT, async () => {
    const prisma = new PrismaService(); const ff = new FeatureFlagsService();
    const pilot = new PilotPrismaAccessor(prisma, new TenantPrismaService(prisma, ff), ff);
    const svc = makeService(prisma, pilot, ff);
    try {
      let threw = false;
      try {
        await withRequestContext({ requestId: newRequestId() }, async () => {
          attach(tA, 'a'); await svc.updateWorkflow(wfB, { description: 'hacked' } as any, 'actor');
        });
      } catch (err: any) { threw = /WORKFLOW\.NOT_FOUND|Workflow not found/i.test(msg(err)); }
      out.push({ name: '10. updateWorkflow pilot A: tenant B workflow → NotFound', ok: threw, detail: threw ? 'NotFound' : 'UNEXPECTED' });
    } finally { await prisma.$disconnect(); }
  });

  // 11 — updateWorkflow pilot A: own workflow → success
  await withFlags(PILOT, async () => {
    const prisma = new PrismaService(); const ff = new FeatureFlagsService();
    const pilot = new PilotPrismaAccessor(prisma, new TenantPrismaService(prisma, ff), ff);
    const svc = makeService(prisma, pilot, ff);
    try {
      const w: any = await withRequestContext({ requestId: newRequestId() }, async () => {
        attach(tA, 'a'); return svc.updateWorkflow(wfA, { description: 'owned-update' } as any, undefined);
      });
      out.push({ name: '11. updateWorkflow pilot A: own workflow → success',
        ok: w?.description === 'owned-update', detail: `description=${w?.description}` });
    } finally { await prisma.$disconnect(); }
  });

  // 12 — deleteWorkflow pilot A: NULL-global → NotFound
  await withFlags(PILOT, async () => {
    const prisma = new PrismaService(); const ff = new FeatureFlagsService();
    const pilot = new PilotPrismaAccessor(prisma, new TenantPrismaService(prisma, ff), ff);
    const svc = makeService(prisma, pilot, ff);
    try {
      let threw = false;
      try {
        await withRequestContext({ requestId: newRequestId() }, async () => {
          attach(tA, 'a'); await svc.deleteWorkflow(GLOBAL_WF_ID, 'actor');
        });
      } catch (err: any) { threw = /WORKFLOW\.NOT_FOUND|Workflow not found/i.test(msg(err)); }
      out.push({ name: '12. deleteWorkflow pilot A: NULL-global → NotFound', ok: threw, detail: threw ? 'NotFound' : 'UNEXPECTED' });
    } finally { await prisma.$disconnect(); }
  });

  // 13 — archiveWorkflow pilot A: tenant B → NotFound
  await withFlags(PILOT, async () => {
    const prisma = new PrismaService(); const ff = new FeatureFlagsService();
    const pilot = new PilotPrismaAccessor(prisma, new TenantPrismaService(prisma, ff), ff);
    const svc = makeService(prisma, pilot, ff);
    try {
      let threw = false;
      try {
        await withRequestContext({ requestId: newRequestId() }, async () => {
          attach(tA, 'a'); await svc.archiveWorkflow(wfB, 'actor');
        });
      } catch (err: any) { threw = /WORKFLOW\.NOT_FOUND|Workflow not found/i.test(msg(err)); }
      out.push({ name: '13. archiveWorkflow pilot A: tenant B → NotFound', ok: threw, detail: threw ? 'NotFound' : 'UNEXPECTED' });
    } finally { await prisma.$disconnect(); }
  });

  // 14 — addStage pilot A: tenant B parent → NotFound + no row inserted
  await withFlags(PILOT, async () => {
    const prisma = new PrismaService(); const ff = new FeatureFlagsService();
    const pilot = new PilotPrismaAccessor(prisma, new TenantPrismaService(prisma, ff), ff);
    const svc = makeService(prisma, pilot, ff);
    try {
      const c = pgClient(url); await c.connect();
      const before = await c.query<{ count: string }>(`SELECT COUNT(*)::text AS count FROM workflow_stages WHERE "workflowId" = $1`, [wfB]);
      let threw = false;
      try {
        await withRequestContext({ requestId: newRequestId() }, async () => {
          attach(tA, 'a'); await svc.addStage(wfB, { name: 'evil', order: 99 } as any, 'actor');
        });
      } catch (err: any) { threw = /WORKFLOW\.NOT_FOUND|Workflow not found/i.test(msg(err)); }
      const after = await c.query<{ count: string }>(`SELECT COUNT(*)::text AS count FROM workflow_stages WHERE "workflowId" = $1`, [wfB]);
      await c.end();
      out.push({ name: '14. addStage pilot A: tenant B parent → NotFound + no row inserted',
        ok: threw && before.rows[0].count === after.rows[0].count, detail: `threw=${threw} before=${before.rows[0].count} after=${after.rows[0].count}` });
    } finally { await prisma.$disconnect(); }
  });

  // 15 — updateStage pilot A: stage in NULL-global → NotFound
  await withFlags(PILOT, async () => {
    const prisma = new PrismaService(); const ff = new FeatureFlagsService();
    const pilot = new PilotPrismaAccessor(prisma, new TenantPrismaService(prisma, ff), ff);
    const svc = makeService(prisma, pilot, ff);
    try {
      let threw = false;
      try {
        await withRequestContext({ requestId: newRequestId() }, async () => {
          attach(tA, 'a'); await svc.updateStage(GLOBAL_STAGE_ID, { description: 'mutated' } as any, 'actor');
        });
      } catch (err: any) { threw = /WORKFLOW\.NOT_FOUND|Workflow not found/i.test(msg(err)); }
      out.push({ name: '15. updateStage pilot A: stage in NULL-global → NotFound', ok: threw, detail: threw ? 'NotFound' : 'UNEXPECTED' });
    } finally { await prisma.$disconnect(); }
  });

  // 16 — deleteStage pilot A: stage in NULL-global → NotFound
  await withFlags(PILOT, async () => {
    const prisma = new PrismaService(); const ff = new FeatureFlagsService();
    const pilot = new PilotPrismaAccessor(prisma, new TenantPrismaService(prisma, ff), ff);
    const svc = makeService(prisma, pilot, ff);
    try {
      let threw = false;
      try {
        await withRequestContext({ requestId: newRequestId() }, async () => {
          attach(tA, 'a'); await svc.deleteStage(GLOBAL_STAGE_ID, 'actor');
        });
      } catch (err: any) { threw = /WORKFLOW\.NOT_FOUND|Workflow not found/i.test(msg(err)); }
      out.push({ name: '16. deleteStage pilot A: stage in NULL-global → NotFound', ok: threw, detail: threw ? 'NotFound' : 'UNEXPECTED' });
    } finally { await prisma.$disconnect(); }
  });

  // 17 — addAccessUser pilot A: tenant B parent → NotFound
  await withFlags(PILOT, async () => {
    const prisma = new PrismaService(); const ff = new FeatureFlagsService();
    const pilot = new PilotPrismaAccessor(prisma, new TenantPrismaService(prisma, ff), ff);
    const svc = makeService(prisma, pilot, ff);
    try {
      let threw = false;
      try {
        await withRequestContext({ requestId: newRequestId() }, async () => {
          attach(tA, 'a'); await svc.addAccessUser(wfB, 'irrelevant', 'actor');
        });
      } catch (err: any) { threw = /WORKFLOW\.NOT_FOUND|Workflow not found/i.test(msg(err)); }
      out.push({ name: '17. addAccessUser pilot A: tenant B parent → NotFound', ok: threw, detail: threw ? 'NotFound' : 'UNEXPECTED' });
    } finally { await prisma.$disconnect(); }
  });

  // 18 — concurrent ALS frames remain isolated for updateWorkflow
  await withFlags(PILOT, async () => {
    const prisma = new PrismaService(); const ff = new FeatureFlagsService();
    const pilot = new PilotPrismaAccessor(prisma, new TenantPrismaService(prisma, ff), ff);
    const svc = makeService(prisma, pilot, ff);
    try {
      let aBlocked = false, bBlocked = false;
      await Promise.all([
        (async () => {
          try {
            await withRequestContext({ requestId: newRequestId() }, async () => {
              attach(tA, 'a'); await svc.updateWorkflow(wfB, { description: 'cross-A→B' } as any, 'actor');
            });
          } catch (err: any) { aBlocked = /WORKFLOW\.NOT_FOUND/i.test(msg(err)); }
        })(),
        (async () => {
          try {
            await withRequestContext({ requestId: newRequestId() }, async () => {
              attach(tB, 'b'); await svc.updateWorkflow(wfA, { description: 'cross-B→A' } as any, 'actor');
            });
          } catch (err: any) { bBlocked = /WORKFLOW\.NOT_FOUND/i.test(msg(err)); }
        })(),
      ]);
      out.push({ name: '18. concurrent ALS frames remain isolated for updateWorkflow',
        ok: aBlocked && bBlocked, detail: `A.blocked=${aBlocked} B.blocked=${bBlocked}` });
    } finally { await prisma.$disconnect(); }
  });

  // 19 — source-level meta-assertions
  const svcSrc = await fs.readFile(SVC_SRC, 'utf8');
  const stripped = svcSrc.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
  const hasReadWhere     = /private\s+workflowReadWhere\s*\(/.test(stripped);
  const hasMutWhere      = /private\s+workflowMutateWhere\s*\(/.test(stripped);
  const hasMutOrFail     = /private\s+async\s+findMutableWorkflowOrFail\s*\(/.test(stripped);
  // updateWorkflow / archiveWorkflow / deleteWorkflow / addStage / reorderStages
  // / addAccessUser / removeAccessUser must each call findMutableWorkflowOrFail.
  const gatedMethods = ['updateWorkflow', 'archiveWorkflow', 'deleteWorkflow',
    'addStage', 'reorderStages', 'addAccessUser', 'removeAccessUser'];
  const gatedOk = gatedMethods.every((m) => {
    const re = new RegExp(`async\\s+${m}\\s*\\([^)]*\\)\\s*\\{[\\s\\S]{0,400}?findMutableWorkflowOrFail`);
    return re.test(stripped);
  });
  // createWorkflow.create() must spread tenantData()
  const createBlock = stripped.match(/this\.prisma\.workflow\.create\([\s\S]+?\}\)/);
  const createStamped = !!(createBlock && /tenantData\(\)/.test(createBlock[0]));
  const ok19 = hasReadWhere && hasMutWhere && hasMutOrFail && gatedOk && createStamped;
  out.push({ name: '19. source-level: helpers defined + wired into update/archive/delete/stage routes + createWorkflow stamps tenantData()',
    ok: ok19,
    detail: `readWhere=${hasReadWhere} mutWhere=${hasMutWhere} mutOrFail=${hasMutOrFail} gated=${gatedOk} createStamped=${createStamped}` });

  await fs.mkdir(OUT_DIR, { recursive: true });
  const passed = out.filter((c) => c.ok).length;
  const total = out.length;
  await fs.writeFile(path.join(OUT_DIR, 'workflow-config-isolation.json'),
    JSON.stringify({ passed, total, cases: out }, null, 2));
  const md = [
    `# Phase 2.63 — workflow config tenant-scope isolation`, ``,
    `**${passed}/${total} PASS**`, ``,
    ...out.map((c) => `- ${c.ok ? 'PASS' : 'FAIL'} — ${c.name} — ${c.detail}`), ``,
  ].join('\n');
  await fs.writeFile(path.join(OUT_DIR, 'workflow-config-isolation.md'), md);
  console.log(`[workflow-config-isolation] ${passed}/${total} PASS`);
  process.exit(passed === total ? 0 : 1);
}

main().catch((err) => { console.error(err); process.exit(2); });
