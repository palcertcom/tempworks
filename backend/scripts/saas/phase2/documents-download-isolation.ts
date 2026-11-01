/**
 * Phase 2.22 — documents download isolation harness.
 *
 * Two tenants, seeded documents. Storage is stubbed (counts byte fetches
 * via patched global fetch).
 *
 *   1. DOWNLOAD GUARD: pilot ON, tenant A readDocumentBytes(tenantB-id)
 *      raises NotFoundException; 0 storage reads.
 *   2. Pilot ON, tenant A readDocumentBytes(tenantA-id) succeeds; 1
 *      storage read.
 *   3. ARCHIVE GUARD (cross-tenant only): pilot ON, tenant A
 *      createBulkDownloadArchive([tenantB-id1, tenantB-id2]) returns
 *      empty zip; 0 storage reads.
 *   4. ARCHIVE GUARD (mixed-tenant): pilot ON, tenant A
 *      createBulkDownloadArchive([A1, A2, B1, B2]) returns 2 entries;
 *      exactly 2 storage reads (A's only).
 *   5. Pilot ON, tenant A archive of same-tenant ids: full archive +
 *      N storage reads.
 *   6. Pilot OFF: legacy archive returns the union (4 entries for the
 *      mixed-tenant input); proves the gate disengages.
 *   7. Concurrent ALS frames: T_A and T_B isolated for both single-byte
 *      reads and bulk archives.
 *   8. Source-level meta-assertion: download sites carry
 *      `phase222-download-guard` and route through `this.prisma`.
 *
 * Output: backend/reports/saas/phase2/documents-download-isolation.{json,md}
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
const SRC_FILE = path.resolve(__dirname, '..', '..', '..', 'src', 'documents', 'documents.service.ts');
interface CaseResult { name: string; ok: boolean; detail: string; }

const TENANT_A_DOC_1 = '00000000-0000-0000-0000-0000000dc001';
const TENANT_A_DOC_2 = '00000000-0000-0000-0000-0000000dc002';
const TENANT_B_DOC_1 = '00000000-0000-0000-0000-0000000dc101';
const TENANT_B_DOC_2 = '00000000-0000-0000-0000-0000000dc102';

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

interface StubCounters { downloads: number; }

function makeService(prisma: PrismaService, pilot: PilotPrismaAccessor, counters: StubCounters): DocumentsService {
  const notifStub: any = { notifyUploaderAndRoles: async () => undefined, notifyUsersByRoles: async () => undefined };
  const idStub = new DocumentIdService(prisma);
  const originalFetch = global.fetch;
  (global as any).fetch = async (url: string) => {
    counters.downloads += 1;
    return new Response(Buffer.from(`stub-bytes-for-${url}`), { status: 200 }) as any;
  };
  const storageStub: any = {
    uploadFile: async () => ({ url: 'stub://x', key: 'x' }),
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
    console.error(`[documents-download-isolation] refusing on classification=${env.classification}`);
    process.exit(3);
  }
  const c = new Client({ connectionString: url, ssl: /127\.0\.0\.1|localhost/.test(url) ? false : { rejectUnauthorized: false } });
  await c.connect();
  const ts = await c.query<{ id: string }>(
    `SELECT t.id FROM tenants t
       WHERE EXISTS (SELECT 1 FROM documents d WHERE d."tenantId" = t.id::text)
       ORDER BY t.name`);
  const tA = ts.rows[0]?.id; const tB = ts.rows[1]?.id;
  await c.end();
  if (!tA || !tB) { console.error('need two tenants with documents'); process.exit(3); }

  const out: CaseResult[] = [];

  // 1 — readDocumentBytes(tenantB-id) raises 404, 0 storage reads
  await withFlags({ TENANT_PRISMA_PILOT_ENABLED: 'true', TENANT_PRISMA_PILOT_MODULES: 'documents' }, async () => {
    const prisma = new PrismaService();
    const flags = new FeatureFlagsService();
    const pilot = new PilotPrismaAccessor(prisma, new TenantPrismaService(prisma, flags), flags);
    const counters = { downloads: 0 };
    const svc = makeService(prisma, pilot, counters);
    try {
      let leaked = false; let errName = '';
      try {
        await withRequestContext({ requestId: newRequestId() }, async () => {
          TenantContext.attach({ id: tA, slug: 'a', name: 'A', status: 'ACTIVE', region: 'eu' });
          await svc.readDocumentBytes(TENANT_B_DOC_1);
        });
        leaked = true;
      } catch (e) { errName = (e as Error).constructor.name; }
      out.push({
        name: 'DOWNLOAD GUARD: pilot ON, tenant A readDocumentBytes(tenantB-id) raises NotFoundException; 0 storage reads',
        ok: !leaked && errName === 'NotFoundException' && counters.downloads === 0,
        detail: leaked ? 'UNEXPECTED: returned bytes' : `err=${errName} downloads=${counters.downloads}`,
      });
    } finally { (svc as any).__restoreFetch?.(); await prisma.$disconnect(); }
  });

  // 2 — readDocumentBytes(tenantA-id) succeeds, 1 storage read
  await withFlags({ TENANT_PRISMA_PILOT_ENABLED: 'true', TENANT_PRISMA_PILOT_MODULES: 'documents' }, async () => {
    const prisma = new PrismaService();
    const flags = new FeatureFlagsService();
    const pilot = new PilotPrismaAccessor(prisma, new TenantPrismaService(prisma, flags), flags);
    const counters = { downloads: 0 };
    const svc = makeService(prisma, pilot, counters);
    try {
      const r = await withRequestContext({ requestId: newRequestId() }, async () => {
        TenantContext.attach({ id: tA, slug: 'a', name: 'A', status: 'ACTIVE', region: 'eu' });
        return svc.readDocumentBytes(TENANT_A_DOC_1);
      });
      out.push({
        name: 'pilot ON, tenant A readDocumentBytes(tenantA-id) succeeds; 1 storage read',
        ok: Buffer.isBuffer(r.buffer) && counters.downloads === 1,
        detail: `bytes=${Buffer.isBuffer(r.buffer)} downloads=${counters.downloads}`,
      });
    } finally { (svc as any).__restoreFetch?.(); await prisma.$disconnect(); }
  });

  // 3 — ARCHIVE GUARD: cross-tenant-only id list ⇒ empty zip + 0 reads
  await withFlags({ TENANT_PRISMA_PILOT_ENABLED: 'true', TENANT_PRISMA_PILOT_MODULES: 'documents' }, async () => {
    const prisma = new PrismaService();
    const flags = new FeatureFlagsService();
    const pilot = new PilotPrismaAccessor(prisma, new TenantPrismaService(prisma, flags), flags);
    const counters = { downloads: 0 };
    const svc = makeService(prisma, pilot, counters);
    try {
      const buf = await withRequestContext({ requestId: newRequestId() }, async () => {
        TenantContext.attach({ id: tA, slug: 'a', name: 'A', status: 'ACTIVE', region: 'eu' });
        return svc.createBulkDownloadArchive([TENANT_B_DOC_1, TENANT_B_DOC_2]);
      });
      const zip = new AdmZip(buf);
      out.push({
        name: 'ARCHIVE GUARD: pilot ON, tenant A archive of cross-tenant-only ids ⇒ empty zip; 0 storage reads',
        ok: zip.getEntries().length === 0 && counters.downloads === 0,
        detail: `entries=${zip.getEntries().length} downloads=${counters.downloads}`,
      });
    } finally { (svc as any).__restoreFetch?.(); await prisma.$disconnect(); }
  });

  // 4 — ARCHIVE GUARD: mixed-tenant id list ⇒ A entries only + N reads
  await withFlags({ TENANT_PRISMA_PILOT_ENABLED: 'true', TENANT_PRISMA_PILOT_MODULES: 'documents' }, async () => {
    const prisma = new PrismaService();
    const flags = new FeatureFlagsService();
    const pilot = new PilotPrismaAccessor(prisma, new TenantPrismaService(prisma, flags), flags);
    const counters = { downloads: 0 };
    const svc = makeService(prisma, pilot, counters);
    try {
      const buf = await withRequestContext({ requestId: newRequestId() }, async () => {
        TenantContext.attach({ id: tA, slug: 'a', name: 'A', status: 'ACTIVE', region: 'eu' });
        return svc.createBulkDownloadArchive([TENANT_A_DOC_1, TENANT_A_DOC_2, TENANT_B_DOC_1, TENANT_B_DOC_2]);
      });
      const zip = new AdmZip(buf);
      // Verify entries do NOT contain tenant B's expected file names
      const names = zip.getEntries().map((e: any) => e.entryName);
      const noB = !names.some((n: string) => /Bob|dc101|dc102/i.test(n));
      out.push({
        name: 'ARCHIVE GUARD: pilot ON, tenant A archive of mixed ids ⇒ 2 entries (A only); 2 storage reads; no tenant-B file names',
        ok: zip.getEntries().length === 2 && counters.downloads === 2 && noB,
        detail: `entries=${zip.getEntries().length} downloads=${counters.downloads} names=${names.join('|')}`,
      });
    } finally { (svc as any).__restoreFetch?.(); await prisma.$disconnect(); }
  });

  // 5 — same-tenant archive
  await withFlags({ TENANT_PRISMA_PILOT_ENABLED: 'true', TENANT_PRISMA_PILOT_MODULES: 'documents' }, async () => {
    const prisma = new PrismaService();
    const flags = new FeatureFlagsService();
    const pilot = new PilotPrismaAccessor(prisma, new TenantPrismaService(prisma, flags), flags);
    const counters = { downloads: 0 };
    const svc = makeService(prisma, pilot, counters);
    try {
      const buf = await withRequestContext({ requestId: newRequestId() }, async () => {
        TenantContext.attach({ id: tA, slug: 'a', name: 'A', status: 'ACTIVE', region: 'eu' });
        return svc.createBulkDownloadArchive([TENANT_A_DOC_1, TENANT_A_DOC_2]);
      });
      const zip = new AdmZip(buf);
      out.push({
        name: 'pilot ON, tenant A: same-tenant archive ⇒ 2 entries; 2 storage reads',
        ok: zip.getEntries().length === 2 && counters.downloads === 2,
        detail: `entries=${zip.getEntries().length} downloads=${counters.downloads}`,
      });
    } finally { (svc as any).__restoreFetch?.(); await prisma.$disconnect(); }
  });

  // 6 — pilot OFF: legacy archive of mixed ids returns 4 entries
  await withFlags({ TENANT_PRISMA_PILOT_ENABLED: 'false' }, async () => {
    const prisma = new PrismaService();
    const flags = new FeatureFlagsService();
    const pilot = new PilotPrismaAccessor(prisma, new TenantPrismaService(prisma, flags), flags);
    const counters = { downloads: 0 };
    const svc = makeService(prisma, pilot, counters);
    try {
      const buf = await svc.createBulkDownloadArchive([TENANT_A_DOC_1, TENANT_A_DOC_2, TENANT_B_DOC_1, TENANT_B_DOC_2]);
      const zip = new AdmZip(buf);
      out.push({
        name: 'pilot OFF: legacy archive of mixed ids returns 4 entries (gate disengages)',
        ok: zip.getEntries().length === 4 && counters.downloads === 4,
        detail: `entries=${zip.getEntries().length} downloads=${counters.downloads}`,
      });
    } finally { (svc as any).__restoreFetch?.(); await prisma.$disconnect(); }
  });

  // 7 — concurrent ALS frames isolated
  await withFlags({ TENANT_PRISMA_PILOT_ENABLED: 'true', TENANT_PRISMA_PILOT_MODULES: 'documents' }, async () => {
    const prisma = new PrismaService();
    const flags = new FeatureFlagsService();
    const pilot = new PilotPrismaAccessor(prisma, new TenantPrismaService(prisma, flags), flags);
    const counters = { downloads: 0 };
    const svc = makeService(prisma, pilot, counters);
    try {
      const seen: Array<{ tenant: string; entries: number }> = [];
      await Promise.all([
        withRequestContext({ requestId: newRequestId() }, async () => {
          TenantContext.attach({ id: tA, slug: 'a', name: 'A', status: 'ACTIVE', region: 'eu' });
          await new Promise((r) => setTimeout(r, 5));
          const buf = await svc.createBulkDownloadArchive([TENANT_A_DOC_1, TENANT_A_DOC_2, TENANT_B_DOC_1]);
          const zip = new AdmZip(buf);
          seen.push({ tenant: tA, entries: zip.getEntries().length });
        }),
        withRequestContext({ requestId: newRequestId() }, async () => {
          TenantContext.attach({ id: tB, slug: 'b', name: 'B', status: 'ACTIVE', region: 'eu' });
          await new Promise((r) => setTimeout(r, 1));
          const buf = await svc.createBulkDownloadArchive([TENANT_A_DOC_1, TENANT_B_DOC_1, TENANT_B_DOC_2]);
          const zip = new AdmZip(buf);
          seen.push({ tenant: tB, entries: zip.getEntries().length });
        }),
      ]);
      const a = seen.find((s) => s.tenant === tA);
      const b = seen.find((s) => s.tenant === tB);
      out.push({
        name: 'concurrent ALS frames isolated: T_A archive has 2 A entries; T_B archive has 2 B entries',
        ok: a?.entries === 2 && b?.entries === 2,
        detail: `aEntries=${a?.entries} bEntries=${b?.entries}`,
      });
    } finally { (svc as any).__restoreFetch?.(); await prisma.$disconnect(); }
  });

  // 8 — source-level meta-assertion
  const src = await fs.readFile(SRC_FILE, 'utf8');
  const expected: Array<[string, RegExp]> = [
    ['readDocumentBytes is phase222-download-guard', /async readDocumentBytes\([\s\S]*?this\.prisma\.document\.findFirst[\s\S]{0,400}phase222-download-guard/],
    ['createBulkDownloadArchive uses this.prisma + tenant predicate', /async createBulkDownloadArchive\([\s\S]*?this\.prisma\.document\.findMany\([\s\S]{0,400}phase222-download-guard/],
    ['createBulkDownloadArchive spreads ...t into where', /async createBulkDownloadArchive\([\s\S]*?id: \{ in: ids \}, deletedAt: null, \.\.\.t/],
  ];
  const failed: string[] = [];
  expected.forEach(([name, re]) => { if (!re.test(src)) failed.push(name); });
  out.push({
    name: 'source: download sites carry phase222-download-guard and route through pilot client',
    ok: failed.length === 0,
    detail: failed.length === 0 ? 'all patterns matched' : failed.join('; '),
  });

  await fs.mkdir(OUT_DIR, { recursive: true });
  const summary = {
    generatedAt: new Date().toISOString(),
    environment: env, tenantA: tA, tenantB: tB,
    counts: { total: out.length, passed: out.filter((r) => r.ok).length, failed: out.filter((r) => !r.ok).length },
    results: out,
  };
  await fs.writeFile(path.join(OUT_DIR, 'documents-download-isolation.json'), JSON.stringify(summary, null, 2));
  const md: string[] = [];
  md.push('# Phase 2.22 — Documents Download Isolation');
  md.push(''); md.push(`Generated: ${summary.generatedAt}`);
  md.push(`Environment: ${env.classification} (${env.reason})`);
  md.push(`Tenants: A=\`${tA}\` B=\`${tB}\``); md.push('');
  md.push(`- Cases passed: **${summary.counts.passed}** / ${summary.counts.total}`);
  md.push(`- Cases failed: ${summary.counts.failed}`); md.push('');
  md.push('| # | Case | Result | Detail |');
  md.push('|--:|------|:------:|--------|');
  out.forEach((r, i) => md.push(`| ${i + 1} | ${r.name} | ${r.ok ? 'PASS' : '**FAIL**'} | ${r.detail} |`));
  await fs.writeFile(path.join(OUT_DIR, 'documents-download-isolation.md'), md.join('\n'));

  console.log(`documents-download-isolation: ${summary.counts.passed}/${summary.counts.total} cases PASS`);
  if (summary.counts.failed > 0) process.exit(2);
}

main().catch((e) => { console.error(e); process.exit(3); });
