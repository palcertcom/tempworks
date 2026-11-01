/**
 * Phase 2.31 — applicants deferred-paths isolation harness.
 *
 *   1. uploadPhoto pilot tenant=A on tenant-B applicant raises 404; storage NOT touched.
 *   2. uploadPhoto pilot same-tenant succeeds and writes exactly 1 storage call.
 *   3. publicSubmit pilot + ALS A + agencyId of A: row stamped tenantId=A.
 *   4. publicSubmit pilot + ALS A + agencyId of B: rejected (TENANT_MISMATCH); no row created.
 *   5. publicSubmit pilot, no ALS, no agencyId: rejected (NO_TENANT); no row created.
 *   6. publicSubmit pilot + agencyId of B (no ALS): row stamped tenantId=B; tenant A cannot see it.
 *   7. publicSubmit legacy (flag off), no ALS, no agencyId: row created tenantId=NULL.
 *   8. concurrent ALS frames: parallel publicSubmit on A and B yield correct attribution.
 *   9. source-level meta-assertion: phase231 patterns present.
 *
 * Output: backend/reports/saas/phase2/applicants-deferred-paths-isolation.{json,md}
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
import { TenantContext, withRequestContext, newRequestId } from '../../../src/saas/context/als';

autoLoadEnv(__filename);

const OUT_DIR = path.resolve(__dirname, '..', '..', '..', 'reports', 'saas', 'phase2');
const SRC_FILE = path.resolve(__dirname, '..', '..', '..', 'src', 'applicants', 'applicants.service.ts');
interface CaseResult { name: string; ok: boolean; detail: string; }

const TENANT_A_AGENCY = 'aaaaaaa1-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const TENANT_B_AGENCY = 'bbbbbbb2-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const TENANT_A_LEAD = '00000000-0000-0000-0000-0000000aa001';
const TENANT_B_LEAD = '00000000-0000-0000-0000-0000000bb001';

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

interface StorageStubCall { keyPrefix: string; size: number; }
function makeStorageStub(): { storage: any; calls: StorageStubCall[] } {
  const calls: StorageStubCall[] = [];
  const storage: any = {
    onModuleInit: async () => undefined,
    uploadFile: async (buffer: Buffer, opts: any) => {
      calls.push({ keyPrefix: opts.keyPrefix, size: buffer.length });
      return { url: `https://stub/${opts.keyPrefix}/${calls.length}.png`, key: `${opts.keyPrefix}/${calls.length}.png` };
    },
    deleteFileByUrlOrKey: async () => undefined,
  };
  return { storage, calls };
}

function makeService(prisma: PrismaService, pilot: PilotPrismaAccessor, storage: any): ApplicantsService {
  const emailStub: any = { sendApplicationConfirmation: async () => undefined };
  return new ApplicantsService(prisma, emailStub, storage, pilot, new TenantAuditLogService(prisma, new FeatureFlagsService()));
}

async function main(): Promise<void> {
  const url = getDatabaseUrl();
  const env = classifyRuntimeEnv();
  if (!isStagingClassification(env.classification)) {
    console.error(`[applicants-deferred-paths-isolation] refusing on classification=${env.classification}`);
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
  const createdIds: string[] = [];
  const stamp = Date.now().toString(36);
  const tinyPng = Buffer.from('89504E470D0A1A0A', 'hex');

  // 1 — uploadPhoto cross-tenant rejection without storage write
  await withFlags({ TENANT_PRISMA_PILOT_ENABLED: 'true', TENANT_PRISMA_PILOT_MODULES: 'applicants' }, async () => {
    const prisma = new PrismaService();
    const ff = new FeatureFlagsService();
    const pilot = new PilotPrismaAccessor(prisma, new TenantPrismaService(prisma, ff), ff);
    const { storage, calls } = makeStorageStub();
    const svc = makeService(prisma, pilot, storage);
    try {
      let threw = false;
      try {
        await withRequestContext({ requestId: newRequestId() }, async () => {
          TenantContext.attach({ id: tA, slug: 'a', name: 'A', status: 'ACTIVE', region: 'eu' });
          await svc.uploadPhoto(TENANT_B_LEAD, { buffer: tinyPng, mimetype: 'image/png', originalname: 'b.png' } as any);
        });
      } catch { threw = true; }
      out.push({ name: '1. uploadPhoto cross-tenant rejected; no storage call', ok: threw && calls.length === 0, detail: `threw=${threw} uploads=${calls.length}` });
    } finally { await prisma.$disconnect(); }
  });

  // 2 — uploadPhoto same-tenant succeeds with 1 storage call
  await withFlags({ TENANT_PRISMA_PILOT_ENABLED: 'true', TENANT_PRISMA_PILOT_MODULES: 'applicants' }, async () => {
    const prisma = new PrismaService();
    const ff = new FeatureFlagsService();
    const pilot = new PilotPrismaAccessor(prisma, new TenantPrismaService(prisma, ff), ff);
    const { storage, calls } = makeStorageStub();
    const svc = makeService(prisma, pilot, storage);
    try {
      const r: any = await withRequestContext({ requestId: newRequestId() }, async () => {
        TenantContext.attach({ id: tA, slug: 'a', name: 'A', status: 'ACTIVE', region: 'eu' });
        return svc.uploadPhoto(TENANT_A_LEAD, { buffer: tinyPng, mimetype: 'image/png', originalname: 'a.png' } as any);
      });
      out.push({ name: '2. uploadPhoto same-tenant succeeds; 1 storage call', ok: !!r?.id && calls.length === 1, detail: `id=${r?.id} uploads=${calls.length}` });
    } finally { await prisma.$disconnect(); }
  });

  // 3 — publicSubmit ALS A + agencyId A
  await withFlags({ TENANT_PRISMA_PILOT_ENABLED: 'true', TENANT_PRISMA_PILOT_MODULES: 'applicants' }, async () => {
    const prisma = new PrismaService();
    const ff = new FeatureFlagsService();
    const pilot = new PilotPrismaAccessor(prisma, new TenantPrismaService(prisma, ff), ff);
    const svc = makeService(prisma, pilot, makeStorageStub().storage);
    try {
      const r: any = await withRequestContext({ requestId: newRequestId() }, async () => {
        TenantContext.attach({ id: tA, slug: 'a', name: 'A', status: 'ACTIVE', region: 'eu' });
        return svc.publicSubmit({ firstName: 'P3', lastName: stamp, email: `p3-${stamp}@a.test`, phone: '+1', nationality: 'GB', residencyStatus: 'Other', hasNationalInsurance: false, hasWorkAuthorization: false, availability: 'Immediate', hasDrivingLicense: false, agencyId: TENANT_A_AGENCY } as any);
      });
      createdIds.push(r.id);
      out.push({ name: '3. publicSubmit ALS A + agencyId A: tenantId=A', ok: r.tenantId === tA, detail: `tenantId=${r.tenantId}` });
    } finally { await prisma.$disconnect(); }
  });

  // 4 — publicSubmit ALS A + agencyId B → TENANT_MISMATCH
  await withFlags({ TENANT_PRISMA_PILOT_ENABLED: 'true', TENANT_PRISMA_PILOT_MODULES: 'applicants' }, async () => {
    const prisma = new PrismaService();
    const ff = new FeatureFlagsService();
    const pilot = new PilotPrismaAccessor(prisma, new TenantPrismaService(prisma, ff), ff);
    const svc = makeService(prisma, pilot, makeStorageStub().storage);
    try {
      let threw = false; let code = '';
      try {
        await withRequestContext({ requestId: newRequestId() }, async () => {
          TenantContext.attach({ id: tA, slug: 'a', name: 'A', status: 'ACTIVE', region: 'eu' });
          await svc.publicSubmit({ firstName: 'P4', lastName: stamp, email: `p4-${stamp}@a.test`, phone: '+1', nationality: 'GB', residencyStatus: 'Other', hasNationalInsurance: false, hasWorkAuthorization: false, availability: 'Immediate', hasDrivingLicense: false, agencyId: TENANT_B_AGENCY } as any);
        });
      } catch (e: any) { threw = true; code = e?.response?.code ?? e?.code ?? ''; }
      // Verify no row created with that email
      const dup: any = await (prisma as any).applicant.findFirst({ where: { email: `p4-${stamp}@a.test` } });
      out.push({ name: '4. ALS A + agencyId B: TENANT_MISMATCH; no row', ok: threw && code === 'APPLICANT.PUBLIC_SUBMIT_TENANT_MISMATCH' && !dup, detail: `threw=${threw} code=${code} dup=${!!dup}` });
    } finally { await prisma.$disconnect(); }
  });

  // 5 — publicSubmit pilot, no ALS, no agencyId → NO_TENANT
  await withFlags({ TENANT_PRISMA_PILOT_ENABLED: 'true', TENANT_PRISMA_PILOT_MODULES: 'applicants' }, async () => {
    const prisma = new PrismaService();
    const ff = new FeatureFlagsService();
    const pilot = new PilotPrismaAccessor(prisma, new TenantPrismaService(prisma, ff), ff);
    const svc = makeService(prisma, pilot, makeStorageStub().storage);
    try {
      let threw = false; let code = '';
      try {
        await svc.publicSubmit({ firstName: 'P5', lastName: stamp, email: `p5-${stamp}@a.test`, phone: '+1', nationality: 'GB', residencyStatus: 'Other', hasNationalInsurance: false, hasWorkAuthorization: false, availability: 'Immediate', hasDrivingLicense: false } as any);
      } catch (e: any) { threw = true; code = e?.response?.code ?? e?.code ?? ''; }
      const dup: any = await (prisma as any).applicant.findFirst({ where: { email: `p5-${stamp}@a.test` } });
      out.push({ name: '5. pilot no ALS no agencyId: NO_TENANT; no row', ok: threw && code === 'APPLICANT.PUBLIC_SUBMIT_NO_TENANT' && !dup, detail: `threw=${threw} code=${code} dup=${!!dup}` });
    } finally { await prisma.$disconnect(); }
  });

  // 6 — publicSubmit pilot agencyId B (no ALS): tenant B; tenant A cannot see it
  await withFlags({ TENANT_PRISMA_PILOT_ENABLED: 'true', TENANT_PRISMA_PILOT_MODULES: 'applicants' }, async () => {
    const prisma = new PrismaService();
    const ff = new FeatureFlagsService();
    const pilot = new PilotPrismaAccessor(prisma, new TenantPrismaService(prisma, ff), ff);
    const svc = makeService(prisma, pilot, makeStorageStub().storage);
    try {
      const r: any = await svc.publicSubmit({ firstName: 'P6', lastName: stamp, email: `p6-${stamp}@a.test`, phone: '+1', nationality: 'GB', residencyStatus: 'Other', hasNationalInsurance: false, hasWorkAuthorization: false, availability: 'Immediate', hasDrivingLicense: false, agencyId: TENANT_B_AGENCY } as any);
      createdIds.push(r.id);
      // tenant A list should NOT see it
      const seen = await withRequestContext({ requestId: newRequestId() }, async () => {
        TenantContext.attach({ id: tA, slug: 'a', name: 'A', status: 'ACTIVE', region: 'eu' });
        const list = await svc.findAll({} as any, undefined as any);
        return (list as any).data.find((a: any) => a.id === r.id);
      });
      out.push({ name: '6. agencyId B (no ALS) → tenantId=B; tenant A cannot see it', ok: r.tenantId === tB && !seen, detail: `tenantId=${r.tenantId} aSees=${!!seen}` });
    } finally { await prisma.$disconnect(); }
  });

  // 7 — legacy publicSubmit, no ALS no agencyId: NULL tenant row
  await withFlags({ TENANT_PRISMA_PILOT_ENABLED: 'false' }, async () => {
    const prisma = new PrismaService();
    const ff = new FeatureFlagsService();
    const pilot = new PilotPrismaAccessor(prisma, new TenantPrismaService(prisma, ff), ff);
    const svc = makeService(prisma, pilot, makeStorageStub().storage);
    try {
      const r: any = await svc.publicSubmit({ firstName: 'P7', lastName: stamp, email: `p7-${stamp}@a.test`, phone: '+1', nationality: 'GB', residencyStatus: 'Other', hasNationalInsurance: false, hasWorkAuthorization: false, availability: 'Immediate', hasDrivingLicense: false } as any);
      createdIds.push(r.id);
      out.push({ name: '7. legacy: tenantId NULL (pre-2.31 behaviour)', ok: r.tenantId === null || r.tenantId === undefined, detail: `tenantId=${r.tenantId ?? 'null'}` });
    } finally { await prisma.$disconnect(); }
  });

  // 8 — concurrent ALS frames
  await withFlags({ TENANT_PRISMA_PILOT_ENABLED: 'true', TENANT_PRISMA_PILOT_MODULES: 'applicants' }, async () => {
    const prisma = new PrismaService();
    const ff = new FeatureFlagsService();
    const pilot = new PilotPrismaAccessor(prisma, new TenantPrismaService(prisma, ff), ff);
    const svc = makeService(prisma, pilot, makeStorageStub().storage);
    try {
      const [a, b] = await Promise.all([
        withRequestContext({ requestId: newRequestId() }, async () => {
          TenantContext.attach({ id: tA, slug: 'a', name: 'A', status: 'ACTIVE', region: 'eu' });
          return svc.publicSubmit({ firstName: 'P8a', lastName: stamp, email: `p8a-${stamp}@a.test`, phone: '+1', nationality: 'GB', residencyStatus: 'Other', hasNationalInsurance: false, hasWorkAuthorization: false, availability: 'Immediate', hasDrivingLicense: false, agencyId: TENANT_A_AGENCY } as any);
        }),
        withRequestContext({ requestId: newRequestId() }, async () => {
          TenantContext.attach({ id: tB, slug: 'b', name: 'B', status: 'ACTIVE', region: 'eu' });
          return svc.publicSubmit({ firstName: 'P8b', lastName: stamp, email: `p8b-${stamp}@b.test`, phone: '+1', nationality: 'GB', residencyStatus: 'Other', hasNationalInsurance: false, hasWorkAuthorization: false, availability: 'Immediate', hasDrivingLicense: false, agencyId: TENANT_B_AGENCY } as any);
        }),
      ]);
      createdIds.push((a as any).id, (b as any).id);
      out.push({ name: '8. concurrent ALS frames isolated', ok: (a as any).tenantId === tA && (b as any).tenantId === tB, detail: `a=${(a as any).tenantId} b=${(b as any).tenantId}` });
    } finally { await prisma.$disconnect(); }
  });

  // 9 — source-level meta-assertion
  const src = await fs.readFile(SRC_FILE, 'utf8');
  const ok = /phase231-storage-guard/.test(src) && /phase231-public-submit-attribution/.test(src) && /resolvePublicSubmitTenantId\(/.test(src);
  out.push({ name: '9. source-level: phase231 patterns present', ok, detail: ok ? 'OK' : 'missing pattern' });

  // cleanup
  if (createdIds.length) {
    const prisma = new PrismaService();
    try { await (prisma as any).applicant.deleteMany({ where: { id: { in: createdIds } } }); } finally { await prisma.$disconnect(); }
  }

  await fs.mkdir(OUT_DIR, { recursive: true });
  const passed = out.filter((c) => c.ok).length;
  const total = out.length;
  await fs.writeFile(path.join(OUT_DIR, 'applicants-deferred-paths-isolation.json'),
    JSON.stringify({ passed, total, cases: out }, null, 2));
  const md = [
    `# Phase 2.31 — applicants deferred-paths isolation`,
    ``,
    `**${passed}/${total} PASS**`,
    ``,
    ...out.map((c) => `- ${c.ok ? 'PASS' : 'FAIL'} — ${c.name} — ${c.detail}`),
    ``,
  ].join('\n');
  await fs.writeFile(path.join(OUT_DIR, 'applicants-deferred-paths-isolation.md'), md);
  console.log(`[applicants-deferred-paths-isolation] ${passed}/${total} PASS`);
  process.exit(passed === total ? 0 : 1);
}

main().catch((err) => { console.error(err); process.exit(2); });
