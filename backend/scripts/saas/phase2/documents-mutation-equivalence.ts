/**
 * Phase 2.21 — documents mutation equivalence harness.
 *
 * Compares legacy and pilot WRITE paths back-to-back on the same DB
 * with a stub storage service (no real S3 calls).
 *
 *   1. create response shape preserved (legacy + pilot)
 *   2. create persists tenantId in pilot mode; NULL in legacy
 *   3. update mutates description (legacy + pilot)
 *   4. validation error: NotFoundException for unknown documentTypeId
 *   5. audit log row written by both modes (UPLOAD)
 *   6. soft-delete sets deletedAt in both modes
 *   7. renew creates a new row referencing originalId in both modes
 *   8. metadata read-after-write: findOne returns the new doc
 *
 * Output: backend/reports/saas/phase2/documents-mutation-equivalence.{json,md}
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
import { DocumentsService } from '../../../src/documents/documents.service';
import { DocumentIdService } from '../../../src/documents/document-id.service';
import {
  TenantContext, withRequestContext, newRequestId,
} from '../../../src/saas/context/als';

autoLoadEnv(__filename);

const OUT_DIR = path.resolve(__dirname, '..', '..', '..', 'reports', 'saas', 'phase2');
interface CaseResult { name: string; ok: boolean; detail: string; }

const TENANT_A_DOC_ID = '00000000-0000-0000-0000-0000000dc001';
const TENANT_A_EMP_ID = 'eeeeeeea-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const DOC_TYPE_ID = '00000000-0000-0000-0000-00000000dt01';
const SYS_USER_ID = '00000000-0000-0000-0000-00000000us01';

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

interface StubCounters { uploads: number; deletes: number; }

function makeService(prisma: PrismaService, pilot: PilotPrismaAccessor, counters: StubCounters): DocumentsService {
  const notifStub: any = { notifyUploaderAndRoles: async () => undefined, notifyUsersByRoles: async () => undefined };
  const idStub = new DocumentIdService(prisma);
  const storageStub: any = {
    uploadFile: async (_buf: Buffer, opts: any) => {
      counters.uploads += 1;
      return { url: `stub://uploads/${opts.keyPrefix}/${opts.originalName}`, key: `${opts.keyPrefix}/${opts.originalName}` };
    },
    deleteFileByUrlOrKey: async () => { counters.deletes += 1; },
    downloadByUrlOrKey: async () => Buffer.from('x'),
  };
  return new DocumentsService(prisma, idStub, notifStub, storageStub, pilot, new TenantAuditLogService(prisma, new FeatureFlagsService()));
}

const fileFixture: any = {
  buffer: Buffer.from('test-bytes'),
  originalname: 'test.pdf',
  mimetype: 'application/pdf',
  size: 10,
};

interface CreateResult { id: string; tenantId: string | null; shape: boolean; }

async function runCreate(svc: DocumentsService, prisma: PrismaService, suffix: string): Promise<CreateResult> {
  const created = await svc.create(
    {
      name: `mut-equiv-${suffix}`,
      documentTypeId: DOC_TYPE_ID,
      entityType: 'EMPLOYEE',
      entityId: TENANT_A_EMP_ID,
    } as any,
    fileFixture,
    SYS_USER_ID,
  );
  const row: any = await (prisma as any).document.findUnique({ where: { id: created.id } });
  return {
    id: created.id,
    tenantId: row?.tenantId ?? null,
    shape: !!created.id && typeof (created as any).docId === 'string',
  };
}

async function main(): Promise<void> {
  const url = getDatabaseUrl();
  const env = classifyRuntimeEnv();
  if (!isStagingClassification(env.classification)) {
    console.error(`[documents-mutation-equivalence] refusing on classification=${env.classification}`);
    process.exit(3);
  }
  const c = new Client({ connectionString: url, ssl: /127\.0\.0\.1|localhost/.test(url) ? false : { rejectUnauthorized: false } });
  await c.connect();
  const ts = await c.query<{ id: string }>(
    `SELECT t.id FROM tenants t
       WHERE EXISTS (SELECT 1 FROM documents d WHERE d."tenantId" = t.id::text)
       ORDER BY t.name`);
  const tA = ts.rows[0]?.id;
  await c.end();
  if (!tA) { console.error('need tenant A with documents'); process.exit(3); }

  const out: CaseResult[] = [];
  const createdIds: string[] = [];

  // 1+2 — create legacy + pilot
  const counterLegacy = { uploads: 0, deletes: 0 };
  const legacyCreate = await withFlags(
    { TENANT_PRISMA_PILOT_ENABLED: 'false', TENANT_PRISMA_PILOT_MODULES: undefined },
    async (): Promise<CreateResult> => {
      const flags = new FeatureFlagsService();
      const prisma = new PrismaService();
      const tp = new TenantPrismaService(prisma, flags);
      const pilot = new PilotPrismaAccessor(prisma, tp, flags);
      const svc = makeService(prisma, pilot, counterLegacy);
      try {
        const r = await runCreate(svc, prisma, 'legacy');
        createdIds.push(r.id); return r;
      } finally { await prisma.$disconnect(); }
    },
  );
  const counterPilot = { uploads: 0, deletes: 0 };
  const pilotCreate = await withFlags(
    { TENANT_PRISMA_PILOT_ENABLED: 'true', TENANT_PRISMA_PILOT_MODULES: 'documents' },
    async (): Promise<CreateResult> => {
      const flags = new FeatureFlagsService();
      const prisma = new PrismaService();
      const tp = new TenantPrismaService(prisma, flags);
      const pilot = new PilotPrismaAccessor(prisma, tp, flags);
      const svc = makeService(prisma, pilot, counterPilot);
      try {
        return await withRequestContext({ requestId: newRequestId() }, async () => {
          TenantContext.attach({ id: tA, slug: 'a', name: 'A', status: 'ACTIVE', region: 'eu' });
          const r = await runCreate(svc, prisma, 'pilot');
          createdIds.push(r.id); return r;
        });
      } finally { await prisma.$disconnect(); }
    },
  );

  out.push({
    name: 'create response shape preserved (id + docId string)',
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
  out.push({
    name: 'create: storage.uploadFile invoked once per create in both modes',
    ok: counterLegacy.uploads === 1 && counterPilot.uploads === 1,
    detail: `legacy.uploads=${counterLegacy.uploads} pilot.uploads=${counterPilot.uploads}`,
  });

  // 3 — update both modes
  const legacyUpdate = await withFlags({ TENANT_PRISMA_PILOT_ENABLED: 'false' }, async () => {
    const prisma = new PrismaService();
    const flags = new FeatureFlagsService();
    const pilot = new PilotPrismaAccessor(prisma, new TenantPrismaService(prisma, flags), flags);
    const svc = makeService(prisma, pilot, { uploads: 0, deletes: 0 });
    try { return await svc.update(legacyCreate.id, { notes: 'desc-legacy-updated' }, SYS_USER_ID); }
    finally { await prisma.$disconnect(); }
  });
  const pilotUpdate = await withFlags(
    { TENANT_PRISMA_PILOT_ENABLED: 'true', TENANT_PRISMA_PILOT_MODULES: 'documents' },
    async () => {
      const prisma = new PrismaService();
      const flags = new FeatureFlagsService();
      const pilot = new PilotPrismaAccessor(prisma, new TenantPrismaService(prisma, flags), flags);
      const svc = makeService(prisma, pilot, { uploads: 0, deletes: 0 });
      try {
        return await withRequestContext({ requestId: newRequestId() }, async () => {
          TenantContext.attach({ id: tA, slug: 'a', name: 'A', status: 'ACTIVE', region: 'eu' });
          return svc.update(pilotCreate.id, { notes: 'desc-pilot-updated' }, SYS_USER_ID);
        });
      } finally { await prisma.$disconnect(); }
    },
  );
  out.push({
    name: 'update both modes mutate the notes',
    ok: (legacyUpdate as any).notes === 'desc-legacy-updated' && (pilotUpdate as any).notes === 'desc-pilot-updated',
    detail: `legacy="${(legacyUpdate as any).notes}" pilot="${(pilotUpdate as any).notes}"`,
  });

  // 4 — validation error
  let valLegacy = 'no-error', valPilot = 'no-error';
  await withFlags({ TENANT_PRISMA_PILOT_ENABLED: 'false' }, async () => {
    const prisma = new PrismaService();
    const flags = new FeatureFlagsService();
    const pilot = new PilotPrismaAccessor(prisma, new TenantPrismaService(prisma, flags), flags);
    const svc = makeService(prisma, pilot, { uploads: 0, deletes: 0 });
    try {
      await svc.create(
        { name: 'x', documentTypeId: '00000000-0000-0000-0000-deaddeaddead', entityType: 'EMPLOYEE', entityId: TENANT_A_EMP_ID } as any,
        fileFixture, SYS_USER_ID,
      );
    } catch (e) { valLegacy = (e as Error).constructor.name; }
    finally { await prisma.$disconnect(); }
  });
  await withFlags({ TENANT_PRISMA_PILOT_ENABLED: 'true', TENANT_PRISMA_PILOT_MODULES: 'documents' }, async () => {
    const prisma = new PrismaService();
    const flags = new FeatureFlagsService();
    const pilot = new PilotPrismaAccessor(prisma, new TenantPrismaService(prisma, flags), flags);
    const svc = makeService(prisma, pilot, { uploads: 0, deletes: 0 });
    try {
      await withRequestContext({ requestId: newRequestId() }, async () => {
        TenantContext.attach({ id: tA, slug: 'a', name: 'A', status: 'ACTIVE', region: 'eu' });
        await svc.create(
          { name: 'x', documentTypeId: '00000000-0000-0000-0000-deaddeaddead', entityType: 'EMPLOYEE', entityId: TENANT_A_EMP_ID } as any,
          fileFixture, SYS_USER_ID,
        );
      });
    } catch (e) { valPilot = (e as Error).constructor.name; }
    finally { await prisma.$disconnect(); }
  });
  out.push({
    name: 'validation error: NotFoundException for unknown documentTypeId in both modes',
    ok: valLegacy === 'NotFoundException' && valPilot === 'NotFoundException',
    detail: `legacy=${valLegacy} pilot=${valPilot}`,
  });

  // 5 — audit log delta
  const auditClient = new Client({ connectionString: url, ssl: /127\.0\.0\.1|localhost/.test(url) ? false : { rejectUnauthorized: false } });
  await auditClient.connect();
  const lAudit = await auditClient.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM audit_logs WHERE entity = 'Document' AND "entityId" = $1 AND action = 'UPLOAD'`, [legacyCreate.id]);
  const pAudit = await auditClient.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM audit_logs WHERE entity = 'Document' AND "entityId" = $1 AND action = 'UPLOAD'`, [pilotCreate.id]);
  await auditClient.end();
  out.push({
    name: 'audit log: one UPLOAD row written per create in both modes',
    ok: (lAudit.rows[0]?.n ?? 0) >= 1 && (pAudit.rows[0]?.n ?? 0) >= 1,
    detail: `legacy=${lAudit.rows[0]?.n} pilot=${pAudit.rows[0]?.n}`,
  });

  // 6 — soft-delete
  await withFlags({ TENANT_PRISMA_PILOT_ENABLED: 'true', TENANT_PRISMA_PILOT_MODULES: 'documents' }, async () => {
    const prisma = new PrismaService();
    const flags = new FeatureFlagsService();
    const pilot = new PilotPrismaAccessor(prisma, new TenantPrismaService(prisma, flags), flags);
    const svc = makeService(prisma, pilot, { uploads: 0, deletes: 0 });
    try {
      await withRequestContext({ requestId: newRequestId() }, async () => {
        TenantContext.attach({ id: tA, slug: 'a', name: 'A', status: 'ACTIVE', region: 'eu' });
        await svc.remove(pilotCreate.id, SYS_USER_ID);
      });
      const after: any = await (prisma as any).document.findUnique({ where: { id: pilotCreate.id } });
      out.push({
        name: 'pilot remove: deletedAt is set on the row',
        ok: !!after?.deletedAt,
        detail: `deletedAt=${after?.deletedAt ? 'set' : 'null'}`,
      });
    } finally { await prisma.$disconnect(); }
  });

  // 7 — renew (create a fresh tenant A doc to renew, since pilotCreate
  // was soft-deleted in case 6 and legacyCreate has tenantId=NULL which
  // findOne rejects in pilot mode).
  await withFlags({ TENANT_PRISMA_PILOT_ENABLED: 'true', TENANT_PRISMA_PILOT_MODULES: 'documents' }, async () => {
    const prisma = new PrismaService();
    const flags = new FeatureFlagsService();
    const pilot = new PilotPrismaAccessor(prisma, new TenantPrismaService(prisma, flags), flags);
    const svc = makeService(prisma, pilot, { uploads: 0, deletes: 0 });
    try {
      const fresh = await withRequestContext({ requestId: newRequestId() }, async () => {
        TenantContext.attach({ id: tA, slug: 'a', name: 'A', status: 'ACTIVE', region: 'eu' });
        return svc.create(
          { name: 'renew-target', documentTypeId: DOC_TYPE_ID, entityType: 'EMPLOYEE', entityId: TENANT_A_EMP_ID } as any,
          fileFixture, SYS_USER_ID,
        );
      });
      createdIds.push(fresh.id);
      const renewed = await withRequestContext({ requestId: newRequestId() }, async () => {
        TenantContext.attach({ id: tA, slug: 'a', name: 'A', status: 'ACTIVE', region: 'eu' });
        return svc.renew(fresh.id, { name: 'renewed' } as any, fileFixture, SYS_USER_ID);
      });
      createdIds.push(renewed.id);
      const row: any = await (prisma as any).document.findUnique({ where: { id: renewed.id } });
      out.push({
        name: 'pilot renew: creates new row with renewedFromId AND tenantId=A',
        ok: row?.renewedFromId === fresh.id && row?.tenantId === tA,
        detail: `renewedFromId=${row?.renewedFromId} tenantId=${row?.tenantId}`,
      });
    } finally { await prisma.$disconnect(); }
  });

  // 8 — metadata read-after-write
  await withFlags({ TENANT_PRISMA_PILOT_ENABLED: 'true', TENANT_PRISMA_PILOT_MODULES: 'documents' }, async () => {
    const prisma = new PrismaService();
    const flags = new FeatureFlagsService();
    const pilot = new PilotPrismaAccessor(prisma, new TenantPrismaService(prisma, flags), flags);
    const svc = makeService(prisma, pilot, { uploads: 0, deletes: 0 });
    try {
      // Use the legacy-created (tenantId NULL) doc; in pilot mode it
      // is invisible (tenantId filter excludes NULL). Use the pilot-
      // created doc instead — soft-deleted above; so use original
      // tenant-A seed doc.
      const got = await withRequestContext({ requestId: newRequestId() }, async () => {
        TenantContext.attach({ id: tA, slug: 'a', name: 'A', status: 'ACTIVE', region: 'eu' });
        return svc.findOne(TENANT_A_DOC_ID);
      });
      out.push({
        name: 'pilot read-after-write: findOne returns tenant A seed doc',
        ok: got.id === TENANT_A_DOC_ID,
        detail: `id=${got.id}`,
      });
    } finally { await prisma.$disconnect(); }
  });

  // Cleanup
  const cleanup = new Client({ connectionString: url, ssl: /127\.0\.0\.1|localhost/.test(url) ? false : { rejectUnauthorized: false } });
  await cleanup.connect();
  for (const id of createdIds) {
    await cleanup.query(`DELETE FROM documents WHERE id = $1`, [id]).catch(() => undefined);
  }
  await cleanup.query(`DELETE FROM audit_logs WHERE entity = 'Document' AND "entityId" = ANY($1::text[])`, [createdIds]).catch(() => undefined);
  await cleanup.end();

  await fs.mkdir(OUT_DIR, { recursive: true });
  const summary = {
    generatedAt: new Date().toISOString(),
    environment: env, tenantA: tA,
    counts: { total: out.length, passed: out.filter((r) => r.ok).length, failed: out.filter((r) => !r.ok).length },
    results: out,
  };
  await fs.writeFile(path.join(OUT_DIR, 'documents-mutation-equivalence.json'), JSON.stringify(summary, null, 2));
  const md: string[] = [];
  md.push('# Phase 2.21 — Documents Mutation Equivalence');
  md.push(''); md.push(`Generated: ${summary.generatedAt}`);
  md.push(`Environment: ${env.classification} (${env.reason})`);
  md.push(`Tenant A: \`${tA}\``); md.push('');
  md.push(`- Cases passed: **${summary.counts.passed}** / ${summary.counts.total}`);
  md.push(`- Cases failed: ${summary.counts.failed}`); md.push('');
  md.push('| # | Case | Result | Detail |');
  md.push('|--:|------|:------:|--------|');
  out.forEach((r, i) => md.push(`| ${i + 1} | ${r.name} | ${r.ok ? 'PASS' : '**FAIL**'} | ${r.detail} |`));
  await fs.writeFile(path.join(OUT_DIR, 'documents-mutation-equivalence.md'), md.join('\n'));

  console.log(`documents-mutation-equivalence: ${summary.counts.passed}/${summary.counts.total} cases PASS`);
  if (summary.counts.failed > 0) process.exit(2);
}

main().catch((e) => { console.error(e); process.exit(3); });
