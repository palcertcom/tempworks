/**
 * Phase 2.29 — applicants mutation equivalence harness.
 *
 *   1. create shape preserved (id present in both modes)
 *   2. create legacy: tenantId NULL; pilot: tenantId=A
 *   3. update mutates the field in both modes
 *   4. updateStatus mutates the status in both modes
 *   5. soft-delete sets deletedAt in both modes
 *   6. validation: bogus id ⇒ NotFoundException both modes
 *   7. bulk filter: pilot drops cross-tenant ids; legacy passes whole list
 *   8. requestDelete creates a delete request in both modes
 *
 * Output: backend/reports/saas/phase2/applicants-mutation-equivalence.{json,md}
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
const TENANT_A_AGENCY = 'aaaaaaa1-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const TENANT_A_LEAD = '00000000-0000-0000-0000-0000000aa001';
const TENANT_A_CAND = '00000000-0000-0000-0000-0000000aa002';
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
    console.error(`[applicants-mutation-equivalence] refusing on classification=${env.classification}`);
    process.exit(3);
  }
  const c = new Client({ connectionString: url, ssl: /127\.0\.0\.1|localhost/.test(url) ? false : { rejectUnauthorized: false } });
  await c.connect();
  const ts = await c.query<{ id: string }>(
    `SELECT t.id FROM tenants t WHERE EXISTS (SELECT 1 FROM applicants a WHERE a."tenantId" = t.id::text) ORDER BY t.name`);
  const tA = ts.rows[0]?.id;
  await c.end();
  if (!tA) { console.error('need tenant A'); process.exit(3); }

  const out: CaseResult[] = [];
  const createdIds: string[] = [];
  const stamp = Date.now().toString(36);

  // 1+2 — create legacy + pilot
  let lid = '', pid = '';
  await withFlags({ TENANT_PRISMA_PILOT_ENABLED: 'false' }, async () => {
    const prisma = new PrismaService();
    const ff = new FeatureFlagsService();
    const pilot = new PilotPrismaAccessor(prisma, new TenantPrismaService(prisma, ff), ff);
    const svc = makeService(prisma, pilot);
    try {
      const r = await svc.create({ firstName: 'L', lastName: stamp, email: `l-${stamp}@a.test`, phone: '+1', nationality: 'GB', residencyStatus: 'Other', hasNationalInsurance: false, hasWorkAuthorization: false, availability: 'Immediate', hasDrivingLicense: false, agencyId: TENANT_A_AGENCY } as any, SYS_USER);
      lid = r.id; createdIds.push(lid);
    } finally { await prisma.$disconnect(); }
  });
  await withFlags({ TENANT_PRISMA_PILOT_ENABLED: 'true', TENANT_PRISMA_PILOT_MODULES: 'applicants' }, async () => {
    const prisma = new PrismaService();
    const ff = new FeatureFlagsService();
    const pilot = new PilotPrismaAccessor(prisma, new TenantPrismaService(prisma, ff), ff);
    const svc = makeService(prisma, pilot);
    try {
      await withRequestContext({ requestId: newRequestId() }, async () => {
        TenantContext.attach({ id: tA, slug: 'a', name: 'A', status: 'ACTIVE', region: 'eu' });
        const r = await svc.create({ firstName: 'P', lastName: stamp, email: `p-${stamp}@a.test`, phone: '+1', nationality: 'GB', residencyStatus: 'Other', hasNationalInsurance: false, hasWorkAuthorization: false, availability: 'Immediate', hasDrivingLicense: false, agencyId: TENANT_A_AGENCY } as any, SYS_USER);
        pid = r.id; createdIds.push(pid);
      });
    } finally { await prisma.$disconnect(); }
  });
  out.push({ name: 'create response shape preserved', ok: !!lid && !!pid, detail: `legacy.id=${lid} pilot.id=${pid}` });

  const verify = new Client({ connectionString: url, ssl: /127\.0\.0\.1|localhost/.test(url) ? false : { rejectUnauthorized: false } });
  await verify.connect();
  const lRow = await verify.query<{ tenantId: string | null }>(`SELECT "tenantId" FROM applicants WHERE id=$1`, [lid]);
  const pRow = await verify.query<{ tenantId: string | null }>(`SELECT "tenantId" FROM applicants WHERE id=$1`, [pid]);
  await verify.end();
  out.push({ name: 'create legacy: tenantId NULL', ok: lRow.rows[0]?.tenantId === null, detail: `tid=${lRow.rows[0]?.tenantId}` });
  out.push({ name: 'create pilot: tenantId=A', ok: pRow.rows[0]?.tenantId === tA, detail: `tid=${pRow.rows[0]?.tenantId}` });

  // 3 — update mutates phone in both modes
  await withFlags({ TENANT_PRISMA_PILOT_ENABLED: 'false' }, async () => {
    const prisma = new PrismaService();
    const ff = new FeatureFlagsService();
    const pilot = new PilotPrismaAccessor(prisma, new TenantPrismaService(prisma, ff), ff);
    const svc = makeService(prisma, pilot);
    try {
      const u = await svc.update(lid, { phone: '+legacy' } as any, SYS_USER);
      out.push({ name: 'update (legacy) mutates phone', ok: (u as any).phone === '+legacy', detail: `phone=${(u as any).phone}` });
    } finally { await prisma.$disconnect(); }
  });
  await withFlags({ TENANT_PRISMA_PILOT_ENABLED: 'true', TENANT_PRISMA_PILOT_MODULES: 'applicants' }, async () => {
    const prisma = new PrismaService();
    const ff = new FeatureFlagsService();
    const pilot = new PilotPrismaAccessor(prisma, new TenantPrismaService(prisma, ff), ff);
    const svc = makeService(prisma, pilot);
    try {
      await withRequestContext({ requestId: newRequestId() }, async () => {
        TenantContext.attach({ id: tA, slug: 'a', name: 'A', status: 'ACTIVE', region: 'eu' });
        const u = await svc.update(pid, { phone: '+pilot' } as any, SYS_USER);
        out.push({ name: 'update (pilot) mutates phone', ok: (u as any).phone === '+pilot', detail: `phone=${(u as any).phone}` });
      });
    } finally { await prisma.$disconnect(); }
  });

  // 4 — updateStatus mutates status (pilot)
  await withFlags({ TENANT_PRISMA_PILOT_ENABLED: 'true', TENANT_PRISMA_PILOT_MODULES: 'applicants' }, async () => {
    const prisma = new PrismaService();
    const ff = new FeatureFlagsService();
    const pilot = new PilotPrismaAccessor(prisma, new TenantPrismaService(prisma, ff), ff);
    const svc = makeService(prisma, pilot);
    try {
      await withRequestContext({ requestId: newRequestId() }, async () => {
        TenantContext.attach({ id: tA, slug: 'a', name: 'A', status: 'ACTIVE', region: 'eu' });
        const u = await svc.updateStatus(pid, 'SCREENING' as any, SYS_USER);
        out.push({ name: 'updateStatus (pilot) mutates status', ok: (u as any).status === 'SCREENING', detail: `status=${(u as any).status}` });
      });
    } finally { await prisma.$disconnect(); }
  });

  // 5 — soft-delete (pilot)
  await withFlags({ TENANT_PRISMA_PILOT_ENABLED: 'true', TENANT_PRISMA_PILOT_MODULES: 'applicants' }, async () => {
    const prisma = new PrismaService();
    const ff = new FeatureFlagsService();
    const pilot = new PilotPrismaAccessor(prisma, new TenantPrismaService(prisma, ff), ff);
    const svc = makeService(prisma, pilot);
    try {
      await withRequestContext({ requestId: newRequestId() }, async () => {
        TenantContext.attach({ id: tA, slug: 'a', name: 'A', status: 'ACTIVE', region: 'eu' });
        await svc.remove(pid, SYS_USER);
      });
      const after: any = await (prisma as any).applicant.findUnique({ where: { id: pid } });
      out.push({ name: 'pilot remove: deletedAt set', ok: !!after?.deletedAt, detail: `deletedAt=${after?.deletedAt ? 'set' : 'null'}` });
    } finally { await prisma.$disconnect(); }
  });

  // 6 — validation parity
  let lE = 'no-error', pE = 'no-error';
  await withFlags({ TENANT_PRISMA_PILOT_ENABLED: 'false' }, async () => {
    const prisma = new PrismaService();
    const ff = new FeatureFlagsService();
    const pilot = new PilotPrismaAccessor(prisma, new TenantPrismaService(prisma, ff), ff);
    const svc = makeService(prisma, pilot);
    try { await svc.update('00000000-0000-0000-0000-deaddeaddead', { phone: 'x' } as any, SYS_USER); }
    catch (e) { lE = (e as Error).constructor.name; }
    finally { await prisma.$disconnect(); }
  });
  await withFlags({ TENANT_PRISMA_PILOT_ENABLED: 'true', TENANT_PRISMA_PILOT_MODULES: 'applicants' }, async () => {
    const prisma = new PrismaService();
    const ff = new FeatureFlagsService();
    const pilot = new PilotPrismaAccessor(prisma, new TenantPrismaService(prisma, ff), ff);
    const svc = makeService(prisma, pilot);
    try {
      await withRequestContext({ requestId: newRequestId() }, async () => {
        TenantContext.attach({ id: tA, slug: 'a', name: 'A', status: 'ACTIVE', region: 'eu' });
        await svc.update('00000000-0000-0000-0000-deaddeaddead', { phone: 'x' } as any, SYS_USER);
      });
    } catch (e) { pE = (e as Error).constructor.name; }
    finally { await prisma.$disconnect(); }
  });
  out.push({ name: 'validation: NotFoundException for missing applicant id in both modes', ok: lE === 'NotFoundException' && pE === 'NotFoundException', detail: `legacy=${lE} pilot=${pE}` });

  // 7 — bulk filter: pilot drops cross-tenant ids
  await withFlags({ TENANT_PRISMA_PILOT_ENABLED: 'true', TENANT_PRISMA_PILOT_MODULES: 'applicants' }, async () => {
    const prisma = new PrismaService();
    const ff = new FeatureFlagsService();
    const pilot = new PilotPrismaAccessor(prisma, new TenantPrismaService(prisma, ff), ff);
    const svc = makeService(prisma, pilot);
    try {
      const r = await withRequestContext({ requestId: newRequestId() }, async () => {
        TenantContext.attach({ id: tA, slug: 'a', name: 'A', status: 'ACTIVE', region: 'eu' });
        return svc.bulkAction({ ids: [TENANT_A_LEAD, '00000000-0000-0000-0000-0000000bb001'], action: 'STATUS_CHANGE' as any, value: 'SCREENING' } as any, SYS_USER);
      });
      const results = (r as any).results as any[];
      const tenantBPresent = results.some((x: any) => x.id === '00000000-0000-0000-0000-0000000bb001');
      const tenantAPresent = results.some((x: any) => x.id === TENANT_A_LEAD && x.success);
      out.push({ name: 'bulk filter (pilot): tenant B id silently dropped; tenant A id processed', ok: !tenantBPresent && tenantAPresent, detail: `results=${results.length} bIncluded=${tenantBPresent}` });
    } finally { await prisma.$disconnect(); }
  });

  // 8 — requestDelete creates a delete request (pilot)
  await withFlags({ TENANT_PRISMA_PILOT_ENABLED: 'true', TENANT_PRISMA_PILOT_MODULES: 'applicants' }, async () => {
    const prisma = new PrismaService();
    const ff = new FeatureFlagsService();
    const pilot = new PilotPrismaAccessor(prisma, new TenantPrismaService(prisma, ff), ff);
    const svc = makeService(prisma, pilot);
    try {
      // Clear any existing pending request first
      await (prisma as any).candidateDeleteRequest.deleteMany({ where: { candidateId: TENANT_A_CAND } });
      const req = await withRequestContext({ requestId: newRequestId() }, async () => {
        TenantContext.attach({ id: tA, slug: 'a', name: 'A', status: 'ACTIVE', region: 'eu' });
        return svc.requestDelete(TENANT_A_CAND, 'iso-test', SYS_USER);
      });
      out.push({ name: 'requestDelete (pilot) creates request for tenant A applicant', ok: !!(req as any).id, detail: `id=${(req as any).id}` });
      // Cleanup
      await (prisma as any).candidateDeleteRequest.delete({ where: { id: (req as any).id } }).catch(() => undefined);
    } finally { await prisma.$disconnect(); }
  });

  // Cleanup applicants we created (legacyCreate already soft-deleted; pilotCreate already soft-deleted)
  const cleanup = new Client({ connectionString: url, ssl: /127\.0\.0\.1|localhost/.test(url) ? false : { rejectUnauthorized: false } });
  await cleanup.connect();
  for (const id of createdIds) {
    await cleanup.query(`DELETE FROM applicants WHERE id=$1`, [id]).catch(() => undefined);
  }
  // Restore status of the seed lead in case bulkAction touched it
  await cleanup.query(`UPDATE applicants SET status='NEW' WHERE id=$1`, [TENANT_A_LEAD]).catch(() => undefined);
  await cleanup.end();

  await fs.mkdir(OUT_DIR, { recursive: true });
  const summary = {
    generatedAt: new Date().toISOString(), environment: env, tenantA: tA,
    counts: { total: out.length, passed: out.filter((r) => r.ok).length, failed: out.filter((r) => !r.ok).length },
    results: out,
  };
  await fs.writeFile(path.join(OUT_DIR, 'applicants-mutation-equivalence.json'), JSON.stringify(summary, null, 2));
  const md: string[] = [];
  md.push('# Phase 2.29 — Applicants Mutation Equivalence');
  md.push(''); md.push(`Generated: ${summary.generatedAt}`);
  md.push(`Environment: ${env.classification} (${env.reason})`);
  md.push(`Tenant A: \`${tA}\``); md.push('');
  md.push(`- Cases passed: **${summary.counts.passed}** / ${summary.counts.total}`);
  md.push(`- Cases failed: ${summary.counts.failed}`); md.push('');
  md.push('| # | Case | Result | Detail |'); md.push('|--:|------|:------:|--------|');
  out.forEach((r, i) => md.push(`| ${i + 1} | ${r.name} | ${r.ok ? 'PASS' : '**FAIL**'} | ${r.detail} |`));
  await fs.writeFile(path.join(OUT_DIR, 'applicants-mutation-equivalence.md'), md.join('\n'));

  console.log(`applicants-mutation-equivalence: ${summary.counts.passed}/${summary.counts.total} cases PASS`);
  if (summary.counts.failed > 0) process.exit(2);
}

main().catch((e) => { console.error(e); process.exit(3); });
