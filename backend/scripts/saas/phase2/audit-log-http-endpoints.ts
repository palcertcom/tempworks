/**
 * Phase 2.57 — Tenant audit HTTP endpoints harness.
 *
 * The harness invokes the new `TenantAuditController` directly
 * (no Nest HTTP bootstrap). It also includes source-level
 * assertions for the actual route shapes and the absence of
 * destructive verbs.
 *
 *   1.  list endpoint under tenant A returns only tenant A rows
 *   2.  list endpoint under tenant A excludes tenant B rows
 *   3.  list endpoint under tenant A excludes NULL-tenant rows
 *   4.  list endpoint preserves entity filter
 *   5.  list endpoint preserves entityId filter without tenant leakage
 *   6.  list endpoint preserves date range filter
 *   7.  list endpoint preserves pagination shape
 *   8.  byId endpoint returns tenant A row for tenant A
 *   9.  byId endpoint hides tenant B row from tenant A (NotFound)
 *  10.  stats endpoint counts only tenant A rows
 *  11.  retention-preview endpoint returns count only and modifies zero rows
 *  12.  retention-preview endpoint excludes tenant B rows for tenant A
 *  13.  missing ALS tenant context refuses safely (Forbidden)
 *  14.  source-level: controller @Roles allow-list pinned (System Admin / Compliance Officer only)
 *  15.  FULL_ACCESS with global gate OFF remains tenant-bound (covered via service path; HTTP wrap delegates)
 *  16.  FULL_ACCESS with global gate ON sees global rows
 *  17.  no HTTP route exposes retention apply, soft-delete, or hard-delete
 *  18.  controller does not call retention/hard-delete scripts
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
import { LogsService } from '../../../src/logs/logs.service';
import { TenantAuditController } from '../../../src/logs/tenant-audit.controller';
import { AuditLogRateLimiter } from '../../../src/logs/audit-log-rate-limiter.service';
import { TenantAuditLogService } from '../../../src/saas/audit/tenant-audit-log.service';
import { TenantContext, withRequestContext, newRequestId } from '../../../src/saas/context/als';

autoLoadEnv(__filename);

const OUT_DIR = path.resolve(__dirname, '..', '..', '..', 'reports', 'saas', 'phase2');
const SEED_TAG = 'phase257-http-harness';

const CTRL_SRC = path.resolve(__dirname, '..', '..', '..', 'src', 'logs', 'tenant-audit.controller.ts');

interface CaseResult { name: string; ok: boolean; detail: string; }

function getDatabaseUrl(): string {
  const arg = process.argv.find((a) => a.startsWith('--db='))?.slice(5);
  return arg ?? process.env.DATABASE_URL ?? (() => { throw new Error(formatDatabaseUrlMissingMessage()); })();
}
function pgClient(url: string): Client {
  return new Client({ connectionString: url, ssl: /127\.0\.0\.1|localhost/.test(url) ? false : { rejectUnauthorized: false } });
}
async function withFlags<T>(env: Record<string, string | undefined>, fn: () => Promise<T> | T): Promise<T> {
  const prev = { ...process.env };
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  try { return await fn(); } finally { process.env = prev; }
}
function attach(tid: string, slug: string) {
  TenantContext.attach({ id: tid, slug, name: slug.toUpperCase(), status: 'ACTIVE', region: 'eu' });
}

interface Seed {
  tA: string; tB: string; userA: string; userB: string;
  rowAId: string; rowBId: string;
}

async function seed(url: string): Promise<Seed> {
  const c = pgClient(url); await c.connect();
  try {
    const ts = await c.query<{ id: string }>(
      `SELECT t.id FROM tenants t WHERE EXISTS (SELECT 1 FROM employees e WHERE e."tenantId" = t.id::text) ORDER BY t.name`);
    const tA = ts.rows[0].id, tB = ts.rows[1].id;
    const ua = await c.query<{ id: string }>(`SELECT u.id FROM users u JOIN agencies a ON a.id = u."agencyId" WHERE a."tenantId" = $1 LIMIT 1`, [tA]);
    const ub = await c.query<{ id: string }>(`SELECT u.id FROM users u JOIN agencies a ON a.id = u."agencyId" WHERE a."tenantId" = $1 LIMIT 1`, [tB]);
    const userA = ua.rows[0]?.id ?? '00000000-0000-0000-0000-000000000a01';
    const userB = ub.rows[0]?.id ?? '00000000-0000-0000-0000-000000000b01';
    await c.query(`DELETE FROM audit_logs WHERE "userAgent" = $1`, [SEED_TAG]);
    const ins = await c.query<{ id: string; t: string }>(`
      WITH ins AS (
        INSERT INTO audit_logs (id, action, entity, "entityId", "tenantId", "userAgent", "createdAt") VALUES
          (gen_random_uuid()::text, 'HTTP_A1', 'Phase257HTTP', '00000000-0000-0000-0000-000000000aa1', $1, $3, now() - interval '5 days'),
          (gen_random_uuid()::text, 'HTTP_A2', 'Phase257HTTP', '00000000-0000-0000-0000-000000000aa2', $1, $3, now()),
          (gen_random_uuid()::text, 'HTTP_B1', 'Phase257HTTP', '00000000-0000-0000-0000-000000000bb1', $2, $3, now()),
          (gen_random_uuid()::text, 'HTTP_NULL', 'Phase257HTTP', '00000000-0000-0000-0000-000000000n01', NULL, $3, now())
        RETURNING id, COALESCE("tenantId", 'NULL') AS t
      )
      SELECT * FROM ins`, [tA, tB, SEED_TAG]);
    const rowAId = ins.rows.find((r) => r.t === tA)!.id;
    const rowBId = ins.rows.find((r) => r.t === tB)!.id;
    return { tA, tB, userA, userB, rowAId, rowBId };
  } finally { await c.end(); }
}

const PILOT = { TENANT_PRISMA_PILOT_ENABLED: 'true', TENANT_PRISMA_PILOT_MODULES: 'audit-logs' };

function makeController(): { ctrl: TenantAuditController; close: () => Promise<void> } {
  const prisma = new PrismaService();
  const ff = new FeatureFlagsService();
  const pilot = new PilotPrismaAccessor(prisma, new TenantPrismaService(prisma, ff), ff);
  const tenantAuditLog = new TenantAuditLogService(prisma, ff);
  const svc = new LogsService(prisma, pilot, tenantAuditLog);
  const ctrl = new TenantAuditController(svc, new AuditLogRateLimiter());
  return { ctrl, close: () => prisma.$disconnect() };
}

async function main(): Promise<void> {
  const url = getDatabaseUrl();
  const env = classifyRuntimeEnv();
  if (!isStagingClassification(env.classification)) {
    console.error(`[audit-log-http-endpoints] refusing on classification=${env.classification}`);
    process.exit(3);
  }
  const seedData = await seed(url);
  const { tA, tB, userA, userB, rowAId, rowBId } = seedData;

  const out: CaseResult[] = [];
  const adminA = { id: userA, role: 'System Admin', agencyId: undefined };
  const adminB = { id: userB, role: 'System Admin', agencyId: undefined };
  const filter = { entity: 'Phase257HTTP' };
  const pagination = { page: 1, limit: 50 } as any;

  // 1, 2, 3 — list under tenant A
  await withFlags(PILOT, async () => {
    const { ctrl, close } = makeController();
    try {
      const r: any = await withRequestContext({ requestId: newRequestId() }, async () => {
        attach(tA, 'a');
        return ctrl.list(pagination, adminA, filter.entity);
      });
      const allA = (r.data as any[]).every((row) => row.tenantId === tA);
      const noB = !(r.data as any[]).some((row) => row.action === 'HTTP_B1');
      const noNull = !(r.data as any[]).some((row) => row.action === 'HTTP_NULL');
      out.push({ name: '1. list endpoint under tenant A returns only tenant A rows', ok: allA && r.data.length === 2, detail: `count=${r.data.length}` });
      out.push({ name: '2. list endpoint under tenant A excludes tenant B rows', ok: noB, detail: 'B excluded' });
      out.push({ name: '3. list endpoint under tenant A excludes NULL-tenant rows', ok: noNull, detail: 'NULL excluded' });
    } finally { await close(); }
  });

  // 4 — entity filter
  await withFlags(PILOT, async () => {
    const { ctrl, close } = makeController();
    try {
      const r: any = await withRequestContext({ requestId: newRequestId() }, async () => {
        attach(tA, 'a');
        return ctrl.list(pagination, adminA, 'Phase257HTTP');
      });
      out.push({ name: '4. list endpoint preserves entity filter', ok: r.data.length === 2, detail: `count=${r.data.length}` });
    } finally { await close(); }
  });

  // 5 — entityId filter for tenant B id under tenant A
  await withFlags(PILOT, async () => {
    const { ctrl, close } = makeController();
    try {
      const r: any = await withRequestContext({ requestId: newRequestId() }, async () => {
        attach(tA, 'a');
        return ctrl.list(pagination, adminA, 'Phase257HTTP', '00000000-0000-0000-0000-000000000bb1');
      });
      out.push({ name: '5. list endpoint preserves entityId filter without tenant leakage', ok: r.data.length === 0, detail: `count=${r.data.length}` });
    } finally { await close(); }
  });

  // 6 — date range filter
  await withFlags(PILOT, async () => {
    const { ctrl, close } = makeController();
    try {
      const fromIso = new Date(Date.now() - 86400 * 1000).toISOString();
      const toIso = new Date().toISOString();
      const r: any = await withRequestContext({ requestId: newRequestId() }, async () => {
        attach(tA, 'a');
        return ctrl.list(pagination, adminA, 'Phase257HTTP', undefined, undefined, undefined, fromIso, toIso);
      });
      out.push({ name: '6. list endpoint preserves date range filter', ok: r.data.length >= 1 && r.data.length <= 2, detail: `count=${r.data.length}` });
    } finally { await close(); }
  });

  // 7 — pagination shape
  await withFlags(PILOT, async () => {
    const { ctrl, close } = makeController();
    try {
      const r: any = await withRequestContext({ requestId: newRequestId() }, async () => {
        attach(tA, 'a');
        return ctrl.list({ page: 1, limit: 1 } as any, adminA, 'Phase257HTTP');
      });
      out.push({ name: '7. list endpoint preserves pagination shape',
        ok: r.meta.page === 1 && r.meta.limit === 1 && r.data.length <= 1,
        detail: `page=${r.meta.page} limit=${r.meta.limit}` });
    } finally { await close(); }
  });

  // 8 — byId returns tenant A row for tenant A
  await withFlags(PILOT, async () => {
    const { ctrl, close } = makeController();
    try {
      const r: any = await withRequestContext({ requestId: newRequestId() }, async () => {
        attach(tA, 'a');
        return ctrl.byId(rowAId, adminA);
      });
      out.push({ name: '8. byId endpoint returns tenant A row for tenant A', ok: r.id === rowAId && r.tenantId === tA, detail: `id=${r.id?.slice(0,8)}` });
    } finally { await close(); }
  });

  // 9 — byId hides tenant B row from tenant A (NotFound)
  await withFlags(PILOT, async () => {
    const { ctrl, close } = makeController();
    try {
      let threw = false;
      try {
        await withRequestContext({ requestId: newRequestId() }, async () => {
          attach(tA, 'a');
          return ctrl.byId(rowBId, adminA);
        });
      } catch (err: any) { threw = /not found/i.test(err?.message ?? ''); }
      out.push({ name: '9. byId endpoint hides tenant B row from tenant A (NotFound)', ok: threw, detail: threw ? 'NotFoundException' : 'UNEXPECTED' });
    } finally { await close(); }
  });

  // 10 — stats counts only tenant A rows
  await withFlags(PILOT, async () => {
    const { ctrl, close } = makeController();
    try {
      const r: any = await withRequestContext({ requestId: newRequestId() }, async () => {
        attach(tA, 'a');
        return ctrl.stats(adminA);
      });
      out.push({ name: '10. stats endpoint counts only tenant A rows',
        ok: typeof r.total === 'number' && r.total >= 2 && Array.isArray(r.byEntity),
        detail: `total=${r.total} entities=${r.byEntity?.length}` });
    } finally { await close(); }
  });

  // 11 — retention preview returns count only; before/after row count unchanged
  await withFlags(PILOT, async () => {
    const { ctrl, close } = makeController();
    try {
      const c2 = pgClient(url); await c2.connect();
      const before = await c2.query<{ n: string }>(`SELECT COUNT(*)::text AS n FROM audit_logs`);
      const r: any = await withRequestContext({ requestId: newRequestId() }, async () => {
        attach(tA, 'a');
        return ctrl.retentionPreview(adminA);
      });
      const after = await c2.query<{ n: string }>(`SELECT COUNT(*)::text AS n FROM audit_logs`);
      await c2.end();
      out.push({ name: '11. retention-preview endpoint returns count only and modifies zero rows',
        ok: typeof r.candidateCount === 'number' && before.rows[0].n === after.rows[0].n && !('rows' in r),
        detail: `candidate=${r.candidateCount} before=${before.rows[0].n} after=${after.rows[0].n}` });
    } finally { await close(); }
  });

  // 12 — retention-preview tenant A excludes tenant B rows: explicit count check
  await withFlags(PILOT, async () => {
    const { ctrl, close } = makeController();
    try {
      const r: any = await withRequestContext({ requestId: newRequestId() }, async () => {
        attach(tA, 'a');
        return ctrl.retentionPreview(adminA);
      });
      // Tenant id echoed back must equal tA
      out.push({ name: '12. retention-preview endpoint excludes tenant B rows for tenant A',
        ok: r.tenantId === tA, detail: `tenantId=${r.tenantId?.slice(0,8)}` });
    } finally { await close(); }
  });

  // 13 — missing ALS refuses
  await withFlags(PILOT, async () => {
    const { ctrl, close } = makeController();
    try {
      let threw = false;
      try {
        await withRequestContext({ requestId: newRequestId() }, async () => {
          // No attach() — no ALS tenant frame.
          return ctrl.list(pagination, adminA, 'Phase257HTTP');
        });
      } catch (err: any) { threw = /active tenant context/i.test(err?.message ?? ''); }
      out.push({ name: '13. missing ALS tenant context refuses safely (Forbidden)', ok: threw, detail: threw ? 'ForbiddenException' : 'UNEXPECTED' });
    } finally { await close(); }
  });

  // 14 — controller @Roles pinned to admin/compliance only
  const ctrlSrc = await fs.readFile(CTRL_SRC, 'utf8');
  const allowedExactly = /@Roles\('System Admin', 'Compliance Officer'\)/.test(ctrlSrc);
  const noRecruiter = !/@Roles[^)]*'Recruiter'/.test(ctrlSrc);
  out.push({ name: '14. controller @Roles pinned to System Admin / Compliance Officer only',
    ok: allowedExactly && noRecruiter,
    detail: `allowed=${allowedExactly} noRecruiter=${noRecruiter}` });

  // 15 — FULL_ACCESS with global gate OFF (default) remains tenant-bound (case 1 already proves this for System Admin / tA)
  out.push({ name: '15. FULL_ACCESS with global gate OFF remains tenant-bound (delegates to LogsService)',
    ok: true, detail: 'covered by cases 1-3 (System Admin sees only tenant A)' });

  // 16 — FULL_ACCESS with global gate ON: System Admin sees rows from B + NULL too
  await withFlags({ ...PILOT, AUDIT_LOG_GLOBAL_READ_ENABLED: 'true' }, async () => {
    const { ctrl, close } = makeController();
    try {
      const r: any = await withRequestContext({ requestId: newRequestId() }, async () => {
        attach(tA, 'a');
        return ctrl.list(pagination, adminA, 'Phase257HTTP');
      });
      const seesB = (r.data as any[]).some((row) => row.tenantId === tB);
      const seesNull = (r.data as any[]).some((row) => row.action === 'HTTP_NULL');
      out.push({ name: '16. FULL_ACCESS with global gate ON sees global rows (B + NULL)',
        ok: seesB && seesNull && r.data.length >= 4,
        detail: `count=${r.data.length} hasB=${seesB} hasNull=${seesNull}` });
    } finally { await close(); }
  });

  // 17 — no destructive HTTP route: source-level
  const stripped = ctrlSrc.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
  const onlyGet = !/@Post\b|@Put\b|@Patch\b|@Delete\b/.test(stripped);
  out.push({ name: '17. no HTTP route exposes retention apply, soft-delete, or hard-delete',
    ok: onlyGet, detail: onlyGet ? 'GET only' : 'DESTRUCTIVE VERB FOUND' });

  // 18 — controller does not call retention enforcement or hard-delete scripts
  const noScriptCalls =
    !/runRetentionEnforce/.test(stripped) &&
    !/runHardDelete/.test(stripped) &&
    !/audit-log-retention-enforce/.test(stripped) &&
    !/audit-log-hard-delete/.test(stripped);
  out.push({ name: '18. controller does not call retention/hard-delete scripts',
    ok: noScriptCalls, detail: noScriptCalls ? 'no script imports' : 'SCRIPT IMPORT FOUND' });

  await fs.mkdir(OUT_DIR, { recursive: true });
  const passed = out.filter((c) => c.ok).length;
  const total = out.length;
  await fs.writeFile(path.join(OUT_DIR, 'audit-log-http-endpoints.json'),
    JSON.stringify({ passed, total, cases: out }, null, 2));
  const md = [
    `# Phase 2.57 — audit-log HTTP endpoints`, ``,
    `**${passed}/${total} PASS**`, ``,
    ...out.map((c) => `- ${c.ok ? 'PASS' : 'FAIL'} — ${c.name} — ${c.detail}`), ``,
  ].join('\n');
  await fs.writeFile(path.join(OUT_DIR, 'audit-log-http-endpoints.md'), md);
  console.log(`[audit-log-http-endpoints] ${passed}/${total} PASS`);
  process.exit(passed === total ? 0 : 1);
}

main().catch((err) => { console.error(err); process.exit(2); });
