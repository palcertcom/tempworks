/**
 * Phase 2.28 — applicants pilot read-equivalence harness.
 *
 *   1. legacy: pilotActive=false
 *   2. pilot ON + applicants allow-list ⇒ pilotActive=true
 *   3. findAll: pilot total <= legacy total
 *   4. findOne: legacy + pilot resolve same id
 *   5. error path: NotFoundException for missing id
 *   6. tier filter: both modes respect filter
 *   7. status filter: both modes respect filter
 *   8. search filter: both modes respect filter
 *   9. getFinancialProfile: legacy + pilot return same profile
 *  10. getAgencyHistory: legacy + pilot return same rows
 *  11. getDeleteRequests: pilot total <= legacy total
 *  12. response shape preserved
 *
 * Output: backend/reports/saas/phase2/applicants-equivalence.{json,md}
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
import { ApplicantsService } from '../../../src/applicants/applicants.service';
import { StorageService } from '../../../src/common/storage/storage.service';
import { TenantContext, withRequestContext, newRequestId } from '../../../src/saas/context/als';

autoLoadEnv(__filename);

const OUT_DIR = path.resolve(__dirname, '..', '..', '..', 'reports', 'saas', 'phase2');
interface CaseResult { name: string; ok: boolean; detail: string; }
const TENANT_A_APP_LEAD = '00000000-0000-0000-0000-0000000aa001';
const TENANT_A_APP_CAND = '00000000-0000-0000-0000-0000000aa002';

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

function makeService(prisma: PrismaService, pilot: PilotPrismaAccessor): ApplicantsService {
  const emailStub: any = { send: async () => undefined };
  return new ApplicantsService(prisma, emailStub, new StorageService(), pilot, new TenantAuditLogService(prisma, new FeatureFlagsService()));
}

interface Snap {
  pilotActive: boolean; reason: string;
  listTotal: number;
  oneId: string | null;
  errOnMissing: string;
  candTotal: number;
  acceptedTotal: number;
  searchTotal: number;
  fpFound: boolean;
  ahCount: number;
  delReqTotal: number;
  shapeOk: boolean;
}

async function snap(flags: Record<string, string | undefined>, ctx: { id: string } | null): Promise<Snap> {
  return withFlags(flags, async () => {
    const ff = new FeatureFlagsService();
    const prisma = new PrismaService();
    const tp = new TenantPrismaService(prisma, ff);
    const pilot = new PilotPrismaAccessor(prisma, tp, ff);
    const svc = makeService(prisma, pilot);
    const run = async (): Promise<Snap> => {
      const list = await svc.findAll({ page: 1, limit: 50 } as any);
      let oneId: string | null = null;
      try { oneId = (await svc.findOne(TENANT_A_APP_LEAD)).id; } catch { oneId = null; }
      let errOnMissing = 'no-error';
      try { await svc.findOne('00000000-0000-0000-0000-deaddeaddead'); }
      catch (e) { errOnMissing = (e as Error).constructor.name; }
      const cand = await svc.findAll({ page: 1, limit: 50, tier: 'CANDIDATE' } as any);
      const accepted = await svc.findAll({ page: 1, limit: 50, status: 'ACCEPTED' } as any);
      const search = await svc.findAll({ page: 1, limit: 50, search: 'A-' } as any);
      const fp = await svc.getFinancialProfile(TENANT_A_APP_CAND);
      const ah = await svc.getAgencyHistory(TENANT_A_APP_CAND);
      const dreq = await svc.getDeleteRequests({ page: 1, limit: 50 });
      const shapeOk = Array.isArray((list as any).data) && typeof (list as any).meta?.total === 'number';
      return {
        pilotActive: pilot.isPilotActive(),
        reason: pilot.pilotReason().reason,
        listTotal: (list as any).meta?.total ?? 0,
        oneId, errOnMissing,
        candTotal: (cand as any).meta?.total ?? 0,
        acceptedTotal: (accepted as any).meta?.total ?? 0,
        searchTotal: (search as any).meta?.total ?? 0,
        fpFound: !!fp,
        ahCount: ah.length,
        delReqTotal: (dreq as any).meta?.total ?? 0,
        shapeOk,
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
    } finally { await prisma.$disconnect(); }
  });
}

async function main(): Promise<void> {
  const url = getDatabaseUrl();
  const env = classifyRuntimeEnv();
  if (!isStagingClassification(env.classification)) {
    console.error(`[applicants-equivalence] refusing on classification=${env.classification}`);
    process.exit(3);
  }
  const c = new Client({ connectionString: url, ssl: /127\.0\.0\.1|localhost/.test(url) ? false : { rejectUnauthorized: false } });
  await c.connect();
  const ts = await c.query<{ id: string }>(
    `SELECT t.id FROM tenants t WHERE EXISTS (SELECT 1 FROM applicants a WHERE a."tenantId" = t.id::text) ORDER BY t.name`);
  const tA = ts.rows[0]?.id;
  await c.end();
  if (!tA) { console.error('need tenant A with applicants'); process.exit(3); }

  const out: CaseResult[] = [];
  const legacy = await snap({ TENANT_PRISMA_PILOT_ENABLED: 'false' }, null);
  const pilot  = await snap({ TENANT_PRISMA_PILOT_ENABLED: 'true', TENANT_PRISMA_PILOT_MODULES: 'applicants' }, { id: tA });

  out.push({ name: 'legacy: pilot OFF reports pilotActive=false', ok: !legacy.pilotActive, detail: legacy.reason });
  out.push({ name: 'pilot: pilot ON + applicants allow-list ⇒ pilotActive=true', ok: pilot.pilotActive && pilot.reason.startsWith('pilot ON'), detail: pilot.reason });
  out.push({ name: 'findAll: pilot total <= legacy total', ok: pilot.listTotal <= legacy.listTotal && pilot.listTotal > 0, detail: `legacy=${legacy.listTotal} pilot=${pilot.listTotal}` });
  out.push({ name: 'findOne: legacy + pilot resolve the tenant A applicant id', ok: legacy.oneId === TENANT_A_APP_LEAD && pilot.oneId === TENANT_A_APP_LEAD, detail: `legacy=${legacy.oneId} pilot=${pilot.oneId}` });
  out.push({ name: 'error path: NotFoundException for missing id in both modes', ok: legacy.errOnMissing === 'NotFoundException' && pilot.errOnMissing === 'NotFoundException', detail: `legacy=${legacy.errOnMissing} pilot=${pilot.errOnMissing}` });
  out.push({ name: 'tier filter: pilot CANDIDATE total <= legacy', ok: pilot.candTotal <= legacy.candTotal && pilot.candTotal > 0, detail: `legacy=${legacy.candTotal} pilot=${pilot.candTotal}` });
  out.push({ name: 'status filter: pilot ACCEPTED total <= legacy', ok: pilot.acceptedTotal <= legacy.acceptedTotal && pilot.acceptedTotal > 0, detail: `legacy=${legacy.acceptedTotal} pilot=${pilot.acceptedTotal}` });
  out.push({ name: 'search filter: pilot search total <= legacy', ok: pilot.searchTotal <= legacy.searchTotal && pilot.searchTotal > 0, detail: `legacy=${legacy.searchTotal} pilot=${pilot.searchTotal}` });
  out.push({ name: 'getFinancialProfile: both modes return profile for tenant A candidate', ok: legacy.fpFound && pilot.fpFound, detail: `legacy=${legacy.fpFound} pilot=${pilot.fpFound}` });
  out.push({ name: 'getAgencyHistory: both modes return rows for tenant A candidate', ok: legacy.ahCount === pilot.ahCount && pilot.ahCount > 0, detail: `legacy=${legacy.ahCount} pilot=${pilot.ahCount}` });
  out.push({ name: 'getDeleteRequests: pilot total <= legacy total (relation filter)', ok: pilot.delReqTotal <= legacy.delReqTotal, detail: `legacy=${legacy.delReqTotal} pilot=${pilot.delReqTotal}` });
  out.push({ name: 'response shape preserved (PaginatedResponse)', ok: legacy.shapeOk && pilot.shapeOk, detail: `legacy=${legacy.shapeOk} pilot=${pilot.shapeOk}` });

  await fs.mkdir(OUT_DIR, { recursive: true });
  const summary = {
    generatedAt: new Date().toISOString(), environment: env, tenantA: tA,
    legacy, pilot,
    counts: { total: out.length, passed: out.filter((r) => r.ok).length, failed: out.filter((r) => !r.ok).length },
    results: out,
  };
  await fs.writeFile(path.join(OUT_DIR, 'applicants-equivalence.json'), JSON.stringify(summary, null, 2));
  const md: string[] = [];
  md.push('# Phase 2.28 — Applicants Equivalence');
  md.push(''); md.push(`Generated: ${summary.generatedAt}`);
  md.push(`Environment: ${env.classification} (${env.reason})`);
  md.push(`Tenant A: \`${tA}\``); md.push('');
  md.push(`- Cases passed: **${summary.counts.passed}** / ${summary.counts.total}`);
  md.push(`- Cases failed: ${summary.counts.failed}`); md.push('');
  md.push('| # | Case | Result | Detail |'); md.push('|--:|------|:------:|--------|');
  out.forEach((r, i) => md.push(`| ${i + 1} | ${r.name} | ${r.ok ? 'PASS' : '**FAIL**'} | ${r.detail} |`));
  await fs.writeFile(path.join(OUT_DIR, 'applicants-equivalence.md'), md.join('\n'));

  console.log(`applicants-equivalence: ${summary.counts.passed}/${summary.counts.total} cases PASS`);
  if (summary.counts.failed > 0) process.exit(2);
}

main().catch((e) => { console.error(e); process.exit(3); });
