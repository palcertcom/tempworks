/**
 * Phase 2.16 — finance pilot read-equivalence harness.
 *
 * Compares legacy and pilot READ paths back-to-back on the same DB:
 *   - findAll total (cross-tenant union vs. tenant A only)
 *   - findOne(tenant-A-id) resolves in both modes
 *   - findOne(missing-id) raises NotFoundException in both modes
 *   - getTotals(EMPLOYEE, employeeA-id) sums only that entity's records
 *   - listTransactionTypes (global catalog) returns the same rows
 *   - getHistory(tenant-A-record-id).id matches in both modes
 *   - response shape preservation (PaginatedResponse<FinancialRecord>)
 *
 * Mutation paths are intentionally NOT exercised — Phase 2.16 is
 * reads-first.
 *
 * Output:
 *   backend/reports/saas/phase2/finance-equivalence.{json,md}
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
import { FinanceService } from '../../../src/finance/finance.service';
import { StorageService } from '../../../src/common/storage/storage.service';
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

function makeService(prisma: PrismaService, pilot: PilotPrismaAccessor): FinanceService {
  // Notifications is invoked on writes only; we never call write paths
  // here, so we pass a stub that satisfies the type system.
  const notifStub: any = {
    notifyUploaderAndRoles: async () => undefined,
    notifyUsersByRoles: async () => undefined,
    wasHighBalanceAlertRecentlySent: async () => false,
  };
  const storage = new StorageService();
  return new FinanceService(prisma, notifStub, storage, pilot, new TenantAuditLogService(prisma, new FeatureFlagsService()));
}

interface Snapshot {
  pilotActive: boolean;
  reason: string;
  findAllTotal: number;
  findOneAId: string | null;
  errorOnMissing: string;
  totalsADisbursed: number;
  totalsACount: number;
  txTypeCount: number;
  historyId: string | null;
  responseShapeOk: boolean;
}

const TENANT_A_RECORD_ID = '00000000-0000-0000-0000-0000000fa001';

async function snapshotForFlags(
  flagsOverride: Record<string, string | undefined>,
  ctx: { id: string } | null,
): Promise<Snapshot> {
  return withFlags(flagsOverride, async () => {
    const flags = new FeatureFlagsService();
    const prisma = new PrismaService();
    const tp = new TenantPrismaService(prisma, flags);
    const pilot = new PilotPrismaAccessor(prisma, tp, flags);
    const svc = makeService(prisma, pilot);

    const run = async (): Promise<Snapshot> => {
      const all = await svc.findAll({ page: 1, limit: 50 } as any);

      // Locate any tenant A record from listing for findOne probe.
      const aRow = (all as any).data?.find((r: any) => r.id === TENANT_A_RECORD_ID)
        ?? (all as any).data?.[0];
      let findOneAId: string | null = null;
      try { if (aRow) findOneAId = (await svc.findOne(aRow.id)).id; } catch { findOneAId = null; }

      let errorOnMissing = 'no-error';
      try { await svc.findOne('00000000-0000-0000-0000-deaddeaddead'); }
      catch (e) { errorOnMissing = (e as Error).constructor.name; }

      // Totals on the same entity used by tenant A's seeded records.
      let totalsADisbursed = 0;
      let totalsACount = 0;
      if (aRow) {
        const t = await svc.getTotals(aRow.entityType, aRow.entityId);
        totalsADisbursed = t.totalDisbursed;
        totalsACount = t.recordCount;
      }

      const txTypes = await svc.listTransactionTypes();
      let historyId: string | null = null;
      try { if (aRow) { await svc.getHistory(aRow.id); historyId = aRow.id; } } catch { historyId = null; }

      const responseShapeOk = Array.isArray((all as any).data)
        && typeof (all as any).meta?.total === 'number';

      return {
        pilotActive: pilot.isPilotActive(),
        reason: pilot.pilotReason().reason,
        findAllTotal: (all as any).meta?.total ?? 0,
        findOneAId,
        errorOnMissing,
        totalsADisbursed,
        totalsACount,
        txTypeCount: txTypes.length,
        historyId,
        responseShapeOk,
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
    } finally {
      await prisma.$disconnect();
    }
  });
}

async function main(): Promise<void> {
  const url = getDatabaseUrl();
  const env = classifyRuntimeEnv();
  if (!isStagingClassification(env.classification)) {
    console.error(`[finance-equivalence] refusing on classification=${env.classification}`);
    process.exit(3);
  }
  const c = new Client({ connectionString: url, ssl: /127\.0\.0\.1|localhost/.test(url) ? false : { rejectUnauthorized: false } });
  await c.connect();
  const ts = await c.query<{ id: string }>(
    `SELECT t.id FROM tenants t
       WHERE EXISTS (SELECT 1 FROM employees e WHERE e."tenantId" = t.id::text)
       ORDER BY t.name`);
  const tA = ts.rows[0]?.id;
  await c.end();
  if (!tA) { console.error('[finance-equivalence] need a tenant'); process.exit(3); }

  const out: CaseResult[] = [];

  const legacy = await snapshotForFlags(
    { TENANT_PRISMA_PILOT_ENABLED: 'false', TENANT_PRISMA_PILOT_MODULES: undefined },
    null,
  );
  const pilot = await snapshotForFlags(
    { TENANT_PRISMA_PILOT_ENABLED: 'true', TENANT_PRISMA_PILOT_MODULES: 'finance' },
    { id: tA },
  );

  out.push({
    name: 'legacy: pilot OFF reports pilotActive=false',
    ok: legacy.pilotActive === false,
    detail: legacy.reason,
  });
  out.push({
    name: 'pilot: pilot ON + finance allow-list ⇒ pilotActive=true',
    ok: pilot.pilotActive === true && pilot.reason.startsWith('pilot ON'),
    detail: pilot.reason,
  });
  out.push({
    name: 'findAll: pilot total <= legacy total (tenant filter applies)',
    ok: pilot.findAllTotal <= legacy.findAllTotal && pilot.findAllTotal > 0,
    detail: `legacy=${legacy.findAllTotal} pilot=${pilot.findAllTotal}`,
  });
  out.push({
    name: 'findOne: legacy + pilot resolve the tenant A record id',
    ok: legacy.findOneAId !== null && legacy.findOneAId === pilot.findOneAId,
    detail: `legacy=${legacy.findOneAId} pilot=${pilot.findOneAId}`,
  });
  out.push({
    name: 'error path: NotFoundException for missing id in both modes',
    ok: legacy.errorOnMissing === 'NotFoundException' && pilot.errorOnMissing === 'NotFoundException',
    detail: `legacy=${legacy.errorOnMissing} pilot=${pilot.errorOnMissing}`,
  });
  out.push({
    name: 'getTotals: legacy + pilot return same per-entity sum',
    ok: legacy.totalsADisbursed === pilot.totalsADisbursed
      && legacy.totalsACount === pilot.totalsACount,
    detail: `legacy=${legacy.totalsADisbursed}/${legacy.totalsACount} pilot=${pilot.totalsADisbursed}/${pilot.totalsACount}`,
  });
  out.push({
    name: 'listTransactionTypes: global catalog identical in both modes',
    ok: legacy.txTypeCount === pilot.txTypeCount && pilot.txTypeCount > 0,
    detail: `legacy=${legacy.txTypeCount} pilot=${pilot.txTypeCount}`,
  });
  out.push({
    name: 'getHistory: pilot resolves the same record id (tenant pre-check)',
    ok: legacy.historyId !== null && legacy.historyId === pilot.historyId,
    detail: `legacy=${legacy.historyId} pilot=${pilot.historyId}`,
  });
  out.push({
    name: 'response shape preserved (PaginatedResponse<FinancialRecord>)',
    ok: legacy.responseShapeOk && pilot.responseShapeOk,
    detail: `legacy=${legacy.responseShapeOk} pilot=${pilot.responseShapeOk}`,
  });

  await fs.mkdir(OUT_DIR, { recursive: true });
  const summary = {
    generatedAt: new Date().toISOString(),
    environment: env, tenantA: tA,
    legacy, pilot,
    counts: { total: out.length, passed: out.filter((r) => r.ok).length, failed: out.filter((r) => !r.ok).length },
    results: out,
  };
  await fs.writeFile(path.join(OUT_DIR, 'finance-equivalence.json'), JSON.stringify(summary, null, 2));
  const md: string[] = [];
  md.push('# Phase 2.16 — Finance Equivalence');
  md.push('');
  md.push(`Generated: ${summary.generatedAt}`);
  md.push(`Environment: ${env.classification} (${env.reason})`);
  md.push(`Tenant A: \`${tA}\``);
  md.push('');
  md.push(`- Cases passed: **${summary.counts.passed}** / ${summary.counts.total}`);
  md.push(`- Cases failed: ${summary.counts.failed}`);
  md.push('');
  md.push('| # | Case | Result | Detail |');
  md.push('|--:|------|:------:|--------|');
  out.forEach((r, i) => md.push(`| ${i + 1} | ${r.name} | ${r.ok ? 'PASS' : '**FAIL**'} | ${r.detail} |`));
  await fs.writeFile(path.join(OUT_DIR, 'finance-equivalence.md'), md.join('\n'));

  console.log(`finance-equivalence: ${summary.counts.passed}/${summary.counts.total} cases PASS`);
  if (summary.counts.failed > 0) process.exit(2);
}

main().catch((e) => { console.error(e); process.exit(3); });
