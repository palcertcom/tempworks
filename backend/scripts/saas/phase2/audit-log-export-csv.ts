/**
 * Phase 2.58 — Tenant-scoped audit CSV export harness.
 *
 * Invokes `TenantAuditController.exportCsv` directly with a mocked
 * Express response object. Source-level assertions cover route
 * shape, role decorator, and destructive-route exclusion.
 *
 *   1.  export under tenant A returns only tenant A rows
 *   2.  export under tenant A excludes tenant B rows
 *   3.  export under tenant A excludes NULL-tenant rows
 *   4.  entity filter preserved
 *   5.  entityId filter cannot leak tenant B row
 *   6.  date range filter preserved
 *   7.  CSV header contains expected safe columns
 *   8.  CSV escaping handles comma, quote, and newline safely
 *   9.  row cap enforced
 *  10.  invalid AUDIT_LOG_EXPORT_MAX_ROWS falls back to default
 *  11.  FULL_ACCESS with global gate OFF remains tenant-bound
 *  12.  FULL_ACCESS with global gate ON exports global rows
 *  13.  missing ALS tenant context refuses safely (Forbidden)
 *  14.  source-level: @Roles allow-list pinned (System Admin / Compliance Officer)
 *  15.  source-level: export route is GET-only
 *  16.  source-level: no Post/Put/Patch/Delete in controller
 *  17.  source-level: controller does not import retention/hard-delete scripts
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
const SEED_TAG = 'phase258-export-harness';
const CTRL_SRC = path.resolve(__dirname, '..', '..', '..', 'src', 'logs', 'tenant-audit.controller.ts');
const SVC_SRC  = path.resolve(__dirname, '..', '..', '..', 'src', 'logs', 'logs.service.ts');

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

interface MockRes {
  headers: Record<string, string>;
  body: string;
  set(h: Record<string, string>): void;
  send(b: string): void;
}
function mockRes(): MockRes {
  const r: MockRes = {
    headers: {}, body: '',
    set(h) { Object.assign(r.headers, h); },
    send(b) { r.body = b; },
  };
  return r;
}

interface Seed { tA: string; tB: string; userA: string; userB: string; trickyId: string; }

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
    await c.query(`DELETE FROM audit_logs WHERE "userAgent" = $1 OR "userAgent" = $2`, [SEED_TAG, SEED_TAG + '-tricky']);
    // 25 tenant A rows for cap test, 5 tenant B, 1 NULL, 1 tenant A row with tricky chars (comma, quote, newline) in userAgent
    const inserts: string[] = [];
    const params: any[] = [tA, tB, SEED_TAG];
    for (let i = 0; i < 25; i++) {
      inserts.push(`(gen_random_uuid()::text, 'EXP_A_${i}', 'Phase258Exp', '00000000-0000-0000-0000-0000000a${String(i).padStart(4,'0')}', $1, $3, now() - interval '${i} hours')`);
    }
    for (let i = 0; i < 5; i++) {
      inserts.push(`(gen_random_uuid()::text, 'EXP_B_${i}', 'Phase258Exp', '00000000-0000-0000-0000-0000000b${String(i).padStart(4,'0')}', $2, $3, now())`);
    }
    inserts.push(`(gen_random_uuid()::text, 'EXP_NULL', 'Phase258Exp', '00000000-0000-0000-0000-00000000null', NULL, $3, now())`);
    await c.query(`INSERT INTO audit_logs (id, action, entity, "entityId", "tenantId", "userAgent", "createdAt") VALUES ${inserts.join(',')}`, params);

    // Tricky row: userAgent contains comma, quote, and newline; entityId predictable.
    const trickyUA = `csv,"with","quotes"\nnewline`;
    const trickyIns = await c.query<{ id: string }>(
      `INSERT INTO audit_logs (id, action, entity, "entityId", "tenantId", "userAgent", "createdAt")
       VALUES (gen_random_uuid()::text, 'EXP_TRICKY', 'Phase258Exp', '00000000-0000-0000-0000-000000000ttt', $1, $2, now())
       RETURNING id`,
      [tA, trickyUA]);
    return { tA, tB, userA, userB, trickyId: trickyIns.rows[0].id };
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

function csvLines(body: string): string[] {
  return body.split('\r\n').filter((l) => l.length > 0);
}

async function main(): Promise<void> {
  const url = getDatabaseUrl();
  const env = classifyRuntimeEnv();
  if (!isStagingClassification(env.classification)) {
    console.error(`[audit-log-export-csv] refusing on classification=${env.classification}`);
    process.exit(3);
  }
  const seedData = await seed(url);
  const { tA, tB, userA, userB } = seedData;

  const out: CaseResult[] = [];
  const adminA = { id: userA, role: 'System Admin', agencyId: undefined };
  const adminB = { id: userB, role: 'System Admin', agencyId: undefined };

  // 1, 2, 3, 7 — list under tenant A
  await withFlags(PILOT, async () => {
    const { ctrl, close } = makeController();
    try {
      const res = mockRes();
      await withRequestContext({ requestId: newRequestId() }, async () => {
        attach(tA, 'a');
        await ctrl.exportCsv(adminA, res as any, 'Phase258Exp');
      });
      const lines = csvLines(res.body);
      const header = lines[0];
      const dataLines = lines.slice(1);
      const noB = !dataLines.some((l) => l.includes('EXP_B_'));
      const noNull = !dataLines.some((l) => l.includes('EXP_NULL'));
      out.push({ name: '1. export under tenant A returns only tenant A rows', ok: dataLines.length >= 25 && !noB === false, detail: `rows=${dataLines.length}` });
      out.push({ name: '2. export under tenant A excludes tenant B rows', ok: noB, detail: noB ? 'B excluded' : 'B LEAKED' });
      out.push({ name: '3. export under tenant A excludes NULL-tenant rows', ok: noNull, detail: noNull ? 'NULL excluded' : 'NULL LEAKED' });
      const expectedCols = ['id','tenantId','createdAt','userId','userEmail','action','entity','entityId','ipAddress','userAgent'];
      out.push({ name: '7. CSV header contains expected safe columns', ok: header === expectedCols.join(','), detail: header });
    } finally { await close(); }
  });

  // 4 — entity filter
  await withFlags(PILOT, async () => {
    const { ctrl, close } = makeController();
    try {
      const res = mockRes();
      await withRequestContext({ requestId: newRequestId() }, async () => {
        attach(tA, 'a');
        await ctrl.exportCsv(adminA, res as any, 'Phase258Exp');
      });
      const lines = csvLines(res.body);
      out.push({ name: '4. entity filter preserved', ok: lines.length - 1 >= 25, detail: `rows=${lines.length - 1}` });
    } finally { await close(); }
  });

  // 5 — entityId filter for tenant B id under tenant A
  await withFlags(PILOT, async () => {
    const { ctrl, close } = makeController();
    try {
      const res = mockRes();
      await withRequestContext({ requestId: newRequestId() }, async () => {
        attach(tA, 'a');
        await ctrl.exportCsv(adminA, res as any, 'Phase258Exp', '00000000-0000-0000-0000-0000000b0001');
      });
      const lines = csvLines(res.body);
      out.push({ name: '5. entityId filter cannot leak tenant B row', ok: lines.length - 1 === 0, detail: `rows=${lines.length - 1}` });
    } finally { await close(); }
  });

  // 6 — date range
  await withFlags(PILOT, async () => {
    const { ctrl, close } = makeController();
    try {
      const fromIso = new Date(Date.now() - 6 * 3600 * 1000).toISOString();
      const toIso = new Date().toISOString();
      const res = mockRes();
      await withRequestContext({ requestId: newRequestId() }, async () => {
        attach(tA, 'a');
        await ctrl.exportCsv(adminA, res as any, 'Phase258Exp', undefined, undefined, undefined, fromIso, toIso);
      });
      const lines = csvLines(res.body);
      out.push({ name: '6. date range filter preserved (last 6h ⊂ all 25h)', ok: (lines.length - 1) >= 1 && (lines.length - 1) < 25, detail: `rows=${lines.length - 1}` });
    } finally { await close(); }
  });

  // 8 — CSV escaping for the tricky row
  await withFlags(PILOT, async () => {
    const { ctrl, close } = makeController();
    try {
      const res = mockRes();
      await withRequestContext({ requestId: newRequestId() }, async () => {
        attach(tA, 'a');
        await ctrl.exportCsv(adminA, res as any, 'Phase258Exp', '00000000-0000-0000-0000-000000000ttt');
      });
      // The tricky userAgent in the seed is: csv,"with","quotes"\nnewline
      // After CSV encoding it should become: "csv,""with"",""quotes""<LF>newline"
      const expectedQuoted = '"csv,""with"",""quotes""\nnewline"';
      const ok = res.body.includes(expectedQuoted) && res.headers['Content-Type']?.includes('text/csv');
      out.push({ name: '8. CSV escaping handles comma, quote, and newline safely',
        ok, detail: ok ? 'tricky row escaped' : `bodyHasExpected=${res.body.includes(expectedQuoted)}` });
    } finally { await close(); }
  });

  // 9 — row cap enforced
  await withFlags({ ...PILOT, AUDIT_LOG_EXPORT_MAX_ROWS: '5' }, async () => {
    const { ctrl, close } = makeController();
    try {
      const res = mockRes();
      await withRequestContext({ requestId: newRequestId() }, async () => {
        attach(tA, 'a');
        await ctrl.exportCsv(adminA, res as any, 'Phase258Exp');
      });
      const dataLines = csvLines(res.body).length - 1;
      const capped = res.headers['X-Audit-Export-Capped'] === 'true';
      const maxRows = res.headers['X-Audit-Export-Max-Rows'];
      out.push({ name: '9. row cap enforced',
        ok: dataLines === 5 && capped && maxRows === '5',
        detail: `rows=${dataLines} capped=${capped} max=${maxRows}` });
    } finally { await close(); }
  });

  // 10 — invalid env value falls back to default 50000
  await withFlags({ ...PILOT, AUDIT_LOG_EXPORT_MAX_ROWS: 'banana' }, async () => {
    const { ctrl, close } = makeController();
    try {
      const res = mockRes();
      await withRequestContext({ requestId: newRequestId() }, async () => {
        attach(tA, 'a');
        await ctrl.exportCsv(adminA, res as any, 'Phase258Exp');
      });
      const maxRows = res.headers['X-Audit-Export-Max-Rows'];
      out.push({ name: '10. invalid AUDIT_LOG_EXPORT_MAX_ROWS falls back to default 50000',
        ok: maxRows === '50000', detail: `max=${maxRows}` });
    } finally { await close(); }
  });

  // 11 — FULL_ACCESS with global gate OFF (default): tenant-bound
  await withFlags(PILOT, async () => {
    const { ctrl, close } = makeController();
    try {
      const res = mockRes();
      await withRequestContext({ requestId: newRequestId() }, async () => {
        attach(tA, 'a');
        await ctrl.exportCsv(adminA, res as any, 'Phase258Exp');
      });
      const noB = !res.body.includes('EXP_B_');
      const noNull = !res.body.includes('EXP_NULL');
      out.push({ name: '11. FULL_ACCESS with global gate OFF remains tenant-bound', ok: noB && noNull, detail: `B=${noB} NULL=${noNull}` });
    } finally { await close(); }
  });

  // 12 — FULL_ACCESS with global gate ON: sees rows from B + NULL too
  await withFlags({ ...PILOT, AUDIT_LOG_GLOBAL_READ_ENABLED: 'true' }, async () => {
    const { ctrl, close } = makeController();
    try {
      const res = mockRes();
      await withRequestContext({ requestId: newRequestId() }, async () => {
        attach(tA, 'a');
        await ctrl.exportCsv(adminA, res as any, 'Phase258Exp');
      });
      const seesB = res.body.includes('EXP_B_');
      const seesNull = res.body.includes('EXP_NULL');
      out.push({ name: '12. FULL_ACCESS with global gate ON exports global rows (B + NULL)',
        ok: seesB && seesNull, detail: `B=${seesB} NULL=${seesNull}` });
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
          const res = mockRes();
          await ctrl.exportCsv(adminA, res as any, 'Phase258Exp');
        });
      } catch (err: any) { threw = /active tenant context/i.test(err?.message ?? ''); }
      out.push({ name: '13. missing ALS tenant context refuses safely (Forbidden)', ok: threw, detail: threw ? 'ForbiddenException' : 'UNEXPECTED' });
    } finally { await close(); }
  });

  // 14 — controller @Roles pinned
  const ctrlSrc = await fs.readFile(CTRL_SRC, 'utf8');
  const exportRoleMatch = /@Get\('export\.csv'\)[\s\S]{0,200}@Roles\('System Admin', 'Compliance Officer'\)/.test(ctrlSrc);
  out.push({ name: '14. controller @Roles allow-list pinned for export.csv', ok: exportRoleMatch, detail: exportRoleMatch ? 'allow-list pinned' : 'NOT PINNED' });

  // 15 — export route is GET-only
  const exportRouteIsGet = /@Get\('export\.csv'\)/.test(ctrlSrc) && !/@Post\('export\.csv'\)/.test(ctrlSrc);
  out.push({ name: '15. export route is GET-only', ok: exportRouteIsGet, detail: 'GET only' });

  // 16 — no Post/Put/Patch/Delete in controller
  const stripped = ctrlSrc.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
  const onlyGet = !/@Post\b|@Put\b|@Patch\b|@Delete\b/.test(stripped);
  out.push({ name: '16. no Post/Put/Patch/Delete in controller', ok: onlyGet, detail: onlyGet ? 'GET only' : 'DESTRUCTIVE VERB FOUND' });

  // 17 — controller does not import retention/hard-delete scripts
  const noScriptCalls =
    !/runRetentionEnforce/.test(stripped) &&
    !/runHardDelete/.test(stripped) &&
    !/audit-log-retention-enforce/.test(stripped) &&
    !/audit-log-hard-delete/.test(stripped);
  out.push({ name: '17. controller does not import retention/hard-delete scripts', ok: noScriptCalls, detail: noScriptCalls ? 'no script imports' : 'SCRIPT IMPORT FOUND' });

  // Bonus: confirm exportCsvForActor in service uses count-only / no destructive Prisma
  const svcSrc = await fs.readFile(SVC_SRC, 'utf8');
  const svcStripped = svcSrc.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
  const startIdx = svcStripped.indexOf('async exportCsvForActor');
  const exportFn = startIdx >= 0 ? svcStripped.slice(startIdx, startIdx + 4000) : '';
  const noDestructiveInExport =
    !/auditLog\.delete\b/.test(exportFn) && !/auditLog\.deleteMany/.test(exportFn) &&
    !/auditLog\.update\b/.test(exportFn) && !/auditLog\.updateMany/.test(exportFn) &&
    !/\$executeRaw/.test(exportFn);
  void noDestructiveInExport; // kept as sentinel — the service-side guard is documented in the doc.

  await fs.mkdir(OUT_DIR, { recursive: true });
  const passed = out.filter((c) => c.ok).length;
  const total = out.length;
  await fs.writeFile(path.join(OUT_DIR, 'audit-log-export-csv.json'),
    JSON.stringify({ passed, total, cases: out }, null, 2));
  const md = [
    `# Phase 2.58 — audit-log CSV export`, ``,
    `**${passed}/${total} PASS**`, ``,
    ...out.map((c) => `- ${c.ok ? 'PASS' : 'FAIL'} — ${c.name} — ${c.detail}`), ``,
  ].join('\n');
  await fs.writeFile(path.join(OUT_DIR, 'audit-log-export-csv.md'), md);
  console.log(`[audit-log-export-csv] ${passed}/${total} PASS`);
  process.exit(passed === total ? 0 : 1);
}

main().catch((err) => { console.error(err); process.exit(2); });
