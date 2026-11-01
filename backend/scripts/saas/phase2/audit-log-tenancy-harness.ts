/**
 * Phase 2.30 — cross-module audit-log tenancy harness.
 *
 * Verifies the shared `TenantAuditLogService`:
 *
 *   1. Pilot OFF: writes a row with `tenantId = NULL`.
 *   2. Pilot ON + ALS frame for tenant A: writes `tenantId = A`.
 *   3. Pilot ON + ALS frame for tenant B: writes `tenantId = B`.
 *   4. Pilot ON without ALS frame: falls back to `tenantId = NULL`.
 *   5. Explicit override: `tenantId` arg used even without ALS frame.
 *   6. Pilot ON in non-staging env: legacy fallback (no tenantId).
 *      (simulated by overriding the FF and asserting the decide() output)
 *   7. Failure swallow: write() never throws even when prisma.create rejects.
 *   8. Source-level meta-assertion: every piloted module that emits audit
 *      rows now delegates to the shared helper (no inline
 *      `legacyPrisma.auditLog.create` left in finance/documents/workflow/
 *      applicants).
 *
 * Output: backend/reports/saas/phase2/audit-log-tenancy-harness.{json,md}
 */
/* eslint-disable no-console */
import { promises as fs } from 'fs';
import path from 'path';
import { Client } from 'pg';
import { autoLoadEnv, formatDatabaseUrlMissingMessage } from './../phase1/reconciliation/lib/env';
import { classifyRuntimeEnv, isStagingClassification } from '../../../src/saas/tenancy/env-safety';
import { PrismaService } from '../../../src/prisma/prisma.service';
import { FeatureFlagsService } from '../../../src/saas/feature-flags/feature-flags.service';
import { TenantAuditLogService } from '../../../src/saas/audit/tenant-audit-log.service';
import { TenantContext, withRequestContext, newRequestId } from '../../../src/saas/context/als';

autoLoadEnv(__filename);

const OUT_DIR = path.resolve(__dirname, '..', '..', '..', 'reports', 'saas', 'phase2');
const SRC_FINANCE   = path.resolve(__dirname, '..', '..', '..', 'src', 'finance', 'finance.service.ts');
const SRC_DOCS      = path.resolve(__dirname, '..', '..', '..', 'src', 'documents', 'documents.service.ts');
const SRC_WORKFLOW  = path.resolve(__dirname, '..', '..', '..', 'src', 'workflow', 'workflow.service.ts');
const SRC_APPLIC    = path.resolve(__dirname, '..', '..', '..', 'src', 'applicants', 'applicants.service.ts');

interface CaseResult { name: string; ok: boolean; detail: string; }

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

const ENTITY = 'AuditTenancyHarness';
const SYS_USER = '00000000-0000-0000-0000-00000000us01';

async function fetchRow(prisma: PrismaService, entityId: string): Promise<{ tenantId: string | null } | null> {
  const r: any = await (prisma as any).auditLog.findFirst({
    where: { entity: ENTITY, entityId }, orderBy: { createdAt: 'desc' },
  });
  return r ? { tenantId: r.tenantId ?? null } : null;
}

async function cleanup(prisma: PrismaService): Promise<void> {
  await (prisma as any).auditLog.deleteMany({ where: { entity: ENTITY } });
}

async function main(): Promise<void> {
  const url = getDatabaseUrl();
  const env = classifyRuntimeEnv();
  if (!isStagingClassification(env.classification)) {
    console.error(`[audit-log-tenancy-harness] refusing on classification=${env.classification}`);
    process.exit(3);
  }
  const c = new Client({ connectionString: url, ssl: /127\.0\.0\.1|localhost/.test(url) ? false : { rejectUnauthorized: false } });
  await c.connect();
  const ts = await c.query<{ id: string }>(`SELECT id FROM tenants ORDER BY name LIMIT 2`);
  const tA = ts.rows[0]?.id; const tB = ts.rows[1]?.id;
  await c.end();
  if (!tA || !tB) { console.error('need two tenants'); process.exit(3); }

  const out: CaseResult[] = [];

  // 1 — pilot OFF
  await withFlags({ TENANT_AUDIT_LOG_PILOT_ENABLED: 'false' }, async () => {
    const prisma = new PrismaService();
    const svc = new TenantAuditLogService(prisma, new FeatureFlagsService());
    try {
      await cleanup(prisma);
      const id = `case1-${Date.now()}`;
      await withRequestContext({ requestId: newRequestId() }, async () => {
        TenantContext.attach({ id: tA, slug: 'a', name: 'A', status: 'ACTIVE', region: 'eu' });
        await svc.write({ userId: SYS_USER, action: 'TEST', entity: ENTITY, entityId: id });
      });
      const r = await fetchRow(prisma, id);
      out.push({ name: '1. pilot OFF: tenantId is NULL', ok: r !== null && r.tenantId === null, detail: `tenantId=${r?.tenantId}` });
    } finally { await prisma.$disconnect(); }
  });

  // 2 — pilot ON, ALS=A
  await withFlags({ TENANT_AUDIT_LOG_PILOT_ENABLED: 'true' }, async () => {
    const prisma = new PrismaService();
    const svc = new TenantAuditLogService(prisma, new FeatureFlagsService());
    try {
      const id = `case2-${Date.now()}`;
      await withRequestContext({ requestId: newRequestId() }, async () => {
        TenantContext.attach({ id: tA, slug: 'a', name: 'A', status: 'ACTIVE', region: 'eu' });
        await svc.write({ userId: SYS_USER, action: 'TEST', entity: ENTITY, entityId: id });
      });
      const r = await fetchRow(prisma, id);
      out.push({ name: '2. pilot ON + ALS A: tenantId=A', ok: r?.tenantId === tA, detail: `tenantId=${r?.tenantId}` });
    } finally { await prisma.$disconnect(); }
  });

  // 3 — pilot ON, ALS=B
  await withFlags({ TENANT_AUDIT_LOG_PILOT_ENABLED: 'true' }, async () => {
    const prisma = new PrismaService();
    const svc = new TenantAuditLogService(prisma, new FeatureFlagsService());
    try {
      const id = `case3-${Date.now()}`;
      await withRequestContext({ requestId: newRequestId() }, async () => {
        TenantContext.attach({ id: tB, slug: 'b', name: 'B', status: 'ACTIVE', region: 'eu' });
        await svc.write({ userId: SYS_USER, action: 'TEST', entity: ENTITY, entityId: id });
      });
      const r = await fetchRow(prisma, id);
      out.push({ name: '3. pilot ON + ALS B: tenantId=B', ok: r?.tenantId === tB, detail: `tenantId=${r?.tenantId}` });
    } finally { await prisma.$disconnect(); }
  });

  // 4 — pilot ON, no ALS
  await withFlags({ TENANT_AUDIT_LOG_PILOT_ENABLED: 'true' }, async () => {
    const prisma = new PrismaService();
    const svc = new TenantAuditLogService(prisma, new FeatureFlagsService());
    try {
      const id = `case4-${Date.now()}`;
      await svc.write({ userId: SYS_USER, action: 'TEST', entity: ENTITY, entityId: id });
      const r = await fetchRow(prisma, id);
      out.push({ name: '4. pilot ON, no ALS: tenantId is NULL', ok: r?.tenantId === null, detail: `tenantId=${r?.tenantId}` });
    } finally { await prisma.$disconnect(); }
  });

  // 5 — explicit override
  await withFlags({ TENANT_AUDIT_LOG_PILOT_ENABLED: 'true' }, async () => {
    const prisma = new PrismaService();
    const svc = new TenantAuditLogService(prisma, new FeatureFlagsService());
    try {
      const id = `case5-${Date.now()}`;
      await svc.write({ userId: SYS_USER, action: 'TEST', entity: ENTITY, entityId: id, tenantId: tB });
      const r = await fetchRow(prisma, id);
      out.push({ name: '5. explicit tenantId override: tenantId=B (no ALS)', ok: r?.tenantId === tB, detail: `tenantId=${r?.tenantId}` });
    } finally { await prisma.$disconnect(); }
  });

  // 6 — decide() reports inactive when flag is off
  await withFlags({ TENANT_AUDIT_LOG_PILOT_ENABLED: 'false' }, async () => {
    const prisma = new PrismaService();
    const svc = new TenantAuditLogService(prisma, new FeatureFlagsService());
    try {
      const d = svc.decide(null);
      out.push({ name: '6. decide() inactive when flag off', ok: !d.active && d.tenantId === null, detail: d.reason });
    } finally { await prisma.$disconnect(); }
  });

  // 7 — write() swallows failures
  await withFlags({ TENANT_AUDIT_LOG_PILOT_ENABLED: 'false' }, async () => {
    const prisma = new PrismaService();
    const svc = new TenantAuditLogService(prisma, new FeatureFlagsService());
    try {
      // sabotage prisma to force a throw
      (prisma as any).auditLog = { create: async () => { throw new Error('boom'); } };
      let threw = false;
      try {
        await svc.write({ userId: SYS_USER, action: 'TEST', entity: ENTITY, entityId: 'case7' });
      } catch { threw = true; }
      out.push({ name: '7. write() never throws on DB error', ok: !threw, detail: threw ? 'UNEXPECTED throw' : 'swallowed' });
    } finally { await prisma.$disconnect(); }
  });

  // 8 — source-level meta-assertion
  const sources = await Promise.all([
    fs.readFile(SRC_FINANCE,  'utf8'),
    fs.readFile(SRC_DOCS,     'utf8'),
    fs.readFile(SRC_WORKFLOW, 'utf8'),
    fs.readFile(SRC_APPLIC,   'utf8'),
  ]);
  const noInlineAudit = sources.every((s) => !/legacyPrisma\.auditLog\.create/.test(s));
  const allDelegate = sources.every((s) => /tenantAuditLog\.write\(/.test(s));
  out.push({
    name: '8. source-level: no `legacyPrisma.auditLog.create` left in piloted modules',
    ok: noInlineAudit && allDelegate,
    detail: `noInline=${noInlineAudit} delegates=${allDelegate}`,
  });

  // cleanup harness rows
  const prisma = new PrismaService();
  try { await cleanup(prisma); } finally { await prisma.$disconnect(); }

  await fs.mkdir(OUT_DIR, { recursive: true });
  const passed = out.filter((c) => c.ok).length;
  const total = out.length;
  await fs.writeFile(path.join(OUT_DIR, 'audit-log-tenancy-harness.json'),
    JSON.stringify({ passed, total, cases: out }, null, 2));
  const md = [
    `# Phase 2.30 — audit-log tenancy harness`,
    ``,
    `**${passed}/${total} PASS**`,
    ``,
    ...out.map((c) => `- ${c.ok ? 'PASS' : 'FAIL'} — ${c.name} — ${c.detail}`),
    ``,
  ].join('\n');
  await fs.writeFile(path.join(OUT_DIR, 'audit-log-tenancy-harness.md'), md);
  console.log(`[audit-log-tenancy-harness] ${passed}/${total} PASS`);
  process.exit(passed === total ? 0 : 1);
}

main().catch((err) => { console.error(err); process.exit(2); });
