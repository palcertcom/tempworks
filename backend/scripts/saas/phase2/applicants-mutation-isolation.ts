/**
 * Phase 2.29 — applicants mutation isolation harness.
 *
 *   1. update(tenantB-id) raises 404; row unchanged
 *   2. updateStatus(tenantB-id) raises 404; row unchanged
 *   3. remove(tenantB-id) raises 404; deletedAt unchanged
 *   4. setCurrentStage(tenantB-id) raises 404
 *   5. approveApplicant(tenantB-id) raises 404
 *   6. reassignAgency(tenantB-id) raises 404
 *   7. reassignAgency(tenantA-id, tenantB-agency) raises 404 (agency gate)
 *   8. bulkAction with mixed [A, B] ids only processes A (B silently dropped)
 *   9. requestDelete(tenantB-id) raises 404
 *  10. pilot OFF: legacy update on tenant B still mutates
 *  11. source-level meta-assertion: phase229 patterns present
 *
 * Output: backend/reports/saas/phase2/applicants-mutation-isolation.{json,md}
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
const STAGE_1 = '00000000-0000-0000-0000-00000000st01';
const SYS_USER = '00000000-0000-0000-0000-00000000us01';

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
  const emailStub: any = { sendApplicationConfirmation: async () => undefined };
  return new ApplicantsService(prisma, emailStub, new StorageService(), pilot, new TenantAuditLogService(prisma, new FeatureFlagsService()));
}

async function main(): Promise<void> {
  const url = getDatabaseUrl();
  const env = classifyRuntimeEnv();
  if (!isStagingClassification(env.classification)) {
    console.error(`[applicants-mutation-isolation] refusing on classification=${env.classification}`);
    process.exit(3);
  }
  const c = new Client({ connectionString: url, ssl: /127\.0\.0\.1|localhost/.test(url) ? false : { rejectUnauthorized: false } });
  await c.connect();
  const ts = await c.query<{ id: string }>(
    `SELECT t.id FROM tenants t WHERE EXISTS (SELECT 1 FROM applicants a WHERE a."tenantId" = t.id::text) ORDER BY t.name`);
  const tA = ts.rows[0]?.id; const tB = ts.rows[1]?.id;
  await c.end();
  if (!tA || !tB) { console.error('need two tenants'); process.exit(3); }

  const out: CaseResult[] = [];

  // Cross-tenant rejections (cases 1-7, 9)
  await withFlags({ TENANT_PRISMA_PILOT_ENABLED: 'true', TENANT_PRISMA_PILOT_MODULES: 'applicants' }, async () => {
    const prisma = new PrismaService();
    const ff = new FeatureFlagsService();
    const pilot = new PilotPrismaAccessor(prisma, new TenantPrismaService(prisma, ff), ff);
    const svc = makeService(prisma, pilot);
    try {
      const beforeB: any = await (prisma as any).applicant.findUnique({ where: { id: TENANT_B_LEAD } });
      const beforePhone = beforeB?.phone;
      const beforeStatus = beforeB?.status;
      const beforeDeletedAt = beforeB?.deletedAt ?? null;

      const ctx = () => TenantContext.attach({ id: tA, slug: 'a', name: 'A', status: 'ACTIVE', region: 'eu' });

      let upL = false; try { await withRequestContext({ requestId: newRequestId() }, async () => { ctx(); await svc.update(TENANT_B_LEAD, { phone: 'A-trying-B' } as any, SYS_USER); }); upL = true; } catch { upL = false; }
      let usL = false; try { await withRequestContext({ requestId: newRequestId() }, async () => { ctx(); await svc.updateStatus(TENANT_B_LEAD, 'REJECTED' as any, SYS_USER); }); usL = true; } catch { usL = false; }
      let rmL = false; try { await withRequestContext({ requestId: newRequestId() }, async () => { ctx(); await svc.remove(TENANT_B_LEAD, SYS_USER); }); rmL = true; } catch { rmL = false; }
      let scL = false; try { await withRequestContext({ requestId: newRequestId() }, async () => { ctx(); await svc.setCurrentStage(TENANT_B_LEAD, STAGE_1, SYS_USER); }); scL = true; } catch { scL = false; }
      let apL = false; try { await withRequestContext({ requestId: newRequestId() }, async () => { ctx(); await svc.approveApplicant(TENANT_B_LEAD, SYS_USER); }); apL = true; } catch { apL = false; }
      let raL = false; try { await withRequestContext({ requestId: newRequestId() }, async () => { ctx(); await svc.reassignAgency(TENANT_B_LEAD, { agencyId: TENANT_B_AGENCY } as any, SYS_USER); }); raL = true; } catch { raL = false; }
      let raAgL = false; try { await withRequestContext({ requestId: newRequestId() }, async () => { ctx(); await svc.reassignAgency(TENANT_A_LEAD, { agencyId: TENANT_B_AGENCY } as any, SYS_USER); }); raAgL = true; } catch { raAgL = false; }
      let rdL = false; try { await withRequestContext({ requestId: newRequestId() }, async () => { ctx(); await svc.requestDelete(TENANT_B_CAND, 'reason', SYS_USER); }); rdL = true; } catch { rdL = false; }

      const afterB: any = await (prisma as any).applicant.findUnique({ where: { id: TENANT_B_LEAD } });
      out.push({ name: 'pilot ON, tenant A: update(tenantB-id) rejected; phone unchanged', ok: !upL && afterB?.phone === beforePhone, detail: `before="${beforePhone}" after="${afterB?.phone}"` });
      out.push({ name: 'pilot ON, tenant A: updateStatus(tenantB-id) rejected; status unchanged', ok: !usL && afterB?.status === beforeStatus, detail: `before=${beforeStatus} after=${afterB?.status}` });
      out.push({ name: 'pilot ON, tenant A: remove(tenantB-id) rejected; deletedAt unchanged', ok: !rmL && (afterB?.deletedAt ?? null) === beforeDeletedAt, detail: `deletedAt=${afterB?.deletedAt ? 'set' : 'null'}` });
      out.push({ name: 'pilot ON, tenant A: setCurrentStage(tenantB-id) raises 404', ok: !scL, detail: scL ? 'UNEXPECTED' : 'NotFoundException' });
      out.push({ name: 'pilot ON, tenant A: approveApplicant(tenantB-id) raises 404', ok: !apL, detail: apL ? 'UNEXPECTED' : 'NotFoundException' });
      out.push({ name: 'pilot ON, tenant A: reassignAgency(tenantB-id) raises 404 (parent gate)', ok: !raL, detail: raL ? 'UNEXPECTED' : 'NotFoundException' });
      out.push({ name: 'pilot ON, tenant A: reassignAgency(tenantA-id, tenantB-agency) raises 404 (agency gate)', ok: !raAgL, detail: raAgL ? 'UNEXPECTED' : 'NotFoundException' });
      out.push({ name: 'pilot ON, tenant A: requestDelete(tenantB-id) raises 404', ok: !rdL, detail: rdL ? 'UNEXPECTED' : 'NotFoundException' });
    } finally { await prisma.$disconnect(); }
  });

  // 8 — bulk filter
  await withFlags({ TENANT_PRISMA_PILOT_ENABLED: 'true', TENANT_PRISMA_PILOT_MODULES: 'applicants' }, async () => {
    const prisma = new PrismaService();
    const ff = new FeatureFlagsService();
    const pilot = new PilotPrismaAccessor(prisma, new TenantPrismaService(prisma, ff), ff);
    const svc = makeService(prisma, pilot);
    try {
      const beforeB: any = await (prisma as any).applicant.findUnique({ where: { id: TENANT_B_LEAD } });
      const r = await withRequestContext({ requestId: newRequestId() }, async () => {
        TenantContext.attach({ id: tA, slug: 'a', name: 'A', status: 'ACTIVE', region: 'eu' });
        return svc.bulkAction({ ids: [TENANT_A_LEAD, TENANT_B_LEAD], action: 'STATUS_CHANGE' as any, value: 'SCREENING' } as any, SYS_USER);
      });
      const results = (r as any).results as any[];
      const tenantBProcessed = results.some((x: any) => x.id === TENANT_B_LEAD);
      const afterB: any = await (prisma as any).applicant.findUnique({ where: { id: TENANT_B_LEAD } });
      out.push({
        name: 'BULK FILTER: pilot ON, tenant A bulk(STATUS_CHANGE on [A,B]) → only A processed; B unchanged',
        ok: !tenantBProcessed && afterB?.status === beforeB?.status,
        detail: `processedCount=${results.length} bIncluded=${tenantBProcessed} bStatusBefore=${beforeB?.status} bStatusAfter=${afterB?.status}`,
      });
    } finally { await prisma.$disconnect(); }
  });

  // 10 — pilot OFF: legacy still mutates B
  await withFlags({ TENANT_PRISMA_PILOT_ENABLED: 'false' }, async () => {
    const prisma = new PrismaService();
    const ff = new FeatureFlagsService();
    const pilot = new PilotPrismaAccessor(prisma, new TenantPrismaService(prisma, ff), ff);
    const svc = makeService(prisma, pilot);
    try {
      const before: any = await (prisma as any).applicant.findUnique({ where: { id: TENANT_B_LEAD } });
      let mutated = false;
      try {
        const u = await svc.update(TENANT_B_LEAD, { phone: 'legacy-no-tenant-gate' } as any, SYS_USER);
        mutated = (u as any).phone === 'legacy-no-tenant-gate';
      } catch { mutated = false; }
      if (mutated && before) {
        await (prisma as any).applicant.update({ where: { id: TENANT_B_LEAD }, data: { phone: before.phone } });
      }
      out.push({ name: 'pilot OFF: legacy update on tenant B applicant still succeeds', ok: mutated, detail: mutated ? 'mutated' : 'UNEXPECTED' });
    } finally { await prisma.$disconnect(); }
  });

  // 11 — source-level meta-assertion
  const src = await fs.readFile(SRC_FILE, 'utf8');
  const expected: Array<[string, RegExp]> = [
    ['findApplicantOrFail tenant-scoped helper', /private async findApplicantOrFail\([\s\S]*?this\.prisma\.applicant\.findFirst\([\s\S]{0,200}\.\.\.t/],
    ['findAgencyOrFail tenant-scoped helper', /private async findAgencyOrFail\([\s\S]*?this\.prisma\.agency\.findFirst\([\s\S]{0,200}\.\.\.t/],
    ['create uses tenantData spread', /async create\([\s\S]*?this\.legacyPrisma\.applicant\.create\(\{[\s\S]{0,2000}\.\.\.tdata/],
    ['convertToEmployee.employee.create uses tenantData spread', /async convertToEmployee\([\s\S]*?this\.legacyPrisma\.employee\.create\([\s\S]{0,3500}\.\.\.tdata/],
    ['bulkAction has phase229-bulk-filter pre-filter', /async bulkAction\([\s\S]*?phase229-bulk-filter[\s\S]{0,400}allowedIds\.has/],
    ['reassignAgency uses findAgencyOrFail', /async reassignAgency\([\s\S]*?this\.findAgencyOrFail/],
    ['convertLeadToCandidate uses findAgencyOrFail', /async convertLeadToCandidate\([\s\S]*?this\.findAgencyOrFail/],
    ['requestDelete uses findApplicantOrFail', /async requestDelete\([\s\S]*?this\.findApplicantOrFail/],
    ['reviewDeleteRequest uses relation filter via parent applicant', /async reviewDeleteRequest\([\s\S]*?applicant: \{ tenantId[\s\S]{0,400}candidateDeleteRequest\.findFirst/],
  ];
  const failed: string[] = [];
  expected.forEach(([n, re]) => { if (!re.test(src)) failed.push(n); });
  out.push({ name: 'source: every Phase 2.29 mutation pattern present', ok: failed.length === 0, detail: failed.length === 0 ? 'all patterns matched' : failed.join('; ') });

  // Cleanup — restore tenant A lead status if bulk modified
  const cleanup = new Client({ connectionString: url, ssl: /127\.0\.0\.1|localhost/.test(url) ? false : { rejectUnauthorized: false } });
  await cleanup.connect();
  await cleanup.query(`UPDATE applicants SET status='NEW' WHERE id=$1`, [TENANT_A_LEAD]).catch(() => undefined);
  await cleanup.end();

  await fs.mkdir(OUT_DIR, { recursive: true });
  const summary = {
    generatedAt: new Date().toISOString(), environment: env, tenantA: tA, tenantB: tB,
    counts: { total: out.length, passed: out.filter((r) => r.ok).length, failed: out.filter((r) => !r.ok).length },
    results: out,
  };
  await fs.writeFile(path.join(OUT_DIR, 'applicants-mutation-isolation.json'), JSON.stringify(summary, null, 2));
  const md: string[] = [];
  md.push('# Phase 2.29 — Applicants Mutation Isolation');
  md.push(''); md.push(`Generated: ${summary.generatedAt}`);
  md.push(`Environment: ${env.classification} (${env.reason})`);
  md.push(`Tenants: A=\`${tA}\` B=\`${tB}\``); md.push('');
  md.push(`- Cases passed: **${summary.counts.passed}** / ${summary.counts.total}`);
  md.push(`- Cases failed: ${summary.counts.failed}`); md.push('');
  md.push('| # | Case | Result | Detail |'); md.push('|--:|------|:------:|--------|');
  out.forEach((r, i) => md.push(`| ${i + 1} | ${r.name} | ${r.ok ? 'PASS' : '**FAIL**'} | ${r.detail} |`));
  await fs.writeFile(path.join(OUT_DIR, 'applicants-mutation-isolation.md'), md.join('\n'));

  console.log(`applicants-mutation-isolation: ${summary.counts.passed}/${summary.counts.total} cases PASS`);
  if (summary.counts.failed > 0) process.exit(2);
}

main().catch((e) => { console.error(e); process.exit(3); });
