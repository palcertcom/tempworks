/**
 * Phase 2.31 — applicants deferred-paths equivalence harness.
 *
 *   1. uploadPhoto legacy: shape preserved (id present, photoUrl set)
 *   2. uploadPhoto pilot: shape preserved (same fields populated)
 *   3. uploadPhoto pilot same-tenant: storage upload count = 1
 *   4. publicSubmit legacy: row created, tenantId = NULL (pre-2.31 behaviour)
 *   5. publicSubmit pilot + agencyId of A (no ALS): tenantId = A
 *   6. publicSubmit pilot + ALS A (no agencyId): tenantId = A
 *
 * Output: backend/reports/saas/phase2/applicants-deferred-paths-equivalence.{json,md}
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
interface CaseResult { name: string; ok: boolean; detail: string; }

const TENANT_A_AGENCY = 'aaaaaaa1-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const TENANT_A_LEAD = '00000000-0000-0000-0000-0000000aa001';

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
    console.error(`[applicants-deferred-paths-equivalence] refusing on classification=${env.classification}`);
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
  const tinyPng = Buffer.from('89504E470D0A1A0A', 'hex');

  // 1 — uploadPhoto legacy
  await withFlags({ TENANT_PRISMA_PILOT_ENABLED: 'false' }, async () => {
    const prisma = new PrismaService();
    const ff = new FeatureFlagsService();
    const pilot = new PilotPrismaAccessor(prisma, new TenantPrismaService(prisma, ff), ff);
    const { storage, calls } = makeStorageStub();
    const svc = makeService(prisma, pilot, storage);
    try {
      const r: any = await svc.uploadPhoto(TENANT_A_LEAD, { buffer: tinyPng, mimetype: 'image/png', originalname: 'a.png' } as any);
      out.push({ name: '1. uploadPhoto legacy: shape preserved', ok: !!r?.id && typeof r.photoUrl === 'string', detail: `id=${r?.id} hasPhotoUrl=${!!r?.photoUrl} uploads=${calls.length}` });
    } finally { await prisma.$disconnect(); }
  });

  // 2 + 3 — uploadPhoto pilot
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
      out.push({ name: '2. uploadPhoto pilot: shape preserved', ok: !!r?.id && typeof r.photoUrl === 'string', detail: `id=${r?.id} hasPhotoUrl=${!!r?.photoUrl}` });
      out.push({ name: '3. uploadPhoto pilot same-tenant: 1 storage call', ok: calls.length === 1, detail: `uploads=${calls.length}` });
    } finally { await prisma.$disconnect(); }
  });

  // 4 — publicSubmit legacy
  await withFlags({ TENANT_PRISMA_PILOT_ENABLED: 'false' }, async () => {
    const prisma = new PrismaService();
    const ff = new FeatureFlagsService();
    const pilot = new PilotPrismaAccessor(prisma, new TenantPrismaService(prisma, ff), ff);
    const svc = makeService(prisma, pilot, makeStorageStub().storage);
    try {
      const r: any = await svc.publicSubmit({ firstName: 'Pub', lastName: 'Legacy', email: `pl-${stamp}@a.test`, phone: '+1', nationality: 'GB', residencyStatus: 'Other', hasNationalInsurance: false, hasWorkAuthorization: false, availability: 'Immediate', hasDrivingLicense: false } as any);
      createdIds.push(r.id);
      out.push({ name: '4. publicSubmit legacy: tenantId = NULL', ok: r.tenantId === null || r.tenantId === undefined, detail: `id=${r.id} tenantId=${r.tenantId ?? 'null'}` });
    } finally { await prisma.$disconnect(); }
  });

  // 5 — publicSubmit pilot + agencyId only (no ALS)
  await withFlags({ TENANT_PRISMA_PILOT_ENABLED: 'true', TENANT_PRISMA_PILOT_MODULES: 'applicants' }, async () => {
    const prisma = new PrismaService();
    const ff = new FeatureFlagsService();
    const pilot = new PilotPrismaAccessor(prisma, new TenantPrismaService(prisma, ff), ff);
    const svc = makeService(prisma, pilot, makeStorageStub().storage);
    try {
      const r: any = await svc.publicSubmit({ firstName: 'Pub', lastName: 'Agency', email: `pa-${stamp}@a.test`, phone: '+1', nationality: 'GB', residencyStatus: 'Other', hasNationalInsurance: false, hasWorkAuthorization: false, availability: 'Immediate', hasDrivingLicense: false, agencyId: TENANT_A_AGENCY } as any);
      createdIds.push(r.id);
      out.push({ name: '5. publicSubmit pilot + agencyId (no ALS): tenantId = A', ok: r.tenantId === tA, detail: `tenantId=${r.tenantId}` });
    } finally { await prisma.$disconnect(); }
  });

  // 6 — publicSubmit pilot + ALS A only (no agencyId)
  await withFlags({ TENANT_PRISMA_PILOT_ENABLED: 'true', TENANT_PRISMA_PILOT_MODULES: 'applicants' }, async () => {
    const prisma = new PrismaService();
    const ff = new FeatureFlagsService();
    const pilot = new PilotPrismaAccessor(prisma, new TenantPrismaService(prisma, ff), ff);
    const svc = makeService(prisma, pilot, makeStorageStub().storage);
    try {
      const r: any = await withRequestContext({ requestId: newRequestId() }, async () => {
        TenantContext.attach({ id: tA, slug: 'a', name: 'A', status: 'ACTIVE', region: 'eu' });
        return svc.publicSubmit({ firstName: 'Pub', lastName: 'Als', email: `pa2-${stamp}@a.test`, phone: '+1', nationality: 'GB', residencyStatus: 'Other', hasNationalInsurance: false, hasWorkAuthorization: false, availability: 'Immediate', hasDrivingLicense: false } as any);
      });
      createdIds.push(r.id);
      out.push({ name: '6. publicSubmit pilot + ALS A: tenantId = A', ok: r.tenantId === tA, detail: `tenantId=${r.tenantId}` });
    } finally { await prisma.$disconnect(); }
  });

  // cleanup
  if (createdIds.length) {
    const prisma = new PrismaService();
    try { await (prisma as any).applicant.deleteMany({ where: { id: { in: createdIds } } }); } finally { await prisma.$disconnect(); }
  }

  await fs.mkdir(OUT_DIR, { recursive: true });
  const passed = out.filter((c) => c.ok).length;
  const total = out.length;
  await fs.writeFile(path.join(OUT_DIR, 'applicants-deferred-paths-equivalence.json'),
    JSON.stringify({ passed, total, cases: out }, null, 2));
  const md = [
    `# Phase 2.31 — applicants deferred-paths equivalence`,
    ``,
    `**${passed}/${total} PASS**`,
    ``,
    ...out.map((c) => `- ${c.ok ? 'PASS' : 'FAIL'} — ${c.name} — ${c.detail}`),
    ``,
  ].join('\n');
  await fs.writeFile(path.join(OUT_DIR, 'applicants-deferred-paths-equivalence.md'), md);
  console.log(`[applicants-deferred-paths-equivalence] ${passed}/${total} PASS`);
  process.exit(passed === total ? 0 : 1);
}

main().catch((err) => { console.error(err); process.exit(2); });
