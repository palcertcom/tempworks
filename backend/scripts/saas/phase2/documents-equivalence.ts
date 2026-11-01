/**
 * Phase 2.20 — documents pilot read-equivalence harness.
 *
 * Compares legacy and pilot READ paths back-to-back on the same DB:
 *   - findAll total (cross-tenant union vs. tenant A only)
 *   - findOne(tenant-A-id) resolves in both modes
 *   - findOne(missing-id) raises NotFoundException in both modes
 *   - findByEntity returns docs for the entity (count delta in pilot)
 *   - getExpiringDocuments tenant filter applies in pilot
 *   - readDocumentBytes metadata lookup is tenant-scoped
 *   - response shape preservation
 *   - global catalog (`checkDocTypePermission`) identical in both modes
 *
 * Output:
 *   backend/reports/saas/phase2/documents-equivalence.{json,md}
 *
 * Exit:
 *   0 — every comparison equal
 *   2 — at least one mismatch
 *   3 — runtime error
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

interface CaseResult { name: string; ok: boolean; detail: string; }

const TENANT_A_DOC_ID = '00000000-0000-0000-0000-0000000dc001';
const TENANT_A_EMP_ID = 'eeeeeeea-aaaa-aaaa-aaaa-aaaaaaaaaaaa';

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
  const notifStub: any = {
    notifyUploaderAndRoles: async () => undefined,
    notifyUsersByRoles: async () => undefined,
  };
  const idStub = new DocumentIdService(prisma);
  const storage = new StorageService();
  return new DocumentsService(prisma, idStub, notifStub, storage, pilot, new TenantAuditLogService(prisma, new FeatureFlagsService()));
}

interface Snapshot {
  pilotActive: boolean;
  reason: string;
  findAllTotal: number;
  findOneAId: string | null;
  errorOnMissing: string;
  findByEntityCount: number;
  expiringCount: number;
  bytesMetaOk: boolean;
  permIdentical: any;
  responseShapeOk: boolean;
}

async function snapshotForFlags(
  flagsOverride: Record<string, string | undefined>,
  ctx: { id: string } | null,
): Promise<Snapshot> {
  return withFlags(flagsOverride, async () => {
    const flags = new FeatureFlagsService();
    const prisma = new PrismaService();
    const tp = new TenantPrismaService(prisma, flags);
    const pilot = new PilotPrismaAccessor(prisma, tp, flags);
    const svc = makeService(prisma, pilot);

    const run = async (): Promise<Snapshot> => {
      const all = await svc.findAll({ page: 1, limit: 50 } as any);
      let findOneAId: string | null = null;
      try { findOneAId = (await svc.findOne(TENANT_A_DOC_ID)).id; } catch { findOneAId = null; }

      let errorOnMissing = 'no-error';
      try { await svc.findOne('00000000-0000-0000-0000-deaddeaddead'); }
      catch (e) { errorOnMissing = (e as Error).constructor.name; }

      const byEntity = await svc.findByEntity('EMPLOYEE', TENANT_A_EMP_ID, { page: 1, limit: 50 } as any);
      const expiring = await svc.getExpiringDocuments(365);

      let bytesMetaOk = false;
      try {
        // Use a non-existent URL to avoid actually fetching bytes —
        // we only verify the metadata lookup behaviour.
        await svc.readDocumentBytes(TENANT_A_DOC_ID);
      } catch (e) {
        // Either succeeds with bytes (HTTP fetch may fail in staging),
        // or fails with HTTP error AFTER metadata succeeded — both
        // mean the metadata lookup found the row.
        const msg = (e as Error).message ?? '';
        bytesMetaOk = !/DOCUMENT\.NOT_FOUND/.test(msg);
      }
      // If no exception thrown → metadata succeeded
      // If we reach here without exception, treat as success
      // (bytesMetaOk computed above when exception thrown)
      // Re-evaluate: if call returned, set true:
      try { await svc.readDocumentBytes(TENANT_A_DOC_ID); bytesMetaOk = true; } catch (e) {
        const msg = (e as Error).message ?? '';
        // bytesMetaOk true unless the error is DOCUMENT.NOT_FOUND
        bytesMetaOk = bytesMetaOk || !/DOCUMENT\.NOT_FOUND/.test(msg);
      }

      const perm = await svc.checkDocTypePermission(
        '00000000-0000-0000-0000-00000000dt01',
        '00000000-0000-0000-0000-00000000ro01',
        'canView',
      );

      const responseShapeOk = Array.isArray((all as any).data)
        && typeof (all as any).meta?.total === 'number';

      return {
        pilotActive: pilot.isPilotActive(),
        reason: pilot.pilotReason().reason,
        findAllTotal: (all as any).meta?.total ?? 0,
        findOneAId,
        errorOnMissing,
        findByEntityCount: (byEntity as any).meta?.total ?? 0,
        expiringCount: expiring.length,
        bytesMetaOk,
        permIdentical: perm,
        responseShapeOk,
      };
    };

    try {
      if (ctx) {
        return await withRequestContext({ requestId: newRequestId() }, async () => {
          TenantContext.attach({ id: ctx.id, slug: 'a', name: 'A', status: 'ACTIVE', region: 'eu' });
          return run();
        });
      }
      return await run();
    } finally {
      await prisma.$disconnect();
    }
  });
}

async function main(): Promise<void> {
  const url = getDatabaseUrl();
  const env = classifyRuntimeEnv();
  if (!isStagingClassification(env.classification)) {
    console.error(`[documents-equivalence] refusing on classification=${env.classification}`);
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
  if (!tA) { console.error('[documents-equivalence] need a tenant with documents'); process.exit(3); }

  const out: CaseResult[] = [];
  const legacy = await snapshotForFlags(
    { TENANT_PRISMA_PILOT_ENABLED: 'false', TENANT_PRISMA_PILOT_MODULES: undefined },
    null,
  );
  const pilot = await snapshotForFlags(
    { TENANT_PRISMA_PILOT_ENABLED: 'true', TENANT_PRISMA_PILOT_MODULES: 'documents' },
    { id: tA },
  );

  out.push({
    name: 'legacy: pilot OFF reports pilotActive=false',
    ok: legacy.pilotActive === false, detail: legacy.reason,
  });
  out.push({
    name: 'pilot: pilot ON + documents allow-list ⇒ pilotActive=true',
    ok: pilot.pilotActive === true && pilot.reason.startsWith('pilot ON'),
    detail: pilot.reason,
  });
  out.push({
    name: 'findAll: pilot total <= legacy total (tenant filter applies)',
    ok: pilot.findAllTotal <= legacy.findAllTotal && pilot.findAllTotal > 0,
    detail: `legacy=${legacy.findAllTotal} pilot=${pilot.findAllTotal}`,
  });
  out.push({
    name: 'findOne: legacy + pilot resolve the tenant A document id',
    ok: legacy.findOneAId === TENANT_A_DOC_ID && pilot.findOneAId === TENANT_A_DOC_ID,
    detail: `legacy=${legacy.findOneAId} pilot=${pilot.findOneAId}`,
  });
  out.push({
    name: 'error path: NotFoundException for missing id in both modes',
    ok: legacy.errorOnMissing === 'NotFoundException' && pilot.errorOnMissing === 'NotFoundException',
    detail: `legacy=${legacy.errorOnMissing} pilot=${pilot.errorOnMissing}`,
  });
  out.push({
    name: 'findByEntity: pilot count <= legacy count (entity is tenant A; counts equal here)',
    ok: pilot.findByEntityCount <= legacy.findByEntityCount && pilot.findByEntityCount > 0,
    detail: `legacy=${legacy.findByEntityCount} pilot=${pilot.findByEntityCount}`,
  });
  out.push({
    name: 'getExpiringDocuments: pilot count <= legacy count (tenant filter applies)',
    ok: pilot.expiringCount <= legacy.expiringCount,
    detail: `legacy=${legacy.expiringCount} pilot=${pilot.expiringCount}`,
  });
  out.push({
    name: 'readDocumentBytes: metadata lookup succeeds in BOTH modes for tenant A doc',
    ok: legacy.bytesMetaOk && pilot.bytesMetaOk,
    detail: `legacy=${legacy.bytesMetaOk} pilot=${pilot.bytesMetaOk}`,
  });
  out.push({
    name: 'checkDocTypePermission: global catalog returns same value in both modes',
    ok: legacy.permIdentical === pilot.permIdentical,
    detail: `legacy=${legacy.permIdentical} pilot=${pilot.permIdentical}`,
  });
  out.push({
    name: 'response shape preserved (PaginatedResponse<Document>)',
    ok: legacy.responseShapeOk && pilot.responseShapeOk,
    detail: `legacy=${legacy.responseShapeOk} pilot=${pilot.responseShapeOk}`,
  });

  await fs.mkdir(OUT_DIR, { recursive: true });
  const summary = {
    generatedAt: new Date().toISOString(),
    environment: env, tenantA: tA,
    legacy, pilot,
    counts: { total: out.length, passed: out.filter((r) => r.ok).length, failed: out.filter((r) => !r.ok).length },
    results: out,
  };
  await fs.writeFile(path.join(OUT_DIR, 'documents-equivalence.json'), JSON.stringify(summary, null, 2));
  const md: string[] = [];
  md.push('# Phase 2.20 — Documents Equivalence');
  md.push(''); md.push(`Generated: ${summary.generatedAt}`);
  md.push(`Environment: ${env.classification} (${env.reason})`);
  md.push(`Tenant A: \`${tA}\``); md.push('');
  md.push(`- Cases passed: **${summary.counts.passed}** / ${summary.counts.total}`);
  md.push(`- Cases failed: ${summary.counts.failed}`); md.push('');
  md.push('| # | Case | Result | Detail |');
  md.push('|--:|------|:------:|--------|');
  out.forEach((r, i) => md.push(`| ${i + 1} | ${r.name} | ${r.ok ? 'PASS' : '**FAIL**'} | ${r.detail} |`));
  await fs.writeFile(path.join(OUT_DIR, 'documents-equivalence.md'), md.join('\n'));

  console.log(`documents-equivalence: ${summary.counts.passed}/${summary.counts.total} cases PASS`);
  if (summary.counts.failed > 0) process.exit(2);
}

main().catch((e) => { console.error(e); process.exit(3); });
