/**
 * Phase 2.38 — compliance audit-routing + scheduler-safe entrypoint harness.
 *
 *   1. tenant A updateAlert on tenant A row succeeds
 *   2. tenant A updateAlert on tenant B row rejected
 *   3. rejected tenant B update does not mutate row
 *   4. tenant A audit row created for tenant A update (tenantId=A under audit pilot)
 *   5. no audit row leaks to tenant B for the tenant A action
 *   6. legacy mode (pilot off): audit row written NULL-tenant; behaviour preserved
 *   7. generateAlertsForTenant(A) runs inside an A ALS frame (creates A-only alerts)
 *   8. generateAlertsForTenant(A) does not create B or NULL-tenant alerts
 *   9. concurrent scheduler-safe frames isolated (A and B in parallel)
 *
 * Output: backend/reports/saas/phase2/compliance-audit-and-scheduler.{json,md}
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
import { TenantContext, withRequestContext, newRequestId } from '../../../src/saas/context/als';

autoLoadEnv(__filename);

const OUT_DIR = path.resolve(__dirname, '..', '..', '..', 'reports', 'saas', 'phase2');
interface CaseResult { name: string; ok: boolean; detail: string; }

const SYS_USER = '00000000-0000-0000-0000-00000000us01';
const TENANT_A_ALERT = '00000000-0000-0000-0000-00000000c001';
const TENANT_B_ALERT = '00000000-0000-0000-0000-00000000c101';

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

function makeService(prisma: PrismaService, pilot: PilotPrismaAccessor, flags: FeatureFlagsService): ComplianceService {
  return new ComplianceService(prisma, pilot, new TenantAuditLogService(prisma, flags), flags);
}

async function fetchAuditRow(prisma: PrismaService, entityId: string): Promise<{ tenantId: string | null } | null> {
  const r: any = await (prisma as any).auditLog.findFirst({
    where: { entity: 'ComplianceAlert', entityId, action: 'UPDATE_ALERT' },
    orderBy: { createdAt: 'desc' },
  });
  return r ? { tenantId: r.tenantId ?? null } : null;
}

async function deleteAuditRows(prisma: PrismaService, entityIds: string[]): Promise<void> {
  if (!entityIds.length) return;
  await (prisma as any).auditLog.deleteMany({
    where: { entity: 'ComplianceAlert', entityId: { in: entityIds }, action: 'UPDATE_ALERT' },
  });
}

async function main(): Promise<void> {
  const url = getDatabaseUrl();
  const env = classifyRuntimeEnv();
  if (!isStagingClassification(env.classification)) {
    console.error(`[compliance-audit-and-scheduler] refusing on classification=${env.classification}`);
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

  // Pre-clean any prior audit rows for these alert ids.
  {
    const prisma = new PrismaService();
    try { await deleteAuditRows(prisma, [TENANT_A_ALERT, TENANT_B_ALERT]); } finally { await prisma.$disconnect(); }
  }

  // 1+2+3+4+5 — pilot mode + audit pilot on
  await withFlags({ TENANT_PRISMA_PILOT_ENABLED: 'true', TENANT_PRISMA_PILOT_MODULES: 'compliance', TENANT_AUDIT_LOG_PILOT_ENABLED: 'true' }, async () => {
    const prisma = new PrismaService();
    const flags = new FeatureFlagsService();
    const pilot = new PilotPrismaAccessor(prisma, new TenantPrismaService(prisma, flags), flags);
    const svc = makeService(prisma, pilot, flags);
    try {
      const beforeB: any = await (prisma as any).complianceAlert.findUnique({ where: { id: TENANT_B_ALERT } });

      // 1 — same-tenant succeeds
      const u1: any = await withRequestContext({ requestId: newRequestId() }, async () => {
        TenantContext.attach({ id: tA, slug: 'a', name: 'A', status: 'ACTIVE', region: 'eu' });
        return svc.updateAlert(TENANT_A_ALERT, { status: 'ACKNOWLEDGED' as any, notes: 'same-tenant' } as any, SYS_USER);
      });
      out.push({ name: '1. tenant A updateAlert(A-row): succeeds', ok: u1?.id === TENANT_A_ALERT && u1.status === 'ACKNOWLEDGED', detail: `status=${u1?.status}` });

      // 2 — cross-tenant rejected
      let threw = false;
      try {
        await withRequestContext({ requestId: newRequestId() }, async () => {
          TenantContext.attach({ id: tA, slug: 'a', name: 'A', status: 'ACTIVE', region: 'eu' });
          await svc.updateAlert(TENANT_B_ALERT, { status: 'RESOLVED' as any } as any, SYS_USER);
        });
      } catch { threw = true; }
      out.push({ name: '2. tenant A updateAlert(B-row): rejected', ok: threw, detail: threw ? 'NotFound' : 'UNEXPECTED' });

      // 3 — B row unchanged
      const afterB: any = await (prisma as any).complianceAlert.findUnique({ where: { id: TENANT_B_ALERT } });
      out.push({ name: '3. rejected B update does not mutate row', ok: afterB.status === beforeB.status, detail: `status=${afterB.status}` });

      // 4 — audit row tenantId = A
      const aRow = await fetchAuditRow(prisma, TENANT_A_ALERT);
      out.push({ name: '4. audit row created for A with tenantId=A', ok: aRow?.tenantId === tA, detail: `tenantId=${aRow?.tenantId}` });

      // 5 — no audit row for B
      const bRow = await fetchAuditRow(prisma, TENANT_B_ALERT);
      out.push({ name: '5. no audit row leaked to B (rejected before audit emit)', ok: bRow === null, detail: bRow ? `tenantId=${bRow.tenantId}` : 'none' });
    } finally { await prisma.$disconnect(); }
  });

  // 6 — legacy mode: audit row NULL-tenant
  await withFlags({ TENANT_PRISMA_PILOT_ENABLED: 'false', TENANT_AUDIT_LOG_PILOT_ENABLED: 'false' }, async () => {
    const prisma = new PrismaService();
    const flags = new FeatureFlagsService();
    const pilot = new PilotPrismaAccessor(prisma, new TenantPrismaService(prisma, flags), flags);
    const svc = makeService(prisma, pilot, flags);
    try {
      // Clear prior audit rows for clean check.
      await deleteAuditRows(prisma, [TENANT_A_ALERT]);
      const r: any = await svc.updateAlert(TENANT_A_ALERT, { status: 'OPEN' as any, notes: 'legacy' } as any, SYS_USER);
      const aRow = await fetchAuditRow(prisma, TENANT_A_ALERT);
      out.push({ name: '6. legacy mode: audit row NULL-tenant + behaviour preserved', ok: r?.id === TENANT_A_ALERT && aRow?.tenantId === null, detail: `tenantId=${aRow?.tenantId}` });
    } finally { await prisma.$disconnect(); }
  });

  // 7+8 — scheduler-safe entrypoint for tenant A
  let createdAIds: string[] = [];
  await withFlags({ TENANT_PRISMA_PILOT_ENABLED: 'true', TENANT_PRISMA_PILOT_MODULES: 'compliance' }, async () => {
    const prisma = new PrismaService();
    const flags = new FeatureFlagsService();
    const pilot = new PilotPrismaAccessor(prisma, new TenantPrismaService(prisma, flags), flags);
    const svc = makeService(prisma, pilot, flags);
    try {
      // Snapshot existing alert ids to identify what scheduler creates.
      const beforeA: any[] = await (prisma as any).complianceAlert.findMany({ where: { tenantId: tA }, select: { id: true } });
      const beforeAIds = new Set(beforeA.map((a) => a.id));
      const beforeBN: number = await (prisma as any).complianceAlert.count({ where: { OR: [{ tenantId: tB }, { tenantId: null }] } });

      const r = await svc.generateAlertsForTenant(tA);

      const afterA: any[] = await (prisma as any).complianceAlert.findMany({ where: { tenantId: tA }, select: { id: true } });
      const newA = afterA.filter((a) => !beforeAIds.has(a.id)).map((a) => a.id);
      createdAIds = newA;
      const afterBN: number = await (prisma as any).complianceAlert.count({ where: { OR: [{ tenantId: tB }, { tenantId: null }] } });

      out.push({ name: '7. generateAlertsForTenant(A) runs inside tenant A ALS frame', ok: typeof r.tenantId === 'string' && r.tenantId === tA, detail: `tenantId=${r.tenantId} created=${newA.length}` });
      out.push({ name: '8. scheduler does not create B/NULL-tenant alerts', ok: afterBN === beforeBN, detail: `beforeBN=${beforeBN} afterBN=${afterBN}` });
    } finally { await prisma.$disconnect(); }
  });

  // 9 — concurrent scheduler-safe frames
  await withFlags({ TENANT_PRISMA_PILOT_ENABLED: 'true', TENANT_PRISMA_PILOT_MODULES: 'compliance' }, async () => {
    const prisma = new PrismaService();
    const flags = new FeatureFlagsService();
    const pilot = new PilotPrismaAccessor(prisma, new TenantPrismaService(prisma, flags), flags);
    const svc = makeService(prisma, pilot, flags);
    try {
      const [a, b] = await Promise.all([
        svc.generateAlertsForTenant(tA),
        svc.generateAlertsForTenant(tB),
      ]);
      out.push({ name: '9. concurrent scheduler frames isolated (A→A, B→B)', ok: a.tenantId === tA && b.tenantId === tB, detail: `a=${a.tenantId} b=${b.tenantId}` });
    } finally { await prisma.$disconnect(); }
  });

  // cleanup: any alerts created by the scheduler runs
  if (createdAIds.length) {
    const prisma = new PrismaService();
    try { await (prisma as any).complianceAlert.deleteMany({ where: { id: { in: createdAIds } } }); } finally { await prisma.$disconnect(); }
  }
  // cleanup any audit rows our test produced
  {
    const prisma = new PrismaService();
    try { await deleteAuditRows(prisma, [TENANT_A_ALERT, TENANT_B_ALERT]); } finally { await prisma.$disconnect(); }
  }

  await fs.mkdir(OUT_DIR, { recursive: true });
  const passed = out.filter((c) => c.ok).length;
  const total = out.length;
  await fs.writeFile(path.join(OUT_DIR, 'compliance-audit-and-scheduler.json'),
    JSON.stringify({ passed, total, cases: out }, null, 2));
  const md = [
    `# Phase 2.38 — compliance audit-routing + scheduler-safe entrypoint`, ``,
    `**${passed}/${total} PASS**`, ``,
    ...out.map((c) => `- ${c.ok ? 'PASS' : 'FAIL'} — ${c.name} — ${c.detail}`), ``,
  ].join('\n');
  await fs.writeFile(path.join(OUT_DIR, 'compliance-audit-and-scheduler.md'), md);
  console.log(`[compliance-audit-and-scheduler] ${passed}/${total} PASS`);
  process.exit(passed === total ? 0 : 1);
}

main().catch((err) => { console.error(err); process.exit(2); });
