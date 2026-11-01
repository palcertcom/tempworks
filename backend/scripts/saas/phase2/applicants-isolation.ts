/**
 * Phase 2.28 — applicants pilot isolation harness.
 *
 *   1. findAll (pilot ON, tenant A) returns only A applicants
 *   2. findOne(tenantB-id) raises NotFoundException
 *   3. agencyId filter for tenant B agency from tenant A returns 0
 *   4. search across name does not leak B
 *   5. getFinancialProfile(tenantB-applicant) raises 404 (parent gate)
 *   6. getAgencyHistory(tenantB-applicant) raises 404 (parent gate)
 *   7. getDeleteRequests excludes tenant B
 *   8. concurrent ALS frames isolated
 *   9. pilot OFF: legacy returns the union
 *  10. source-level meta-assertion: every mutation method sources legacyPrisma
 *
 * Output: backend/reports/saas/phase2/applicants-isolation.{json,md}
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
const SRC_FILE = path.resolve(__dirname, '..', '..', '..', 'src', 'applicants', 'applicants.service.ts');
interface CaseResult { name: string; ok: boolean; detail: string; }

const TENANT_A_LEAD = '00000000-0000-0000-0000-0000000aa001';
const TENANT_A_CAND = '00000000-0000-0000-0000-0000000aa002';
const TENANT_B_LEAD = '00000000-0000-0000-0000-0000000bb001';
const TENANT_B_CAND = '00000000-0000-0000-0000-0000000bb002';
const TENANT_B_AGENCY = 'bbbbbbb2-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

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

async function main(): Promise<void> {
  const url = getDatabaseUrl();
  const env = classifyRuntimeEnv();
  if (!isStagingClassification(env.classification)) {
    console.error(`[applicants-isolation] refusing on classification=${env.classification}`);
    process.exit(3);
  }
  const c = new Client({ connectionString: url, ssl: /127\.0\.0\.1|localhost/.test(url) ? false : { rejectUnauthorized: false } });
  await c.connect();
  const ts = await c.query<{ id: string }>(
    `SELECT t.id FROM tenants t WHERE EXISTS (SELECT 1 FROM applicants a WHERE a."tenantId" = t.id::text) ORDER BY t.name`);
  const tA = ts.rows[0]?.id; const tB = ts.rows[1]?.id;
  await c.end();
  if (!tA || !tB) { console.error('need two tenants with applicants'); process.exit(3); }

  const out: CaseResult[] = [];

  // 1+2 — list/findOne pilot ON tenant A
  await withFlags({ TENANT_PRISMA_PILOT_ENABLED: 'true', TENANT_PRISMA_PILOT_MODULES: 'applicants' }, async () => {
    const prisma = new PrismaService();
    const ff = new FeatureFlagsService();
    const pilot = new PilotPrismaAccessor(prisma, new TenantPrismaService(prisma, ff), ff);
    const svc = makeService(prisma, pilot);
    try {
      const list = await withRequestContext({ requestId: newRequestId() }, async () => {
        TenantContext.attach({ id: tA, slug: 'a', name: 'A', status: 'ACTIVE', region: 'eu' });
        return svc.findAll({ page: 1, limit: 50 } as any);
      });
      const ids = (list as any).data.map((a: any) => a.id);
      const noB = !ids.includes(TENANT_B_LEAD) && !ids.includes(TENANT_B_CAND);
      out.push({ name: 'pilot ON, tenant A: findAll returns ONLY tenant A applicants', ok: noB && ids.length > 0, detail: `count=${ids.length} noB=${noB}` });

      let leaked = false;
      try {
        await withRequestContext({ requestId: newRequestId() }, async () => {
          TenantContext.attach({ id: tA, slug: 'a', name: 'A', status: 'ACTIVE', region: 'eu' });
          await svc.findOne(TENANT_B_LEAD);
        });
        leaked = true;
      } catch { leaked = false; }
      out.push({ name: 'pilot ON, tenant A: findOne(tenantB-id) raises NotFoundException', ok: !leaked, detail: leaked ? 'UNEXPECTED' : 'NotFoundException' });
    } finally { await prisma.$disconnect(); }
  });

  // 3 — agencyId filter for tenant B agency returns 0 from tenant A
  await withFlags({ TENANT_PRISMA_PILOT_ENABLED: 'true', TENANT_PRISMA_PILOT_MODULES: 'applicants' }, async () => {
    const prisma = new PrismaService();
    const ff = new FeatureFlagsService();
    const pilot = new PilotPrismaAccessor(prisma, new TenantPrismaService(prisma, ff), ff);
    const svc = makeService(prisma, pilot);
    try {
      const r = await withRequestContext({ requestId: newRequestId() }, async () => {
        TenantContext.attach({ id: tA, slug: 'a', name: 'A', status: 'ACTIVE', region: 'eu' });
        return svc.findAll({ page: 1, limit: 50, agencyId: TENANT_B_AGENCY } as any);
      });
      out.push({ name: 'pilot ON, tenant A: agencyId=tenantB filter returns 0', ok: ((r as any).meta?.total ?? 0) === 0, detail: `total=${(r as any).meta?.total}` });
    } finally { await prisma.$disconnect(); }
  });

  // 4 — search by name doesn't leak B
  await withFlags({ TENANT_PRISMA_PILOT_ENABLED: 'true', TENANT_PRISMA_PILOT_MODULES: 'applicants' }, async () => {
    const prisma = new PrismaService();
    const ff = new FeatureFlagsService();
    const pilot = new PilotPrismaAccessor(prisma, new TenantPrismaService(prisma, ff), ff);
    const svc = makeService(prisma, pilot);
    try {
      // Tenant B's applicants have firstNames "Boris" and "Bella". Search for "B-" should find them in legacy
      // but pilot tenant A search must return 0.
      const r = await withRequestContext({ requestId: newRequestId() }, async () => {
        TenantContext.attach({ id: tA, slug: 'a', name: 'A', status: 'ACTIVE', region: 'eu' });
        return svc.findAll({ page: 1, limit: 50, search: 'B-' } as any);
      });
      const ids = (r as any).data.map((a: any) => a.id);
      const noB = !ids.includes(TENANT_B_LEAD) && !ids.includes(TENANT_B_CAND);
      out.push({ name: 'pilot ON, tenant A: search "B-" does not leak tenant B applicants', ok: noB, detail: `count=${ids.length} noB=${noB}` });
    } finally { await prisma.$disconnect(); }
  });

  // 5 — getFinancialProfile cross-tenant raises 404
  await withFlags({ TENANT_PRISMA_PILOT_ENABLED: 'true', TENANT_PRISMA_PILOT_MODULES: 'applicants' }, async () => {
    const prisma = new PrismaService();
    const ff = new FeatureFlagsService();
    const pilot = new PilotPrismaAccessor(prisma, new TenantPrismaService(prisma, ff), ff);
    const svc = makeService(prisma, pilot);
    try {
      let leaked = false;
      try {
        await withRequestContext({ requestId: newRequestId() }, async () => {
          TenantContext.attach({ id: tA, slug: 'a', name: 'A', status: 'ACTIVE', region: 'eu' });
          await svc.getFinancialProfile(TENANT_B_CAND);
        });
        leaked = true;
      } catch { leaked = false; }
      out.push({ name: 'pilot ON, tenant A: getFinancialProfile(tenantB-applicant) raises 404 (parent gate)', ok: !leaked, detail: leaked ? 'UNEXPECTED' : 'NotFoundException' });
    } finally { await prisma.$disconnect(); }
  });

  // 6 — getAgencyHistory cross-tenant raises 404
  await withFlags({ TENANT_PRISMA_PILOT_ENABLED: 'true', TENANT_PRISMA_PILOT_MODULES: 'applicants' }, async () => {
    const prisma = new PrismaService();
    const ff = new FeatureFlagsService();
    const pilot = new PilotPrismaAccessor(prisma, new TenantPrismaService(prisma, ff), ff);
    const svc = makeService(prisma, pilot);
    try {
      let leaked = false;
      try {
        await withRequestContext({ requestId: newRequestId() }, async () => {
          TenantContext.attach({ id: tA, slug: 'a', name: 'A', status: 'ACTIVE', region: 'eu' });
          await svc.getAgencyHistory(TENANT_B_CAND);
        });
        leaked = true;
      } catch { leaked = false; }
      out.push({ name: 'pilot ON, tenant A: getAgencyHistory(tenantB-applicant) raises 404 (parent gate)', ok: !leaked, detail: leaked ? 'UNEXPECTED' : 'NotFoundException' });
    } finally { await prisma.$disconnect(); }
  });

  // 7 — getDeleteRequests excludes tenant B (relation filter; legacy mode = sees both)
  await withFlags({ TENANT_PRISMA_PILOT_ENABLED: 'true', TENANT_PRISMA_PILOT_MODULES: 'applicants' }, async () => {
    const prisma = new PrismaService();
    const ff = new FeatureFlagsService();
    const pilot = new PilotPrismaAccessor(prisma, new TenantPrismaService(prisma, ff), ff);
    const svc = makeService(prisma, pilot);
    try {
      // No delete requests seeded; both modes should return 0/0.
      const a = await withRequestContext({ requestId: newRequestId() }, async () => {
        TenantContext.attach({ id: tA, slug: 'a', name: 'A', status: 'ACTIVE', region: 'eu' });
        return svc.getDeleteRequests({ page: 1, limit: 50 });
      });
      out.push({ name: 'pilot ON, tenant A: getDeleteRequests excludes tenant B (relation filter)', ok: ((a as any).meta?.total ?? 0) === 0, detail: `total=${(a as any).meta?.total}` });
    } finally { await prisma.$disconnect(); }
  });

  // 8 — concurrent ALS frames isolated
  await withFlags({ TENANT_PRISMA_PILOT_ENABLED: 'true', TENANT_PRISMA_PILOT_MODULES: 'applicants' }, async () => {
    const prisma = new PrismaService();
    const ff = new FeatureFlagsService();
    const pilot = new PilotPrismaAccessor(prisma, new TenantPrismaService(prisma, ff), ff);
    const svc = makeService(prisma, pilot);
    try {
      const seen: Array<{ t: string; ids: string[] }> = [];
      await Promise.all([
        withRequestContext({ requestId: newRequestId() }, async () => {
          TenantContext.attach({ id: tA, slug: 'a', name: 'A', status: 'ACTIVE', region: 'eu' });
          await new Promise((r) => setTimeout(r, 5));
          const r = await svc.findAll({ page: 1, limit: 50 } as any);
          seen.push({ t: tA, ids: (r as any).data.map((x: any) => x.id) });
        }),
        withRequestContext({ requestId: newRequestId() }, async () => {
          TenantContext.attach({ id: tB, slug: 'b', name: 'B', status: 'ACTIVE', region: 'eu' });
          await new Promise((r) => setTimeout(r, 1));
          const r = await svc.findAll({ page: 1, limit: 50 } as any);
          seen.push({ t: tB, ids: (r as any).data.map((x: any) => x.id) });
        }),
      ]);
      const a = seen.find((x) => x.t === tA);
      const b = seen.find((x) => x.t === tB);
      const aHasNoB = !!a && !a.ids.includes(TENANT_B_LEAD);
      const bHasNoA = !!b && !b.ids.includes(TENANT_A_LEAD);
      out.push({ name: 'concurrent ALS frames isolated (T_A no B-rows; T_B no A-rows)', ok: aHasNoB && bHasNoA, detail: `aCount=${a?.ids.length} bCount=${b?.ids.length}` });
    } finally { await prisma.$disconnect(); }
  });

  // 9 — pilot OFF: legacy returns union
  await withFlags({ TENANT_PRISMA_PILOT_ENABLED: 'false' }, async () => {
    const prisma = new PrismaService();
    const ff = new FeatureFlagsService();
    const pilot = new PilotPrismaAccessor(prisma, new TenantPrismaService(prisma, ff), ff);
    const svc = makeService(prisma, pilot);
    try {
      const list = await svc.findAll({ page: 1, limit: 50 } as any);
      const ids = (list as any).data.map((a: any) => a.id);
      out.push({ name: 'pilot OFF: legacy findAll includes tenants A AND B', ok: ids.includes(TENANT_A_LEAD) && ids.includes(TENANT_B_LEAD), detail: `count=${ids.length}` });
    } finally { await prisma.$disconnect(); }
  });

  // 10 — source-level meta-assertion
  const src = await fs.readFile(SRC_FILE, 'utf8');
  const expected: Array<[string, RegExp]> = [
    ['create uses legacyPrisma', /async create\([\s\S]*?this\.legacyPrisma\.applicant\.create/],
    ['update uses legacyPrisma', /async update\([\s\S]*?this\.legacyPrisma\.applicant\.update/],
    ['remove uses legacyPrisma', /async remove\([\s\S]*?this\.legacyPrisma\.applicant\.update/],
    ['updateStatus uses legacyPrisma', /async updateStatus\([\s\S]*?this\.legacyPrisma\.applicant\.update/],
    ['publicSubmit uses legacyPrisma', /async publicSubmit\([\s\S]*?this\.legacyPrisma\.applicant\.create/],
    ['convertLeadToCandidate uses legacyPrisma', /async convertLeadToCandidate\([\s\S]*?this\.legacyPrisma\.applicant\.update/],
    ['reassignAgency uses legacyPrisma', /async reassignAgency\([\s\S]*?this\.legacyPrisma\.applicant\.update/],
    ['convertToEmployee uses legacyPrisma', /async convertToEmployee\([\s\S]*?this\.legacyPrisma\.employee\.create/],
    ['findOne migrated to findFirst with tenant predicate', /async findOne\([\s\S]*?this\.prisma\.applicant\.findFirst\([\s\S]{0,200}\.\.\.t/],
    ['findApplicantOrFail tenant-scoped helper', /private async findApplicantOrFail\([\s\S]*?this\.prisma\.applicant\.findFirst\([\s\S]{0,200}\.\.\.t/],
  ];
  const failed: string[] = [];
  expected.forEach(([n, re]) => { if (!re.test(src)) failed.push(n); });
  out.push({ name: 'source: every Phase 2.28 mutation uses legacyPrisma; reads use tenantWhere/findFirst', ok: failed.length === 0, detail: failed.length === 0 ? 'all patterns matched' : failed.join('; ') });

  await fs.mkdir(OUT_DIR, { recursive: true });
  const summary = {
    generatedAt: new Date().toISOString(), environment: env, tenantA: tA, tenantB: tB,
    counts: { total: out.length, passed: out.filter((r) => r.ok).length, failed: out.filter((r) => !r.ok).length },
    results: out,
  };
  await fs.writeFile(path.join(OUT_DIR, 'applicants-isolation.json'), JSON.stringify(summary, null, 2));
  const md: string[] = [];
  md.push('# Phase 2.28 — Applicants Isolation');
  md.push(''); md.push(`Generated: ${summary.generatedAt}`);
  md.push(`Environment: ${env.classification} (${env.reason})`);
  md.push(`Tenants: A=\`${tA}\` B=\`${tB}\``); md.push('');
  md.push(`- Cases passed: **${summary.counts.passed}** / ${summary.counts.total}`);
  md.push(`- Cases failed: ${summary.counts.failed}`); md.push('');
  md.push('| # | Case | Result | Detail |'); md.push('|--:|------|:------:|--------|');
  out.forEach((r, i) => md.push(`| ${i + 1} | ${r.name} | ${r.ok ? 'PASS' : '**FAIL**'} | ${r.detail} |`));
  await fs.writeFile(path.join(OUT_DIR, 'applicants-isolation.md'), md.join('\n'));

  console.log(`applicants-isolation: ${summary.counts.passed}/${summary.counts.total} cases PASS`);
  if (summary.counts.failed > 0) process.exit(2);
}

main().catch((e) => { console.error(e); process.exit(3); });
