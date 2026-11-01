/**
 * Phase 2.32 — applicants conversion isolation harness.
 *
 *   1. tenant A cannot convert tenant B applicant (404; no Employee created)
 *   2. tenant A conversion creates Employee.tenantId = A
 *   3. tenant A conversion re-links ONLY tenant A documents
 *   4. tenant A conversion re-links ONLY tenant A financial records
 *   5. tenant B documents (with same applicantId stamp) remain untouched
 *   6. tenant B financial records (with same applicantId stamp) remain untouched
 *   7. legacy mode: same row set re-linked as today (flag-off parity)
 *   8. concurrent ALS frames isolated (parallel A and B conversions)
 *   9. source-level meta-assertion: phase232 patterns present
 *
 * Output: backend/reports/saas/phase2/applicants-conversion-isolation.{json,md}
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

const TENANT_A_AGENCY = 'aaaaaaa1-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const TENANT_B_AGENCY = 'bbbbbbb2-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const DOC_TYPE = '00000000-0000-0000-0000-00000000dt01';
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

const dto = { addressLine1: '1 Quay St', city: 'Dublin', country: 'IE', postalCode: 'D01', yearsExperience: 1 };

async function seedCandidate(prisma: PrismaService, tenantId: string, agencyId: string, suffix: string): Promise<string> {
  const a: any = await (prisma as any).applicant.create({
    data: {
      firstName: 'Conv', lastName: suffix, email: `iso-${suffix}@x.test`, phone: '+1', nationality: 'IE',
      residencyStatus: 'Other', hasNationalInsurance: false, hasWorkAuthorization: false,
      availability: 'Immediate', hasDrivingLicense: false, agencyId,
      leadNumber: `L${suffix.slice(0,8)}`, candidateNumber: `C${suffix.slice(0,8)}`, candidateConvertedAt: new Date(),
      tier: 'CANDIDATE', status: 'NEW', approvalStatus: 'APPROVED', source: 'STAFF_CREATED',
      tenantId,
    } as any,
  });
  return a.id;
}

async function seedDoc(prisma: PrismaService, applicantId: string, tenantId: string, suffix: string): Promise<string> {
  const d: any = await (prisma as any).document.create({
    data: {
      name: `doc-${suffix}`, docId: `D${suffix}`,
      documentTypeId: DOC_TYPE, entityType: 'APPLICANT', entityId: applicantId,
      fileUrl: 'https://stub/doc', mimeType: 'application/pdf', fileSize: 1, status: 'PENDING',
      uploadedById: SYS_USER, tenantId,
    },
  });
  return d.id;
}

async function seedFin(prisma: PrismaService, applicantId: string, tenantId: string): Promise<string> {
  const f: any = await (prisma as any).financialRecord.create({
    data: {
      entityType: 'APPLICANT', entityId: applicantId, applicantId, stageAtCreation: 'CANDIDATE',
      transactionDate: new Date(), currency: 'EUR', transactionType: 'FEE_INCOMING',
      companyDisbursedAmount: 0, employeeOrAgencyPaidAmount: 100, status: 'PENDING',
      createdById: SYS_USER, tenantId,
    },
  });
  return f.id;
}

async function main(): Promise<void> {
  const url = getDatabaseUrl();
  const env = classifyRuntimeEnv();
  if (!isStagingClassification(env.classification)) {
    console.error(`[applicants-conversion-isolation] refusing on classification=${env.classification}`);
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
  const cleanup: { applicants: string[]; employees: string[]; docs: string[]; fins: string[] } = { applicants: [], employees: [], docs: [], fins: [] };
  const stamp = Date.now().toString(36);

  // 1 — cross-tenant rejection
  await withFlags({ TENANT_PRISMA_PILOT_ENABLED: 'true', TENANT_PRISMA_PILOT_MODULES: 'applicants' }, async () => {
    const prisma = new PrismaService();
    const ff = new FeatureFlagsService();
    const pilot = new PilotPrismaAccessor(prisma, new TenantPrismaService(prisma, ff), ff);
    const svc = makeService(prisma, pilot);
    try {
      const bid = await seedCandidate(prisma, tB, TENANT_B_AGENCY, `i1-${stamp}`); cleanup.applicants.push(bid);
      let threw = false;
      try {
        await withRequestContext({ requestId: newRequestId() }, async () => {
          TenantContext.attach({ id: tA, slug: 'a', name: 'A', status: 'ACTIVE', region: 'eu' });
          await svc.convertToEmployee(bid, dto as any, SYS_USER);
        });
      } catch { threw = true; }
      const empCount: number = await (prisma as any).employee.count({ where: { email: `iso-i1-${stamp}@x.test` } });
      out.push({ name: '1. tenant A: convert(tenantB-id) rejected; no Employee created', ok: threw && empCount === 0, detail: `threw=${threw} employees=${empCount}` });
    } finally { await prisma.$disconnect(); }
  });

  // 2-6 — selective re-link with cross-tenant noise rows
  await withFlags({ TENANT_PRISMA_PILOT_ENABLED: 'true', TENANT_PRISMA_PILOT_MODULES: 'applicants' }, async () => {
    const prisma = new PrismaService();
    const ff = new FeatureFlagsService();
    const pilot = new PilotPrismaAccessor(prisma, new TenantPrismaService(prisma, ff), ff);
    const svc = makeService(prisma, pilot);
    try {
      const aid = await seedCandidate(prisma, tA, TENANT_A_AGENCY, `i2-${stamp}`); cleanup.applicants.push(aid);
      // legitimate tenant-A rows
      const dA = await seedDoc(prisma, aid, tA, `i2A-${stamp}`); cleanup.docs.push(dA);
      const fA = await seedFin(prisma, aid, tA); cleanup.fins.push(fA);
      // adversarial tenant-B rows pointing at tenant A's applicantId (drift simulation)
      const dB = await seedDoc(prisma, aid, tB, `i2B-${stamp}`); cleanup.docs.push(dB);
      const fB = await seedFin(prisma, aid, tB); cleanup.fins.push(fB);
      const r: any = await withRequestContext({ requestId: newRequestId() }, async () => {
        TenantContext.attach({ id: tA, slug: 'a', name: 'A', status: 'ACTIVE', region: 'eu' });
        return svc.convertToEmployee(aid, dto as any, SYS_USER);
      });
      cleanup.employees.push(r.employee.id);
      const empRow: any = await (prisma as any).employee.findUnique({ where: { id: r.employee.id } });
      const dAfterA: any = await (prisma as any).document.findUnique({ where: { id: dA } });
      const dAfterB: any = await (prisma as any).document.findUnique({ where: { id: dB } });
      const fAfterA: any = await (prisma as any).financialRecord.findUnique({ where: { id: fA } });
      const fAfterB: any = await (prisma as any).financialRecord.findUnique({ where: { id: fB } });
      out.push({ name: '2. pilot: Employee.tenantId = A', ok: empRow.tenantId === tA, detail: `tenantId=${empRow.tenantId}` });
      out.push({ name: '3. pilot: tenant A document re-linked to EMPLOYEE', ok: dAfterA.entityType === 'EMPLOYEE' && dAfterA.entityId === r.employee.id, detail: `entityType=${dAfterA.entityType}` });
      out.push({ name: '4. pilot: tenant A FinancialRecord re-linked to EMPLOYEE', ok: fAfterA.entityType === 'EMPLOYEE' && fAfterA.entityId === r.employee.id, detail: `entityType=${fAfterA.entityType}` });
      out.push({ name: '5. pilot: tenant B document NOT smuggled', ok: dAfterB.entityType === 'APPLICANT' && dAfterB.entityId === aid, detail: `entityType=${dAfterB.entityType} entityId=${dAfterB.entityId.slice(0,8)}` });
      out.push({ name: '6. pilot: tenant B FinancialRecord NOT smuggled', ok: fAfterB.entityType === 'APPLICANT' && fAfterB.entityId === aid, detail: `entityType=${fAfterB.entityType}` });
    } finally { await prisma.$disconnect(); }
  });

  // 7 — legacy parity: BOTH tenant rows re-linked (today's behaviour)
  await withFlags({ TENANT_PRISMA_PILOT_ENABLED: 'false' }, async () => {
    const prisma = new PrismaService();
    const ff = new FeatureFlagsService();
    const pilot = new PilotPrismaAccessor(prisma, new TenantPrismaService(prisma, ff), ff);
    const svc = makeService(prisma, pilot);
    try {
      const aid = await seedCandidate(prisma, tA, TENANT_A_AGENCY, `i7-${stamp}`); cleanup.applicants.push(aid);
      const dA = await seedDoc(prisma, aid, tA, `i7A-${stamp}`); cleanup.docs.push(dA);
      const dB = await seedDoc(prisma, aid, tB, `i7B-${stamp}`); cleanup.docs.push(dB);
      const r: any = await svc.convertToEmployee(aid, dto as any, SYS_USER);
      cleanup.employees.push(r.employee.id);
      const dAfterA: any = await (prisma as any).document.findUnique({ where: { id: dA } });
      const dAfterB: any = await (prisma as any).document.findUnique({ where: { id: dB } });
      // In legacy mode, the where-clause has no tenantId filter, so BOTH rows re-link.
      // This documents that pre-2.32 behaviour is byte-identical.
      const ok = dAfterA.entityType === 'EMPLOYEE' && dAfterB.entityType === 'EMPLOYEE';
      out.push({ name: '7. legacy: both rows re-linked (today\'s behaviour)', ok, detail: `A=${dAfterA.entityType} B=${dAfterB.entityType}` });
    } finally { await prisma.$disconnect(); }
  });

  // 8 — concurrent ALS frames
  await withFlags({ TENANT_PRISMA_PILOT_ENABLED: 'true', TENANT_PRISMA_PILOT_MODULES: 'applicants' }, async () => {
    const prisma = new PrismaService();
    const ff = new FeatureFlagsService();
    const pilot = new PilotPrismaAccessor(prisma, new TenantPrismaService(prisma, ff), ff);
    const svc = makeService(prisma, pilot);
    try {
      const aid = await seedCandidate(prisma, tA, TENANT_A_AGENCY, `i8a-${stamp}`); cleanup.applicants.push(aid);
      const bid = await seedCandidate(prisma, tB, TENANT_B_AGENCY, `i8b-${stamp}`); cleanup.applicants.push(bid);
      const [a, b] = await Promise.all([
        withRequestContext({ requestId: newRequestId() }, async () => {
          TenantContext.attach({ id: tA, slug: 'a', name: 'A', status: 'ACTIVE', region: 'eu' });
          return svc.convertToEmployee(aid, dto as any, SYS_USER);
        }),
        withRequestContext({ requestId: newRequestId() }, async () => {
          TenantContext.attach({ id: tB, slug: 'b', name: 'B', status: 'ACTIVE', region: 'eu' });
          return svc.convertToEmployee(bid, dto as any, SYS_USER);
        }),
      ]);
      cleanup.employees.push((a as any).employee.id, (b as any).employee.id);
      const eA: any = await (prisma as any).employee.findUnique({ where: { id: (a as any).employee.id } });
      const eB: any = await (prisma as any).employee.findUnique({ where: { id: (b as any).employee.id } });
      out.push({ name: '8. concurrent ALS frames: A→A, B→B', ok: eA.tenantId === tA && eB.tenantId === tB, detail: `eA=${eA.tenantId} eB=${eB.tenantId}` });
    } finally { await prisma.$disconnect(); }
  });

  // 9 — source-level
  const src = await fs.readFile(SRC_FILE, 'utf8');
  const ok = /phase232-conversion-gate/.test(src) && /\.\.\.tWhere/.test(src);
  out.push({ name: '9. source-level: phase232 patterns present', ok, detail: ok ? 'OK' : 'missing pattern' });

  // cleanup
  const prisma = new PrismaService();
  try {
    if (cleanup.fins.length)       await (prisma as any).financialRecord.deleteMany({ where: { id: { in: cleanup.fins } } });
    if (cleanup.docs.length)       await (prisma as any).document.deleteMany({ where: { id: { in: cleanup.docs } } });
    if (cleanup.employees.length)  await (prisma as any).employeeStage.deleteMany({ where: { employeeId: { in: cleanup.employees } } });
    if (cleanup.employees.length)  await (prisma as any).employee.deleteMany({ where: { id: { in: cleanup.employees } } });
    if (cleanup.applicants.length) await (prisma as any).applicant.deleteMany({ where: { id: { in: cleanup.applicants } } });
  } finally { await prisma.$disconnect(); }

  await fs.mkdir(OUT_DIR, { recursive: true });
  const passed = out.filter((c) => c.ok).length;
  const total = out.length;
  await fs.writeFile(path.join(OUT_DIR, 'applicants-conversion-isolation.json'),
    JSON.stringify({ passed, total, cases: out }, null, 2));
  const md = [
    `# Phase 2.32 — applicants conversion isolation`, ``,
    `**${passed}/${total} PASS**`, ``,
    ...out.map((c) => `- ${c.ok ? 'PASS' : 'FAIL'} — ${c.name} — ${c.detail}`), ``,
  ].join('\n');
  await fs.writeFile(path.join(OUT_DIR, 'applicants-conversion-isolation.md'), md);
  console.log(`[applicants-conversion-isolation] ${passed}/${total} PASS`);
  process.exit(passed === total ? 0 : 1);
}

main().catch((err) => { console.error(err); process.exit(2); });
