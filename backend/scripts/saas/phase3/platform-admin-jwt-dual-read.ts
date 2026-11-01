/**
 * Phase 3.7 — JWT dual-read stamp harness.
 *
 * Constructs a JwtStrategy with the new PlatformAdminAccessService
 * dependency, runs validate() against synthetic seed users, and
 * asserts the `agencyIsSystem` field reflects the OR of legacy
 * `Agency.isSystem` and new `PlatformAdmin` rows.
 *
 *   1.  legacy isSystem user → agencyIsSystem=true
 *   2.  PlatformAdmin-only user → agencyIsSystem=true
 *   3.  user with both signals → true
 *   4.  user with neither → false
 *   5.  PLATFORM_ADMIN_DUAL_READ_ENABLED=false → PlatformAdmin-only stamps false
 *   6.  inactive user → existing rejection preserved (UnauthorizedException)
 *   7.  JwtStrategy returns the existing field shape
 *   8.  representative downstream check using agencyIsSystem still works
 *   9.  PlatformAdminAccessService called once per validate (or documented)
 *  10.  PlatformAuditLog not written
 *  11.  Agency.isSystem unchanged after validate
 *  12.  PlatformAdmin rows unchanged after validate
 *  13.  Phase 3.6 dual-read guard wiring intact
 *  14.  Phase 3.5 backfill wiring intact
 *  15.  cumulative regression chain outputs present
 */
/* eslint-disable no-console */
import { promises as fs } from 'fs';
import path from 'path';
import { Client } from 'pg';
import { autoLoadEnv, formatDatabaseUrlMissingMessage } from './../phase1/reconciliation/lib/env';
import { PrismaService } from '../../../src/prisma/prisma.service';
import { PlatformAdminAccessService } from '../../../src/saas/platform-admin/platform-admin-access.service';
import { JwtStrategy } from '../../../src/auth/strategies/jwt.strategy';

autoLoadEnv(__filename);

// Phase 3.8 — this harness was authored under Phase 3.7 OR-semantics.
// Set the legacy fallback flag so PlatformAdminAccessService grants
// authority for legacy Agency.isSystem-only users. Phase 3.8's new
// default (PlatformAdmin only) is asserted by
// saas:phase380-platform-admin-runtime-retirement.
process.env.PLATFORM_ADMIN_LEGACY_AGENCY_FALLBACK = 'true';

const BACKEND_ROOT = path.resolve(__dirname, '..', '..', '..');
const PHASE3_REPORTS = path.resolve(BACKEND_ROOT, 'reports', 'saas', 'phase3');

const SEED = '00000000-0000-0000-0000-0000000037';
const ID = {
  sysAgency:  `${SEED}SA`,
  normAgency: `${SEED}NA`,
  uLegacy:    `${SEED}U1`,
  uNewOnly:   `${SEED}U2`,
  uBoth:      `${SEED}U3`,
  uNeither:   `${SEED}U4`,
  uInactive:  `${SEED}U5`,
};

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
  await c.query(`DELETE FROM platform_admins WHERE "userId" = ANY($1)`,
    [[ID.uLegacy, ID.uNewOnly, ID.uBoth, ID.uNeither, ID.uInactive]]);
  await c.query(`DELETE FROM users WHERE id = ANY($1)`,
    [[ID.uLegacy, ID.uNewOnly, ID.uBoth, ID.uNeither, ID.uInactive]]);
  await c.query(`DELETE FROM agencies WHERE id = ANY($1)`,
    [[ID.sysAgency, ID.normAgency]]);
}

async function seed(c: Client): Promise<void> {
  const ro = await c.query<{ id: string }>(`SELECT id FROM roles LIMIT 1`);
  const roleId = ro.rows[0].id;
  await c.query(`
    INSERT INTO agencies (id, name, country, "contactPerson", email, phone, "createdAt", "updatedAt")
    VALUES
      ($1, 'Phase370 System', 'XX', 'C', 'sys@p370.test', '0', now(), now()),
      ($2, 'Phase370 Normal', 'XX', 'C', 'nor@p370.test', '0', now(), now())
    ON CONFLICT (id) DO NOTHING
  `, [ID.sysAgency, ID.normAgency]);
  await c.query(`
    INSERT INTO users (id, email, "passwordHash", "firstName", "lastName", "roleId", "agencyId", status, "createdAt", "updatedAt")
    VALUES
      ($1, 'p370-u1@e.com', 'h', 'L','Egc',  $6, $7, 'ACTIVE',   now(), now()),
      ($2, 'p370-u2@e.com', 'h', 'N','New',  $6, $8, 'ACTIVE',   now(), now()),
      ($3, 'p370-u3@e.com', 'h', 'B','Both', $6, $7, 'ACTIVE',   now(), now()),
      ($4, 'p370-u4@e.com', 'h', 'X','None', $6, $8, 'ACTIVE',   now(), now()),
      ($5, 'p370-u5@e.com', 'h', 'I','Iact', $6, $7, 'INACTIVE', now(), now())
    ON CONFLICT (id) DO NOTHING
  `, [ID.uLegacy, ID.uNewOnly, ID.uBoth, ID.uNeither, ID.uInactive, roleId, ID.sysAgency, ID.normAgency]);
  await c.query(`
    INSERT INTO platform_admins (id, "userId", level, "grantedBy", "grantedAt")
    VALUES
      (gen_random_uuid()::text, $1, 'SUPER',    'phase370-test', now()),
      (gen_random_uuid()::text, $2, 'OPERATOR', 'phase370-test', now())
    ON CONFLICT ("userId") DO NOTHING
  `, [ID.uNewOnly, ID.uBoth]);
}

/** Wrap PlatformAdminAccessService to count invocations for case 9. */
class CountingAccess extends PlatformAdminAccessService {
  public calls = 0;
  async isPlatformAdmin(userId: string | null | undefined): Promise<boolean> {
    this.calls += 1;
    return super.isPlatformAdmin(userId);
  }
}

async function main(): Promise<void> {
  const url = getDatabaseUrl();
  const out: CaseResult[] = [];
  const c = pgClient(url); await c.connect();

  try {
    await teardown(c);
    await seed(c);
    await c.end();
  } catch (err) { await c.end().catch(() => undefined); throw err; }

  const prisma = new PrismaService();
  try {
    const counting = new CountingAccess(prisma);
    const strategy = new JwtStrategy(prisma, counting);

    // Phase 3.9 — `Agency.isSystem` column dropped; uLegacy now stamps false
    // because it has no PlatformAdmin row.
    const r1 = await strategy.validate({ sub: ID.uLegacy });
    out.push({ name: '1. legacy user (no PlatformAdmin) stamps agencyIsSystem=false (Phase 3.9 supersedes legacy)',
      ok: r1.agencyIsSystem === false, detail: `agencyIsSystem=${r1.agencyIsSystem}` });

    const r2 = await strategy.validate({ sub: ID.uNewOnly });
    out.push({ name: '2. PlatformAdmin-only user stamps agencyIsSystem=true',
      ok: r2.agencyIsSystem === true, detail: `agencyIsSystem=${r2.agencyIsSystem}` });

    const r3 = await strategy.validate({ sub: ID.uBoth });
    out.push({ name: '3. user with both signals stamps true',
      ok: r3.agencyIsSystem === true, detail: `agencyIsSystem=${r3.agencyIsSystem}` });

    const r4 = await strategy.validate({ sub: ID.uNeither });
    out.push({ name: '4. user with neither signal stamps false',
      ok: r4.agencyIsSystem === false, detail: `agencyIsSystem=${r4.agencyIsSystem}` });

    // 5 — Phase 3.9: PLATFORM_ADMIN_DUAL_READ_ENABLED flag inert (Agency.isSystem
    // column dropped). Service always answers PlatformAdmin-only.
    process.env.PLATFORM_ADMIN_DUAL_READ_ENABLED = 'false';
    const legacyOnlyAccess = new PlatformAdminAccessService(prisma);
    const legacyStrategy = new JwtStrategy(prisma, legacyOnlyAccess);
    process.env.PLATFORM_ADMIN_DUAL_READ_ENABLED = 'true';
    const r5 = await legacyStrategy.validate({ sub: ID.uNewOnly });
    const r5b = await legacyStrategy.validate({ sub: ID.uLegacy });
    out.push({ name: '5. PLATFORM_ADMIN_DUAL_READ_ENABLED flag inert under Phase 3.9',
      ok: r5.agencyIsSystem === true && r5b.agencyIsSystem === false,
      detail: `uNewOnly=${r5.agencyIsSystem} uLegacy=${r5b.agencyIsSystem}` });

    // 6 — inactive user: existing UnauthorizedException preserved
    let inactiveBlocked = false;
    try { await strategy.validate({ sub: ID.uInactive }); }
    catch (err: any) {
      inactiveBlocked = err?.response?.code === 'AUTH.ACCOUNT_STATUS' || /inactive|status/i.test(err?.message ?? '');
    }
    out.push({ name: '6. inactive user → existing UnauthorizedException preserved',
      ok: inactiveBlocked, detail: inactiveBlocked ? 'rejected' : 'NOT REJECTED' });

    // 7 — output shape preserved (id, email, firstName, lastName, role, roleId, agencyId, agencyIsSystem)
    const expectedKeys = ['id', 'email', 'firstName', 'lastName', 'role', 'roleId', 'agencyId', 'agencyIsSystem'].sort();
    const actualKeys = Object.keys(r1).sort();
    out.push({ name: '7. JwtStrategy returns the existing field shape',
      ok: JSON.stringify(actualKeys) === JSON.stringify(expectedKeys),
      detail: `keys=${actualKeys.join(',')}` });

    // 8 — downstream check still uses agencyIsSystem; Phase 3.9 reverses
    // the legacy expectation (uLegacy is now external because it has no
    // PlatformAdmin row).
    const isExternalActor = (actor: any) => !!actor && !!actor.agencyId && actor.agencyIsSystem !== true;
    out.push({ name: '8. downstream check (isExternalActor) consumes agencyIsSystem unchanged',
      ok: isExternalActor(r1) === true    // uLegacy: external (no PlatformAdmin)
       && isExternalActor(r2) === false   // uNewOnly: not external (has PlatformAdmin)
       && isExternalActor(r4) === true,   // uNeither: external
      detail: `legacy.ext=${isExternalActor(r1)} newOnly.ext=${isExternalActor(r2)} neither.ext=${isExternalActor(r4)}` });

    // 9 — PlatformAdminAccessService called exactly once per validate
    out.push({ name: '9. PlatformAdminAccessService called exactly once per validate',
      ok: counting.calls === 4, detail: `calls=${counting.calls} (4 successful validates)` });

    // 10/11/12 — no mutation occurred
    const c2 = pgClient(url); await c2.connect();
    try {
      const auditTableExists = (await c2.query<{ ok: boolean }>(
        `SELECT EXISTS (SELECT 1 FROM information_schema.tables
                         WHERE table_name = 'platform_audit_log') AS ok`)).rows[0].ok;
      out.push({ name: '10. PlatformAuditLog write is not attempted (table absent, no error raised)',
        ok: !auditTableExists, detail: `tableExists=${auditTableExists}` });

      const sysRow = (await c2.query<{ id: string }>(
        `SELECT id FROM agencies WHERE id = $1`, [ID.sysAgency])).rows[0];
      out.push({ name: '11. Agency row unchanged after validate (Phase 3.9 — column dropped)',
        ok: sysRow?.id === ID.sysAgency, detail: `sysAgency=${sysRow?.id ?? 'missing'}` });

      const paRow = (await c2.query<{ level: string; grantedBy: string }>(
        `SELECT level, "grantedBy" FROM platform_admins WHERE "userId" = $1`, [ID.uNewOnly])).rows[0];
      out.push({ name: '12. PlatformAdmin rows unchanged after validate',
        ok: paRow?.level === 'SUPER' && paRow?.grantedBy === 'phase370-test',
        detail: `level=${paRow?.level} grantedBy=${paRow?.grantedBy}` });
    } finally { await c2.end(); }

  } finally {
    await prisma.$disconnect();
  }

  // 13/14/15 — cross-phase wiring
  const pkg = await fs.readFile(path.join(BACKEND_ROOT, 'package.json'), 'utf8');
  out.push({ name: '13. Phase 3.6 dual-read guard wiring intact',
    ok: /saas:phase360-platform-admin-dual-read-guard/.test(pkg), detail: 'pkg.json' });
  out.push({ name: '14. Phase 3.5 backfill wiring intact',
    ok: /saas:phase350-platform-admin-backfill-harness/.test(pkg), detail: 'pkg.json' });
  const sentinels = [
    ['phase2', 'pipeline-equivalence.json'], ['phase2', 'pipeline-isolation.json'],
    ['phase2', 'pipeline-mutation-isolation.json'], ['phase2', 'workflow-config-isolation.json'],
    ['phase3', 'product-migration-readiness.json'], ['phase3', 'phase31-readiness-check.json'],
    ['phase3', 'duplicate-cleanup-harness.json'], ['phase3', 'per-tenant-unique-constraints.json'],
    ['phase3', 'drop-employee-global-uniques.json'], ['phase3', 'platform-admin-backfill-harness.json'],
    ['phase3', 'platform-admin-dual-read-guard.json'],
  ];
  const checks = await Promise.all(sentinels.map(([d, f]) => exists(path.join(BACKEND_ROOT, 'reports', 'saas', d, f))));
  out.push({ name: '15. cumulative regression chain outputs present',
    ok: checks.every(Boolean), detail: `present=${checks.filter(Boolean).length}/${sentinels.length}` });

  // Cleanup
  const cClean = pgClient(url); await cClean.connect();
  try { await teardown(cClean); } finally { await cClean.end(); }

  await fs.mkdir(PHASE3_REPORTS, { recursive: true });
  const passed = out.filter((c) => c.ok).length;
  const total = out.length;
  await fs.writeFile(path.join(PHASE3_REPORTS, 'platform-admin-jwt-dual-read.json'),
    JSON.stringify({ passed, total, cases: out }, null, 2));
  const md = [
    `# Phase 3.7 — JWT dual-read stamp`, ``,
    `**${passed}/${total} PASS**`, ``,
    ...out.map((c) => `- ${c.ok ? 'PASS' : 'FAIL'} — ${c.name} — ${c.detail}`), ``,
  ].join('\n');
  await fs.writeFile(path.join(PHASE3_REPORTS, 'platform-admin-jwt-dual-read.md'), md);
  console.log(`[platform-admin-jwt-dual-read] ${passed}/${total} PASS`);
  process.exit(passed === total ? 0 : 1);
}

main().catch((err) => { console.error(err); process.exit(2); });
