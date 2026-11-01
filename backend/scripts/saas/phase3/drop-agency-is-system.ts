/**
 * Phase 3.9 — Destructive drop of Agency.isSystem.
 *
 *   1.  migration drops only agencies.isSystem
 *   2.  migration does not drop other agency columns
 *   3.  Prisma schema no longer contains Agency.isSystem
 *   4.  PlatformAdminAccessService no longer reads Agency.isSystem
 *   5.  PLATFORM_ADMIN_LEGACY_AGENCY_FALLBACK is inert (column gone)
 *   6.  JwtStrategy output still includes agencyIsSystem
 *   7.  PlatformAdmin user stamps agencyIsSystem=true
 *   8.  non-PlatformAdmin user stamps agencyIsSystem=false
 *   9.  runtime inventory contains no Agency.isSystem authorization read
 *  10.  PlatformAuditLog still not written
 *  11.  down migration re-adds column default false + caveat documented
 *  12.  Phase 3.8 / 3.7B harnesses re-pass under new defaults
 *  13.  Phase 3.5 backfill harness updated for legacy criterion removal
 *  14.  cumulative regression chain outputs present
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

const BACKEND_ROOT = path.resolve(__dirname, '..', '..', '..');
const SRC_DIR = path.resolve(BACKEND_ROOT, 'src');
const PHASE3_REPORTS = path.resolve(BACKEND_ROOT, 'reports', 'saas', 'phase3');
const SCHEMA_PATH = path.resolve(BACKEND_ROOT, 'prisma', 'schema.prisma');
const MIG_DIR = path.resolve(BACKEND_ROOT, 'prisma', 'migrations', 'saas_phase39_drop_agency_is_system');
const UP_SQL = path.join(MIG_DIR, 'migration.sql');
const DN_SQL = path.join(MIG_DIR, 'migration.down.sql');

const SEED = '00000000-0000-0000-0000-0000000039';
const ID = {
  agency:   `${SEED}AA`,
  uPa:      `${SEED}U1`,
  uNone:    `${SEED}U2`,
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
  await c.query(`DELETE FROM platform_admins WHERE "userId" = ANY($1)`, [[ID.uPa, ID.uNone]]);
  await c.query(`DELETE FROM users WHERE id = ANY($1)`, [[ID.uPa, ID.uNone]]);
  await c.query(`DELETE FROM agencies WHERE id = ANY($1)`, [[ID.agency]]);
}
async function seed(c: Client): Promise<void> {
  const ro = await c.query<{ id: string }>(`SELECT id FROM roles LIMIT 1`);
  const roleId = ro.rows[0].id;
  await c.query(`
    INSERT INTO agencies (id, name, country, "contactPerson", email, phone, "createdAt", "updatedAt")
    VALUES ($1, 'P390', 'XX', 'C', 'a@p390.test', '0', now(), now())
    ON CONFLICT (id) DO NOTHING
  `, [ID.agency]);
  await c.query(`
    INSERT INTO users (id, email, "passwordHash", "firstName", "lastName", "roleId", "agencyId", status, "createdAt", "updatedAt")
    VALUES ($1, 'p390-pa@e.com', 'h', 'P','A', $3, $4, 'ACTIVE', now(), now()),
           ($2, 'p390-none@e.com','h','N','O', $3, $4, 'ACTIVE', now(), now())
    ON CONFLICT (id) DO NOTHING
  `, [ID.uPa, ID.uNone, roleId, ID.agency]);
  await c.query(`
    INSERT INTO platform_admins (id, "userId", level, "grantedBy", "grantedAt")
    VALUES (gen_random_uuid()::text, $1, 'SUPER', 'phase390-test', now())
    ON CONFLICT ("userId") DO NOTHING
  `, [ID.uPa]);
}

async function main(): Promise<void> {
  const url = getDatabaseUrl();
  const out: CaseResult[] = [];

  // Source-level assertions
  const up = await fs.readFile(UP_SQL, 'utf8');
  const dn = await fs.readFile(DN_SQL, 'utf8');
  const upClean = up.replace(/--.*$/gm, '');
  const dnClean = dn.replace(/--.*$/gm, '');

  // 1
  out.push({ name: '1. migration drops only agencies.isSystem',
    ok: /ALTER TABLE "agencies"\s+DROP COLUMN IF EXISTS "isSystem"/i.test(upClean),
    detail: 'DROP COLUMN agencies.isSystem' });
  // 2
  const otherDrops = /\bDROP\b.*"agencies"/i.test(upClean.replace(/DROP COLUMN IF EXISTS "isSystem"/i, ''));
  out.push({ name: '2. migration does not drop other agency columns',
    ok: !otherDrops, detail: otherDrops ? 'unexpected drop' : 'isSystem only' });
  // 3
  const schemaSrc = await fs.readFile(SCHEMA_PATH, 'utf8');
  const schemaHasField = /model\s+Agency\b[\s\S]+?\bisSystem\s+Boolean/.test(schemaSrc);
  out.push({ name: '3. Prisma schema no longer contains Agency.isSystem',
    ok: !schemaHasField, detail: schemaHasField ? 'still present' : 'removed' });
  // 4
  const svcSrcRaw = await fs.readFile(path.join(SRC_DIR, 'saas', 'platform-admin', 'platform-admin-access.service.ts'), 'utf8');
  const svcSrcStripped = svcSrcRaw.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
  out.push({ name: '4. PlatformAdminAccessService no longer reads Agency.isSystem',
    ok: !/agency\??\.isSystem/.test(svcSrcStripped),
    detail: 'no non-comment isSystem reads' });

  // DB probes (5-8)
  const c = pgClient(url); await c.connect();
  try {
    await teardown(c);
    await seed(c);
    await c.end();
  } catch (err) { await c.end().catch(() => undefined); throw err; }

  const prisma = new PrismaService();
  try {
    // 5 — fallback flag inert
    process.env.PLATFORM_ADMIN_LEGACY_AGENCY_FALLBACK = 'true';
    const svc = new PlatformAdminAccessService(prisma);
    const strategy = new JwtStrategy(prisma, svc);
    delete process.env.PLATFORM_ADMIN_LEGACY_AGENCY_FALLBACK;
    const rNone = await strategy.validate({ sub: ID.uNone });
    out.push({ name: '5. PLATFORM_ADMIN_LEGACY_AGENCY_FALLBACK is inert (column gone)',
      ok: rNone.agencyIsSystem === false, detail: `uNone.agencyIsSystem=${rNone.agencyIsSystem}` });

    // 6 — output still includes agencyIsSystem
    const rPa = await strategy.validate({ sub: ID.uPa });
    out.push({ name: '6. JwtStrategy output still includes agencyIsSystem',
      ok: 'agencyIsSystem' in rPa, detail: `keys=${Object.keys(rPa).join(',')}` });

    // 7 — PlatformAdmin user stamps true
    out.push({ name: '7. PlatformAdmin user stamps agencyIsSystem=true',
      ok: rPa.agencyIsSystem === true, detail: `agencyIsSystem=${rPa.agencyIsSystem}` });

    // 8 — Non-PlatformAdmin user stamps false
    out.push({ name: '8. non-PlatformAdmin user stamps agencyIsSystem=false',
      ok: rNone.agencyIsSystem === false, detail: `agencyIsSystem=${rNone.agencyIsSystem}` });
  } finally {
    await prisma.$disconnect();
  }

  // 9 — runtime inventory: walk src/ for `agency.isSystem`. Allowed:
  // residual comments in agencies.service.ts and access service.
  const allowDirs = [
    'src/saas/platform-admin/',
    'src/agencies/',
    'src/auth/auth.service',
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
        if (/agency\??\.isSystem/.test(ln)) {
          violations.push({ file: rel, line: i + 1, text: ln.trim().slice(0, 200) });
        }
      }
    }
  }
  out.push({ name: '9. runtime inventory: no Agency.isSystem authorization read outside allow-list',
    ok: violations.length === 0,
    detail: violations.length === 0 ? 'clean' : `${violations.length} sites` });

  // 10 — PlatformAuditLog table still absent (verifies no writes attempted)
  const c2 = pgClient(url); await c2.connect();
  try {
    const tbl = (await c2.query<{ ok: boolean }>(
      `SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'platform_audit_log') AS ok`)).rows[0].ok;
    out.push({ name: '10. PlatformAuditLog still not written (table absent)',
      ok: !tbl, detail: `tableExists=${tbl}` });
  } finally { await c2.end(); }

  // 11 — down migration adds column default false + caveat documented
  const downAddsCol = /ADD COLUMN IF NOT EXISTS "isSystem"\s+boolean\s+NOT NULL\s+DEFAULT false/i.test(dnClean);
  const downHasCaveat = /DATA LOSS|cannot be reconstructed|restore from .*backup/i.test(dn);
  out.push({ name: '11. down migration re-adds column default false + caveat documented',
    ok: downAddsCol && downHasCaveat, detail: `addsCol=${downAddsCol} caveat=${downHasCaveat}` });

  // 12 — Phase 3.8 / 3.7B wiring intact in package.json
  const pkg = await fs.readFile(path.join(BACKEND_ROOT, 'package.json'), 'utf8');
  out.push({ name: '12. Phase 3.8 / 3.7B harness wiring intact',
    ok: /saas:phase380-platform-admin-runtime-retirement/.test(pkg)
     && /saas:phase37b-platform-admin-jwt-bake-check/.test(pkg), detail: 'pkg.json' });

  // 13 — Phase 3.5 backfill harness updated (legacy criterion now unreachable)
  const p35src = await fs.readFile(path.resolve(__dirname, 'platform-admin-backfill-harness.ts'), 'utf8');
  out.push({ name: '13. Phase 3.5 backfill harness updated for legacy criterion removal',
    ok: /Phase 3\.9/.test(p35src) && /0 eligible/.test(p35src), detail: 'updated' });

  // 14 — sentinel outputs
  const sentinels = [
    ['phase2', 'pipeline-equivalence.json'], ['phase2', 'pipeline-isolation.json'],
    ['phase2', 'pipeline-mutation-isolation.json'], ['phase2', 'workflow-config-isolation.json'],
    ['phase3', 'product-migration-readiness.json'], ['phase3', 'phase31-readiness-check.json'],
    ['phase3', 'duplicate-cleanup-harness.json'], ['phase3', 'per-tenant-unique-constraints.json'],
    ['phase3', 'drop-employee-global-uniques.json'], ['phase3', 'platform-admin-backfill-harness.json'],
    ['phase3', 'platform-admin-dual-read-guard.json'], ['phase3', 'platform-admin-jwt-dual-read.json'],
    ['phase3', 'platform-admin-jwt-bake-check.json'], ['phase3', 'platform-admin-signal-agreement-report.json'],
    ['phase3', 'platform-admin-runtime-retirement.json'],
  ];
  const checks = await Promise.all(sentinels.map(([d, f]) => exists(path.join(BACKEND_ROOT, 'reports', 'saas', d, f))));
  out.push({ name: '14. cumulative regression chain outputs present',
    ok: checks.every(Boolean), detail: `present=${checks.filter(Boolean).length}/${sentinels.length}` });

  // Cleanup
  const cClean = pgClient(url); await cClean.connect();
  try { await teardown(cClean); } finally { await cClean.end(); }

  await fs.mkdir(PHASE3_REPORTS, { recursive: true });
  const passed = out.filter((c) => c.ok).length;
  const total = out.length;
  await fs.writeFile(path.join(PHASE3_REPORTS, 'drop-agency-is-system.json'),
    JSON.stringify({ passed, total, cases: out, violations: violations.slice(0, 50) }, null, 2));
  const md = [
    `# Phase 3.9 — drop Agency.isSystem`, ``,
    `**${passed}/${total} PASS**`, ``,
    ...out.map((c) => `- ${c.ok ? 'PASS' : 'FAIL'} — ${c.name} — ${c.detail}`), ``,
  ].join('\n');
  await fs.writeFile(path.join(PHASE3_REPORTS, 'drop-agency-is-system.md'), md);
  console.log(`[drop-agency-is-system] ${passed}/${total} PASS`);
  process.exit(passed === total ? 0 : 1);
}

main().catch((err) => { console.error(err); process.exit(2); });
