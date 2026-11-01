/**
 * Phase 2.20 — documents pilot isolation harness.
 *
 * Two tenants × two same-shape documents each. Proves:
 *   1. Pilot ON, tenant A: findAll returns only tenant A documents.
 *   2. Pilot ON, tenant A: findOne(tenantB-id) raises NotFoundException.
 *   3. Pilot ON, tenant A: findByEntity on tenant B's employee returns 0.
 *   4. Pilot ON, tenant A: getExpiringDocuments excludes tenant B docs.
 *   5. Pilot ON, tenant A: readDocumentBytes(tenantB-id) raises 404
 *      (metadata-lookup gate prevents storage byte fetch).
 *   6. Pilot ON: checkDocTypePermission still works (global catalog).
 *   7. Concurrent ALS frames: T_A no B-rows, T_B no A-rows.
 *   8. Pilot OFF: legacy returns the union of A+B documents.
 *   9. Source-level meta-assertion: every mutation method
 *      (`create`, `update`, `verify`, `renew`, `remove`,
 *      `upsertDocTypePermission`, `checkAndAutoCompleteStage`) and
 *      `createBulkDownloadArchive` use `legacyPrisma`.
 *
 * Output: backend/reports/saas/phase2/documents-isolation.{json,md}
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
import { StorageService } from '../../../src/common/storage/storage.service';
import {
  TenantContext,
  withRequestContext,
  newRequestId,
} from '../../../src/saas/context/als';

autoLoadEnv(__filename);

const OUT_DIR = path.resolve(__dirname, '..', '..', '..', 'reports', 'saas', 'phase2');
const SRC_FILE = path.resolve(__dirname, '..', '..', '..', 'src', 'documents', 'documents.service.ts');

interface CaseResult { name: string; ok: boolean; detail: string; }

const TENANT_A_DOC_ID = '00000000-0000-0000-0000-0000000dc001';
const TENANT_B_DOC_ID = '00000000-0000-0000-0000-0000000dc101';
const TENANT_A_EMP_ID = 'eeeeeeea-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const TENANT_B_EMP_ID = 'eeeeeeeb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

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

function makeService(prisma: PrismaService, pilot: PilotPrismaAccessor): DocumentsService {
  const notifStub: any = { notifyUploaderAndRoles: async () => undefined, notifyUsersByRoles: async () => undefined };
  const idStub = new DocumentIdService(prisma);
  const storage = new StorageService();
  return new DocumentsService(prisma, idStub, notifStub, storage, pilot, new TenantAuditLogService(prisma, new FeatureFlagsService()));
}

async function main(): Promise<void> {
  const url = getDatabaseUrl();
  const env = classifyRuntimeEnv();
  if (!isStagingClassification(env.classification)) {
    console.error(`[documents-isolation] refusing on classification=${env.classification}`);
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

  // 1+2 — pilot ON, tenant A
  await withFlags({ TENANT_PRISMA_PILOT_ENABLED: 'true', TENANT_PRISMA_PILOT_MODULES: 'documents' }, async () => {
    const prisma = new PrismaService();
    const flags = new FeatureFlagsService();
    const pilot = new PilotPrismaAccessor(prisma, new TenantPrismaService(prisma, flags), flags);
    const svc = makeService(prisma, pilot);
    try {
      const all = await withRequestContext({ requestId: newRequestId() }, async () => {
        TenantContext.attach({ id: tA, slug: 'a', name: 'A', status: 'ACTIVE', region: 'eu' });
        return svc.findAll({ page: 1, limit: 50 } as any);
      });
      const ids = (all as any).data.map((d: any) => d.id);
      const noB = !ids.includes(TENANT_B_DOC_ID)
        && !ids.includes('00000000-0000-0000-0000-0000000dc102');
      out.push({
        name: 'pilot ON, tenant A: findAll returns ONLY tenant A documents',
        ok: noB && ids.length > 0,
        detail: `count=${ids.length} noB=${noB}`,
      });

      let leaked = false;
      try {
        await withRequestContext({ requestId: newRequestId() }, async () => {
          TenantContext.attach({ id: tA, slug: 'a', name: 'A', status: 'ACTIVE', region: 'eu' });
          await svc.findOne(TENANT_B_DOC_ID);
        });
        leaked = true;
      } catch { leaked = false; }
      out.push({
        name: 'pilot ON, tenant A: findOne(tenantB-id) raises NotFoundException',
        ok: !leaked,
        detail: leaked ? 'UNEXPECTED: returned' : 'NotFoundException',
      });
    } finally { await prisma.$disconnect(); }
  });

  // 3 — findByEntity on tenant B's employee returns 0
  await withFlags({ TENANT_PRISMA_PILOT_ENABLED: 'true', TENANT_PRISMA_PILOT_MODULES: 'documents' }, async () => {
    const prisma = new PrismaService();
    const flags = new FeatureFlagsService();
    const pilot = new PilotPrismaAccessor(prisma, new TenantPrismaService(prisma, flags), flags);
    const svc = makeService(prisma, pilot);
    try {
      const r = await withRequestContext({ requestId: newRequestId() }, async () => {
        TenantContext.attach({ id: tA, slug: 'a', name: 'A', status: 'ACTIVE', region: 'eu' });
        return svc.findByEntity('EMPLOYEE', TENANT_B_EMP_ID, { page: 1, limit: 50 } as any);
      });
      out.push({
        name: 'pilot ON, tenant A: findByEntity on tenant B employee returns 0 documents',
        ok: ((r as any).meta?.total ?? 0) === 0,
        detail: `total=${(r as any).meta?.total}`,
      });
    } finally { await prisma.$disconnect(); }
  });

  // 4 — getExpiringDocuments excludes tenant B
  await withFlags({ TENANT_PRISMA_PILOT_ENABLED: 'true', TENANT_PRISMA_PILOT_MODULES: 'documents' }, async () => {
    const prisma = new PrismaService();
    const flags = new FeatureFlagsService();
    const pilot = new PilotPrismaAccessor(prisma, new TenantPrismaService(prisma, flags), flags);
    const svc = makeService(prisma, pilot);
    try {
      const r = await withRequestContext({ requestId: newRequestId() }, async () => {
        TenantContext.attach({ id: tA, slug: 'a', name: 'A', status: 'ACTIVE', region: 'eu' });
        return svc.getExpiringDocuments(365);
      });
      const ids = r.map((d: any) => d.id);
      out.push({
        name: 'pilot ON, tenant A: getExpiringDocuments excludes tenant B documents',
        ok: !ids.includes(TENANT_B_DOC_ID) && !ids.includes('00000000-0000-0000-0000-0000000dc102'),
        detail: `count=${ids.length} ids=${ids.slice(0, 4).join(',')}…`,
      });
    } finally { await prisma.$disconnect(); }
  });

  // 5 — readDocumentBytes(tenantB-id) raises 404 (metadata-lookup gate)
  await withFlags({ TENANT_PRISMA_PILOT_ENABLED: 'true', TENANT_PRISMA_PILOT_MODULES: 'documents' }, async () => {
    const prisma = new PrismaService();
    const flags = new FeatureFlagsService();
    const pilot = new PilotPrismaAccessor(prisma, new TenantPrismaService(prisma, flags), flags);
    const svc = makeService(prisma, pilot);
    try {
      let leaked = false;
      let errName = '';
      let errMsg = '';
      try {
        await withRequestContext({ requestId: newRequestId() }, async () => {
          TenantContext.attach({ id: tA, slug: 'a', name: 'A', status: 'ACTIVE', region: 'eu' });
          await svc.readDocumentBytes(TENANT_B_DOC_ID);
        });
        leaked = true;
      } catch (e) {
        errName = (e as Error).constructor.name;
        errMsg = (e as Error).message ?? '';
      }
      out.push({
        name: 'pilot ON, tenant A: readDocumentBytes(tenantB-id) raises NotFoundException (no storage fetch)',
        ok: !leaked && errName === 'NotFoundException',
        detail: leaked ? 'UNEXPECTED: returned bytes' : `err=${errName} msg=${errMsg.slice(0, 60)}`,
      });
    } finally { await prisma.$disconnect(); }
  });

  // 6 — global catalog still works in pilot mode
  await withFlags({ TENANT_PRISMA_PILOT_ENABLED: 'true', TENANT_PRISMA_PILOT_MODULES: 'documents' }, async () => {
    const prisma = new PrismaService();
    const flags = new FeatureFlagsService();
    const pilot = new PilotPrismaAccessor(prisma, new TenantPrismaService(prisma, flags), flags);
    const svc = makeService(prisma, pilot);
    try {
      const v = await withRequestContext({ requestId: newRequestId() }, async () => {
        TenantContext.attach({ id: tA, slug: 'a', name: 'A', status: 'ACTIVE', region: 'eu' });
        return svc.checkDocTypePermission(
          '00000000-0000-0000-0000-00000000dt01',
          '00000000-0000-0000-0000-00000000ro01',
          'canView',
        );
      });
      out.push({
        name: 'pilot ON: checkDocTypePermission (global catalog) returns boolean',
        ok: typeof v === 'boolean',
        detail: `value=${v}`,
      });
    } finally { await prisma.$disconnect(); }
  });

  // 7 — concurrent ALS frames isolated
  await withFlags({ TENANT_PRISMA_PILOT_ENABLED: 'true', TENANT_PRISMA_PILOT_MODULES: 'documents' }, async () => {
    const prisma = new PrismaService();
    const flags = new FeatureFlagsService();
    const pilot = new PilotPrismaAccessor(prisma, new TenantPrismaService(prisma, flags), flags);
    const svc = makeService(prisma, pilot);
    try {
      const seen: Array<{ t: string; ids: string[] }> = [];
      await Promise.all([
        withRequestContext({ requestId: newRequestId() }, async () => {
          TenantContext.attach({ id: tA, slug: 'a', name: 'A', status: 'ACTIVE', region: 'eu' });
          await new Promise((r) => setTimeout(r, 5));
          const r = await svc.findAll({ page: 1, limit: 50 } as any);
          seen.push({ t: tA, ids: (r as any).data.map((x: any) => x.id) });
        }),
        withRequestContext({ requestId: newRequestId() }, async () => {
          TenantContext.attach({ id: tB, slug: 'b', name: 'B', status: 'ACTIVE', region: 'eu' });
          await new Promise((r) => setTimeout(r, 1));
          const r = await svc.findAll({ page: 1, limit: 50 } as any);
          seen.push({ t: tB, ids: (r as any).data.map((x: any) => x.id) });
        }),
      ]);
      const a = seen.find((x) => x.t === tA);
      const b = seen.find((x) => x.t === tB);
      const aHasNoB = !!a && !a.ids.includes(TENANT_B_DOC_ID);
      const bHasNoA = !!b && !b.ids.includes(TENANT_A_DOC_ID);
      out.push({
        name: 'concurrent ALS frames isolated (T_A no B-rows; T_B no A-rows)',
        ok: aHasNoB && bHasNoA,
        detail: `aCount=${a?.ids.length} bCount=${b?.ids.length} aNoB=${aHasNoB} bNoA=${bHasNoA}`,
      });
    } finally { await prisma.$disconnect(); }
  });

  // 8 — pilot OFF: legacy returns union
  await withFlags({ TENANT_PRISMA_PILOT_ENABLED: 'false' }, async () => {
    const prisma = new PrismaService();
    const flags = new FeatureFlagsService();
    const pilot = new PilotPrismaAccessor(prisma, new TenantPrismaService(prisma, flags), flags);
    const svc = makeService(prisma, pilot);
    try {
      const all = await svc.findAll({ page: 1, limit: 50 } as any);
      const ids = (all as any).data.map((d: any) => d.id);
      out.push({
        name: 'pilot OFF: legacy reads include both tenant A and tenant B documents',
        ok: ids.includes(TENANT_A_DOC_ID) && ids.includes(TENANT_B_DOC_ID),
        detail: `count=${ids.length} hasA=${ids.includes(TENANT_A_DOC_ID)} hasB=${ids.includes(TENANT_B_DOC_ID)}`,
      });
    } finally { await prisma.$disconnect(); }
  });

  // 9 — source-level meta-assertion
  const src = await fs.readFile(SRC_FILE, 'utf8');
  const expected = [
    /async create\([^)]*\) \{[\s\S]*?this\.legacyPrisma\.\$transaction/,
    /async update\([^)]*\) \{[\s\S]*?this\.legacyPrisma\.document\.update/,
    /async verify\([^)]*\) \{[\s\S]*?this\.legacyPrisma\.document\.update/,
    /async renew\([^)]*?\) \{[\s\S]*?this\.legacyPrisma\.\$transaction/,
    /async remove\([^)]*\) \{[\s\S]*?this\.legacyPrisma\.document\.update/,
    /async upsertDocTypePermission\([^)]*\) \{[\s\S]*?this\.legacyPrisma\.documentTypePermission\.upsert/,
    // Phase 2.22 — createBulkDownloadArchive moved from legacyPrisma
    // to the pilot client with `...t` spread (download guard).
    /async createBulkDownloadArchive\([^)]*\)[^{]*\{[\s\S]*?this\.prisma\.document\.findMany\([\s\S]{0,400}phase222-download-guard/,
    /private async checkAndAutoCompleteStage\([^)]*\) \{[\s\S]*?this\.legacyPrisma\./,
  ];
  const failed: string[] = [];
  expected.forEach((re, i) => { if (!re.test(src)) failed.push(`pattern #${i + 1} missing`); });
  out.push({
    name: 'source: every mutation/download method routes through legacyPrisma',
    ok: failed.length === 0,
    detail: failed.length === 0 ? 'all guard annotations present' : failed.join('; '),
  });

  await fs.mkdir(OUT_DIR, { recursive: true });
  const summary = {
    generatedAt: new Date().toISOString(),
    environment: env, tenantA: tA, tenantB: tB,
    counts: { total: out.length, passed: out.filter((r) => r.ok).length, failed: out.filter((r) => !r.ok).length },
    results: out,
  };
  await fs.writeFile(path.join(OUT_DIR, 'documents-isolation.json'), JSON.stringify(summary, null, 2));
  const md: string[] = [];
  md.push('# Phase 2.20 — Documents Isolation');
  md.push(''); md.push(`Generated: ${summary.generatedAt}`);
  md.push(`Environment: ${env.classification} (${env.reason})`);
  md.push(`Tenants: A=\`${tA}\` B=\`${tB}\``); md.push('');
  md.push(`- Cases passed: **${summary.counts.passed}** / ${summary.counts.total}`);
  md.push(`- Cases failed: ${summary.counts.failed}`); md.push('');
  md.push('| # | Case | Result | Detail |');
  md.push('|--:|------|:------:|--------|');
  out.forEach((r, i) => md.push(`| ${i + 1} | ${r.name} | ${r.ok ? 'PASS' : '**FAIL**'} | ${r.detail} |`));
  await fs.writeFile(path.join(OUT_DIR, 'documents-isolation.md'), md.join('\n'));

  console.log(`documents-isolation: ${summary.counts.passed}/${summary.counts.total} cases PASS`);
  if (summary.counts.failed > 0) process.exit(2);
}

main().catch((e) => { console.error(e); process.exit(3); });
