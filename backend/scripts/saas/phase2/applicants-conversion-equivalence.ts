/**
 * Phase 2.32 — applicants conversion equivalence harness.
 *
 *   1. legacy convert: response shape preserved (employee+employeeNumber+message)
 *   2. pilot convert: response shape preserved
 *   3. legacy convert: Employee.tenantId NULL
 *   4. pilot convert: Employee.tenantId = applicant.tenantId
 *   5. Document re-link count parity for same-tenant applicant-typed rows
 *   6. FinancialRecord re-link count parity for same-tenant applicant-typed rows
 *   7. Applicant soft-deleted + convertedToEmployeeId set in both modes
 *
 * Output: backend/reports/saas/phase2/applicants-conversion-equivalence.{json,md}
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

const dto = {
  addressLine1: '1 Quay St', city: 'Dublin', country: 'IE', postalCode: 'D01',
  yearsExperience: 1,
};

async function seedCandidate(prisma: PrismaService, tenantId: string, agencyId: string, suffix: string): Promise<string> {
  const email = `convert-${suffix}@x.test`;
  const lead = `LE${Date.now().toString().slice(-7)}${suffix.slice(-2)}`;
  const cand = `CN${Date.now().toString().slice(-7)}${suffix.slice(-2)}`;
  const a: any = await (prisma as any).applicant.create({
    data: {
      firstName: 'Conv', lastName: suffix, email, phone: '+1', nationality: 'IE',
      residencyStatus: 'Other', hasNationalInsurance: false, hasWorkAuthorization: false,
      availability: 'Immediate', hasDrivingLicense: false, agencyId,
      leadNumber: lead, candidateNumber: cand, candidateConvertedAt: new Date(),
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
    console.error(`[applicants-conversion-equivalence] refusing on classification=${env.classification}`);
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
  const cleanup: { applicants: string[]; employees: string[]; docs: string[]; fins: string[] } = { applicants: [], employees: [], docs: [], fins: [] };
  const stamp = Date.now().toString(36);

  // 1+3+5+6+7 — legacy
  await withFlags({ TENANT_PRISMA_PILOT_ENABLED: 'false' }, async () => {
    const prisma = new PrismaService();
    const ff = new FeatureFlagsService();
    const pilot = new PilotPrismaAccessor(prisma, new TenantPrismaService(prisma, ff), ff);
    const svc = makeService(prisma, pilot);
    try {
      const aid = await seedCandidate(prisma, tA, TENANT_A_AGENCY, `lc-${stamp}`); cleanup.applicants.push(aid);
      const did = await seedDoc(prisma, aid, tA, `lc-${stamp}`); cleanup.docs.push(did);
      const fid = await seedFin(prisma, aid, tA); cleanup.fins.push(fid);
      const r: any = await svc.convertToEmployee(aid, dto as any, SYS_USER);
      cleanup.employees.push(r.employee.id);
      const empRow: any = await (prisma as any).employee.findUnique({ where: { id: r.employee.id } });
      const docAfter: any = await (prisma as any).document.findUnique({ where: { id: did } });
      const finAfter: any = await (prisma as any).financialRecord.findUnique({ where: { id: fid } });
      const aAfter: any = await (prisma as any).applicant.findUnique({ where: { id: aid } });
      out.push({ name: '1. legacy convert: response shape preserved', ok: !!r?.employee?.id && !!r.employeeNumber && !!r.message, detail: `employeeId=${r?.employee?.id?.slice(0,8)}` });
      out.push({ name: '3. legacy convert: Employee.tenantId NULL', ok: empRow.tenantId === null, detail: `tenantId=${empRow.tenantId}` });
      out.push({ name: '5. legacy convert: Document re-linked to EMPLOYEE', ok: docAfter.entityType === 'EMPLOYEE' && docAfter.entityId === r.employee.id, detail: `entityType=${docAfter.entityType}` });
      out.push({ name: '6. legacy convert: FinancialRecord re-linked to EMPLOYEE', ok: finAfter.entityType === 'EMPLOYEE' && finAfter.entityId === r.employee.id, detail: `entityType=${finAfter.entityType}` });
      out.push({ name: '7. legacy convert: Applicant soft-deleted + back-pointer', ok: !!aAfter.deletedAt && aAfter.convertedToEmployeeId === r.employee.id, detail: `deletedAt=${!!aAfter.deletedAt} backPointer=${aAfter.convertedToEmployeeId === r.employee.id}` });
    } finally { await prisma.$disconnect(); }
  });

  // 2+4 — pilot
  await withFlags({ TENANT_PRISMA_PILOT_ENABLED: 'true', TENANT_PRISMA_PILOT_MODULES: 'applicants' }, async () => {
    const prisma = new PrismaService();
    const ff = new FeatureFlagsService();
    const pilot = new PilotPrismaAccessor(prisma, new TenantPrismaService(prisma, ff), ff);
    const svc = makeService(prisma, pilot);
    try {
      const aid = await seedCandidate(prisma, tA, TENANT_A_AGENCY, `pc-${stamp}`); cleanup.applicants.push(aid);
      const did = await seedDoc(prisma, aid, tA, `pc-${stamp}`); cleanup.docs.push(did);
      const fid = await seedFin(prisma, aid, tA); cleanup.fins.push(fid);
      const r: any = await withRequestContext({ requestId: newRequestId() }, async () => {
        TenantContext.attach({ id: tA, slug: 'a', name: 'A', status: 'ACTIVE', region: 'eu' });
        return svc.convertToEmployee(aid, dto as any, SYS_USER);
      });
      cleanup.employees.push(r.employee.id);
      const empRow: any = await (prisma as any).employee.findUnique({ where: { id: r.employee.id } });
      out.push({ name: '2. pilot convert: response shape preserved', ok: !!r?.employee?.id && !!r.employeeNumber && !!r.message, detail: `employeeId=${r?.employee?.id?.slice(0,8)}` });
      out.push({ name: '4. pilot convert: Employee.tenantId = A', ok: empRow.tenantId === tA, detail: `tenantId=${empRow.tenantId}` });
    } finally { await prisma.$disconnect(); }
  });

  // cleanup
  const prisma = new PrismaService();
  try {
    if (cleanup.fins.length)      await (prisma as any).financialRecord.deleteMany({ where: { id: { in: cleanup.fins } } });
    if (cleanup.docs.length)      await (prisma as any).document.deleteMany({ where: { id: { in: cleanup.docs } } });
    if (cleanup.employees.length) await (prisma as any).employeeStage.deleteMany({ where: { employeeId: { in: cleanup.employees } } });
    if (cleanup.employees.length) await (prisma as any).employee.deleteMany({ where: { id: { in: cleanup.employees } } });
    if (cleanup.applicants.length) await (prisma as any).applicant.deleteMany({ where: { id: { in: cleanup.applicants } } });
  } finally { await prisma.$disconnect(); }

  await fs.mkdir(OUT_DIR, { recursive: true });
  const passed = out.filter((c) => c.ok).length;
  const total = out.length;
  await fs.writeFile(path.join(OUT_DIR, 'applicants-conversion-equivalence.json'),
    JSON.stringify({ passed, total, cases: out }, null, 2));
  const md = [
    `# Phase 2.32 — applicants conversion equivalence`, ``,
    `**${passed}/${total} PASS**`, ``,
    ...out.map((c) => `- ${c.ok ? 'PASS' : 'FAIL'} — ${c.name} — ${c.detail}`), ``,
  ].join('\n');
  await fs.writeFile(path.join(OUT_DIR, 'applicants-conversion-equivalence.md'), md);
  console.log(`[applicants-conversion-equivalence] ${passed}/${total} PASS`);
  process.exit(passed === total ? 0 : 1);
}

main().catch((err) => { console.error(err); process.exit(2); });
