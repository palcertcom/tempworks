/**
 * Phase 2.21 — documents mutation isolation harness.
 *
 * Two tenants × seeded documents. Storage is stubbed (counts uploads).
 *
 *   1. STORAGE GUARD: pilot ON, tenant A creates pointing at tenant B
 *      employee ⇒ NotFoundException, 0 storage uploads, 0 row inserted.
 *   2. Pilot ON, tenant A: create({ entityA }) succeeds, tenantId=A,
 *      1 storage upload.
 *   3. Pilot ON, tenant A: update(tenantB-doc-id) raises NotFoundException;
 *      target row's notes/status unchanged.
 *   4. Pilot ON, tenant A: verify(tenantB-doc-id) raises NotFoundException;
 *      target row's status unchanged.
 *   5. Pilot ON, tenant A: renew(tenantB-doc-id) raises NotFoundException;
 *      0 storage uploads, no new row inserted.
 *   6. Pilot ON, tenant A: remove(tenantB-doc-id) raises NotFoundException;
 *      target row's deletedAt unchanged.
 *   7. Pilot ON, tenant A: getExpiringDocuments excludes tenant B
 *      after a same-tenant create.
 *   8. Pilot OFF: legacy update on tenant B doc still mutates.
 *   9. Source-level meta-assertion: every Phase 2.21 mutation site
 *      carries the right tag.
 *
 * Output: backend/reports/saas/phase2/documents-mutation-isolation.{json,md}
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
const SRC_FILE = path.resolve(__dirname, '..', '..', '..', 'src', 'documents', 'documents.service.ts');
interface CaseResult { name: string; ok: boolean; detail: string; }

const TENANT_A_EMP_ID = 'eeeeeeea-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const TENANT_B_EMP_ID = 'eeeeeeeb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const TENANT_B_DOC_ID = '00000000-0000-0000-0000-0000000dc101';
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

const fileFixture: any = { buffer: Buffer.from('test-bytes'), originalname: 'test.pdf', mimetype: 'application/pdf', size: 10 };

async function main(): Promise<void> {
  const url = getDatabaseUrl();
  const env = classifyRuntimeEnv();
  if (!isStagingClassification(env.classification)) {
    console.error(`[documents-mutation-isolation] refusing on classification=${env.classification}`);
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
  const createdIds: string[] = [];

  // 1 — STORAGE GUARD: cross-tenant create raises BEFORE upload
  await withFlags({ TENANT_PRISMA_PILOT_ENABLED: 'true', TENANT_PRISMA_PILOT_MODULES: 'documents' }, async () => {
    const prisma = new PrismaService();
    const flags = new FeatureFlagsService();
    const pilot = new PilotPrismaAccessor(prisma, new TenantPrismaService(prisma, flags), flags);
    const counters = { uploads: 0, deletes: 0 };
    const svc = makeService(prisma, pilot, counters);
    try {
      const beforeCount = await (prisma as any).document.count({ where: { tenantId: tB } });
      let leaked = false; let errName = '';
      try {
        await withRequestContext({ requestId: newRequestId() }, async () => {
          TenantContext.attach({ id: tA, slug: 'a', name: 'A', status: 'ACTIVE', region: 'eu' });
          await svc.create(
            { name: 'cross-tenant-attempt', documentTypeId: DOC_TYPE_ID, entityType: 'EMPLOYEE', entityId: TENANT_B_EMP_ID } as any,
            fileFixture, SYS_USER_ID,
          );
        });
        leaked = true;
      } catch (e) { errName = (e as Error).constructor.name; }
      const afterCount = await (prisma as any).document.count({ where: { tenantId: tB } });
      out.push({
        name: 'STORAGE GUARD: cross-tenant create raises NotFoundException; 0 uploads; 0 rows inserted',
        ok: !leaked && errName === 'NotFoundException' && counters.uploads === 0 && beforeCount === afterCount,
        detail: leaked ? 'UNEXPECTED: created' : `err=${errName} uploads=${counters.uploads} dbDelta=${afterCount - beforeCount}`,
      });
    } finally { await prisma.$disconnect(); }
  });

  // 2 — same-tenant create succeeds, persists tenantId=A, 1 upload
  await withFlags({ TENANT_PRISMA_PILOT_ENABLED: 'true', TENANT_PRISMA_PILOT_MODULES: 'documents' }, async () => {
    const prisma = new PrismaService();
    const flags = new FeatureFlagsService();
    const pilot = new PilotPrismaAccessor(prisma, new TenantPrismaService(prisma, flags), flags);
    const counters = { uploads: 0, deletes: 0 };
    const svc = makeService(prisma, pilot, counters);
    try {
      const created = await withRequestContext({ requestId: newRequestId() }, async () => {
        TenantContext.attach({ id: tA, slug: 'a', name: 'A', status: 'ACTIVE', region: 'eu' });
        return svc.create(
          { name: 'iso-doc-A', documentTypeId: DOC_TYPE_ID, entityType: 'EMPLOYEE', entityId: TENANT_A_EMP_ID } as any,
          fileFixture, SYS_USER_ID,
        );
      });
      createdIds.push(created.id);
      const row: any = await (prisma as any).document.findUnique({ where: { id: created.id } });
      out.push({
        name: 'pilot ON, tenant A: same-tenant create succeeds, tenantId=A, 1 storage upload',
        ok: row?.tenantId === tA && counters.uploads === 1,
        detail: `tenantId=${row?.tenantId} uploads=${counters.uploads}`,
      });
    } finally { await prisma.$disconnect(); }
  });

  // 3-6 — cross-tenant update/verify/renew/remove rejected
  await withFlags({ TENANT_PRISMA_PILOT_ENABLED: 'true', TENANT_PRISMA_PILOT_MODULES: 'documents' }, async () => {
    const prisma = new PrismaService();
    const flags = new FeatureFlagsService();
    const pilot = new PilotPrismaAccessor(prisma, new TenantPrismaService(prisma, flags), flags);
    const counters = { uploads: 0, deletes: 0 };
    const svc = makeService(prisma, pilot, counters);
    try {
      const before: any = await (prisma as any).document.findUnique({ where: { id: TENANT_B_DOC_ID } });
      const beforeNotes = before?.notes;
      const beforeStatus = before?.status;

      let upL = false; try { await withRequestContext({ requestId: newRequestId() }, async () => {
        TenantContext.attach({ id: tA, slug: 'a', name: 'A', status: 'ACTIVE', region: 'eu' });
        await svc.update(TENANT_B_DOC_ID, { notes: 'A-trying-to-update-B' }, SYS_USER_ID);
      }); upL = true; } catch { upL = false; }

      let veL = false; try { await withRequestContext({ requestId: newRequestId() }, async () => {
        TenantContext.attach({ id: tA, slug: 'a', name: 'A', status: 'ACTIVE', region: 'eu' });
        await svc.verify(TENANT_B_DOC_ID, { action: 'VERIFY' as any }, SYS_USER_ID);
      }); veL = true; } catch { veL = false; }

      const renewUploadsBefore = counters.uploads;
      let reL = false; try { await withRequestContext({ requestId: newRequestId() }, async () => {
        TenantContext.attach({ id: tA, slug: 'a', name: 'A', status: 'ACTIVE', region: 'eu' });
        await svc.renew(TENANT_B_DOC_ID, { name: 'A-renew-B' } as any, fileFixture, SYS_USER_ID);
      }); reL = true; } catch { reL = false; }
      const renewUploadDelta = counters.uploads - renewUploadsBefore;

      let rmL = false; try { await withRequestContext({ requestId: newRequestId() }, async () => {
        TenantContext.attach({ id: tA, slug: 'a', name: 'A', status: 'ACTIVE', region: 'eu' });
        await svc.remove(TENANT_B_DOC_ID, SYS_USER_ID);
      }); rmL = true; } catch { rmL = false; }

      const after: any = await (prisma as any).document.findUnique({ where: { id: TENANT_B_DOC_ID } });
      out.push({
        name: 'pilot ON, tenant A: update on tenant B doc rejected, notes unchanged',
        ok: !upL && (after?.notes ?? null) === (beforeNotes ?? null),
        detail: `before="${beforeNotes}" after="${after?.notes}"`,
      });
      out.push({
        name: 'pilot ON, tenant A: verify on tenant B doc rejected, status unchanged',
        ok: !veL && after?.status === beforeStatus,
        detail: `before=${beforeStatus} after=${after?.status}`,
      });
      out.push({
        name: 'pilot ON, tenant A: renew on tenant B doc rejected, 0 storage uploads',
        ok: !reL && renewUploadDelta === 0,
        detail: `leaked=${reL} uploadDelta=${renewUploadDelta}`,
      });
      out.push({
        name: 'pilot ON, tenant A: remove on tenant B doc rejected, deletedAt unchanged',
        ok: !rmL && (after?.deletedAt ?? null) === (before?.deletedAt ?? null),
        detail: `deletedAt=${after?.deletedAt ? 'set' : 'null'}`,
      });
    } finally { await prisma.$disconnect(); }
  });

  // 7 — same-tenant create then getExpiringDocuments excludes B
  await withFlags({ TENANT_PRISMA_PILOT_ENABLED: 'true', TENANT_PRISMA_PILOT_MODULES: 'documents' }, async () => {
    const prisma = new PrismaService();
    const flags = new FeatureFlagsService();
    const pilot = new PilotPrismaAccessor(prisma, new TenantPrismaService(prisma, flags), flags);
    const svc = makeService(prisma, pilot, { uploads: 0, deletes: 0 });
    try {
      const expiring = await withRequestContext({ requestId: newRequestId() }, async () => {
        TenantContext.attach({ id: tA, slug: 'a', name: 'A', status: 'ACTIVE', region: 'eu' });
        return svc.getExpiringDocuments(365);
      });
      const ids = expiring.map((d: any) => d.id);
      out.push({
        name: 'pilot ON, tenant A: getExpiringDocuments after mutation excludes tenant B',
        ok: !ids.includes(TENANT_B_DOC_ID) && !ids.includes('00000000-0000-0000-0000-0000000dc102'),
        detail: `count=${ids.length}`,
      });
    } finally { await prisma.$disconnect(); }
  });

  // 8 — pilot OFF: legacy still mutates without tenant gate
  await withFlags({ TENANT_PRISMA_PILOT_ENABLED: 'false' }, async () => {
    const prisma = new PrismaService();
    const flags = new FeatureFlagsService();
    const pilot = new PilotPrismaAccessor(prisma, new TenantPrismaService(prisma, flags), flags);
    const svc = makeService(prisma, pilot, { uploads: 0, deletes: 0 });
    try {
      const before: any = await (prisma as any).document.findUnique({ where: { id: TENANT_B_DOC_ID } });
      let mutated = false;
      try {
        const u = await svc.update(TENANT_B_DOC_ID, { notes: 'legacy-no-tenant-gate' }, SYS_USER_ID);
        mutated = (u as any).notes === 'legacy-no-tenant-gate';
      } catch { mutated = false; }
      if (mutated && before) {
        await (prisma as any).document.update({ where: { id: TENANT_B_DOC_ID }, data: { notes: before.notes } });
      }
      out.push({
        name: 'pilot OFF: legacy update on tenant B doc still succeeds (gate disengages)',
        ok: mutated,
        detail: mutated ? 'mutated as expected' : 'UNEXPECTED: blocked',
      });
    } finally { await prisma.$disconnect(); }
  });

  // 9 — source-level meta-assertion
  const src = await fs.readFile(SRC_FILE, 'utf8');
  const expected: Array<[string, RegExp]> = [
    ['create has assertEntityOwnedByActiveTenant before storage', /async create\([\s\S]*?assertEntityOwnedByActiveTenant[\s\S]*?storage\.uploadFile/],
    ['create transactional insert is phase221-pilot-scope', /async create\([\s\S]*?legacyPrisma\.\$transaction[\s\S]{0,400}phase221-pilot-scope/],
    ['create.data has ...tdata spread', /async create\([\s\S]*?tx\.document\.create\(\{[\s\S]{0,2000}\.\.\.tdata/],
    ['update by-id is phase221-pilot-scope-precheck', /async update\([\s\S]*?legacyPrisma\.document\.update[\s\S]{0,200}phase221-pilot-scope-precheck/],
    ['verify by-id is phase221-pilot-scope-precheck', /async verify\([\s\S]*?legacyPrisma\.document\.update[\s\S]{0,200}phase221-pilot-scope-precheck/],
    ['renew transactional insert is phase221-pilot-scope', /async renew\([\s\S]*?legacyPrisma\.\$transaction[\s\S]{0,400}phase221-pilot-scope/],
    ['remove soft-delete is phase221-pilot-scope-precheck', /async remove\([\s\S]*?legacyPrisma\.document\.update[\s\S]{0,200}phase221-pilot-scope-precheck/],
    ['publicCreate has tenantData spread', /async publicCreate\([\s\S]*?tx\.document\.create\(\{[\s\S]{0,1000}\.\.\.tdataPub/],
    ['assertEntityOwnedByActiveTenant uses pilot client + tenantWhere', /assertEntityOwnedByActiveTenant[\s\S]*?this\.prisma\.[a-z]+\.findFirst\(\{ where: \{ id: entityId, \.\.\.t \}/],
  ];
  const failed: string[] = [];
  expected.forEach(([name, re]) => { if (!re.test(src)) failed.push(name); });
  out.push({
    name: 'source: every Phase 2.21 mutation site carries the right tag and shape',
    ok: failed.length === 0,
    detail: failed.length === 0 ? 'all patterns matched' : failed.join('; '),
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
    environment: env, tenantA: tA, tenantB: tB,
    counts: { total: out.length, passed: out.filter((r) => r.ok).length, failed: out.filter((r) => !r.ok).length },
    results: out,
  };
  await fs.writeFile(path.join(OUT_DIR, 'documents-mutation-isolation.json'), JSON.stringify(summary, null, 2));
  const md: string[] = [];
  md.push('# Phase 2.21 — Documents Mutation Isolation');
  md.push(''); md.push(`Generated: ${summary.generatedAt}`);
  md.push(`Environment: ${env.classification} (${env.reason})`);
  md.push(`Tenants: A=\`${tA}\` B=\`${tB}\``); md.push('');
  md.push(`- Cases passed: **${summary.counts.passed}** / ${summary.counts.total}`);
  md.push(`- Cases failed: ${summary.counts.failed}`); md.push('');
  md.push('| # | Case | Result | Detail |');
  md.push('|--:|------|:------:|--------|');
  out.forEach((r, i) => md.push(`| ${i + 1} | ${r.name} | ${r.ok ? 'PASS' : '**FAIL**'} | ${r.detail} |`));
  await fs.writeFile(path.join(OUT_DIR, 'documents-mutation-isolation.md'), md.join('\n'));

  console.log(`documents-mutation-isolation: ${summary.counts.passed}/${summary.counts.total} cases PASS`);
  if (summary.counts.failed > 0) process.exit(2);
}

main().catch((e) => { console.error(e); process.exit(3); });
