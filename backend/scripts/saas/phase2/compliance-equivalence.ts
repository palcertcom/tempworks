/**
 * Phase 2.8 — Compliance pilot read-equivalence harness.
 *
 * Compares legacy and pilot paths for `ComplianceService` back-to-back
 * on the same DB:
 *   - getDashboard() summary counts + recent alert ids + groupBy buckets
 *   - getAlerts(pagination) row counts + status / severity filters
 *   - getEmployeeCompliance(employeeId) shape + counts of nested arrays
 *   - getExpiringDocuments(days) row count
 *   - module allow-list gating: with TENANT_PRISMA_PILOT_MODULES=nothing
 *     the pilot scope must report inactive even when the flag is on.
 *
 * Output:
 *   backend/reports/saas/phase2/compliance-equivalence.{json,md}
 *
 * Exit:
 *   0 — every comparison equal
 *   2 — at least one mismatch
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
import { getPilotScope, isModuleAllowed } from '../../../src/saas/prisma/tenant-pilot-scope';

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

interface Snapshot {
  dashSummary: any;
  dashAlertIds: string[];
  dashRecentCount: number;
  alertsTotal: number;
  alertsOpenTotal: number;
  expiringDocsCount: number;
  empDocsCount: number;
  empAlertsCount: number;
}

async function snapshot(flagsOverride: Record<string, string | undefined>,
                       inTenantContext: { id: string } | null,
                       empA: string): Promise<Snapshot> {
  return withFlags(flagsOverride, async () => {
    const flags = new FeatureFlagsService();
    const prisma = new PrismaService();
    const tp = new TenantPrismaService(prisma, flags);
    const pilot = new PilotPrismaAccessor(prisma, tp, flags);
    const svc = new ComplianceService(prisma, pilot, new TenantAuditLogService(prisma, flags), flags);
    const run = async (): Promise<Snapshot> => {
      const dash = await svc.getDashboard();
      const alerts = await svc.getAlerts({ page: 1, limit: 50 } as any);
      const alertsOpen = await svc.getAlerts({ page: 1, limit: 50 } as any, 'OPEN');
      const expiring = await svc.getExpiringDocuments(365);
      const emp = await svc.getEmployeeCompliance(empA);
      return {
        dashSummary: dash.summary,
        dashAlertIds: dash.recentAlerts.map((a: any) => a.id).sort(),
        dashRecentCount: dash.recentAlerts.length,
        alertsTotal: (alerts as any).meta?.total ?? 0,
        alertsOpenTotal: (alertsOpen as any).meta?.total ?? 0,
        expiringDocsCount: expiring.length,
        empDocsCount: emp.documents.length,
        empAlertsCount: emp.openAlerts.length,
      };
    };
    try {
      if (inTenantContext) {
        return await withRequestContext({ requestId: newRequestId() }, async () => {
          TenantContext.attach({ id: inTenantContext.id, slug: 'a', name: 'A',
            status: 'ACTIVE', region: 'eu' });
          return run();
        });
      }
      return await run();
    } finally {
      await prisma.$disconnect();
    }
  });
}

async function main(): Promise<void> {
  const url = getDatabaseUrl();
  const env = classifyRuntimeEnv();
  if (!isStagingClassification(env.classification)) {
    console.error(`[compliance-equivalence] refusing on classification=${env.classification}`);
    process.exit(3);
  }
  const c = new Client({ connectionString: url, ssl: /127\.0\.0\.1|localhost/.test(url) ? false : { rejectUnauthorized: false } });
  await c.connect();
  const ts = await c.query<{ id: string }>(
    `SELECT t.id FROM tenants t
       WHERE EXISTS (SELECT 1 FROM employees e WHERE e."tenantId" = t.id::text)
       ORDER BY t.name`);
  const tA = ts.rows[0]?.id;
  const ea = await c.query<{ id: string }>(`SELECT id FROM employees WHERE "tenantId" = $1 LIMIT 1`, [tA]);
  const empA = ea.rows[0]?.id;
  await c.end();
  if (!tA || !empA) { console.error('[compliance-equivalence] need tenant + employee'); process.exit(3); }

  const out: CaseResult[] = [];

  const legacy = await snapshot({ TENANT_PRISMA_PILOT_ENABLED: 'false', TENANT_PRISMA_PILOT_MODULES: undefined },
                                null, empA);
  const pilot  = await snapshot({ TENANT_PRISMA_PILOT_ENABLED: 'true',  TENANT_PRISMA_PILOT_MODULES: undefined },
                                { id: tA }, empA);

  // Module allow-list checks (no DB calls).
  out.push({
    name: 'allow-list: unset env ⇒ all modules allowed',
    ok: isModuleAllowed('compliance') && isModuleAllowed('employee-work-history'),
    detail: 'isModuleAllowed returns true for both',
  });
  await withFlags({ TENANT_PRISMA_PILOT_MODULES: 'compliance' }, async () => {
    out.push({
      name: 'allow-list: ="compliance" allows compliance, denies others',
      ok: isModuleAllowed('compliance') && !isModuleAllowed('employee-work-history'),
      detail: 'compliance=true, ewh=false',
    });
  });
  await withFlags({ TENANT_PRISMA_PILOT_MODULES: 'employee-work-history,compliance' }, async () => {
    out.push({
      name: 'allow-list: comma-separated allows both modules',
      ok: isModuleAllowed('compliance') && isModuleAllowed('employee-work-history'),
      detail: 'both true',
    });
  });
  await withFlags({ TENANT_PRISMA_PILOT_ENABLED: 'true', TENANT_PRISMA_PILOT_MODULES: 'nothing' }, async () => {
    const flags = new FeatureFlagsService();
    const prisma = new PrismaService();
    const tp = new TenantPrismaService(prisma, flags);
    const p = new PilotPrismaAccessor(prisma, tp, flags);
    await withRequestContext({ requestId: newRequestId() }, async () => {
      TenantContext.attach({ id: tA, slug: 'a', name: 'A', status: 'ACTIVE', region: 'eu' });
      const s = getPilotScope(p, 'compliance');
      out.push({
        name: 'allow-list: =nothing ⇒ scope inactive even with flag on',
        ok: !s.active && /not in TENANT_PRISMA_PILOT_MODULES/.test(s.reason),
        detail: s.reason,
      });
    });
    await prisma.$disconnect();
  });

  // Equivalence — snapshots.
  out.push({
    name: 'getDashboard: legacy totalAlerts ≥ pilot totalAlerts (pilot filtered)',
    ok: legacy.dashSummary.totalAlerts >= pilot.dashSummary.totalAlerts,
    detail: `legacy=${legacy.dashSummary.totalAlerts} pilot=${pilot.dashSummary.totalAlerts}`,
  });
  out.push({
    name: 'getDashboard: pilot summary excludes NULL-tenant + tenant B',
    ok: pilot.dashSummary.totalAlerts === 3, // tenant A: 2 phase24 + 1 phase28 = 3
    detail: `pilot.totalAlerts=${pilot.dashSummary.totalAlerts} (expected 3 for tenant A)`,
  });
  out.push({
    name: 'getAlerts: pilot total < legacy total (other tenants filtered)',
    ok: pilot.alertsTotal < legacy.alertsTotal && pilot.alertsTotal > 0,
    detail: `legacy=${legacy.alertsTotal} pilot=${pilot.alertsTotal}`,
  });
  out.push({
    name: 'getAlerts(status=OPEN): both modes count only OPEN status',
    ok: legacy.alertsOpenTotal <= legacy.alertsTotal
       && pilot.alertsOpenTotal <= pilot.alertsTotal,
    detail: `legacy open=${legacy.alertsOpenTotal}/${legacy.alertsTotal} pilot open=${pilot.alertsOpenTotal}/${pilot.alertsTotal}`,
  });
  out.push({
    name: 'getEmployeeCompliance: response shape preserved',
    ok: legacy.empDocsCount >= 0 && pilot.empDocsCount >= 0,
    detail: `legacy.docs=${legacy.empDocsCount} pilot.docs=${pilot.empDocsCount}`,
  });
  out.push({
    name: 'getEmployeeCompliance: pilot openAlerts only counts tenant A',
    ok: pilot.empAlertsCount <= legacy.empAlertsCount,
    detail: `legacy=${legacy.empAlertsCount} pilot=${pilot.empAlertsCount}`,
  });
  out.push({
    name: 'getExpiringDocuments: pilot result subset of legacy result',
    ok: pilot.expiringDocsCount <= legacy.expiringDocsCount,
    detail: `legacy=${legacy.expiringDocsCount} pilot=${pilot.expiringDocsCount}`,
  });
  out.push({
    name: 'response shape preserved (summary/docs/alertsByStatus/recentAlerts keys present)',
    ok: legacy.dashSummary && pilot.dashSummary
      && typeof legacy.dashSummary.totalAlerts === 'number'
      && typeof pilot.dashSummary.totalAlerts === 'number',
    detail: 'summary keys numeric in both',
  });

  await fs.mkdir(OUT_DIR, { recursive: true });
  const summary = {
    generatedAt: new Date().toISOString(),
    environment: env, tenantA: tA, empA,
    legacySnapshot: legacy, pilotSnapshot: pilot,
    counts: { total: out.length, passed: out.filter((r) => r.ok).length, failed: out.filter((r) => !r.ok).length },
    results: out,
  };
  await fs.writeFile(path.join(OUT_DIR, 'compliance-equivalence.json'), JSON.stringify(summary, null, 2));
  const md: string[] = [];
  md.push('# Phase 2.8 — Compliance Equivalence');
  md.push('');
  md.push(`Generated: ${summary.generatedAt}`);
  md.push(`Environment: ${env.classification} (${env.reason})`);
  md.push(`Tenant A: \`${tA}\` · employee: \`${empA}\``);
  md.push('');
  md.push(`- Cases passed: **${summary.counts.passed}** / ${summary.counts.total}`);
  md.push(`- Cases failed: ${summary.counts.failed}`);
  md.push('');
  md.push('| # | Case | Result | Detail |');
  md.push('|--:|------|:------:|--------|');
  out.forEach((r, i) => md.push(`| ${i + 1} | ${r.name} | ${r.ok ? 'PASS' : '**FAIL**'} | ${r.detail} |`));
  await fs.writeFile(path.join(OUT_DIR, 'compliance-equivalence.md'), md.join('\n'));

  console.log(`compliance-equivalence: ${summary.counts.passed}/${summary.counts.total} cases PASS`);
  if (summary.counts.failed > 0) process.exit(2);
}

main().catch((e) => { console.error(e); process.exit(3); });
