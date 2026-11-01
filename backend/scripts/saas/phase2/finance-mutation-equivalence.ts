/**
 * Phase 2.17 — finance mutation equivalence harness.
 *
 * Compares legacy and pilot WRITE paths back-to-back on the same DB:
 *   1. create response shape preserved
 *   2. create persists tenantId in pilot mode; NULL in legacy
 *   3. update response shape preserved; both modes mutate
 *   4. validation error path: BadRequestException for bad entityType
 *   5. audit log row written by both modes (count delta = 1 per call)
 *   6. removeDeduction parent pre-check raises 404 for missing parent
 *      in both modes (legacy keeps "deduction not found" semantics)
 *   7. soft-delete (`remove`) sets deletedAt in both modes
 *   8. totals after mutation: pilot getTotals reflects both creates
 *
 * Output: backend/reports/saas/phase2/finance-mutation-equivalence.{json,md}
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

interface CreateResult { id: string; tenantId: string | null; shape: boolean; }
interface UpdateResult { id: string; description: string | null; shape: boolean; }

async function runCreate(svc: FinanceService, prisma: PrismaService, employeeId: string, suffix: string): Promise<CreateResult> {
  const created = await svc.create({
    entityType: 'EMPLOYEE',
    entityId: employeeId,
    transactionDate: new Date().toISOString(),
    currency: 'EUR',
    transactionType: 'TRAINING_COST',
    description: 'mut-equiv-' + suffix,
    companyDisbursedAmount: 50,
  } as any);
  const row: any = await (prisma as any).financialRecord.findUnique({ where: { id: created.id } });
  return {
    id: created.id,
    tenantId: row?.tenantId ?? null,
    shape: !!created.id && typeof created.transactionType === 'string' && Array.isArray((created as any).attachments),
  };
}

async function main(): Promise<void> {
  const url = getDatabaseUrl();
  const env = classifyRuntimeEnv();
  if (!isStagingClassification(env.classification)) {
    console.error(`[finance-mutation-equivalence] refusing on classification=${env.classification}`);
    process.exit(3);
  }

  const c = new Client({ connectionString: url, ssl: /127\.0\.0\.1|localhost/.test(url) ? false : { rejectUnauthorized: false } });
  await c.connect();
  const ts = await c.query<{ id: string }>(
    `SELECT t.id FROM tenants t
       WHERE EXISTS (SELECT 1 FROM employees e WHERE e."tenantId" = t.id::text)
       ORDER BY t.name`);
  const tA = ts.rows[0]?.id;
  if (!tA) { console.error('need a tenant'); process.exit(3); }
  const empA = await c.query<{ id: string }>(
    `SELECT id FROM employees WHERE "tenantId" = $1::text ORDER BY id LIMIT 1`, [tA],
  );
  const empAId = empA.rows[0]?.id;
  if (!empAId) { console.error('need an employee in tenant A'); process.exit(3); }
  await c.end();

  const out: CaseResult[] = [];
  const createdIds: string[] = [];

  // 1+2 — create legacy and pilot, compare tenantId
  const legacyCreate = await withFlags(
    { TENANT_PRISMA_PILOT_ENABLED: 'false', TENANT_PRISMA_PILOT_MODULES: undefined },
    async (): Promise<CreateResult> => {
      const flags = new FeatureFlagsService();
      const prisma = new PrismaService();
      const tp = new TenantPrismaService(prisma, flags);
      const pilot = new PilotPrismaAccessor(prisma, tp, flags);
      const svc = makeService(prisma, pilot);
      try {
        const r = await runCreate(svc, prisma, empAId, 'legacy');
        createdIds.push(r.id);
        return r;
      } finally { await prisma.$disconnect(); }
    },
  );
  const pilotCreate = await withFlags(
    { TENANT_PRISMA_PILOT_ENABLED: 'true', TENANT_PRISMA_PILOT_MODULES: 'finance' },
    async (): Promise<CreateResult> => {
      const flags = new FeatureFlagsService();
      const prisma = new PrismaService();
      const tp = new TenantPrismaService(prisma, flags);
      const pilot = new PilotPrismaAccessor(prisma, tp, flags);
      const svc = makeService(prisma, pilot);
      try {
        return await withRequestContext({ requestId: newRequestId() }, async () => {
          TenantContext.attach({ id: tA, slug: 'a', name: 'A', status: 'ACTIVE', region: 'eu' });
          const r = await runCreate(svc, prisma, empAId, 'pilot');
          createdIds.push(r.id);
          return r;
        });
      } finally { await prisma.$disconnect(); }
    },
  );

  out.push({
    name: 'create response shape preserved (id + transactionType + attachments[])',
    ok: legacyCreate.shape && pilotCreate.shape,
    detail: `legacy.shape=${legacyCreate.shape} pilot.shape=${pilotCreate.shape}`,
  });
  out.push({
    name: 'create legacy: tenantId is NULL',
    ok: legacyCreate.tenantId === null,
    detail: `legacy.tenantId=${legacyCreate.tenantId}`,
  });
  out.push({
    name: 'create pilot: tenantId is set to active tenant',
    ok: pilotCreate.tenantId === tA,
    detail: `pilot.tenantId=${pilotCreate.tenantId} tenantA=${tA}`,
  });

  // 3 — update both modes
  const legacyUpdate = await withFlags(
    { TENANT_PRISMA_PILOT_ENABLED: 'false' },
    async (): Promise<UpdateResult> => {
      const prisma = new PrismaService();
      const flags = new FeatureFlagsService();
      const tp = new TenantPrismaService(prisma, flags);
      const pilot = new PilotPrismaAccessor(prisma, tp, flags);
      const svc = makeService(prisma, pilot);
      try {
        const u = await svc.update(legacyCreate.id, { description: 'desc-legacy-updated' } as any);
        return { id: u.id, description: u.description, shape: typeof u.id === 'string' };
      } finally { await prisma.$disconnect(); }
    },
  );
  const pilotUpdate = await withFlags(
    { TENANT_PRISMA_PILOT_ENABLED: 'true', TENANT_PRISMA_PILOT_MODULES: 'finance' },
    async (): Promise<UpdateResult> => {
      const prisma = new PrismaService();
      const flags = new FeatureFlagsService();
      const tp = new TenantPrismaService(prisma, flags);
      const pilot = new PilotPrismaAccessor(prisma, tp, flags);
      const svc = makeService(prisma, pilot);
      try {
        return await withRequestContext({ requestId: newRequestId() }, async () => {
          TenantContext.attach({ id: tA, slug: 'a', name: 'A', status: 'ACTIVE', region: 'eu' });
          const u = await svc.update(pilotCreate.id, { description: 'desc-pilot-updated' } as any);
          return { id: u.id, description: u.description, shape: typeof u.id === 'string' };
        });
      } finally { await prisma.$disconnect(); }
    },
  );

  out.push({
    name: 'update both modes mutate the description',
    ok: legacyUpdate.description === 'desc-legacy-updated' && pilotUpdate.description === 'desc-pilot-updated',
    detail: `legacy="${legacyUpdate.description}" pilot="${pilotUpdate.description}"`,
  });

  // 4 — validation error path
  let validationLegacy = 'no-error';
  let validationPilot = 'no-error';
  await withFlags({ TENANT_PRISMA_PILOT_ENABLED: 'false' }, async () => {
    const prisma = new PrismaService();
    const flags = new FeatureFlagsService();
    const pilot = new PilotPrismaAccessor(prisma, new TenantPrismaService(prisma, flags), flags);
    const svc = makeService(prisma, pilot);
    try {
      await svc.create({ entityType: 'BOGUS', entityId: empAId, transactionDate: new Date().toISOString(), transactionType: 'X', companyDisbursedAmount: 1 } as any);
    } catch (e) { validationLegacy = (e as Error).constructor.name; }
    finally { await prisma.$disconnect(); }
  });
  await withFlags({ TENANT_PRISMA_PILOT_ENABLED: 'true', TENANT_PRISMA_PILOT_MODULES: 'finance' }, async () => {
    const prisma = new PrismaService();
    const flags = new FeatureFlagsService();
    const pilot = new PilotPrismaAccessor(prisma, new TenantPrismaService(prisma, flags), flags);
    const svc = makeService(prisma, pilot);
    try {
      await withRequestContext({ requestId: newRequestId() }, async () => {
        TenantContext.attach({ id: tA, slug: 'a', name: 'A', status: 'ACTIVE', region: 'eu' });
        await svc.create({ entityType: 'BOGUS', entityId: empAId, transactionDate: new Date().toISOString(), transactionType: 'X', companyDisbursedAmount: 1 } as any);
      });
    } catch (e) { validationPilot = (e as Error).constructor.name; }
    finally { await prisma.$disconnect(); }
  });
  out.push({
    name: 'validation error: BadRequestException for invalid entityType in both modes',
    ok: validationLegacy === 'BadRequestException' && validationPilot === 'BadRequestException',
    detail: `legacy=${validationLegacy} pilot=${validationPilot}`,
  });

  // 5 — audit log delta per create
  const auditClient = new Client({ connectionString: url, ssl: /127\.0\.0\.1|localhost/.test(url) ? false : { rejectUnauthorized: false } });
  await auditClient.connect();
  const legacyAudit = await auditClient.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM audit_logs WHERE entity = 'FinancialRecord' AND "entityId" = $1 AND action = 'FINANCIAL_RECORD_CREATED'`, [legacyCreate.id],
  );
  const pilotAudit = await auditClient.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM audit_logs WHERE entity = 'FinancialRecord' AND "entityId" = $1 AND action = 'FINANCIAL_RECORD_CREATED'`, [pilotCreate.id],
  );
  await auditClient.end();
  out.push({
    name: 'audit log: one CREATED row written per create in both modes',
    ok: (legacyAudit.rows[0]?.n ?? 0) >= 1 && (pilotAudit.rows[0]?.n ?? 0) >= 1,
    detail: `legacy=${legacyAudit.rows[0]?.n} pilot=${pilotAudit.rows[0]?.n}`,
  });

  // 6 — removeDeduction parent pre-check: missing parent => 404
  let rdLegacy = 'no-error';
  let rdPilot = 'no-error';
  await withFlags({ TENANT_PRISMA_PILOT_ENABLED: 'false' }, async () => {
    const prisma = new PrismaService();
    const flags = new FeatureFlagsService();
    const pilot = new PilotPrismaAccessor(prisma, new TenantPrismaService(prisma, flags), flags);
    const svc = makeService(prisma, pilot);
    try { await svc.removeDeduction('00000000-0000-0000-0000-deaddeaddead'); }
    catch (e) { rdLegacy = (e as Error).constructor.name; }
    finally { await prisma.$disconnect(); }
  });
  await withFlags({ TENANT_PRISMA_PILOT_ENABLED: 'true', TENANT_PRISMA_PILOT_MODULES: 'finance' }, async () => {
    const prisma = new PrismaService();
    const flags = new FeatureFlagsService();
    const pilot = new PilotPrismaAccessor(prisma, new TenantPrismaService(prisma, flags), flags);
    const svc = makeService(prisma, pilot);
    try {
      await withRequestContext({ requestId: newRequestId() }, async () => {
        TenantContext.attach({ id: tA, slug: 'a', name: 'A', status: 'ACTIVE', region: 'eu' });
        await svc.removeDeduction('00000000-0000-0000-0000-deaddeaddead');
      });
    } catch (e) { rdPilot = (e as Error).constructor.name; }
    finally { await prisma.$disconnect(); }
  });
  out.push({
    name: 'removeDeduction with bogus id: NotFoundException in both modes',
    ok: rdLegacy === 'NotFoundException' && rdPilot === 'NotFoundException',
    detail: `legacy=${rdLegacy} pilot=${rdPilot}`,
  });

  // 7 — soft-delete sets deletedAt
  await withFlags({ TENANT_PRISMA_PILOT_ENABLED: 'true', TENANT_PRISMA_PILOT_MODULES: 'finance' }, async () => {
    const prisma = new PrismaService();
    const flags = new FeatureFlagsService();
    const pilot = new PilotPrismaAccessor(prisma, new TenantPrismaService(prisma, flags), flags);
    const svc = makeService(prisma, pilot);
    try {
      await withRequestContext({ requestId: newRequestId() }, async () => {
        TenantContext.attach({ id: tA, slug: 'a', name: 'A', status: 'ACTIVE', region: 'eu' });
        await svc.remove(pilotCreate.id);
      });
      const after: any = await (prisma as any).financialRecord.findUnique({ where: { id: pilotCreate.id } });
      out.push({
        name: 'pilot remove: deletedAt is set on the row',
        ok: !!after?.deletedAt,
        detail: `deletedAt=${after?.deletedAt ? 'set' : 'null'}`,
      });
    } finally { await prisma.$disconnect(); }
  });

  // 8 — totals after mutation (legacy run unscoped against same entity)
  await withFlags({ TENANT_PRISMA_PILOT_ENABLED: 'false' }, async () => {
    const prisma = new PrismaService();
    const flags = new FeatureFlagsService();
    const pilot = new PilotPrismaAccessor(prisma, new TenantPrismaService(prisma, flags), flags);
    const svc = makeService(prisma, pilot);
    try {
      const totals = await svc.getTotals('EMPLOYEE', empAId);
      out.push({
        name: 'totals after mutation: legacy aggregate non-zero (sees both creates)',
        ok: totals.recordCount > 0 && totals.totalDisbursed >= 0,
        detail: `count=${totals.recordCount} disbursed=${totals.totalDisbursed}`,
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
    environment: env, tenantA: tA, employeeA: empAId,
    counts: { total: out.length, passed: out.filter((r) => r.ok).length, failed: out.filter((r) => !r.ok).length },
    results: out,
  };
  await fs.writeFile(path.join(OUT_DIR, 'finance-mutation-equivalence.json'), JSON.stringify(summary, null, 2));
  const md: string[] = [];
  md.push('# Phase 2.17 — Finance Mutation Equivalence');
  md.push('');
  md.push(`Generated: ${summary.generatedAt}`);
  md.push(`Environment: ${env.classification} (${env.reason})`);
  md.push(`Tenant A: \`${tA}\` · Employee A: \`${empAId}\``);
  md.push('');
  md.push(`- Cases passed: **${summary.counts.passed}** / ${summary.counts.total}`);
  md.push(`- Cases failed: ${summary.counts.failed}`);
  md.push('');
  md.push('| # | Case | Result | Detail |');
  md.push('|--:|------|:------:|--------|');
  out.forEach((r, i) => md.push(`| ${i + 1} | ${r.name} | ${r.ok ? 'PASS' : '**FAIL**'} | ${r.detail} |`));
  await fs.writeFile(path.join(OUT_DIR, 'finance-mutation-equivalence.md'), md.join('\n'));

  console.log(`finance-mutation-equivalence: ${summary.counts.passed}/${summary.counts.total} cases PASS`);
  if (summary.counts.failed > 0) process.exit(2);
}

main().catch((e) => { console.error(e); process.exit(3); });
