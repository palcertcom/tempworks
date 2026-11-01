/**
 * Phase 3.8 — Runtime retirement of Agency.isSystem.
 *
 * Asserts the new default semantics:
 *   - PlatformAdmin row is the SOLE source of platform-admin authority.
 *   - Agency.isSystem is read only when
 *     PLATFORM_ADMIN_LEGACY_AGENCY_FALLBACK=true.
 *
 *   1.  PlatformAdmin user stamps agencyIsSystem=true
 *   2.  legacy Agency.isSystem-only user stamps false (default)
 *   3.  legacy Agency.isSystem-only user stamps true with fallback=true
 *   4.  user with neither signal stamps false
 *   5.  deleted/inactive PlatformAdmin user stamps false
 *   6.  JwtStrategy output shape unchanged
 *   7.  JwtStrategy source does not directly read agency.isSystem
 *   8.  PlatformAdminAccessService source reads Agency.isSystem ONLY
 *       inside fallback / pre-3.6 branches (guarded by flag)
 *   9.  runtime inventory contains no direct Agency.isSystem authorization
 *       dependency outside the documented allow-list
 *  10.  Agency.isSystem column still exists in Prisma schema
 *  11.  PlatformAuditLog write not attempted
 *  12.  Phase 3.7B bake check wiring intact
 *  13.  Phase 3.7 JWT dual-read harness wiring intact
 *  14.  Phase 3.6 dual-read guard harness wiring intact
 *  15.  Phase 3.5 backfill harness wiring intact
 *  16.  cumulative regression chain outputs present
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

// Ensure default semantics for this harness — no fallback, no pre-3.6
// emulation. These are the production-target settings.
delete process.env.PLATFORM_ADMIN_LEGACY_AGENCY_FALLBACK;
delete process.env.PLATFORM_ADMIN_DUAL_READ_ENABLED;

const BACKEND_ROOT = path.resolve(__dirname, '..', '..', '..');
const SRC_DIR = path.resolve(BACKEND_ROOT, 'src');
const PHASE3_REPORTS = path.resolve(BACKEND_ROOT, 'reports', 'saas', 'phase3');
const SCHEMA_PATH = path.resolve(BACKEND_ROOT, 'prisma', 'schema.prisma');

const SEED = '00000000-0000-0000-0000-0000000038';
const ID = {
  sysAgency:  `${SEED}SA`,
  normAgency: `${SEED}NA`,
  uLegacy:    `${SEED}U1`,  // isSystem agency, no PlatformAdmin
  uNewOnly:   `${SEED}U2`,  // non-system agency, has PlatformAdmin
  uNeither:   `${SEED}U3`,  // non-system agency, no PlatformAdmin
  uPaDeleted: `${SEED}U4`,  // has PlatformAdmin but user is deleted
};
const ALL_USERS = [ID.uLegacy, ID.uNewOnly, ID.uNeither, ID.uPaDeleted];

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
  await c.query(`DELETE FROM platform_admins WHERE "userId" = ANY($1)`, [ALL_USERS]);
  await c.query(`DELETE FROM users WHERE id = ANY($1)`, [ALL_USERS]);
  await c.query(`DELETE FROM agencies WHERE id = ANY($1)`, [[ID.sysAgency, ID.normAgency]]);
}

async function seed(c: Client): Promise<void> {
  const ro = await c.query<{ id: string }>(`SELECT id FROM roles LIMIT 1`);
  const roleId = ro.rows[0].id;
  await c.query(`
    INSERT INTO agencies (id, name, country, "contactPerson", email, phone, "createdAt", "updatedAt")
    VALUES ($1, 'P380 Sys', 'XX', 'C', 's@p380.test', '0', now(), now()),
           ($2, 'P380 Norm','XX', 'C', 'n@p380.test', '0', now(), now())
    ON CONFLICT (id) DO NOTHING
  `, [ID.sysAgency, ID.normAgency]);
  await c.query(`
    INSERT INTO users (id, email, "passwordHash", "firstName", "lastName", "roleId", "agencyId", status, "createdAt", "updatedAt")
    VALUES
      ($1, 'p380-u1@e.com', 'h', 'L','Egc', $5, $6, 'ACTIVE', now(), now()),
      ($2, 'p380-u2@e.com', 'h', 'N','New', $5, $7, 'ACTIVE', now(), now()),
      ($3, 'p380-u3@e.com', 'h', 'X','Non', $5, $7, 'ACTIVE', now(), now()),
      ($4, 'p380-u4@e.com', 'h', 'D','Del', $5, $7, 'ACTIVE', now(), now())
    ON CONFLICT (id) DO NOTHING
  `, [ID.uLegacy, ID.uNewOnly, ID.uNeither, ID.uPaDeleted, roleId, ID.sysAgency, ID.normAgency]);
  await c.query(`UPDATE users SET "deletedAt" = now() WHERE id = $1`, [ID.uPaDeleted]);
  await c.query(`
    INSERT INTO platform_admins (id, "userId", level, "grantedBy", "grantedAt")
    VALUES (gen_random_uuid()::text, $1, 'OPERATOR', 'phase380-test', now()),
           (gen_random_uuid()::text, $2, 'SUPER',    'phase380-test', now())
    ON CONFLICT ("userId") DO NOTHING
  `, [ID.uNewOnly, ID.uPaDeleted]);
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
    // Default (no flags): PlatformAdmin only.
    const defaultAccess = new PlatformAdminAccessService(prisma);
    const defaultStrategy = new JwtStrategy(prisma, defaultAccess);

    const r1 = await defaultStrategy.validate({ sub: ID.uNewOnly });
    out.push({ name: '1. PlatformAdmin user stamps agencyIsSystem=true',
      ok: r1.agencyIsSystem === true, detail: `agencyIsSystem=${r1.agencyIsSystem}` });

    const r2 = await defaultStrategy.validate({ sub: ID.uLegacy });
    out.push({ name: '2. legacy Agency.isSystem-only user stamps false (default)',
      ok: r2.agencyIsSystem === false, detail: `agencyIsSystem=${r2.agencyIsSystem}` });

    // 3 — Phase 3.9: fallback flag is INERT (Agency.isSystem column dropped).
    // Setting it has no effect; legacy-only user still stamps false.
    process.env.PLATFORM_ADMIN_LEGACY_AGENCY_FALLBACK = 'true';
    const fallbackAccess = new PlatformAdminAccessService(prisma);
    const fallbackStrategy = new JwtStrategy(prisma, fallbackAccess);
    delete process.env.PLATFORM_ADMIN_LEGACY_AGENCY_FALLBACK;
    const r3 = await fallbackStrategy.validate({ sub: ID.uLegacy });
    out.push({ name: '3. PLATFORM_ADMIN_LEGACY_AGENCY_FALLBACK is inert under Phase 3.9 (column dropped)',
      ok: r3.agencyIsSystem === false, detail: `agencyIsSystem=${r3.agencyIsSystem}` });

    const r4 = await defaultStrategy.validate({ sub: ID.uNeither });
    out.push({ name: '4. user with neither signal stamps false',
      ok: r4.agencyIsSystem === false, detail: `agencyIsSystem=${r4.agencyIsSystem}` });

    // 5 — deleted PlatformAdmin user. Strategy throws AUTH.USER_NOT_FOUND
    // (deletedAt rejection). PlatformAdminAccessService.isPlatformAdmin
    // directly returns false. Test the service result rather than the
    // strategy throw to attribute the failure cleanly.
    const r5 = await defaultAccess.isPlatformAdmin(ID.uPaDeleted);
    out.push({ name: '5. deleted/inactive PlatformAdmin user stamps false',
      ok: r5 === false, detail: `result=${r5}` });

    // 6 — output shape unchanged
    const expectedKeys = ['agencyId','agencyIsSystem','email','firstName','id','lastName','role','roleId'];
    const actualKeys = Object.keys(r1).sort();
    out.push({ name: '6. JwtStrategy output shape unchanged',
      ok: JSON.stringify(actualKeys) === JSON.stringify(expectedKeys),
      detail: `keys=${actualKeys.join(',')}` });
  } finally {
    await prisma.$disconnect();
  }

  // 7 — JwtStrategy source: no direct user.agency.isSystem authorization read
  const jwtSrc = await fs.readFile(path.join(SRC_DIR, 'auth', 'strategies', 'jwt.strategy.ts'), 'utf8');
  const jwtSrcStripped = jwtSrc.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
  // Allowed: the select clause `agency: { select: { isSystem: true } }`
  // and the unused-field cleanup (still selected for future use). Forbidden:
  // any expression like `user.agency?.isSystem` outside comments.
  const jwtUsesAgencyIsSystemDirectly =
    /user\.agency\??\.isSystem/.test(jwtSrcStripped) || /agency\.isSystem\s*===/.test(jwtSrcStripped);
  out.push({ name: '7. JwtStrategy source does not directly read agency.isSystem',
    ok: !jwtUsesAgencyIsSystemDirectly,
    detail: jwtUsesAgencyIsSystemDirectly ? 'direct read found' : 'no direct read' });

  // 8 — Phase 3.9: PlatformAdminAccessService source must contain NO
  // `agency.isSystem` reads at all (column dropped). Doc comments are
  // stripped before the check.
  const svcSrcRaw = await fs.readFile(path.join(SRC_DIR, 'saas', 'platform-admin', 'platform-admin-access.service.ts'), 'utf8');
  const svcSrcStripped = svcSrcRaw.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
  const agencyReads = svcSrcStripped.match(/agency\??\.isSystem/g) ?? [];
  out.push({ name: '8. PlatformAdminAccessService no longer reads Agency.isSystem (Phase 3.9 column removed)',
    ok: agencyReads.length === 0,
    detail: `agencyReads=${agencyReads.length}` });

  // 9 — runtime inventory: walk src/ and find every non-comment, non-string
  // reference to `agency.isSystem`. Allowed callers:
  //   - prisma `select: { ... isSystem: true ... }` clauses
  //   - the access service (already covered by case 8)
  //   - other src/saas/platform-admin/ files
  //   - src/agencies/agencies.service.ts and its DTO/module (this is the
  //     CRUD surface for managing the field itself, not authorization)
  //   - any line carrying a phase380-agency-is-system-fallback tag
  const allowDirs = [
    'src/saas/platform-admin/',
    'src/agencies/',         // CRUD surface that manages the field itself
    'src/auth/strategies/',  // JwtStrategy keeps the select clause for compat
    'src/auth/auth.service', // login response payload (presentation, not auth)
  ];
  const violations: Array<{ file: string; line: number; text: string }> = [];
  const stack: string[] = [SRC_DIR];
  while (stack.length) {
    const dir = stack.pop()!;
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) { stack.push(full); continue; }
      if (!e.isFile() || !e.name.endsWith('.ts')) continue;
      const rel = path.relative(BACKEND_ROOT, full);
      if (allowDirs.some((p) => rel.startsWith(p))) continue;
      const raw = await fs.readFile(full, 'utf8');
      const lines = raw.split('\n');
      for (let i = 0; i < lines.length; i++) {
        const ln = lines[i];
        if (/^\s*(\/\/|\*)/.test(ln)) continue;
        // Look for read patterns that imply authorization:
        // - `actor.agencyIsSystem` is OK (the derived field, not the column)
        // - `agency.isSystem` (column read) is suspect outside allowed dirs
        // - `select: { isSystem: ... }` inside a non-allowed file is suspect
        if (/agency\??\.isSystem/.test(ln) && !/phase380-agency-is-system-fallback/.test(ln)) {
          violations.push({ file: rel, line: i + 1, text: ln.trim().slice(0, 200) });
        }
      }
    }
  }
  out.push({ name: '9. runtime inventory: no direct Agency.isSystem authorization dependency outside allow-list',
    ok: violations.length === 0,
    detail: violations.length === 0 ? 'clean' : `${violations.length} sites: ${violations.slice(0, 3).map((v) => v.file + ':' + v.line).join(', ')}` });

  // 10 — Phase 3.9 — Agency.isSystem REMOVED from Prisma schema.
  const schemaSrc = await fs.readFile(SCHEMA_PATH, 'utf8');
  const schemaHasField = /model\s+Agency[\s\S]+?\bisSystem\s+Boolean/.test(schemaSrc);
  out.push({ name: '10. Agency.isSystem REMOVED from Prisma schema (Phase 3.9)',
    ok: !schemaHasField, detail: schemaHasField ? 'still present' : 'removed' });

  // 11 — PlatformAuditLog not attempted: table absent, no writes
  const c2 = pgClient(url); await c2.connect();
  try {
    const auditTableExists = (await c2.query<{ ok: boolean }>(
      `SELECT EXISTS (SELECT 1 FROM information_schema.tables
                       WHERE table_name = 'platform_audit_log') AS ok`)).rows[0].ok;
    out.push({ name: '11. PlatformAuditLog write not attempted (table absent)',
      ok: !auditTableExists, detail: `tableExists=${auditTableExists}` });
  } finally { await c2.end(); }

  // 12-16 — cross-phase wiring
  const pkg = await fs.readFile(path.join(BACKEND_ROOT, 'package.json'), 'utf8');
  out.push({ name: '12. Phase 3.7B bake check wiring intact',
    ok: /saas:phase37b-platform-admin-jwt-bake-check/.test(pkg), detail: 'pkg.json' });
  out.push({ name: '13. Phase 3.7 JWT dual-read harness wiring intact',
    ok: /saas:phase370-platform-admin-jwt-dual-read/.test(pkg), detail: 'pkg.json' });
  out.push({ name: '14. Phase 3.6 dual-read guard harness wiring intact',
    ok: /saas:phase360-platform-admin-dual-read-guard/.test(pkg), detail: 'pkg.json' });
  out.push({ name: '15. Phase 3.5 backfill harness wiring intact',
    ok: /saas:phase350-platform-admin-backfill-harness/.test(pkg), detail: 'pkg.json' });

  const sentinels = [
    ['phase2', 'pipeline-equivalence.json'], ['phase2', 'pipeline-isolation.json'],
    ['phase2', 'pipeline-mutation-isolation.json'], ['phase2', 'workflow-config-isolation.json'],
    ['phase3', 'product-migration-readiness.json'], ['phase3', 'phase31-readiness-check.json'],
    ['phase3', 'duplicate-cleanup-harness.json'], ['phase3', 'per-tenant-unique-constraints.json'],
    ['phase3', 'drop-employee-global-uniques.json'], ['phase3', 'platform-admin-backfill-harness.json'],
    ['phase3', 'platform-admin-dual-read-guard.json'], ['phase3', 'platform-admin-jwt-dual-read.json'],
    ['phase3', 'platform-admin-jwt-bake-check.json'], ['phase3', 'platform-admin-signal-agreement-report.json'],
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
  await fs.writeFile(path.join(PHASE3_REPORTS, 'platform-admin-runtime-retirement.json'),
    JSON.stringify({ passed, total, cases: out, violations: violations.slice(0, 50) }, null, 2));
  const md = [
    `# Phase 3.8 — PlatformAdmin runtime retirement`, ``,
    `**${passed}/${total} PASS**`, ``,
    ...out.map((c) => `- ${c.ok ? 'PASS' : 'FAIL'} — ${c.name} — ${c.detail}`), ``,
    violations.length > 0 ? `## Inventory violations\n\n${violations.slice(0, 30).map((v) => `- ${v.file}:${v.line} — \`${v.text}\``).join('\n')}` : '',
  ].filter(Boolean).join('\n');
  await fs.writeFile(path.join(PHASE3_REPORTS, 'platform-admin-runtime-retirement.md'), md);
  console.log(`[platform-admin-runtime-retirement] ${passed}/${total} PASS`);
  process.exit(passed === total ? 0 : 1);
}

main().catch((err) => { console.error(err); process.exit(2); });
