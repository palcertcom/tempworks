/**
 * Phase 2.22 — documents download equivalence harness.
 *
 * Compares legacy and pilot DOWNLOAD paths back-to-back on the same DB
 * with a stub storage that counts byte fetches.
 *
 *   1. readDocumentBytes legacy + pilot return same shape for tenant A id
 *   2. readDocumentBytes triggers exactly 1 storage read in both modes
 *   3. createBulkDownloadArchive: same-tenant id list returns a Buffer
 *      with N entries in both modes (using AdmZip to count)
 *   4. createBulkDownloadArchive: legacy storage reads = N for the
 *      requested-and-existing rows; pilot storage reads = N too (same
 *      tenant ⇒ same result)
 *   5. readDocumentBytes: missing id raises NotFoundException in both modes
 *   6. createBulkDownloadArchive: empty input ⇒ empty zip in both modes
 *   7. response shape preservation
 *
 * Output: backend/reports/saas/phase2/documents-download-equivalence.{json,md}
 */
/* eslint-disable no-console */
import { promises as fs } from 'fs';
import path from 'path';
import AdmZip = require('adm-zip');
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
import { TenantContext, withRequestContext, newRequestId } from '../../../src/saas/context/als';

autoLoadEnv(__filename);

const OUT_DIR = path.resolve(__dirname, '..', '..', '..', 'reports', 'saas', 'phase2');
interface CaseResult { name: string; ok: boolean; detail: string; }

const TENANT_A_DOC_ID_1 = '00000000-0000-0000-0000-0000000dc001';
const TENANT_A_DOC_ID_2 = '00000000-0000-0000-0000-0000000dc002';

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

interface StubCounters { uploads: number; downloads: number; }

function makeService(prisma: PrismaService, pilot: PilotPrismaAccessor, counters: StubCounters): DocumentsService {
  const notifStub: any = { notifyUploaderAndRoles: async () => undefined, notifyUsersByRoles: async () => undefined };
  const idStub = new DocumentIdService(prisma);
  // Stub fetchDocumentBuffer indirectly by stubbing global fetch — but
  // fetchDocumentBuffer is a private method that reads the URL itself.
  // For the harness, we patch `fetch` to return a fake response so no
  // real network is used; the byte-fetch counter ticks per call.
  const originalFetch = global.fetch;
  (global as any).fetch = async (url: string) => {
    counters.downloads += 1;
    return new Response(Buffer.from(`stub-bytes-for-${url}`), { status: 200 }) as any;
  };
  // Restore-on-disconnect not strictly needed; tests run sequentially.
  // Track originalFetch on the instance for cleanup.
  const storageStub: any = {
    uploadFile: async (_b: Buffer, opts: any) => { counters.uploads += 1; return { url: `stub://up/${opts.originalName}`, key: opts.originalName }; },
    deleteFileByUrlOrKey: async () => undefined,
    downloadByUrlOrKey: async () => Buffer.from('x'),
  };
  const svc = new DocumentsService(prisma, idStub, notifStub, storageStub, pilot, new TenantAuditLogService(prisma, new FeatureFlagsService()));
  (svc as any).__restoreFetch = () => { (global as any).fetch = originalFetch; };
  return svc;
}

async function main(): Promise<void> {
  const url = getDatabaseUrl();
  const env = classifyRuntimeEnv();
  if (!isStagingClassification(env.classification)) {
    console.error(`[documents-download-equivalence] refusing on classification=${env.classification}`);
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

  interface ReadResult { shape: boolean; downloads: number; }
  const legacyRead: ReadResult = await withFlags({ TENANT_PRISMA_PILOT_ENABLED: 'false' }, async () => {
    const prisma = new PrismaService();
    const flags = new FeatureFlagsService();
    const pilot = new PilotPrismaAccessor(prisma, new TenantPrismaService(prisma, flags), flags);
    const counters = { uploads: 0, downloads: 0 };
    const svc = makeService(prisma, pilot, counters);
    try {
      const r = await svc.readDocumentBytes(TENANT_A_DOC_ID_1);
      const shape = Buffer.isBuffer(r.buffer) && typeof r.mimeType === 'string' && typeof r.name === 'string';
      return { shape, downloads: counters.downloads };
    } finally { (svc as any).__restoreFetch?.(); await prisma.$disconnect(); }
  });
  const pilotRead: ReadResult = await withFlags({ TENANT_PRISMA_PILOT_ENABLED: 'true', TENANT_PRISMA_PILOT_MODULES: 'documents' }, async () => {
    const prisma = new PrismaService();
    const flags = new FeatureFlagsService();
    const pilot = new PilotPrismaAccessor(prisma, new TenantPrismaService(prisma, flags), flags);
    const counters = { uploads: 0, downloads: 0 };
    const svc = makeService(prisma, pilot, counters);
    try {
      return await withRequestContext({ requestId: newRequestId() }, async () => {
        TenantContext.attach({ id: tA, slug: 'a', name: 'A', status: 'ACTIVE', region: 'eu' });
        const r = await svc.readDocumentBytes(TENANT_A_DOC_ID_1);
        const shape = Buffer.isBuffer(r.buffer) && typeof r.mimeType === 'string' && typeof r.name === 'string';
        return { shape, downloads: counters.downloads };
      });
    } finally { (svc as any).__restoreFetch?.(); await prisma.$disconnect(); }
  });

  out.push({
    name: 'readDocumentBytes: response shape preserved (buffer + mimeType + name)',
    ok: legacyRead.shape && pilotRead.shape,
    detail: `legacy.shape=${legacyRead.shape} pilot.shape=${pilotRead.shape}`,
  });
  out.push({
    name: 'readDocumentBytes: exactly 1 storage read in both modes',
    ok: legacyRead.downloads === 1 && pilotRead.downloads === 1,
    detail: `legacy=${legacyRead.downloads} pilot=${pilotRead.downloads}`,
  });

  // Bulk archive — same-tenant id list
  interface ArchiveResult { entries: number; downloads: number; }
  const legacyArchive: ArchiveResult = await withFlags({ TENANT_PRISMA_PILOT_ENABLED: 'false' }, async () => {
    const prisma = new PrismaService();
    const flags = new FeatureFlagsService();
    const pilot = new PilotPrismaAccessor(prisma, new TenantPrismaService(prisma, flags), flags);
    const counters = { uploads: 0, downloads: 0 };
    const svc = makeService(prisma, pilot, counters);
    try {
      const buf = await svc.createBulkDownloadArchive([TENANT_A_DOC_ID_1, TENANT_A_DOC_ID_2]);
      const zip = new AdmZip(buf);
      return { entries: zip.getEntries().length, downloads: counters.downloads };
    } finally { (svc as any).__restoreFetch?.(); await prisma.$disconnect(); }
  });
  const pilotArchive: ArchiveResult = await withFlags({ TENANT_PRISMA_PILOT_ENABLED: 'true', TENANT_PRISMA_PILOT_MODULES: 'documents' }, async () => {
    const prisma = new PrismaService();
    const flags = new FeatureFlagsService();
    const pilot = new PilotPrismaAccessor(prisma, new TenantPrismaService(prisma, flags), flags);
    const counters = { uploads: 0, downloads: 0 };
    const svc = makeService(prisma, pilot, counters);
    try {
      return await withRequestContext({ requestId: newRequestId() }, async () => {
        TenantContext.attach({ id: tA, slug: 'a', name: 'A', status: 'ACTIVE', region: 'eu' });
        const buf = await svc.createBulkDownloadArchive([TENANT_A_DOC_ID_1, TENANT_A_DOC_ID_2]);
        const zip = new AdmZip(buf);
        return { entries: zip.getEntries().length, downloads: counters.downloads };
      });
    } finally { (svc as any).__restoreFetch?.(); await prisma.$disconnect(); }
  });

  out.push({
    name: 'createBulkDownloadArchive: same-tenant 2-id list yields 2 entries in both modes',
    ok: legacyArchive.entries === 2 && pilotArchive.entries === 2,
    detail: `legacy.entries=${legacyArchive.entries} pilot.entries=${pilotArchive.entries}`,
  });
  out.push({
    name: 'createBulkDownloadArchive: 2 storage reads in both modes for same-tenant 2-id list',
    ok: legacyArchive.downloads === 2 && pilotArchive.downloads === 2,
    detail: `legacy.downloads=${legacyArchive.downloads} pilot.downloads=${pilotArchive.downloads}`,
  });

  // Missing-id error path
  let lErr = 'no-error', pErr = 'no-error';
  await withFlags({ TENANT_PRISMA_PILOT_ENABLED: 'false' }, async () => {
    const prisma = new PrismaService();
    const flags = new FeatureFlagsService();
    const pilot = new PilotPrismaAccessor(prisma, new TenantPrismaService(prisma, flags), flags);
    const svc = makeService(prisma, pilot, { uploads: 0, downloads: 0 });
    try { await svc.readDocumentBytes('00000000-0000-0000-0000-deaddeaddead'); }
    catch (e) { lErr = (e as Error).constructor.name; }
    finally { (svc as any).__restoreFetch?.(); await prisma.$disconnect(); }
  });
  await withFlags({ TENANT_PRISMA_PILOT_ENABLED: 'true', TENANT_PRISMA_PILOT_MODULES: 'documents' }, async () => {
    const prisma = new PrismaService();
    const flags = new FeatureFlagsService();
    const pilot = new PilotPrismaAccessor(prisma, new TenantPrismaService(prisma, flags), flags);
    const svc = makeService(prisma, pilot, { uploads: 0, downloads: 0 });
    try {
      await withRequestContext({ requestId: newRequestId() }, async () => {
        TenantContext.attach({ id: tA, slug: 'a', name: 'A', status: 'ACTIVE', region: 'eu' });
        await svc.readDocumentBytes('00000000-0000-0000-0000-deaddeaddead');
      });
    } catch (e) { pErr = (e as Error).constructor.name; }
    finally { (svc as any).__restoreFetch?.(); await prisma.$disconnect(); }
  });
  out.push({
    name: 'readDocumentBytes: NotFoundException for missing id in both modes',
    ok: lErr === 'NotFoundException' && pErr === 'NotFoundException',
    detail: `legacy=${lErr} pilot=${pErr}`,
  });

  // Empty input ⇒ empty zip
  const emptyLegacy = await withFlags({ TENANT_PRISMA_PILOT_ENABLED: 'false' }, async () => {
    const prisma = new PrismaService();
    const flags = new FeatureFlagsService();
    const pilot = new PilotPrismaAccessor(prisma, new TenantPrismaService(prisma, flags), flags);
    const counters = { uploads: 0, downloads: 0 };
    const svc = makeService(prisma, pilot, counters);
    try {
      const buf = await svc.createBulkDownloadArchive([]);
      const zip = new AdmZip(buf);
      return { entries: zip.getEntries().length, downloads: counters.downloads };
    } finally { (svc as any).__restoreFetch?.(); await prisma.$disconnect(); }
  });
  const emptyPilot = await withFlags({ TENANT_PRISMA_PILOT_ENABLED: 'true', TENANT_PRISMA_PILOT_MODULES: 'documents' }, async () => {
    const prisma = new PrismaService();
    const flags = new FeatureFlagsService();
    const pilot = new PilotPrismaAccessor(prisma, new TenantPrismaService(prisma, flags), flags);
    const counters = { uploads: 0, downloads: 0 };
    const svc = makeService(prisma, pilot, counters);
    try {
      return await withRequestContext({ requestId: newRequestId() }, async () => {
        TenantContext.attach({ id: tA, slug: 'a', name: 'A', status: 'ACTIVE', region: 'eu' });
        const buf = await svc.createBulkDownloadArchive([]);
        const zip = new AdmZip(buf);
        return { entries: zip.getEntries().length, downloads: counters.downloads };
      });
    } finally { (svc as any).__restoreFetch?.(); await prisma.$disconnect(); }
  });
  out.push({
    name: 'createBulkDownloadArchive: empty input yields empty zip + 0 storage reads in both modes',
    ok: emptyLegacy.entries === 0 && emptyPilot.entries === 0
      && emptyLegacy.downloads === 0 && emptyPilot.downloads === 0,
    detail: `legacy={entries:${emptyLegacy.entries},downloads:${emptyLegacy.downloads}} pilot={entries:${emptyPilot.entries},downloads:${emptyPilot.downloads}}`,
  });

  await fs.mkdir(OUT_DIR, { recursive: true });
  const summary = {
    generatedAt: new Date().toISOString(),
    environment: env, tenantA: tA,
    counts: { total: out.length, passed: out.filter((r) => r.ok).length, failed: out.filter((r) => !r.ok).length },
    results: out,
  };
  await fs.writeFile(path.join(OUT_DIR, 'documents-download-equivalence.json'), JSON.stringify(summary, null, 2));
  const md: string[] = [];
  md.push('# Phase 2.22 — Documents Download Equivalence');
  md.push(''); md.push(`Generated: ${summary.generatedAt}`);
  md.push(`Environment: ${env.classification} (${env.reason})`);
  md.push(`Tenant A: \`${tA}\``); md.push('');
  md.push(`- Cases passed: **${summary.counts.passed}** / ${summary.counts.total}`);
  md.push(`- Cases failed: ${summary.counts.failed}`); md.push('');
  md.push('| # | Case | Result | Detail |');
  md.push('|--:|------|:------:|--------|');
  out.forEach((r, i) => md.push(`| ${i + 1} | ${r.name} | ${r.ok ? 'PASS' : '**FAIL**'} | ${r.detail} |`));
  await fs.writeFile(path.join(OUT_DIR, 'documents-download-equivalence.md'), md.join('\n'));

  console.log(`documents-download-equivalence: ${summary.counts.passed}/${summary.counts.total} cases PASS`);
  if (summary.counts.failed > 0) process.exit(2);
}

main().catch((e) => { console.error(e); process.exit(3); });
