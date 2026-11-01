/**
 * Phase 3.12 — PlatformAdmin controller harness.
 *
 *  1.  flag off → all routes throw NotFoundException
 *  2.  SUPER can grant SUPPORT
 *  3.  SUPER can grant OPERATOR
 *  4.  SUPER can grant SUPER
 *  5.  SUPPORT cannot grant (service defense rejects)
 *  6.  OPERATOR cannot grant
 *  7.  non-platform user cannot grant
 *  8.  SUPER can revoke another PlatformAdmin
 *  9.  self-revoke rejected
 * 10.  list returns PlatformAdmin rows
 * 11.  grant emits PlatformAuditLog
 * 12.  revoke emits PlatformAuditLog
 * 13.  duplicate grant deterministic (IDEMPOTENT vs LEVEL_CHANGED)
 * 14.  controller delegates only to PlatformAdminService (source-level)
 * 15.  Phase 3.11 grant/revoke wiring intact
 * 16.  cumulative regression chain outputs present
 */
/* eslint-disable no-console */
import { promises as fs } from 'fs';
import path from 'path';
import { Client } from 'pg';
import { autoLoadEnv, formatDatabaseUrlMissingMessage } from './../phase1/reconciliation/lib/env';
import { PrismaService } from '../../../src/prisma/prisma.service';
import { PlatformAdminService } from '../../../src/saas/platform-admin/platform-admin.service';
import { PlatformAdminController } from '../../../src/saas/platform-admin/platform-admin.controller';

autoLoadEnv(__filename);

const BACKEND_ROOT = path.resolve(__dirname, '..', '..', '..');
const PHASE3_REPORTS = path.resolve(BACKEND_ROOT, 'reports', 'saas', 'phase3');

const SEED = '00000000-0000-0000-0000-0000003120';
const ID = {
  agency:   `${SEED}AA`,
  uSuper:   `${SEED}U1`,
  uSupport: `${SEED}U2`,
  uOp:      `${SEED}U3`,
  uNoneA:   `${SEED}U4`,
  uTarget1: `${SEED}T1`,
  uTarget2: `${SEED}T2`,
  uTarget3: `${SEED}T3`,
  uTarget4: `${SEED}T4`,
};
const ALL_USERS = [ID.uSuper, ID.uSupport, ID.uOp, ID.uNoneA,
  ID.uTarget1, ID.uTarget2, ID.uTarget3, ID.uTarget4];

interface CaseResult { name: string; ok: boolean; detail: string; }

function getDatabaseUrl(): string {
  const arg = process.argv.find((a) => a.startsWith('--db='))?.slice(5);
  return arg ?? process.env.DATABASE_URL ?? (() => { throw new Error(formatDatabaseUrlMissingMessage()); })();
}
function pgClient(url: string): Client {
  return new Client({ connectionString: url, ssl: /127\.0\.0\.1|localhost/.test(url) ? false : { rejectUnauthorized: false } });
}
async function exists(p: string): Promise<boolean> { return fs.stat(p).then(() => true).catch(() => false); }

async function teardown(c: Client): Promise<void> {
  await c.query(`DELETE FROM platform_audit_logs WHERE "actorId" = ANY($1) OR (target->>'targetUserId') = ANY($2)`,
    [ALL_USERS, ALL_USERS]);
  await c.query(`DELETE FROM platform_admins WHERE "userId" = ANY($1)`, [ALL_USERS]);
  await c.query(`DELETE FROM users WHERE id = ANY($1)`, [ALL_USERS]);
  await c.query(`DELETE FROM agencies WHERE id = $1`, [ID.agency]);
}
async function seed(c: Client): Promise<void> {
  const ro = await c.query<{ id: string }>(`SELECT id FROM roles LIMIT 1`);
  const roleId = ro.rows[0].id;
  await c.query(`
    INSERT INTO agencies (id, name, country, "contactPerson", email, phone, "createdAt", "updatedAt")
    VALUES ($1, 'P312', 'XX', 'C', 'a@p312.test', '0', now(), now())
    ON CONFLICT (id) DO NOTHING
  `, [ID.agency]);
  await c.query(`
    INSERT INTO users (id, email, "passwordHash", "firstName", "lastName", "roleId", "agencyId", status, "createdAt", "updatedAt")
    VALUES
      ($1, 'p312-super@e.com',  'h','S','U',$9,$10,'ACTIVE', now(), now()),
      ($2, 'p312-support@e.com','h','S','P',$9,$10,'ACTIVE', now(), now()),
      ($3, 'p312-op@e.com',     'h','O','P',$9,$10,'ACTIVE', now(), now()),
      ($4, 'p312-none@e.com',   'h','N','N',$9,$10,'ACTIVE', now(), now()),
      ($5, 'p312-t1@e.com',     'h','T','1',$9,$10,'ACTIVE', now(), now()),
      ($6, 'p312-t2@e.com',     'h','T','2',$9,$10,'ACTIVE', now(), now()),
      ($7, 'p312-t3@e.com',     'h','T','3',$9,$10,'ACTIVE', now(), now()),
      ($8, 'p312-t4@e.com',     'h','T','4',$9,$10,'ACTIVE', now(), now())
    ON CONFLICT (id) DO NOTHING
  `, [ID.uSuper, ID.uSupport, ID.uOp, ID.uNoneA, ID.uTarget1, ID.uTarget2, ID.uTarget3, ID.uTarget4, roleId, ID.agency]);
  await c.query(`
    INSERT INTO platform_admins (id, "userId", level, "grantedBy", "grantedAt")
    VALUES (gen_random_uuid()::text, $1, 'SUPER',    'phase312-seed', now()),
           (gen_random_uuid()::text, $2, 'SUPPORT',  'phase312-seed', now()),
           (gen_random_uuid()::text, $3, 'OPERATOR', 'phase312-seed', now())
    ON CONFLICT ("userId") DO NOTHING
  `, [ID.uSuper, ID.uSupport, ID.uOp]);
}

function mockReq(userId: string): any {
  return { user: { id: userId }, ip: '127.0.0.1', headers: { 'user-agent': 'phase312-test' } };
}

async function main(): Promise<void> {
  const url = getDatabaseUrl();
  const out: CaseResult[] = [];

  const setup = pgClient(url); await setup.connect();
  try {
    await setup.query(`CREATE TABLE IF NOT EXISTS "platform_audit_logs" (
      "id" BIGSERIAL PRIMARY KEY,
      "actorId" text NOT NULL, "tenantId" text,
      "action" text NOT NULL, "reason" text NOT NULL,
      "target" jsonb, "ip" text, "userAgent" text,
      "createdAt" timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP)`);
    await teardown(setup);
    await seed(setup);
  } finally { await setup.end(); }

  const prisma = new PrismaService();
  try {
    const svc = new PlatformAdminService(prisma);
    const ctrl = new PlatformAdminController(svc);

    // 1 — flag off → NotFoundException
    delete process.env.PLATFORM_ADMIN_HTTP_ENABLED;
    let flagOffRejects = 0;
    for (const fn of [
      () => ctrl.grant({ userId: ID.uTarget1, level: 'SUPPORT', reason: 'x' } as any, mockReq(ID.uSuper)),
      () => ctrl.revoke(ID.uTarget1, { reason: 'x' } as any, mockReq(ID.uSuper)),
      () => ctrl.list(mockReq(ID.uSuper)),
    ]) {
      try { await fn(); }
      catch (err: any) { if (/HTTP_DISABLED/.test(JSON.stringify(err?.response ?? {}))) flagOffRejects++; }
    }
    out.push({ name: '1. flag off → all routes throw NotFoundException (HTTP_DISABLED)',
      ok: flagOffRejects === 3, detail: `rejects=${flagOffRejects}/3` });

    process.env.PLATFORM_ADMIN_HTTP_ENABLED = 'true';

    // 2 — SUPER grants SUPPORT
    const r2 = await ctrl.grant({ userId: ID.uTarget1, level: 'SUPPORT', reason: 't1' } as any, mockReq(ID.uSuper));
    out.push({ name: '2. SUPER can grant SUPPORT', ok: r2.action === 'PLATFORM_ADMIN_GRANTED' && r2.level === 'SUPPORT', detail: r2.action });

    // 3 — SUPER grants OPERATOR
    const r3 = await ctrl.grant({ userId: ID.uTarget2, level: 'OPERATOR', reason: 't2' } as any, mockReq(ID.uSuper));
    out.push({ name: '3. SUPER can grant OPERATOR', ok: r3.action === 'PLATFORM_ADMIN_GRANTED' && r3.level === 'OPERATOR', detail: r3.action });

    // 4 — SUPER grants SUPER
    const r4 = await ctrl.grant({ userId: ID.uTarget3, level: 'SUPER', reason: 't3' } as any, mockReq(ID.uSuper));
    out.push({ name: '4. SUPER can grant SUPER', ok: r4.action === 'PLATFORM_ADMIN_GRANTED' && r4.level === 'SUPER', detail: r4.action });

    // 5 — SUPPORT cannot grant
    let r5Blocked = false;
    try { await ctrl.grant({ userId: ID.uTarget4, level: 'SUPPORT', reason: 'x' } as any, mockReq(ID.uSupport)); }
    catch (err: any) { r5Blocked = /ACTOR_NOT_SUPER/.test(JSON.stringify(err?.response ?? {})); }
    out.push({ name: '5. SUPPORT cannot grant (service rejects)', ok: r5Blocked, detail: r5Blocked ? 'forbidden' : 'NOT REJECTED' });

    // 6 — OPERATOR cannot grant
    let r6Blocked = false;
    try { await ctrl.grant({ userId: ID.uTarget4, level: 'SUPPORT', reason: 'x' } as any, mockReq(ID.uOp)); }
    catch (err: any) { r6Blocked = /ACTOR_NOT_SUPER/.test(JSON.stringify(err?.response ?? {})); }
    out.push({ name: '6. OPERATOR cannot grant', ok: r6Blocked, detail: r6Blocked ? 'forbidden' : 'NOT REJECTED' });

    // 7 — non-PlatformAdmin user cannot grant
    let r7Blocked = false;
    try { await ctrl.grant({ userId: ID.uTarget4, level: 'SUPPORT', reason: 'x' } as any, mockReq(ID.uNoneA)); }
    catch (err: any) { r7Blocked = /NOT_PLATFORM_ADMIN/.test(JSON.stringify(err?.response ?? {})); }
    out.push({ name: '7. non-PlatformAdmin user cannot grant', ok: r7Blocked, detail: r7Blocked ? 'forbidden' : 'NOT REJECTED' });

    // 8 — SUPER revokes another PlatformAdmin
    const r8 = await ctrl.revoke(ID.uTarget2, { reason: 'revoke-t2' } as any, mockReq(ID.uSuper));
    out.push({ name: '8. SUPER can revoke another PlatformAdmin', ok: r8.action === 'PLATFORM_ADMIN_REVOKED', detail: r8.action });

    // 9 — self-revoke rejected
    let r9Blocked = false;
    try { await ctrl.revoke(ID.uSuper, { reason: 'self' } as any, mockReq(ID.uSuper)); }
    catch (err: any) { r9Blocked = /SELF_REVOKE_FORBIDDEN/.test(JSON.stringify(err?.response ?? {})); }
    out.push({ name: '9. self-revoke rejected', ok: r9Blocked, detail: r9Blocked ? 'forbidden' : 'NOT REJECTED' });

    // 10 — list returns PlatformAdmin rows
    const list = await ctrl.list(mockReq(ID.uSuper));
    const allValid = (list as any[]).every((r) => ['SUPPORT','OPERATOR','SUPER'].includes(r.level));
    out.push({ name: '10. list returns PlatformAdmin rows', ok: list.length >= 3 && allValid, detail: `count=${list.length}` });

    // 11/12 — audit emission verified via DB
    const c2 = pgClient(url); await c2.connect();
    try {
      const grantRows = Number((await c2.query<{ c: string }>(
        `SELECT COUNT(*)::text AS c FROM platform_audit_logs WHERE action='PLATFORM_ADMIN_GRANTED' AND target->>'targetUserId' = ANY($1)`,
        [[ID.uTarget1, ID.uTarget2, ID.uTarget3]])).rows[0].c);
      out.push({ name: '11. grant emits PlatformAuditLog', ok: grantRows >= 3, detail: `grantRows=${grantRows}` });
      const revokeRows = Number((await c2.query<{ c: string }>(
        `SELECT COUNT(*)::text AS c FROM platform_audit_logs WHERE action='PLATFORM_ADMIN_REVOKED' AND target->>'targetUserId' = $1`,
        [ID.uTarget2])).rows[0].c);
      out.push({ name: '12. revoke emits PlatformAuditLog', ok: revokeRows >= 1, detail: `revokeRows=${revokeRows}` });
    } finally { await c2.end(); }

    // 13 — duplicate-grant deterministic
    const r13a = await ctrl.grant({ userId: ID.uTarget1, level: 'SUPPORT', reason: 'idem' } as any, mockReq(ID.uSuper));
    const r13b = await ctrl.grant({ userId: ID.uTarget1, level: 'OPERATOR', reason: 'change' } as any, mockReq(ID.uSuper));
    out.push({ name: '13. duplicate grant deterministic (IDEMPOTENT vs LEVEL_CHANGED)',
      ok: r13a.action === 'PLATFORM_ADMIN_GRANT_IDEMPOTENT' && r13b.action === 'PLATFORM_ADMIN_LEVEL_CHANGED',
      detail: `idem=${r13a.action} change=${r13b.action}` });

  } finally {
    await prisma.$disconnect();
    delete process.env.PLATFORM_ADMIN_HTTP_ENABLED;
  }

  // 14 — controller delegates only to PlatformAdminService (no direct prisma mutations)
  const ctrlSrc = await fs.readFile(path.join(BACKEND_ROOT, 'src/saas/platform-admin/platform-admin.controller.ts'), 'utf8');
  const ctrlStripped = ctrlSrc.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
  const usesService = /this\.platformAdmin\.(grant|revoke|list)/.test(ctrlStripped);
  const usesPrismaDirectly = /this\.prisma|PrismaService/.test(ctrlStripped);
  out.push({ name: '14. controller delegates only to PlatformAdminService',
    ok: usesService && !usesPrismaDirectly, detail: `usesService=${usesService} usesPrisma=${usesPrismaDirectly}` });

  // 15/16 — cross-phase wiring
  const pkg = await fs.readFile(path.join(BACKEND_ROOT, 'package.json'), 'utf8');
  out.push({ name: '15. Phase 3.11 grant/revoke harness wiring intact',
    ok: /saas:phase311-platform-admin-grant-revoke/.test(pkg), detail: 'pkg.json' });
  const sentinels = [
    ['phase2', 'pipeline-equivalence.json'], ['phase2', 'pipeline-isolation.json'],
    ['phase2', 'pipeline-mutation-isolation.json'], ['phase2', 'workflow-config-isolation.json'],
    ['phase3', 'platform-admin-grant-revoke.json'], ['phase3', 'platform-admin-cleanup-audit-log.json'],
    ['phase3', 'drop-agency-is-system.json'], ['phase3', 'platform-admin-runtime-retirement.json'],
    ['phase3', 'platform-admin-jwt-bake-check.json'], ['phase3', 'platform-admin-jwt-dual-read.json'],
    ['phase3', 'platform-admin-dual-read-guard.json'], ['phase3', 'platform-admin-backfill-harness.json'],
  ];
  const checks = await Promise.all(sentinels.map(([d, f]) => exists(path.join(BACKEND_ROOT, 'reports', 'saas', d, f))));
  out.push({ name: '16. cumulative regression chain outputs present',
    ok: checks.every(Boolean), detail: `present=${checks.filter(Boolean).length}/${sentinels.length}` });

  // Cleanup
  const cClean = pgClient(url); await cClean.connect();
  try { await teardown(cClean); } finally { await cClean.end(); }

  await fs.mkdir(PHASE3_REPORTS, { recursive: true });
  const passed = out.filter((c) => c.ok).length;
  const total = out.length;
  await fs.writeFile(path.join(PHASE3_REPORTS, 'platform-admin-controller.json'),
    JSON.stringify({ passed, total, cases: out }, null, 2));
  const md = [
    `# Phase 3.12 — PlatformAdmin controller`, ``,
    `**${passed}/${total} PASS**`, ``,
    ...out.map((c) => `- ${c.ok ? 'PASS' : 'FAIL'} — ${c.name} — ${c.detail}`), ``,
  ].join('\n');
  await fs.writeFile(path.join(PHASE3_REPORTS, 'platform-admin-controller.md'), md);
  console.log(`[platform-admin-controller] ${passed}/${total} PASS`);
  process.exit(passed === total ? 0 : 1);
}

main().catch((err) => { console.error(err); process.exit(2); });
