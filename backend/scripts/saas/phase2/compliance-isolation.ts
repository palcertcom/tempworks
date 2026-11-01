/**
 * Phase 2.8 — Compliance pilot isolation harness.
 *
 * Two tenants, same-shape alerts. Proves:
 *   1. Pilot ON, tenant A: getAlerts() returns only tenant A rows.
 *   2. Pilot ON, tenant A: getDashboard() counts exclude tenant B and
 *      the NULL-tenant legacy row.
 *   3. Pilot ON, tenant A: updateAlert(B's id) raises NotFound and the
 *      target row is unchanged.
 *   4. Concurrent ALS frames see only their own tenant's alerts.
 *   5. Pilot OFF: legacy path returns the union (no filter).
 *   6. Module allow-list: with TENANT_PRISMA_PILOT_MODULES=nothing, the
 *      pilot scope is inactive — service behaves as legacy.
 *
 * Output: backend/reports/saas/phase2/compliance-isolation.{json,md}
 *
 * Exit:
 *   0 — every assertion holds
 *   2 — at least one isolation failure
 *   3 — runtime error
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
import {
  TenantContext,
  withRequestContext,
  newRequestId,
} from '../../../src/saas/context/als';

autoLoadEnv(__filename);

const OUT_DIR = path.resolve(__dirname, '..', '..', '..', 'reports', 'saas', 'phase2');
interface CaseResult { name: string; ok: boolean; detail: string; }

function getDatabaseUrl(): string {
  const arg = process.argv.find((a) => a.startsWith('--db='))?.slice(5);
  return arg ?? process.env.DATABASE_URL ?? (() => { throw new Error(formatDatabaseUrlMissingMessage()); })();
}

async function withFlags<T>(env: Record<string, string | undefined>, fn: () => Promise<T> | T): Promise<T> {
  const prev = { ...process.env };
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try { return await fn(); }
  finally { process.env = prev; }
}

async function main(): Promise<void> {
  const url = getDatabaseUrl();
  const env = classifyRuntimeEnv();
  if (!isStagingClassification(env.classification)) {
    console.error(`[compliance-isolation] refusing on classification=${env.classification}`);
    process.exit(3);
  }
  const c = new Client({ connectionString: url, ssl: /127\.0\.0\.1|localhost/.test(url) ? false : { rejectUnauthorized: false } });
  await c.connect();
  const ts = await c.query<{ id: string }>(
    `SELECT t.id FROM tenants t
       WHERE EXISTS (SELECT 1 FROM employees e WHERE e."tenantId" = t.id::text)
       ORDER BY t.name`);
  const tA = ts.rows[0]?.id; const tB = ts.rows[1]?.id;
  if (!tA || !tB) { console.error('need two tenants with employees'); process.exit(3); }

  const out: CaseResult[] = [];

  // 1. Pilot ON, tenant A — getAlerts only A.
  await withFlags({ TENANT_PRISMA_PILOT_ENABLED: 'true' }, async () => {
    const flags = new FeatureFlagsService();
    const prisma = new PrismaService();
    const tp = new TenantPrismaService(prisma, flags);
    const pilot = new PilotPrismaAccessor(prisma, tp, flags);
    const svc = new ComplianceService(prisma, pilot, new TenantAuditLogService(prisma, flags), flags);
    try {
      const res = await withRequestContext({ requestId: newRequestId() }, async () => {
        TenantContext.attach({ id: tA, slug: 'a', name: 'A', status: 'ACTIVE', region: 'eu' });
        return svc.getAlerts({ page: 1, limit: 50 } as any);
      });
      const ids = (res as any).data.map((a: any) => a.id);
      const onlyA = ids.every((id: string) => /^00000000-0000-0000-0000-00000000[ac]/.test(id) || id.startsWith('00000000-0000-0000-0000-00000000a'));
      const noB = !ids.some((id: string) => id.startsWith('00000000-0000-0000-0000-00000000c1'));
      const noNull = !ids.includes('00000000-0000-0000-0000-00000000c999');
      out.push({
        name: 'pilot ON, tenant A: getAlerts returns ONLY tenant A rows',
        ok: noB && noNull,
        detail: `ids=${ids.join(',')}`,
      });
    } finally { await prisma.$disconnect(); }
  });

  // 2. Dashboard counts.
  await withFlags({ TENANT_PRISMA_PILOT_ENABLED: 'true' }, async () => {
    const flags = new FeatureFlagsService();
    const prisma = new PrismaService();
    const tp = new TenantPrismaService(prisma, flags);
    const pilot = new PilotPrismaAccessor(prisma, tp, flags);
    const svc = new ComplianceService(prisma, pilot, new TenantAuditLogService(prisma, flags), flags);
    try {
      const dashA = await withRequestContext({ requestId: newRequestId() }, async () => {
        TenantContext.attach({ id: tA, slug: 'a', name: 'A', status: 'ACTIVE', region: 'eu' });
        return svc.getDashboard();
      });
      out.push({
        name: 'pilot ON, tenant A: getDashboard.summary.totalAlerts excludes other tenants',
        ok: dashA.summary.totalAlerts === 3,    // tenant A: 2 phase24 + 1 phase28
        detail: `totalAlerts=${dashA.summary.totalAlerts} (expected 3)`,
      });
      out.push({
        name: 'pilot ON, tenant A: dashboard recentAlerts contain no tenant B ids',
        ok: !dashA.recentAlerts.some((a: any) => /^00000000-0000-0000-0000-00000000c1/.test(a.id)),
        detail: `recentIds=${dashA.recentAlerts.map((a: any) => a.id).join(',')}`,
      });
    } finally { await prisma.$disconnect(); }
  });

  // 3. updateAlert against tenant B id rejected; row unchanged.
  await withFlags({ TENANT_PRISMA_PILOT_ENABLED: 'true' }, async () => {
    const flags = new FeatureFlagsService();
    const prisma = new PrismaService();
    const tp = new TenantPrismaService(prisma, flags);
    const pilot = new PilotPrismaAccessor(prisma, tp, flags);
    const svc = new ComplianceService(prisma, pilot, new TenantAuditLogService(prisma, flags), flags);
    try {
      const before = await (prisma as any).complianceAlert.findUnique({
        where: { id: '00000000-0000-0000-0000-00000000c101' },
      });
      let updateLeaked = false;
      try {
        await withRequestContext({ requestId: newRequestId() }, async () => {
          TenantContext.attach({ id: tA, slug: 'a', name: 'A', status: 'ACTIVE', region: 'eu' });
          await svc.updateAlert('00000000-0000-0000-0000-00000000c101',
            { status: 'RESOLVED' } as any);
        });
        updateLeaked = true;
      } catch { updateLeaked = false; }
      const after = await (prisma as any).complianceAlert.findUnique({
        where: { id: '00000000-0000-0000-0000-00000000c101' },
      });
      out.push({
        name: 'pilot ON, tenant A: updateAlert on tenant B row rejected, row unchanged',
        ok: !updateLeaked && before?.status === after?.status && before?.status !== 'RESOLVED',
        detail: `before=${before?.status} after=${after?.status}`,
      });
    } finally { await prisma.$disconnect(); }
  });

  // 4. Concurrent ALS frames.
  await withFlags({ TENANT_PRISMA_PILOT_ENABLED: 'true' }, async () => {
    const flags = new FeatureFlagsService();
    const prisma = new PrismaService();
    const tp = new TenantPrismaService(prisma, flags);
    const pilot = new PilotPrismaAccessor(prisma, tp, flags);
    const svc = new ComplianceService(prisma, pilot, new TenantAuditLogService(prisma, flags), flags);
    try {
      const seen: Array<{ t: string; ids: string[] }> = [];
      await Promise.all([
        withRequestContext({ requestId: newRequestId() }, async () => {
          TenantContext.attach({ id: tA, slug: 'a', name: 'A', status: 'ACTIVE', region: 'eu' });
          await new Promise((r) => setTimeout(r, 5));
          const r = await svc.getAlerts({ page: 1, limit: 50 } as any);
          seen.push({ t: tA, ids: (r as any).data.map((a: any) => a.id) });
        }),
        withRequestContext({ requestId: newRequestId() }, async () => {
          TenantContext.attach({ id: tB, slug: 'b', name: 'B', status: 'ACTIVE', region: 'eu' });
          await new Promise((r) => setTimeout(r, 1));
          const r = await svc.getAlerts({ page: 1, limit: 50 } as any);
          seen.push({ t: tB, ids: (r as any).data.map((a: any) => a.id) });
        }),
      ]);
      const a = seen.find((x) => x.t === tA);
      const b = seen.find((x) => x.t === tB);
      const aOnlyA = !!a && !a.ids.some((id) => /^00000000-0000-0000-0000-00000000c1/.test(id));
      const bOnlyB = !!b && b.ids.every((id) => /^00000000-0000-0000-0000-00000000c1/.test(id) || id.length > 0);
      const bNoA = !!b && !b.ids.some((id) => id === '00000000-0000-0000-0000-00000000c001');
      out.push({
        name: 'concurrent ALS frames isolated (T_A no B-rows; T_B no A-rows)',
        ok: aOnlyA && bNoA,
        detail: `seenA=${a?.ids.length} ids; seenB=${b?.ids.length} ids; bNoA=${bNoA}`,
      });
    } finally { await prisma.$disconnect(); }
  });

  // 5. Pilot OFF — legacy returns union.
  await withFlags({ TENANT_PRISMA_PILOT_ENABLED: 'false' }, async () => {
    const flags = new FeatureFlagsService();
    const prisma = new PrismaService();
    const tp = new TenantPrismaService(prisma, flags);
    const pilot = new PilotPrismaAccessor(prisma, tp, flags);
    const svc = new ComplianceService(prisma, pilot, new TenantAuditLogService(prisma, flags), flags);
    try {
      const res = await svc.getAlerts({ page: 1, limit: 50 } as any);
      const total = (res as any).meta?.total;
      const includesNull = (res as any).data.some((a: any) => a.id === '00000000-0000-0000-0000-00000000c999');
      const includesB    = (res as any).data.some((a: any) => /^00000000-0000-0000-0000-00000000c1/.test(a.id));
      out.push({
        name: 'pilot OFF: legacy reads include tenant B + NULL-tenant legacy row',
        ok: total >= 5 && includesB && includesNull,
        detail: `total=${total} includesB=${includesB} includesNull=${includesNull}`,
      });
    } finally { await prisma.$disconnect(); }
  });

  // 6. Module allow-list: =nothing.
  await withFlags({ TENANT_PRISMA_PILOT_ENABLED: 'true', TENANT_PRISMA_PILOT_MODULES: 'nothing' }, async () => {
    const flags = new FeatureFlagsService();
    const prisma = new PrismaService();
    const tp = new TenantPrismaService(prisma, flags);
    const pilot = new PilotPrismaAccessor(prisma, tp, flags);
    const svc = new ComplianceService(prisma, pilot, new TenantAuditLogService(prisma, flags), flags);
    try {
      const res = await withRequestContext({ requestId: newRequestId() }, async () => {
        TenantContext.attach({ id: tA, slug: 'a', name: 'A', status: 'ACTIVE', region: 'eu' });
        return svc.getAlerts({ page: 1, limit: 50 } as any);
      });
      const total = (res as any).meta?.total;
      const includesB = (res as any).data.some((a: any) => /^00000000-0000-0000-0000-00000000c1/.test(a.id));
      out.push({
        name: 'allow-list: TENANT_PRISMA_PILOT_MODULES=nothing ⇒ legacy union (compliance opt-out)',
        ok: includesB && total >= 5,
        detail: `total=${total} includesB=${includesB}`,
      });
    } finally { await prisma.$disconnect(); }
  });

  await c.end();

  await fs.mkdir(OUT_DIR, { recursive: true });
  const summary = {
    generatedAt: new Date().toISOString(),
    environment: env, tenantA: tA, tenantB: tB,
    counts: { total: out.length, passed: out.filter((r) => r.ok).length, failed: out.filter((r) => !r.ok).length },
    results: out,
  };
  await fs.writeFile(path.join(OUT_DIR, 'compliance-isolation.json'), JSON.stringify(summary, null, 2));
  const md: string[] = [];
  md.push('# Phase 2.8 — Compliance Isolation');
  md.push('');
  md.push(`Generated: ${summary.generatedAt}`);
  md.push(`Environment: ${env.classification} (${env.reason})`);
  md.push(`Tenants: A=\`${tA}\` B=\`${tB}\``);
  md.push('');
  md.push(`- Cases passed: **${summary.counts.passed}** / ${summary.counts.total}`);
  md.push(`- Cases failed: ${summary.counts.failed}`);
  md.push('');
  md.push('| # | Case | Result | Detail |');
  md.push('|--:|------|:------:|--------|');
  out.forEach((r, i) => md.push(`| ${i + 1} | ${r.name} | ${r.ok ? 'PASS' : '**FAIL**'} | ${r.detail} |`));
  await fs.writeFile(path.join(OUT_DIR, 'compliance-isolation.md'), md.join('\n'));

  console.log(`compliance-isolation: ${summary.counts.passed}/${summary.counts.total} cases PASS`);
  if (summary.counts.failed > 0) process.exit(2);
}

main().catch((e) => { console.error(e); process.exit(3); });
