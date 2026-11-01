/**
 * Phase 2.60 — Structured 429 envelope + Retry-After harness.
 *
 *   1.  limiter disabled ⇒ no Retry-After header added
 *   2.  enabled RPM=1 ⇒ second list request returns status 429
 *   3.  429 body has error='rate_limited'
 *   4.  429 body has retryAfterSeconds positive integer
 *   5.  429 body has limit
 *   6.  429 body has remaining=0
 *   7.  429 body has windowSeconds
 *   8.  Retry-After header equals retryAfterSeconds
 *   9.  stats route returns same structured 429 envelope
 *  10.  retention-preview route returns same structured 429 envelope
 *  11.  export.csv route returns structured 429 envelope, not CSV
 *  12.  byId route returns same structured 429 envelope
 *  13.  successful export.csv still returns text/csv and export headers
 *  14.  tenant A 429 envelope does not affect tenant B
 *  15.  global FULL_ACCESS rate-limit envelope uses global/user key
 *  16.  missing ALS in pilot returns the documented RBAC error path
 *  17.  source-level: every TenantAuditController GET handler passes res to enforceRateLimit
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
const SEED_TAG = 'phase260-envelope-harness';
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

async function seed(url: string): Promise<{ tA: string; tB: string; userA: string; userB: string; rowAId: string }> {
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
      INSERT INTO audit_logs (id, action, entity, "entityId", "tenantId", "userAgent", "createdAt") VALUES
        (gen_random_uuid()::text, 'ENV_A1', 'Phase260Env', '00000000-0000-0000-0000-000000000aa1', $1, $3, now()),
        (gen_random_uuid()::text, 'ENV_A2', 'Phase260Env', '00000000-0000-0000-0000-000000000aa2', $1, $3, now()),
        (gen_random_uuid()::text, 'ENV_B1', 'Phase260Env', '00000000-0000-0000-0000-000000000bb1', $2, $3, now())
      RETURNING id, COALESCE("tenantId",'NULL') AS t`,
      [tA, tB, SEED_TAG]);
    const rowAId = ins.rows.find((r) => r.t === tA)!.id;
    return { tA, tB, userA, userB, rowAId };
  } finally { await c.end(); }
}

const PILOT = { TENANT_PRISMA_PILOT_ENABLED: 'true', TENANT_PRISMA_PILOT_MODULES: 'audit-logs' };
const filter = { entity: 'Phase260Env' };
const pagination = { page: 1, limit: 50 } as any;

function makeController(): { ctrl: TenantAuditController; close: () => Promise<void> } {
  const prisma = new PrismaService();
  const ff = new FeatureFlagsService();
  const pilot = new PilotPrismaAccessor(prisma, new TenantPrismaService(prisma, ff), ff);
  const tenantAuditLog = new TenantAuditLogService(prisma, ff);
  const svc = new LogsService(prisma, pilot, tenantAuditLog);
  const ctrl = new TenantAuditController(svc, new AuditLogRateLimiter());
  return { ctrl, close: () => prisma.$disconnect() };
}

function extractEnvelope(err: any): any {
  // HttpException response can be an object or a string; we want the object.
  const r = err?.response ?? err?.getResponse?.();
  return typeof r === 'object' ? r : null;
}

async function main(): Promise<void> {
  const url = getDatabaseUrl();
  const env = classifyRuntimeEnv();
  if (!isStagingClassification(env.classification)) {
    console.error(`[audit-log-http-rate-limit-envelope] refusing on classification=${env.classification}`);
    process.exit(3);
  }
  const { tA, tB, userA, userB, rowAId } = await seed(url);

  const out: CaseResult[] = [];
  const adminA = { id: userA, role: 'System Admin', agencyId: undefined };
  const adminB = { id: userB, role: 'System Admin', agencyId: undefined };

  // 1 — limiter disabled ⇒ no Retry-After
  await withFlags(PILOT, async () => {
    const { ctrl, close } = makeController();
    try {
      const res = mockRes();
      await withRequestContext({ requestId: newRequestId() }, async () => {
        attach(tA, 'a');
        await ctrl.list(pagination, adminA, filter.entity, undefined, undefined, undefined, undefined, undefined, res as any);
      });
      out.push({ name: '1. limiter disabled ⇒ no Retry-After header added',
        ok: !('Retry-After' in res.headers),
        detail: `headers=${Object.keys(res.headers).join(',') || 'none'}` });
    } finally { await close(); }
  });

  // 2-8 — list 429 envelope
  await withFlags({ ...PILOT, AUDIT_LOG_HTTP_RATE_LIMIT_ENABLED: 'true', AUDIT_LOG_HTTP_RATE_LIMIT_RPM: '1', AUDIT_LOG_HTTP_RATE_LIMIT_WINDOW_SECONDS: '60' }, async () => {
    const { ctrl, close } = makeController();
    try {
      const res1 = mockRes(); const res2 = mockRes();
      await withRequestContext({ requestId: newRequestId() }, async () => {
        attach(tA, 'a');
        await ctrl.list(pagination, adminA, filter.entity, undefined, undefined, undefined, undefined, undefined, res1 as any);
      });
      let err: any;
      try {
        await withRequestContext({ requestId: newRequestId() }, async () => {
          attach(tA, 'a');
          await ctrl.list(pagination, adminA, filter.entity, undefined, undefined, undefined, undefined, undefined, res2 as any);
        });
      } catch (e: any) { err = e; }
      const envelope = extractEnvelope(err);
      out.push({ name: '2. enabled RPM=1 ⇒ second list request returns 429', ok: err?.status === 429, detail: `status=${err?.status}` });
      out.push({ name: '3. 429 body has error="rate_limited"', ok: envelope?.error === 'rate_limited', detail: `error=${envelope?.error}` });
      out.push({ name: '4. 429 body has retryAfterSeconds positive integer',
        ok: typeof envelope?.retryAfterSeconds === 'number' && envelope.retryAfterSeconds > 0 && Number.isInteger(envelope.retryAfterSeconds),
        detail: `retryAfterSeconds=${envelope?.retryAfterSeconds}` });
      out.push({ name: '5. 429 body has limit', ok: envelope?.limit === 1, detail: `limit=${envelope?.limit}` });
      out.push({ name: '6. 429 body has remaining=0', ok: envelope?.remaining === 0, detail: `remaining=${envelope?.remaining}` });
      out.push({ name: '7. 429 body has windowSeconds', ok: envelope?.windowSeconds === 60, detail: `windowSeconds=${envelope?.windowSeconds}` });
      out.push({ name: '8. Retry-After header equals retryAfterSeconds',
        ok: res2.headers['Retry-After'] === String(envelope?.retryAfterSeconds),
        detail: `header=${res2.headers['Retry-After']} envelope=${envelope?.retryAfterSeconds}` });
    } finally { await close(); }
  });

  // 9 — stats route 429 envelope
  await withFlags({ ...PILOT, AUDIT_LOG_HTTP_RATE_LIMIT_ENABLED: 'true', AUDIT_LOG_HTTP_RATE_LIMIT_RPM: '1' }, async () => {
    const { ctrl, close } = makeController();
    try {
      const res1 = mockRes(); const res2 = mockRes();
      await withRequestContext({ requestId: newRequestId() }, async () => { attach(tA, 'a'); await ctrl.stats(adminA, res1 as any); });
      let err: any;
      try { await withRequestContext({ requestId: newRequestId() }, async () => { attach(tA, 'a'); await ctrl.stats(adminA, res2 as any); }); }
      catch (e: any) { err = e; }
      const envelope = extractEnvelope(err);
      out.push({ name: '9. stats route returns same structured 429 envelope',
        ok: err?.status === 429 && envelope?.error === 'rate_limited' && !!res2.headers['Retry-After'],
        detail: `status=${err?.status} error=${envelope?.error}` });
    } finally { await close(); }
  });

  // 10 — retention-preview 429 envelope
  await withFlags({ ...PILOT, AUDIT_LOG_HTTP_RATE_LIMIT_ENABLED: 'true', AUDIT_LOG_HTTP_RATE_LIMIT_RPM: '1' }, async () => {
    const { ctrl, close } = makeController();
    try {
      const res1 = mockRes(); const res2 = mockRes();
      await withRequestContext({ requestId: newRequestId() }, async () => { attach(tA, 'a'); await ctrl.retentionPreview(adminA, undefined, res1 as any); });
      let err: any;
      try { await withRequestContext({ requestId: newRequestId() }, async () => { attach(tA, 'a'); await ctrl.retentionPreview(adminA, undefined, res2 as any); }); }
      catch (e: any) { err = e; }
      const envelope = extractEnvelope(err);
      out.push({ name: '10. retention-preview returns same structured 429 envelope',
        ok: err?.status === 429 && envelope?.error === 'rate_limited' && !!!!res2.headers['Retry-After'],
        detail: `status=${err?.status} error=${envelope?.error}` });
    } finally { await close(); }
  });

  // 11 — export.csv 429 envelope (NOT CSV)
  await withFlags({ ...PILOT, AUDIT_LOG_HTTP_RATE_LIMIT_ENABLED: 'true', AUDIT_LOG_HTTP_RATE_LIMIT_RPM: '1' }, async () => {
    const { ctrl, close } = makeController();
    try {
      const res1 = mockRes(); const res2 = mockRes();
      await withRequestContext({ requestId: newRequestId() }, async () => { attach(tA, 'a'); await ctrl.exportCsv(adminA, res1 as any, filter.entity); });
      let err: any;
      try { await withRequestContext({ requestId: newRequestId() }, async () => { attach(tA, 'a'); await ctrl.exportCsv(adminA, res2 as any, filter.entity); }); }
      catch (e: any) { err = e; }
      const envelope = extractEnvelope(err);
      // The 429 path throws BEFORE res.send() runs, so res2.body must remain empty (no CSV body emitted).
      out.push({ name: '11. export.csv returns structured 429 envelope, not CSV',
        ok: err?.status === 429 && envelope?.error === 'rate_limited' && res2.body === '' && !!!!res2.headers['Retry-After'],
        detail: `bodyLen=${res2.body.length} contentType=${res2.headers['Content-Type']}` });
    } finally { await close(); }
  });

  // 12 — byId 429 envelope
  await withFlags({ ...PILOT, AUDIT_LOG_HTTP_RATE_LIMIT_ENABLED: 'true', AUDIT_LOG_HTTP_RATE_LIMIT_RPM: '1' }, async () => {
    const { ctrl, close } = makeController();
    try {
      const res1 = mockRes(); const res2 = mockRes();
      await withRequestContext({ requestId: newRequestId() }, async () => { attach(tA, 'a'); await ctrl.byId(rowAId, adminA, res1 as any); });
      let err: any;
      try { await withRequestContext({ requestId: newRequestId() }, async () => { attach(tA, 'a'); await ctrl.byId(rowAId, adminA, res2 as any); }); }
      catch (e: any) { err = e; }
      const envelope = extractEnvelope(err);
      out.push({ name: '12. byId route returns same structured 429 envelope',
        ok: err?.status === 429 && envelope?.error === 'rate_limited' && !!!!res2.headers['Retry-After'],
        detail: `status=${err?.status} error=${envelope?.error}` });
    } finally { await close(); }
  });

  // 13 — successful export.csv still returns text/csv + export headers
  await withFlags(PILOT, async () => {
    const { ctrl, close } = makeController();
    try {
      const res = mockRes();
      await withRequestContext({ requestId: newRequestId() }, async () => {
        attach(tA, 'a');
        await ctrl.exportCsv(adminA, res as any, filter.entity);
      });
      const ok = (res.headers['Content-Type'] ?? '').includes('text/csv') &&
                 res.body.includes('id,tenantId,createdAt') &&
                 'X-Audit-Export-Row-Count' in res.headers;
      out.push({ name: '13. successful export.csv still returns text/csv and export headers', ok, detail: `Content-Type=${res.headers['Content-Type']}` });
    } finally { await close(); }
  });

  // 14 — tenant A 429 does not affect tenant B
  await withFlags({ ...PILOT, AUDIT_LOG_HTTP_RATE_LIMIT_ENABLED: 'true', AUDIT_LOG_HTTP_RATE_LIMIT_RPM: '1' }, async () => {
    const { ctrl, close } = makeController();
    try {
      // A consumes
      await withRequestContext({ requestId: newRequestId() }, async () => { attach(tA, 'a'); await ctrl.list(pagination, adminA, filter.entity); });
      // A's second request → 429
      let aErr: any;
      try { await withRequestContext({ requestId: newRequestId() }, async () => { attach(tA, 'a'); await ctrl.list(pagination, adminA, filter.entity); }); }
      catch (e) { aErr = e; }
      // B's first request still passes
      let bOk = false;
      await withRequestContext({ requestId: newRequestId() }, async () => {
        attach(tB, 'b');
        const r: any = await ctrl.list(pagination, adminB, filter.entity);
        bOk = r?.data?.length >= 1;
      });
      out.push({ name: '14. tenant A 429 envelope does not affect tenant B',
        ok: (aErr as any)?.status === 429 && bOk, detail: `A=429 B.passes=${bOk}` });
    } finally { await close(); }
  });

  // 15 — global FULL_ACCESS keying
  await withFlags({
    ...PILOT, AUDIT_LOG_HTTP_RATE_LIMIT_ENABLED: 'true', AUDIT_LOG_HTTP_RATE_LIMIT_RPM: '1',
    AUDIT_LOG_GLOBAL_READ_ENABLED: 'true',
  }, async () => {
    const { ctrl, close } = makeController();
    try {
      await withRequestContext({ requestId: newRequestId() }, async () => { attach(tA, 'a'); await ctrl.list(pagination, adminA, filter.entity); });
      let err: any;
      try {
        await withRequestContext({ requestId: newRequestId() }, async () => {
          attach(tB, 'b');
          await ctrl.list(pagination, adminA, filter.entity); // same actor, different ALS tenant
        });
      } catch (e) { err = e; }
      out.push({ name: '15. global FULL_ACCESS rate-limit envelope uses global/user key',
        ok: (err as any)?.status === 429,
        detail: `status=${(err as any)?.status} key=global` });
    } finally { await close(); }
  });

  // 16 — missing ALS in pilot ⇒ Forbidden
  await withFlags({ ...PILOT, AUDIT_LOG_HTTP_RATE_LIMIT_ENABLED: 'true', AUDIT_LOG_HTTP_RATE_LIMIT_RPM: '1' }, async () => {
    const { ctrl, close } = makeController();
    try {
      let err: any;
      try {
        await withRequestContext({ requestId: newRequestId() }, async () => {
          // No attach()
          await ctrl.list(pagination, adminA, filter.entity);
        });
      } catch (e) { err = e; }
      out.push({ name: '16. missing ALS in pilot returns Forbidden, not rate-limit envelope',
        ok: /active tenant context/i.test((err as any)?.message ?? ''),
        detail: `message=${(err as any)?.message ?? ''}` });
    } finally { await close(); }
  });

  // 17 — source-level: every GET handler passes res to enforceRateLimit
  const ctrlSrc = await fs.readFile(CTRL_SRC, 'utf8');
  const stripped = ctrlSrc.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
  const lines = stripped.split('\n');
  const getIndices: number[] = [];
  lines.forEach((l, i) => { if (/@Get\(/.test(l)) getIndices.push(i); });
  const wired = getIndices.filter((idx) => {
    const window = lines.slice(idx, idx + 80).join('\n');
    // Each GET must have an enforceRateLimit(... res) call (or enforceRateLimit(caller, res))
    return /enforceRateLimit\s*\([^)]*res[^)]*\)/.test(window);
  }).length;
  out.push({ name: '17. every TenantAuditController GET handler passes res to enforceRateLimit',
    ok: getIndices.length >= 5 && wired === getIndices.length,
    detail: `routes=${getIndices.length} wired=${wired}` });

  await fs.mkdir(OUT_DIR, { recursive: true });
  const passed = out.filter((c) => c.ok).length;
  const total = out.length;
  await fs.writeFile(path.join(OUT_DIR, 'audit-log-http-rate-limit-envelope.json'),
    JSON.stringify({ passed, total, cases: out }, null, 2));
  const md = [
    `# Phase 2.60 — audit-log HTTP rate-limit envelope`, ``,
    `**${passed}/${total} PASS**`, ``,
    ...out.map((c) => `- ${c.ok ? 'PASS' : 'FAIL'} — ${c.name} — ${c.detail}`), ``,
  ].join('\n');
  await fs.writeFile(path.join(OUT_DIR, 'audit-log-http-rate-limit-envelope.md'), md);
  console.log(`[audit-log-http-rate-limit-envelope] ${passed}/${total} PASS`);
  process.exit(passed === total ? 0 : 1);
}

main().catch((err) => { console.error(err); process.exit(2); });
