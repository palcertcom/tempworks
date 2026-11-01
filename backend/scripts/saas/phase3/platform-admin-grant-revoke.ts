/**
 * Phase 3.11 — PlatformAdmin grant/revoke service harness.
 *
 *  1.  SUPER actor can grant SUPPORT to active user
 *  2.  SUPER actor can grant OPERATOR to active user
 *  3.  SUPER actor can grant SUPER to active user
 *  4.  non-SUPER PlatformAdmin (OPERATOR / SUPPORT) cannot grant
 *  5.  non-PlatformAdmin cannot grant
 *  6.  cannot grant missing user
 *  7.  cannot grant inactive/deleted user
 *  8.  duplicate-grant behavior is deterministic and documented:
 *      same level → IDEMPOTENT; different level → LEVEL_CHANGED
 *  9.  grant emits PlatformAuditLog (action + reason + target)
 * 10.  SUPER actor can revoke target PlatformAdmin
 * 11.  non-SUPER cannot revoke
 * 12.  non-PlatformAdmin cannot revoke
 * 13.  cannot self-revoke
 * 14.  revoke emits PlatformAuditLog
 * 15.  list returns only PlatformAdmin rows
 * 16.  PlatformAuditLog rows carry actorId/action/reason/target
 * 17.  PlatformAdminAccessService treats granted user as platform admin
 * 18.  PlatformAdminAccessService treats revoked user as NOT platform admin
 * 19.  JwtStrategy stamp reflects grant / revoke at validate() time
 * 20.  Phase 3.10 cleanup harness wiring intact
 * 21.  Phase 3.9 drop-agency-is-system wiring intact
 * 22.  cumulative regression chain outputs present
 */
/* eslint-disable no-console */
import { promises as fs } from 'fs';
import path from 'path';
import { Client } from 'pg';
import { autoLoadEnv, formatDatabaseUrlMissingMessage } from './../phase1/reconciliation/lib/env';
import { PrismaService } from '../../../src/prisma/prisma.service';
import { PlatformAdminAccessService } from '../../../src/saas/platform-admin/platform-admin-access.service';
import { PlatformAdminService } from '../../../src/saas/platform-admin/platform-admin.service';
import { JwtStrategy } from '../../../src/auth/strategies/jwt.strategy';

autoLoadEnv(__filename);

const BACKEND_ROOT = path.resolve(__dirname, '..', '..', '..');
const PHASE3_REPORTS = path.resolve(BACKEND_ROOT, 'reports', 'saas', 'phase3');

const SEED = '00000000-0000-0000-0000-0000003110';
const ID = {
  agency:   `${SEED}AA`,
  uSuper:   `${SEED}U1`, // SUPER actor
  uOp:      `${SEED}U2`, // OPERATOR (non-SUPER PlatformAdmin)
  uNoneA:   `${SEED}U3`, // non-PlatformAdmin actor
  uTarget1: `${SEED}T1`, // grant target (active, no PA)
  uTarget2: `${SEED}T2`, // grant target (active, no PA) — for level-change
  uTarget3: `${SEED}T3`, // grant target (active, no PA)
  uDeleted: `${SEED}D1`, // deleted user (target)
  uMissing: `${SEED}MX`, // never inserted
};
const ALL_USERS = [ID.uSuper, ID.uOp, ID.uNoneA, ID.uTarget1, ID.uTarget2, ID.uTarget3, ID.uDeleted];

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
    VALUES ($1, 'P311', 'XX', 'C', 'a@p311.test', '0', now(), now())
    ON CONFLICT (id) DO NOTHING
  `, [ID.agency]);
  await c.query(`
    INSERT INTO users (id, email, "passwordHash", "firstName", "lastName", "roleId", "agencyId", status, "createdAt", "updatedAt")
    VALUES
      ($1, 'p311-super@e.com', 'h','S','U',$8,$9,'ACTIVE', now(), now()),
      ($2, 'p311-op@e.com',    'h','O','P',$8,$9,'ACTIVE', now(), now()),
      ($3, 'p311-none@e.com',  'h','N','N',$8,$9,'ACTIVE', now(), now()),
      ($4, 'p311-t1@e.com',    'h','T','1',$8,$9,'ACTIVE', now(), now()),
      ($5, 'p311-t2@e.com',    'h','T','2',$8,$9,'ACTIVE', now(), now()),
      ($6, 'p311-t3@e.com',    'h','T','3',$8,$9,'ACTIVE', now(), now()),
      ($7, 'p311-del@e.com',   'h','D','L',$8,$9,'ACTIVE', now(), now())
    ON CONFLICT (id) DO NOTHING
  `, [ID.uSuper, ID.uOp, ID.uNoneA, ID.uTarget1, ID.uTarget2, ID.uTarget3, ID.uDeleted, roleId, ID.agency]);
  await c.query(`UPDATE users SET "deletedAt" = now() WHERE id = $1`, [ID.uDeleted]);
  await c.query(`
    INSERT INTO platform_admins (id, "userId", level, "grantedBy", "grantedAt")
    VALUES (gen_random_uuid()::text, $1, 'SUPER',    'phase311-seed', now()),
           (gen_random_uuid()::text, $2, 'OPERATOR', 'phase311-seed', now())
    ON CONFLICT ("userId") DO NOTHING
  `, [ID.uSuper, ID.uOp]);
}

async function main(): Promise<void> {
  const url = getDatabaseUrl();
  const out: CaseResult[] = [];

  // Make sure platform_audit_logs table exists for this harness.
  const setup = pgClient(url); await setup.connect();
  try {
    await setup.query(`CREATE TABLE IF NOT EXISTS "platform_audit_logs" (
      "id" BIGSERIAL PRIMARY KEY,
      "actorId" text NOT NULL,
      "tenantId" text,
      "action" text NOT NULL,
      "reason" text NOT NULL,
      "target" jsonb,
      "ip" text,
      "userAgent" text,
      "createdAt" timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`);
    await setup.query(`CREATE INDEX IF NOT EXISTS "platform_audit_logs_actorId_createdAt_idx"
      ON "platform_audit_logs" ("actorId", "createdAt")`);
    await setup.query(`CREATE INDEX IF NOT EXISTS "platform_audit_logs_tenantId_createdAt_idx"
      ON "platform_audit_logs" ("tenantId", "createdAt")`);
    await teardown(setup);
    await seed(setup);
  } finally { await setup.end(); }

  const prisma = new PrismaService();
  try {
    const svc = new PlatformAdminService(prisma);
    const access = new PlatformAdminAccessService(prisma);

    // 1
    const r1 = await svc.grant({ actorUserId: ID.uSuper, targetUserId: ID.uTarget1, level: 'SUPPORT', reason: 't1' });
    out.push({ name: '1. SUPER actor can grant SUPPORT to active user',
      ok: r1.action === 'PLATFORM_ADMIN_GRANTED' && r1.level === 'SUPPORT',
      detail: `action=${r1.action} level=${r1.level}` });

    // 2
    const r2 = await svc.grant({ actorUserId: ID.uSuper, targetUserId: ID.uTarget2, level: 'OPERATOR', reason: 't2' });
    out.push({ name: '2. SUPER actor can grant OPERATOR to active user',
      ok: r2.action === 'PLATFORM_ADMIN_GRANTED' && r2.level === 'OPERATOR',
      detail: `action=${r2.action} level=${r2.level}` });

    // 3
    const r3 = await svc.grant({ actorUserId: ID.uSuper, targetUserId: ID.uTarget3, level: 'SUPER', reason: 't3' });
    out.push({ name: '3. SUPER actor can grant SUPER to active user',
      ok: r3.action === 'PLATFORM_ADMIN_GRANTED' && r3.level === 'SUPER',
      detail: `action=${r3.action} level=${r3.level}` });

    // 4 — non-SUPER PlatformAdmin (OPERATOR) cannot grant
    let r4Blocked = false;
    try { await svc.grant({ actorUserId: ID.uOp, targetUserId: ID.uTarget1, level: 'SUPPORT', reason: 'op-attempt' }); }
    catch (err: any) { r4Blocked = /ACTOR_NOT_SUPER/.test(JSON.stringify(err?.response ?? {})); }
    out.push({ name: '4. non-SUPER PlatformAdmin cannot grant',
      ok: r4Blocked, detail: r4Blocked ? 'forbidden' : 'NOT REJECTED' });

    // 5 — non-PlatformAdmin cannot grant
    let r5Blocked = false;
    try { await svc.grant({ actorUserId: ID.uNoneA, targetUserId: ID.uTarget1, level: 'SUPPORT', reason: 'none-attempt' }); }
    catch (err: any) { r5Blocked = /NOT_PLATFORM_ADMIN/.test(JSON.stringify(err?.response ?? {})); }
    out.push({ name: '5. non-PlatformAdmin cannot grant',
      ok: r5Blocked, detail: r5Blocked ? 'forbidden' : 'NOT REJECTED' });

    // 6 — cannot grant missing user
    let r6Blocked = false;
    try { await svc.grant({ actorUserId: ID.uSuper, targetUserId: ID.uMissing, level: 'SUPPORT', reason: 'missing' }); }
    catch (err: any) { r6Blocked = /TARGET_NOT_ACTIVE/.test(JSON.stringify(err?.response ?? {})); }
    out.push({ name: '6. cannot grant missing user',
      ok: r6Blocked, detail: r6Blocked ? 'not-found' : 'NOT REJECTED' });

    // 7 — cannot grant deleted user
    let r7Blocked = false;
    try { await svc.grant({ actorUserId: ID.uSuper, targetUserId: ID.uDeleted, level: 'SUPPORT', reason: 'deleted' }); }
    catch (err: any) { r7Blocked = /TARGET_NOT_ACTIVE/.test(JSON.stringify(err?.response ?? {})); }
    out.push({ name: '7. cannot grant inactive/deleted user',
      ok: r7Blocked, detail: r7Blocked ? 'rejected' : 'NOT REJECTED' });

    // 8 — duplicate-grant deterministic
    const r8a = await svc.grant({ actorUserId: ID.uSuper, targetUserId: ID.uTarget1, level: 'SUPPORT', reason: 'idem' });
    const r8b = await svc.grant({ actorUserId: ID.uSuper, targetUserId: ID.uTarget1, level: 'OPERATOR', reason: 'lvl-change' });
    out.push({ name: '8. duplicate-grant deterministic (IDEMPOTENT same-level, LEVEL_CHANGED different-level)',
      ok: r8a.action === 'PLATFORM_ADMIN_GRANT_IDEMPOTENT' && r8b.action === 'PLATFORM_ADMIN_LEVEL_CHANGED',
      detail: `same=${r8a.action} diff=${r8b.action}` });

    // 9 — grant emitted audit row
    const c2 = pgClient(url); await c2.connect();
    let auditCountForT1 = 0;
    try {
      const r = await c2.query<{ c: string }>(
        `SELECT COUNT(*)::text AS c FROM platform_audit_logs
          WHERE action IN ('PLATFORM_ADMIN_GRANTED','PLATFORM_ADMIN_GRANT_IDEMPOTENT','PLATFORM_ADMIN_LEVEL_CHANGED')
            AND target->>'targetUserId' = $1`, [ID.uTarget1]);
      auditCountForT1 = Number(r.rows[0].c);
    } finally { await c2.end(); }
    out.push({ name: '9. grant emits PlatformAuditLog',
      ok: auditCountForT1 >= 3, detail: `t1.auditRows=${auditCountForT1}` });

    // 10 — SUPER actor can revoke
    const r10 = await svc.revoke({ actorUserId: ID.uSuper, targetUserId: ID.uTarget2, reason: 'revoke-t2' });
    out.push({ name: '10. SUPER actor can revoke target PlatformAdmin',
      ok: r10.action === 'PLATFORM_ADMIN_REVOKED', detail: `action=${r10.action}` });

    // 11 — non-SUPER cannot revoke
    let r11Blocked = false;
    try { await svc.revoke({ actorUserId: ID.uOp, targetUserId: ID.uTarget3, reason: 'op-revoke' }); }
    catch (err: any) { r11Blocked = /ACTOR_NOT_SUPER/.test(JSON.stringify(err?.response ?? {})); }
    out.push({ name: '11. non-SUPER cannot revoke', ok: r11Blocked, detail: r11Blocked ? 'forbidden' : 'NOT REJECTED' });

    // 12 — non-PlatformAdmin cannot revoke
    let r12Blocked = false;
    try { await svc.revoke({ actorUserId: ID.uNoneA, targetUserId: ID.uTarget3, reason: 'none-revoke' }); }
    catch (err: any) { r12Blocked = /NOT_PLATFORM_ADMIN/.test(JSON.stringify(err?.response ?? {})); }
    out.push({ name: '12. non-PlatformAdmin cannot revoke', ok: r12Blocked, detail: r12Blocked ? 'forbidden' : 'NOT REJECTED' });

    // 13 — cannot self-revoke
    let r13Blocked = false;
    try { await svc.revoke({ actorUserId: ID.uSuper, targetUserId: ID.uSuper, reason: 'self' }); }
    catch (err: any) { r13Blocked = /SELF_REVOKE_FORBIDDEN/.test(JSON.stringify(err?.response ?? {})); }
    out.push({ name: '13. cannot self-revoke', ok: r13Blocked, detail: r13Blocked ? 'forbidden' : 'NOT REJECTED' });

    // 14 — revoke emitted audit row
    const c3 = pgClient(url); await c3.connect();
    let revokeAuditCount = 0;
    try {
      const r = await c3.query<{ c: string }>(
        `SELECT COUNT(*)::text AS c FROM platform_audit_logs
          WHERE action = 'PLATFORM_ADMIN_REVOKED' AND target->>'targetUserId' = $1`, [ID.uTarget2]);
      revokeAuditCount = Number(r.rows[0].c);
    } finally { await c3.end(); }
    out.push({ name: '14. revoke emits PlatformAuditLog', ok: revokeAuditCount >= 1, detail: `t2.revokeRows=${revokeAuditCount}` });

    // 15 — list returns only PlatformAdmin rows
    const rows = await svc.list(ID.uSuper);
    const onlyValidLevels = (rows as any[]).every((r) => ['SUPPORT','OPERATOR','SUPER'].includes(r.level));
    out.push({ name: '15. list returns only PlatformAdmin rows',
      ok: rows.length >= 2 && onlyValidLevels, detail: `count=${rows.length}` });

    // 16 — audit row shape: actorId, action, reason, target present
    const c4 = pgClient(url); await c4.connect();
    let shapeOk = false;
    try {
      const r = await c4.query<{ actorId: string; action: string; reason: string; target: any }>(
        `SELECT "actorId", action, reason, target FROM platform_audit_logs
          WHERE action = 'PLATFORM_ADMIN_GRANTED' AND target->>'targetUserId' = $1 LIMIT 1`, [ID.uTarget1]);
      const row = r.rows[0];
      shapeOk = !!row && row.actorId === ID.uSuper && row.action === 'PLATFORM_ADMIN_GRANTED'
             && row.reason === 't1' && row.target?.targetUserId === ID.uTarget1
             && row.target?.level === 'SUPPORT';
    } finally { await c4.end(); }
    out.push({ name: '16. PlatformAuditLog rows carry actorId/action/reason/target',
      ok: shapeOk, detail: shapeOk ? 'shape ok' : 'shape mismatch' });

    // 17 — granted user treated as platform admin
    const t3IsPa = await access.isPlatformAdmin(ID.uTarget3);
    out.push({ name: '17. PlatformAdminAccessService treats granted user as platform admin',
      ok: t3IsPa === true, detail: `uTarget3.isPa=${t3IsPa}` });

    // 18 — revoked user no longer platform admin (uTarget2 was revoked in case 10)
    const t2IsPa = await access.isPlatformAdmin(ID.uTarget2);
    out.push({ name: '18. PlatformAdminAccessService treats revoked user as NOT platform admin',
      ok: t2IsPa === false, detail: `uTarget2.isPa=${t2IsPa}` });

    // 19 — JWT stamp reflects grant / revoke
    const strategy = new JwtStrategy(prisma, access);
    const jwtT3 = await strategy.validate({ sub: ID.uTarget3 });
    const jwtT2 = await strategy.validate({ sub: ID.uTarget2 });
    out.push({ name: '19. JWT stamp reflects grant/revoke at validate() time',
      ok: jwtT3.agencyIsSystem === true && jwtT2.agencyIsSystem === false,
      detail: `t3=${jwtT3.agencyIsSystem} t2=${jwtT2.agencyIsSystem}` });

  } finally {
    await prisma.$disconnect();
  }

  // Cross-phase wiring
  const pkg = await fs.readFile(path.join(BACKEND_ROOT, 'package.json'), 'utf8');
  out.push({ name: '20. Phase 3.10 cleanup harness wiring intact',
    ok: /saas:phase310-platform-admin-cleanup-audit-log/.test(pkg), detail: 'pkg.json' });
  out.push({ name: '21. Phase 3.9 drop-agency-is-system wiring intact',
    ok: /saas:phase390-drop-agency-is-system/.test(pkg), detail: 'pkg.json' });

  const sentinels = [
    ['phase2', 'pipeline-equivalence.json'], ['phase2', 'pipeline-isolation.json'],
    ['phase2', 'pipeline-mutation-isolation.json'], ['phase2', 'workflow-config-isolation.json'],
    ['phase3', 'product-migration-readiness.json'], ['phase3', 'phase31-readiness-check.json'],
    ['phase3', 'duplicate-cleanup-harness.json'], ['phase3', 'per-tenant-unique-constraints.json'],
    ['phase3', 'drop-employee-global-uniques.json'], ['phase3', 'platform-admin-backfill-harness.json'],
    ['phase3', 'platform-admin-dual-read-guard.json'], ['phase3', 'platform-admin-jwt-dual-read.json'],
    ['phase3', 'platform-admin-jwt-bake-check.json'], ['phase3', 'platform-admin-signal-agreement-report.json'],
    ['phase3', 'platform-admin-runtime-retirement.json'], ['phase3', 'drop-agency-is-system.json'],
    ['phase3', 'platform-admin-cleanup-audit-log.json'],
  ];
  const checks = await Promise.all(sentinels.map(([d, f]) => exists(path.join(BACKEND_ROOT, 'reports', 'saas', d, f))));
  out.push({ name: '22. cumulative regression chain outputs present',
    ok: checks.every(Boolean), detail: `present=${checks.filter(Boolean).length}/${sentinels.length}` });

  // Cleanup
  const cClean = pgClient(url); await cClean.connect();
  try { await teardown(cClean); } finally { await cClean.end(); }

  await fs.mkdir(PHASE3_REPORTS, { recursive: true });
  const passed = out.filter((c) => c.ok).length;
  const total = out.length;
  await fs.writeFile(path.join(PHASE3_REPORTS, 'platform-admin-grant-revoke.json'),
    JSON.stringify({ passed, total, cases: out }, null, 2));
  const md = [
    `# Phase 3.11 — PlatformAdmin grant/revoke service`, ``,
    `**${passed}/${total} PASS**`, ``,
    ...out.map((c) => `- ${c.ok ? 'PASS' : 'FAIL'} — ${c.name} — ${c.detail}`), ``,
  ].join('\n');
  await fs.writeFile(path.join(PHASE3_REPORTS, 'platform-admin-grant-revoke.md'), md);
  console.log(`[platform-admin-grant-revoke] ${passed}/${total} PASS`);
  process.exit(passed === total ? 0 : 1);
}

main().catch((err) => { console.error(err); process.exit(2); });
