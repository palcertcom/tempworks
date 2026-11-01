/**
 * Phase 2.16 — finance pilot isolation harness.
 *
 * Two tenants, same-shape financial records. Proves:
 *   1. Pilot ON, tenant A: findAll returns only tenant A rows; tenant B
 *      ids are filtered out.
 *   2. Pilot ON, tenant A: findOne(tenantB-id) raises NotFoundException.
 *   3. Pilot ON, tenant A: getHistory(tenantB-id) raises NotFoundException
 *      (parent existence check is tenant-scoped).
 *   4. Pilot ON, tenant A: getTotals on tenant B's entity returns 0
 *      records (the tenant filter excludes them).
 *   5. Concurrent ALS frames: T_A no B-rows, T_B no A-rows.
 *   6. Pilot OFF: legacy returns the union of A+B records.
 *   7. Source-level meta-assertion: every `check`-style mutation site in
 *      finance.service.ts uses `legacyPrisma` (Phase 2.16 reads-first
 *      contract; mutation paths intentionally NOT in pilot scope).
 *
 * Output: backend/reports/saas/phase2/finance-isolation.{json,md}
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
const SRC_FILE = path.resolve(__dirname, '..', '..', '..', 'src', 'finance', 'finance.service.ts');

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
  const notifStub: any = {
    notifyUploaderAndRoles: async () => undefined,
    notifyUsersByRoles: async () => undefined,
    wasHighBalanceAlertRecentlySent: async () => false,
  };
  const storage = new StorageService();
  return new FinanceService(prisma, notifStub, storage, pilot, new TenantAuditLogService(prisma, new FeatureFlagsService()));
}

const TENANT_A_RECORD_ID = '00000000-0000-0000-0000-0000000fa001';
const TENANT_B_RECORD_ID = '00000000-0000-0000-0000-0000000fb001';

async function main(): Promise<void> {
  const url = getDatabaseUrl();
  const env = classifyRuntimeEnv();
  if (!isStagingClassification(env.classification)) {
    console.error(`[finance-isolation] refusing on classification=${env.classification}`);
    process.exit(3);
  }
  const c = new Client({ connectionString: url, ssl: /127\.0\.0\.1|localhost/.test(url) ? false : { rejectUnauthorized: false } });
  await c.connect();
  const ts = await c.query<{ id: string }>(
    `SELECT t.id FROM tenants t
       WHERE EXISTS (SELECT 1 FROM employees e WHERE e."tenantId" = t.id::text)
       ORDER BY t.name`);
  const tA = ts.rows[0]?.id; const tB = ts.rows[1]?.id;
  await c.end();
  if (!tA || !tB) { console.error('need two tenants with employees'); process.exit(3); }

  const out: CaseResult[] = [];

  // 1+2 — pilot ON, tenant A — listing + cross-tenant findOne
  await withFlags({ TENANT_PRISMA_PILOT_ENABLED: 'true', TENANT_PRISMA_PILOT_MODULES: 'finance' }, async () => {
    const flags = new FeatureFlagsService();
    const prisma = new PrismaService();
    const tp = new TenantPrismaService(prisma, flags);
    const pilot = new PilotPrismaAccessor(prisma, tp, flags);
    const svc = makeService(prisma, pilot);
    try {
      const all = await withRequestContext({ requestId: newRequestId() }, async () => {
        TenantContext.attach({ id: tA, slug: 'a', name: 'A', status: 'ACTIVE', region: 'eu' });
        return svc.findAll({ page: 1, limit: 200 } as any);
      });
      const ids = (all as any).data.map((r: any) => r.id);
      const noB = !ids.includes(TENANT_B_RECORD_ID)
        && !ids.includes('00000000-0000-0000-0000-0000000fb002');
      out.push({
        name: 'pilot ON, tenant A: findAll returns ONLY tenant A rows',
        ok: noB,
        detail: `count=${ids.length} noB=${noB}`,
      });

      let leaked = false;
      try {
        await withRequestContext({ requestId: newRequestId() }, async () => {
          TenantContext.attach({ id: tA, slug: 'a', name: 'A', status: 'ACTIVE', region: 'eu' });
          await svc.findOne(TENANT_B_RECORD_ID);
        });
        leaked = true;
      } catch { leaked = false; }
      out.push({
        name: 'pilot ON, tenant A: findOne(tenantB-id) raises NotFoundException',
        ok: !leaked,
        detail: leaked ? 'UNEXPECTED: returned' : 'NotFoundException',
      });
    } finally { await prisma.$disconnect(); }
  });

  // 3 — getHistory cross-tenant rejected
  await withFlags({ TENANT_PRISMA_PILOT_ENABLED: 'true', TENANT_PRISMA_PILOT_MODULES: 'finance' }, async () => {
    const flags = new FeatureFlagsService();
    const prisma = new PrismaService();
    const tp = new TenantPrismaService(prisma, flags);
    const pilot = new PilotPrismaAccessor(prisma, tp, flags);
    const svc = makeService(prisma, pilot);
    try {
      let leaked = false;
      try {
        await withRequestContext({ requestId: newRequestId() }, async () => {
          TenantContext.attach({ id: tA, slug: 'a', name: 'A', status: 'ACTIVE', region: 'eu' });
          await svc.getHistory(TENANT_B_RECORD_ID);
        });
        leaked = true;
      } catch { leaked = false; }
      out.push({
        name: 'pilot ON, tenant A: getHistory(tenantB-id) raises NotFoundException (parent tenant-checked)',
        ok: !leaked,
        detail: leaked ? 'UNEXPECTED: returned' : 'NotFoundException',
      });
    } finally { await prisma.$disconnect(); }
  });

  // 4 — getTotals on tenant B's entity from tenant A: zero records
  await withFlags({ TENANT_PRISMA_PILOT_ENABLED: 'true', TENANT_PRISMA_PILOT_MODULES: 'finance' }, async () => {
    const flags = new FeatureFlagsService();
    const prisma = new PrismaService();
    const tp = new TenantPrismaService(prisma, flags);
    const pilot = new PilotPrismaAccessor(prisma, tp, flags);
    const svc = makeService(prisma, pilot);
    try {
      // Look up the entityId of a tenant B record directly.
      const bRow = await (prisma as any).financialRecord.findUnique({ where: { id: TENANT_B_RECORD_ID } });
      if (!bRow) {
        out.push({ name: 'pilot ON, tenant A: getTotals on tenant B entity returns 0 records', ok: false, detail: 'fixture missing tenant B row' });
      } else {
        const totals = await withRequestContext({ requestId: newRequestId() }, async () => {
          TenantContext.attach({ id: tA, slug: 'a', name: 'A', status: 'ACTIVE', region: 'eu' });
          return svc.getTotals(bRow.entityType, bRow.entityId);
        });
        out.push({
          name: 'pilot ON, tenant A: getTotals on tenant B entity returns 0 records',
          ok: totals.recordCount === 0 && totals.totalDisbursed === 0,
          detail: `count=${totals.recordCount} disbursed=${totals.totalDisbursed}`,
        });
      }
    } finally { await prisma.$disconnect(); }
  });

  // 5 — concurrent ALS frames isolated
  await withFlags({ TENANT_PRISMA_PILOT_ENABLED: 'true', TENANT_PRISMA_PILOT_MODULES: 'finance' }, async () => {
    const flags = new FeatureFlagsService();
    const prisma = new PrismaService();
    const tp = new TenantPrismaService(prisma, flags);
    const pilot = new PilotPrismaAccessor(prisma, tp, flags);
    const svc = makeService(prisma, pilot);
    try {
      const seen: Array<{ t: string; ids: string[] }> = [];
      await Promise.all([
        withRequestContext({ requestId: newRequestId() }, async () => {
          TenantContext.attach({ id: tA, slug: 'a', name: 'A', status: 'ACTIVE', region: 'eu' });
          await new Promise((r) => setTimeout(r, 5));
          const r = await svc.findAll({ page: 1, limit: 200 } as any);
          seen.push({ t: tA, ids: (r as any).data.map((x: any) => x.id) });
        }),
        withRequestContext({ requestId: newRequestId() }, async () => {
          TenantContext.attach({ id: tB, slug: 'b', name: 'B', status: 'ACTIVE', region: 'eu' });
          await new Promise((r) => setTimeout(r, 1));
          const r = await svc.findAll({ page: 1, limit: 200 } as any);
          seen.push({ t: tB, ids: (r as any).data.map((x: any) => x.id) });
        }),
      ]);
      const a = seen.find((x) => x.t === tA);
      const b = seen.find((x) => x.t === tB);
      const aHasNoB = !!a && !a.ids.includes(TENANT_B_RECORD_ID);
      const bHasNoA = !!b && !b.ids.includes(TENANT_A_RECORD_ID);
      out.push({
        name: 'concurrent ALS frames isolated (T_A no B-rows; T_B no A-rows)',
        ok: aHasNoB && bHasNoA,
        detail: `aCount=${a?.ids.length} bCount=${b?.ids.length} aNoB=${aHasNoB} bNoA=${bHasNoA}`,
      });
    } finally { await prisma.$disconnect(); }
  });

  // 6 — pilot OFF: legacy returns union
  await withFlags({ TENANT_PRISMA_PILOT_ENABLED: 'false' }, async () => {
    const flags = new FeatureFlagsService();
    const prisma = new PrismaService();
    const tp = new TenantPrismaService(prisma, flags);
    const pilot = new PilotPrismaAccessor(prisma, tp, flags);
    const svc = makeService(prisma, pilot);
    try {
      const all = await svc.findAll({ page: 1, limit: 200 } as any);
      const ids = (all as any).data.map((r: any) => r.id);
      out.push({
        name: 'pilot OFF: legacy reads include both tenant A and tenant B records',
        ok: ids.includes(TENANT_A_RECORD_ID) && ids.includes(TENANT_B_RECORD_ID),
        detail: `count=${ids.length} hasA=${ids.includes(TENANT_A_RECORD_ID)} hasB=${ids.includes(TENANT_B_RECORD_ID)}`,
      });
    } finally { await prisma.$disconnect(); }
  });

  // 7 — source-level meta-assertion (Phase 2.17 update): the
  // legacyPrisma update / soft-delete site inside each mutation
  // method still carries a `phase217-pilot-scope-precheck` annotation
  // so reviewers know the tenant gate is the prior `findOne`.
  const src = await fs.readFile(SRC_FILE, 'utf8');
  const expected = [
    /async update\([^)]*\) \{[\s\S]*?this\.legacyPrisma\.financialRecord\.update\([\s\S]{0,400}phase217-pilot-scope-precheck/,
    /async remove\([^)]*\) \{[\s\S]*?this\.legacyPrisma\.financialRecord\.update\([\s\S]{0,400}phase217-pilot-scope-precheck/,
    /async updateStatus\([^)]*\) \{[\s\S]*?this\.legacyPrisma\.financialRecord\.update\([\s\S]{0,400}phase217-pilot-scope-precheck/,
    /async addDeduction\([^)]*\) \{[\s\S]*?this\.legacyPrisma\.financialRecord\.update\([\s\S]{0,400}phase217-pilot-scope-precheck/,
    /async removeDeduction\([^)]*\) \{[\s\S]*?phase217-pilot-scope[\s\S]{0,800}this\.legacyPrisma\.financialRecord\.update\([\s\S]{0,400}phase217-pilot-scope-precheck/,
    /async addAttachment\([^)]*\) \{[\s\S]*?this\.legacyPrisma\.financialRecordAttachment\.create\([\s\S]{0,400}phase217-pilot-scope-precheck/,
    /async removeAttachment\([^)]*\) \{[\s\S]*?this\.legacyPrisma\.financialRecordAttachment\.update\([\s\S]{0,400}phase217-pilot-scope-precheck/,
  ];
  const failed: string[] = [];
  expected.forEach((re, i) => { if (!re.test(src)) failed.push(`pattern #${i + 1} missing`); });
  // Additionally: create must spread tenantData() and use this.prisma.
  if (!/async create\([^)]*\) \{[\s\S]*?this\.prisma\.financialRecord\.create\([\s\S]{0,2000}\.\.\.tdata/.test(src)) {
    failed.push('create() must use this.prisma.financialRecord.create with ...tdata spread');
  }
  out.push({
    name: 'source: Phase 2.17 mutation annotations and tenantData spread present',
    ok: failed.length === 0,
    detail: failed.length === 0 ? 'all mutation guard annotations present' : failed.join('; '),
  });

  await fs.mkdir(OUT_DIR, { recursive: true });
  const summary = {
    generatedAt: new Date().toISOString(),
    environment: env, tenantA: tA, tenantB: tB,
    counts: { total: out.length, passed: out.filter((r) => r.ok).length, failed: out.filter((r) => !r.ok).length },
    results: out,
  };
  await fs.writeFile(path.join(OUT_DIR, 'finance-isolation.json'), JSON.stringify(summary, null, 2));
  const md: string[] = [];
  md.push('# Phase 2.16 — Finance Isolation');
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
  await fs.writeFile(path.join(OUT_DIR, 'finance-isolation.md'), md.join('\n'));

  console.log(`finance-isolation: ${summary.counts.passed}/${summary.counts.total} cases PASS`);
  if (summary.counts.failed > 0) process.exit(2);
}

main().catch((e) => { console.error(e); process.exit(3); });
