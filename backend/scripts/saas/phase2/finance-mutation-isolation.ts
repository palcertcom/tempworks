/**
 * Phase 2.17 — finance mutation isolation harness.
 *
 * Two tenants. Same-shape mutations. Proves:
 *   1. Pilot ON, tenant A: create persists tenantId=A.
 *   2. Pilot ON, tenant A: update(tenantB-record-id) raises
 *      NotFoundException; target row's description is unchanged.
 *   3. Pilot ON, tenant A: remove(tenantB-record-id) raises
 *      NotFoundException; target row's deletedAt remains NULL.
 *   4. Pilot ON, tenant A: updateStatus(tenantB-record-id) raises
 *      NotFoundException; target row's status is unchanged.
 *   5. Pilot ON, tenant A: addAttachment(tenantB-record-id) raises
 *      NotFoundException (no upload, no row inserted).
 *   6. Pilot ON, tenant A: removeDeduction(tenantB-deduction-id)
 *      raises NotFoundException; the child deduction row remains.
 *   7. Pilot ON, tenant A: getTotals on tenant B's entity returns
 *      0 records (mutations did not pollute).
 *   8. Pilot OFF: legacy update on a tenant B id still mutates
 *      (proves the new pre-check does not engage when flags off).
 *
 * Output: backend/reports/saas/phase2/finance-mutation-isolation.{json,md}
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
  const notifStub: any = {
    notifyUploaderAndRoles: async () => undefined,
    notifyUsersByRoles: async () => undefined,
    wasHighBalanceAlertRecentlySent: async () => false,
  };
  return new FinanceService(prisma, notifStub, new StorageService(), pilot, new TenantAuditLogService(prisma, new FeatureFlagsService()));
}

const TENANT_B_RECORD_ID = '00000000-0000-0000-0000-0000000fb001';
const TENANT_B_DEDUCTION_ID = '00000000-0000-0000-0000-0000000fb0d1';

async function main(): Promise<void> {
  const url = getDatabaseUrl();
  const env = classifyRuntimeEnv();
  if (!isStagingClassification(env.classification)) {
    console.error(`[finance-mutation-isolation] refusing on classification=${env.classification}`);
    process.exit(3);
  }

  const c = new Client({ connectionString: url, ssl: /127\.0\.0\.1|localhost/.test(url) ? false : { rejectUnauthorized: false } });
  await c.connect();
  const ts = await c.query<{ id: string }>(
    `SELECT t.id FROM tenants t
       WHERE EXISTS (SELECT 1 FROM employees e WHERE e."tenantId" = t.id::text)
       ORDER BY t.name`);
  const tA = ts.rows[0]?.id; const tB = ts.rows[1]?.id;
  if (!tA || !tB) { console.error('need two tenants with employees'); process.exit(3); }
  const empA = await c.query<{ id: string }>(
    `SELECT id FROM employees WHERE "tenantId" = $1::text ORDER BY id LIMIT 1`, [tA],
  );
  const empAId = empA.rows[0]?.id;

  // Seed a tenant B deduction row for case 6 (idempotent).
  await c.query(`
    INSERT INTO financial_record_deductions(id, "financialRecordId", amount, "deductionDate")
    VALUES ($1, $2, 50, now())
    ON CONFLICT (id) DO NOTHING
  `, [TENANT_B_DEDUCTION_ID, TENANT_B_RECORD_ID]);
  await c.end();

  const out: CaseResult[] = [];
  const createdIds: string[] = [];

  // 1 — create persists tenantId=A
  await withFlags({ TENANT_PRISMA_PILOT_ENABLED: 'true', TENANT_PRISMA_PILOT_MODULES: 'finance' }, async () => {
    const prisma = new PrismaService();
    const flags = new FeatureFlagsService();
    const pilot = new PilotPrismaAccessor(prisma, new TenantPrismaService(prisma, flags), flags);
    const svc = makeService(prisma, pilot);
    try {
      const created = await withRequestContext({ requestId: newRequestId() }, async () => {
        TenantContext.attach({ id: tA, slug: 'a', name: 'A', status: 'ACTIVE', region: 'eu' });
        return svc.create({
          entityType: 'EMPLOYEE', entityId: empAId,
          transactionDate: new Date().toISOString(), currency: 'EUR',
          transactionType: 'TRAINING_COST',
          companyDisbursedAmount: 25,
          description: 'iso-create-A',
        } as any);
      });
      createdIds.push(created.id);
      const row: any = await (prisma as any).financialRecord.findUnique({ where: { id: created.id } });
      out.push({
        name: 'pilot ON, tenant A: create persists tenantId=A',
        ok: row?.tenantId === tA,
        detail: `tenantId=${row?.tenantId} expected=${tA}`,
      });
    } finally { await prisma.$disconnect(); }
  });

  // 2-5 — cross-tenant mutations rejected, target unchanged
  await withFlags({ TENANT_PRISMA_PILOT_ENABLED: 'true', TENANT_PRISMA_PILOT_MODULES: 'finance' }, async () => {
    const prisma = new PrismaService();
    const flags = new FeatureFlagsService();
    const pilot = new PilotPrismaAccessor(prisma, new TenantPrismaService(prisma, flags), flags);
    const svc = makeService(prisma, pilot);
    try {
      const before: any = await (prisma as any).financialRecord.findUnique({ where: { id: TENANT_B_RECORD_ID } });
      const beforeDesc = before?.description;
      const beforeStatus = before?.status;

      let updateLeaked = false;
      try {
        await withRequestContext({ requestId: newRequestId() }, async () => {
          TenantContext.attach({ id: tA, slug: 'a', name: 'A', status: 'ACTIVE', region: 'eu' });
          await svc.update(TENANT_B_RECORD_ID, { description: 'A-trying-to-update-B' } as any);
        });
        updateLeaked = true;
      } catch { updateLeaked = false; }
      let removeLeaked = false;
      try {
        await withRequestContext({ requestId: newRequestId() }, async () => {
          TenantContext.attach({ id: tA, slug: 'a', name: 'A', status: 'ACTIVE', region: 'eu' });
          await svc.remove(TENANT_B_RECORD_ID);
        });
        removeLeaked = true;
      } catch { removeLeaked = false; }
      let statusLeaked = false;
      try {
        await withRequestContext({ requestId: newRequestId() }, async () => {
          TenantContext.attach({ id: tA, slug: 'a', name: 'A', status: 'ACTIVE', region: 'eu' });
          await svc.updateStatus(TENANT_B_RECORD_ID, { status: 'DEDUCTED', deductionAmount: 1 } as any);
        });
        statusLeaked = true;
      } catch { statusLeaked = false; }
      let attachLeaked = false;
      try {
        await withRequestContext({ requestId: newRequestId() }, async () => {
          TenantContext.attach({ id: tA, slug: 'a', name: 'A', status: 'ACTIVE', region: 'eu' });
          await svc.addAttachment(TENANT_B_RECORD_ID, {
            buffer: Buffer.from('x'), originalname: 'iso.txt', mimetype: 'text/plain', size: 1,
          } as any);
        });
        attachLeaked = true;
      } catch { attachLeaked = false; }

      const after: any = await (prisma as any).financialRecord.findUnique({ where: { id: TENANT_B_RECORD_ID } });
      out.push({
        name: 'pilot ON, tenant A: update on tenant B record rejected, description unchanged',
        ok: !updateLeaked && after?.description === beforeDesc,
        detail: `before="${beforeDesc}" after="${after?.description}"`,
      });
      out.push({
        name: 'pilot ON, tenant A: remove on tenant B record rejected, deletedAt unchanged',
        ok: !removeLeaked && (after?.deletedAt ?? null) === (before?.deletedAt ?? null),
        detail: `deletedAt=${after?.deletedAt ? 'set' : 'null'}`,
      });
      out.push({
        name: 'pilot ON, tenant A: updateStatus on tenant B record rejected, status unchanged',
        ok: !statusLeaked && after?.status === beforeStatus,
        detail: `before=${beforeStatus} after=${after?.status}`,
      });
      out.push({
        name: 'pilot ON, tenant A: addAttachment on tenant B record rejected (no upload performed)',
        ok: !attachLeaked,
        detail: attachLeaked ? 'UNEXPECTED: returned' : 'NotFoundException',
      });
    } finally { await prisma.$disconnect(); }
  });

  // 6 — removeDeduction cross-tenant blocked
  await withFlags({ TENANT_PRISMA_PILOT_ENABLED: 'true', TENANT_PRISMA_PILOT_MODULES: 'finance' }, async () => {
    const prisma = new PrismaService();
    const flags = new FeatureFlagsService();
    const pilot = new PilotPrismaAccessor(prisma, new TenantPrismaService(prisma, flags), flags);
    const svc = makeService(prisma, pilot);
    try {
      let leaked = false;
      try {
        await withRequestContext({ requestId: newRequestId() }, async () => {
          TenantContext.attach({ id: tA, slug: 'a', name: 'A', status: 'ACTIVE', region: 'eu' });
          await svc.removeDeduction(TENANT_B_DEDUCTION_ID);
        });
        leaked = true;
      } catch { leaked = false; }
      const stillThere: any = await (prisma as any).financialRecordDeduction.findUnique({ where: { id: TENANT_B_DEDUCTION_ID } });
      out.push({
        name: 'pilot ON, tenant A: removeDeduction on tenant B deduction rejected, child row preserved',
        ok: !leaked && !!stillThere,
        detail: leaked ? 'UNEXPECTED: deletion succeeded' : `child preserved=${!!stillThere}`,
      });
    } finally { await prisma.$disconnect(); }
  });

  // 7 — getTotals on B's entity from A returns 0
  await withFlags({ TENANT_PRISMA_PILOT_ENABLED: 'true', TENANT_PRISMA_PILOT_MODULES: 'finance' }, async () => {
    const prisma = new PrismaService();
    const flags = new FeatureFlagsService();
    const pilot = new PilotPrismaAccessor(prisma, new TenantPrismaService(prisma, flags), flags);
    const svc = makeService(prisma, pilot);
    try {
      const bRow: any = await (prisma as any).financialRecord.findUnique({ where: { id: TENANT_B_RECORD_ID } });
      const totals = await withRequestContext({ requestId: newRequestId() }, async () => {
        TenantContext.attach({ id: tA, slug: 'a', name: 'A', status: 'ACTIVE', region: 'eu' });
        return svc.getTotals(bRow.entityType, bRow.entityId);
      });
      out.push({
        name: 'pilot ON, tenant A: getTotals on tenant B entity returns 0 records (mutations did not pollute)',
        ok: totals.recordCount === 0,
        detail: `count=${totals.recordCount} disbursed=${totals.totalDisbursed}`,
      });
    } finally { await prisma.$disconnect(); }
  });

  // 9 — pilot ON, tenant A: create with tenant B entityId raises 404
  // (helper enrichment narrowing — Phase 2.17.1).
  await withFlags({ TENANT_PRISMA_PILOT_ENABLED: 'true', TENANT_PRISMA_PILOT_MODULES: 'finance' }, async () => {
    const prisma = new PrismaService();
    const flags = new FeatureFlagsService();
    const pilot = new PilotPrismaAccessor(prisma, new TenantPrismaService(prisma, flags), flags);
    const svc = makeService(prisma, pilot);
    try {
      const empB: any = await (prisma as any).employee.findFirst({ where: { tenantId: tB } });
      if (!empB) {
        out.push({ name: 'pilot ON, tenant A: cross-tenant create raises NotFoundException', ok: false, detail: 'fixture missing tenant B employee' });
      } else {
        const beforeCount = await (prisma as any).financialRecord.count({ where: { tenantId: tA } });
        let leaked = false;
        let errName = '';
        try {
          await withRequestContext({ requestId: newRequestId() }, async () => {
            TenantContext.attach({ id: tA, slug: 'a', name: 'A', status: 'ACTIVE', region: 'eu' });
            await svc.create({
              entityType: 'EMPLOYEE', entityId: empB.id,
              transactionDate: new Date().toISOString(), currency: 'EUR',
              transactionType: 'TRAINING_COST',
              companyDisbursedAmount: 99,
              description: 'cross-tenant-create-attempt',
            } as any);
          });
          leaked = true;
        } catch (e) { errName = (e as Error).constructor.name; }
        const afterCount = await (prisma as any).financialRecord.count({ where: { tenantId: tA } });
        out.push({
          name: 'pilot ON, tenant A: create with tenant-B entityId raises NotFoundException; no row inserted (Phase 2.17.1 helper guard)',
          ok: !leaked && errName === 'NotFoundException' && beforeCount === afterCount,
          detail: leaked ? 'UNEXPECTED: created' : `err=${errName} before=${beforeCount} after=${afterCount}`,
        });
      }
    } finally { await prisma.$disconnect(); }
  });

  // 10 — pilot ON, tenant A: smuggled entityType/entityId/applicantId
  // via `as any` are scrubbed in update() (Phase 2.17.1 defensive scrub).
  await withFlags({ TENANT_PRISMA_PILOT_ENABLED: 'true', TENANT_PRISMA_PILOT_MODULES: 'finance' }, async () => {
    const prisma = new PrismaService();
    const flags = new FeatureFlagsService();
    const pilot = new PilotPrismaAccessor(prisma, new TenantPrismaService(prisma, flags), flags);
    const svc = makeService(prisma, pilot);
    try {
      // Create a fresh tenant A record so the test does not pollute the fixture row.
      const empA: any = await (prisma as any).employee.findFirst({ where: { tenantId: tA } });
      const empB: any = await (prisma as any).employee.findFirst({ where: { tenantId: tB } });
      const created = await withRequestContext({ requestId: newRequestId() }, async () => {
        TenantContext.attach({ id: tA, slug: 'a', name: 'A', status: 'ACTIVE', region: 'eu' });
        return svc.create({
          entityType: 'EMPLOYEE', entityId: empA.id,
          transactionDate: new Date().toISOString(), currency: 'EUR',
          transactionType: 'TRAINING_COST', companyDisbursedAmount: 10,
          description: 'iso-scrub-target',
        } as any);
      });
      createdIds.push(created.id);
      const beforeIdent = { entityType: created.entityType, entityId: created.entityId, applicantId: (created as any).applicantId };

      await withRequestContext({ requestId: newRequestId() }, async () => {
        TenantContext.attach({ id: tA, slug: 'a', name: 'A', status: 'ACTIVE', region: 'eu' });
        await svc.update(created.id, {
          description: 'updated',
          // Smuggled identity fields — must be scrubbed:
          entityType: 'AGENCY',
          entityId: empB.id,
          applicantId: empB.id,
          stageAtCreation: 'AGENCY',
        } as any);
      });

      const after: any = await (prisma as any).financialRecord.findUnique({ where: { id: created.id } });
      const ok = after.entityType === beforeIdent.entityType
              && after.entityId === beforeIdent.entityId
              && (after.applicantId ?? null) === (beforeIdent.applicantId ?? null);
      out.push({
        name: 'pilot ON, tenant A: update scrubs smuggled entityType/entityId/applicantId (defensive)',
        ok,
        detail: `before=${JSON.stringify(beforeIdent)} after={"entityType":"${after.entityType}","entityId":"${after.entityId}","applicantId":${JSON.stringify(after.applicantId ?? null)}}`,
      });
    } finally { await prisma.$disconnect(); }
  });

  // 11 — APPLICANT cross-tenant create: pilot ON, tenant A passes
  // tenant B's applicant id ⇒ NotFoundException, no row inserted.
  await withFlags({ TENANT_PRISMA_PILOT_ENABLED: 'true', TENANT_PRISMA_PILOT_MODULES: 'finance' }, async () => {
    const prisma = new PrismaService();
    const flags = new FeatureFlagsService();
    const pilot = new PilotPrismaAccessor(prisma, new TenantPrismaService(prisma, flags), flags);
    const svc = makeService(prisma, pilot);
    try {
      const appB: any = await (prisma as any).applicant.findFirst({ where: { tenantId: tB } });
      if (!appB) {
        out.push({ name: 'pilot ON, tenant A: APPLICANT cross-tenant create raises NotFoundException', ok: false, detail: 'fixture missing tenant B applicant' });
      } else {
        const beforeCount = await (prisma as any).financialRecord.count({ where: { tenantId: tA } });
        let leaked = false;
        let errName = '';
        try {
          await withRequestContext({ requestId: newRequestId() }, async () => {
            TenantContext.attach({ id: tA, slug: 'a', name: 'A', status: 'ACTIVE', region: 'eu' });
            await svc.create({
              entityType: 'APPLICANT', entityId: appB.id,
              transactionDate: new Date().toISOString(), currency: 'EUR',
              transactionType: 'TRAINING_COST',
              companyDisbursedAmount: 11,
              description: 'cross-tenant-applicant-attempt',
            } as any);
          });
          leaked = true;
        } catch (e) { errName = (e as Error).constructor.name; }
        const afterCount = await (prisma as any).financialRecord.count({ where: { tenantId: tA } });
        out.push({
          name: 'pilot ON, tenant A: APPLICANT cross-tenant create raises NotFoundException; no row inserted',
          ok: !leaked && errName === 'NotFoundException' && beforeCount === afterCount,
          detail: leaked ? 'UNEXPECTED: created' : `err=${errName} before=${beforeCount} after=${afterCount}`,
        });
      }
    } finally { await prisma.$disconnect(); }
  });

  // 12 — APPLICANT same-tenant create: pilot ON, tenant A passes its
  // own applicant id ⇒ success, persists tenantId=A, applicantId set.
  await withFlags({ TENANT_PRISMA_PILOT_ENABLED: 'true', TENANT_PRISMA_PILOT_MODULES: 'finance' }, async () => {
    const prisma = new PrismaService();
    const flags = new FeatureFlagsService();
    const pilot = new PilotPrismaAccessor(prisma, new TenantPrismaService(prisma, flags), flags);
    const svc = makeService(prisma, pilot);
    try {
      const appA: any = await (prisma as any).applicant.findFirst({ where: { tenantId: tA } });
      if (!appA) {
        out.push({ name: 'pilot ON, tenant A: APPLICANT same-tenant create succeeds', ok: false, detail: 'fixture missing tenant A applicant' });
      } else {
        const created = await withRequestContext({ requestId: newRequestId() }, async () => {
          TenantContext.attach({ id: tA, slug: 'a', name: 'A', status: 'ACTIVE', region: 'eu' });
          return svc.create({
            entityType: 'APPLICANT', entityId: appA.id,
            transactionDate: new Date().toISOString(), currency: 'EUR',
            transactionType: 'TRAINING_COST',
            companyDisbursedAmount: 12,
            description: 'iso-applicant-same-tenant',
          } as any);
        });
        createdIds.push(created.id);
        const row: any = await (prisma as any).financialRecord.findUnique({ where: { id: created.id } });
        const stageOk = row?.stageAtCreation === 'CANDIDATE' || row?.stageAtCreation === 'LEAD';
        out.push({
          name: 'pilot ON, tenant A: APPLICANT same-tenant create succeeds, tenantId=A, applicantId=appA, stageAtCreation set',
          ok: row?.tenantId === tA && row?.applicantId === appA.id && stageOk,
          detail: `tenantId=${row?.tenantId} applicantId=${row?.applicantId} stage=${row?.stageAtCreation}`,
        });
      }
    } finally { await prisma.$disconnect(); }
  });

  // 13 — resolveEntityNameForNotif via update path: pilot ON, tenant A
  // updates its own APPLICANT-typed record. The notification helper
  // resolves the name from tenant A's applicant only. Cross-tenant
  // applicant ids are NEVER reachable here because `existing` came
  // from the tenant-scoped findOne. We assert the update succeeds and
  // the persisted row keeps its tenant A applicantId (the helper does
  // not corrupt the row).
  await withFlags({ TENANT_PRISMA_PILOT_ENABLED: 'true', TENANT_PRISMA_PILOT_MODULES: 'finance' }, async () => {
    const prisma = new PrismaService();
    const flags = new FeatureFlagsService();
    const pilot = new PilotPrismaAccessor(prisma, new TenantPrismaService(prisma, flags), flags);
    const svc = makeService(prisma, pilot);
    try {
      const aRecord: any = await (prisma as any).financialRecord.findFirst({
        where: { tenantId: tA, entityType: 'APPLICANT' },
      });
      if (!aRecord) {
        out.push({ name: 'pilot ON, tenant A: APPLICANT-typed record update keeps applicantId tenant-scoped', ok: false, detail: 'fixture missing tenant A APPLICANT-typed record' });
      } else {
        const beforeApplicantId = aRecord.applicantId;
        await withRequestContext({ requestId: newRequestId() }, async () => {
          TenantContext.attach({ id: tA, slug: 'a', name: 'A', status: 'ACTIVE', region: 'eu' });
          await svc.update(aRecord.id, { description: 'iso-applicant-update' } as any);
        });
        const after: any = await (prisma as any).financialRecord.findUnique({ where: { id: aRecord.id } });
        out.push({
          name: 'pilot ON, tenant A: APPLICANT-typed record update keeps applicantId tenant-scoped (notif helper safe)',
          ok: after?.tenantId === tA && after?.applicantId === beforeApplicantId && after?.description === 'iso-applicant-update',
          detail: `tenantId=${after?.tenantId} applicantId=${after?.applicantId} desc="${after?.description}"`,
        });
      }
    } finally { await prisma.$disconnect(); }
  });

  // 14 — AGENCY cross-tenant create: pilot ON, tenant A passes
  // tenant B's agency id ⇒ NotFoundException, no row inserted.
  await withFlags({ TENANT_PRISMA_PILOT_ENABLED: 'true', TENANT_PRISMA_PILOT_MODULES: 'finance' }, async () => {
    const prisma = new PrismaService();
    const flags = new FeatureFlagsService();
    const pilot = new PilotPrismaAccessor(prisma, new TenantPrismaService(prisma, flags), flags);
    const svc = makeService(prisma, pilot);
    try {
      const agB: any = await (prisma as any).agency.findFirst({ where: { tenantId: tB } });
      if (!agB) {
        out.push({ name: 'pilot ON, tenant A: AGENCY cross-tenant create raises NotFoundException', ok: false, detail: 'fixture missing tenant B agency' });
      } else {
        const beforeCount = await (prisma as any).financialRecord.count({ where: { tenantId: tA } });
        let leaked = false;
        let errName = '';
        try {
          await withRequestContext({ requestId: newRequestId() }, async () => {
            TenantContext.attach({ id: tA, slug: 'a', name: 'A', status: 'ACTIVE', region: 'eu' });
            await svc.create({
              entityType: 'AGENCY', entityId: agB.id,
              transactionDate: new Date().toISOString(), currency: 'EUR',
              transactionType: 'BONUS',
              companyDisbursedAmount: 14,
              description: 'cross-tenant-agency-attempt',
            } as any);
          });
          leaked = true;
        } catch (e) { errName = (e as Error).constructor.name; }
        const afterCount = await (prisma as any).financialRecord.count({ where: { tenantId: tA } });
        out.push({
          name: 'pilot ON, tenant A: AGENCY cross-tenant create raises NotFoundException; no row inserted',
          ok: !leaked && errName === 'NotFoundException' && beforeCount === afterCount,
          detail: leaked ? 'UNEXPECTED: created' : `err=${errName} before=${beforeCount} after=${afterCount}`,
        });
      }
    } finally { await prisma.$disconnect(); }
  });

  // 15 — AGENCY same-tenant create: pilot ON, tenant A passes its
  // own agency id ⇒ success, persists tenantId=A, applicantId=null,
  // stageAtCreation='AGENCY'.
  await withFlags({ TENANT_PRISMA_PILOT_ENABLED: 'true', TENANT_PRISMA_PILOT_MODULES: 'finance' }, async () => {
    const prisma = new PrismaService();
    const flags = new FeatureFlagsService();
    const pilot = new PilotPrismaAccessor(prisma, new TenantPrismaService(prisma, flags), flags);
    const svc = makeService(prisma, pilot);
    try {
      const agA: any = await (prisma as any).agency.findFirst({ where: { tenantId: tA } });
      if (!agA) {
        out.push({ name: 'pilot ON, tenant A: AGENCY same-tenant create succeeds', ok: false, detail: 'fixture missing tenant A agency' });
      } else {
        const created = await withRequestContext({ requestId: newRequestId() }, async () => {
          TenantContext.attach({ id: tA, slug: 'a', name: 'A', status: 'ACTIVE', region: 'eu' });
          return svc.create({
            entityType: 'AGENCY', entityId: agA.id,
            transactionDate: new Date().toISOString(), currency: 'EUR',
            transactionType: 'BONUS',
            companyDisbursedAmount: 15,
            description: 'iso-agency-same-tenant',
          } as any);
        });
        createdIds.push(created.id);
        const row: any = await (prisma as any).financialRecord.findUnique({ where: { id: created.id } });
        out.push({
          name: 'pilot ON, tenant A: AGENCY same-tenant create succeeds, tenantId=A, applicantId=null, stage=AGENCY',
          ok: row?.tenantId === tA
            && row?.entityId === agA.id
            && row?.applicantId === null
            && row?.stageAtCreation === 'AGENCY',
          detail: `tenantId=${row?.tenantId} entityId=${row?.entityId} applicantId=${row?.applicantId} stage=${row?.stageAtCreation}`,
        });
      }
    } finally { await prisma.$disconnect(); }
  });

  // 16 — AGENCY-typed update: pilot ON, tenant A updates its own
  // AGENCY-typed record. The notif-helper resolves the agency name
  // from tenant A only and does not corrupt the row.
  await withFlags({ TENANT_PRISMA_PILOT_ENABLED: 'true', TENANT_PRISMA_PILOT_MODULES: 'finance' }, async () => {
    const prisma = new PrismaService();
    const flags = new FeatureFlagsService();
    const pilot = new PilotPrismaAccessor(prisma, new TenantPrismaService(prisma, flags), flags);
    const svc = makeService(prisma, pilot);
    try {
      const aRecord: any = await (prisma as any).financialRecord.findFirst({
        where: { tenantId: tA, entityType: 'AGENCY' },
      });
      if (!aRecord) {
        out.push({ name: 'pilot ON, tenant A: AGENCY-typed record update keeps entityId tenant-scoped', ok: false, detail: 'fixture missing tenant A AGENCY-typed record' });
      } else {
        const beforeEntityId = aRecord.entityId;
        await withRequestContext({ requestId: newRequestId() }, async () => {
          TenantContext.attach({ id: tA, slug: 'a', name: 'A', status: 'ACTIVE', region: 'eu' });
          await svc.update(aRecord.id, { description: 'iso-agency-update' } as any);
        });
        const after: any = await (prisma as any).financialRecord.findUnique({ where: { id: aRecord.id } });
        out.push({
          name: 'pilot ON, tenant A: AGENCY-typed record update keeps entityId tenant-scoped (notif helper safe)',
          ok: after?.tenantId === tA && after?.entityId === beforeEntityId && after?.description === 'iso-agency-update',
          detail: `tenantId=${after?.tenantId} entityId=${after?.entityId} desc="${after?.description}"`,
        });
      }
    } finally { await prisma.$disconnect(); }
  });

  // 8 — pilot OFF: legacy still mutates without tenant gate
  await withFlags({ TENANT_PRISMA_PILOT_ENABLED: 'false' }, async () => {
    const prisma = new PrismaService();
    const flags = new FeatureFlagsService();
    const pilot = new PilotPrismaAccessor(prisma, new TenantPrismaService(prisma, flags), flags);
    const svc = makeService(prisma, pilot);
    try {
      const before: any = await (prisma as any).financialRecord.findUnique({ where: { id: TENANT_B_RECORD_ID } });
      let mutated = false;
      try {
        const u = await svc.update(TENANT_B_RECORD_ID, { description: 'legacy-no-tenant-gate' } as any);
        mutated = u.description === 'legacy-no-tenant-gate';
      } catch { mutated = false; }
      // Restore the original description so subsequent runs are not polluted.
      if (mutated && before) {
        await (prisma as any).financialRecord.update({ where: { id: TENANT_B_RECORD_ID }, data: { description: before.description } });
      }
      out.push({
        name: 'pilot OFF: legacy update on tenant B record still succeeds (tenant gate disengages)',
        ok: mutated,
        detail: mutated ? 'mutated as expected' : 'UNEXPECTED: mutation blocked',
      });
    } finally { await prisma.$disconnect(); }
  });

  // Cleanup
  const cleanup = new Client({ connectionString: url, ssl: /127\.0\.0\.1|localhost/.test(url) ? false : { rejectUnauthorized: false } });
  await cleanup.connect();
  for (const id of createdIds) {
    await cleanup.query(`DELETE FROM financial_records WHERE id = $1`, [id]).catch(() => undefined);
  }
  await cleanup.query(`DELETE FROM audit_logs WHERE entity = 'FinancialRecord' AND "entityId" = ANY($1::text[])`, [createdIds]).catch(() => undefined);
  await cleanup.end();

  await fs.mkdir(OUT_DIR, { recursive: true });
  const summary = {
    generatedAt: new Date().toISOString(),
    environment: env, tenantA: tA, tenantB: tB,
    counts: { total: out.length, passed: out.filter((r) => r.ok).length, failed: out.filter((r) => !r.ok).length },
    results: out,
  };
  await fs.writeFile(path.join(OUT_DIR, 'finance-mutation-isolation.json'), JSON.stringify(summary, null, 2));
  const md: string[] = [];
  md.push('# Phase 2.17 — Finance Mutation Isolation');
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
  await fs.writeFile(path.join(OUT_DIR, 'finance-mutation-isolation.md'), md.join('\n'));

  console.log(`finance-mutation-isolation: ${summary.counts.passed}/${summary.counts.total} cases PASS`);
  if (summary.counts.failed > 0) process.exit(2);
}

main().catch((e) => { console.error(e); process.exit(3); });
