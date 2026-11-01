/**
 * Phase 3.10 — PlatformAdmin cleanup + PlatformAuditLog migration.
 *
 *   1.  PlatformAdminAccessService source: no PLATFORM_ADMIN_DUAL_READ_ENABLED
 *   2.  PlatformAdminAccessService source: no PLATFORM_ADMIN_LEGACY_AGENCY_FALLBACK
 *   3.  src/ contains no runtime agency.isSystem authorization read
 *   4.  Prisma schema no longer contains Agency.isSystem
 *   5.  Prisma schema contains PlatformAuditLog model
 *   6.  migration creates platform_audit_logs (CREATE TABLE IF NOT EXISTS)
 *   7.  migration down drops only platform_audit_logs
 *   8.  migration has no UPDATE/DELETE data mutation
 *   9.  applying migration creates the table in the fixture
 *  10.  PlatformAuditLog indexes/columns match the Prisma model
 *  11.  req.user.agencyIsSystem output shape preserved (8 keys)
 *  12.  PlatformAdmin user stamps agencyIsSystem=true
 *  13.  non-PlatformAdmin user stamps agencyIsSystem=false
 *  14.  PlatformAdmin grant/revoke audit emission deferred (no runtime surface)
 *  15.  Phase 3.9 drop-agency-is-system wiring intact
 *  16.  Phase 3.8 runtime retirement wiring intact
 *  17.  Phase 3.7B bake check wiring intact
 *  18.  cumulative regression chain outputs present
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
const MIG_DIR = path.resolve(BACKEND_ROOT, 'prisma', 'migrations', 'saas_phase310_platform_audit_log');
const UP_SQL = path.join(MIG_DIR, 'migration.sql');
const DN_SQL = path.join(MIG_DIR, 'migration.down.sql');

const SEED = '00000000-0000-0000-0000-0000003100';
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
  await c.query(`DELETE FROM agencies WHERE id = $1`, [ID.agency]);
}
async function seed(c: Client): Promise<void> {
  const ro = await c.query<{ id: string }>(`SELECT id FROM roles LIMIT 1`);
  const roleId = ro.rows[0].id;
  await c.query(`
    INSERT INTO agencies (id, name, country, "contactPerson", email, phone, "createdAt", "updatedAt")
    VALUES ($1, 'P310', 'XX', 'C', 'a@p310.test', '0', now(), now())
    ON CONFLICT (id) DO NOTHING
  `, [ID.agency]);
  await c.query(`
    INSERT INTO users (id, email, "passwordHash", "firstName", "lastName", "roleId", "agencyId", status, "createdAt", "updatedAt")
    VALUES ($1, 'p310-pa@e.com',  'h','P','A',$3,$4,'ACTIVE',now(),now()),
           ($2, 'p310-none@e.com','h','N','O',$3,$4,'ACTIVE',now(),now())
    ON CONFLICT (id) DO NOTHING
  `, [ID.uPa, ID.uNone, roleId, ID.agency]);
  await c.query(`
    INSERT INTO platform_admins (id, "userId", level, "grantedBy", "grantedAt")
    VALUES (gen_random_uuid()::text, $1, 'SUPER', 'phase310-test', now())
    ON CONFLICT ("userId") DO NOTHING
  `, [ID.uPa]);
}

async function main(): Promise<void> {
  const url = getDatabaseUrl();
  const out: CaseResult[] = [];

  // Source-level invariants
  const svcRaw = await fs.readFile(path.join(SRC_DIR, 'saas', 'platform-admin', 'platform-admin-access.service.ts'), 'utf8');
  const svcStripped = svcRaw.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
  out.push({ name: '1. PlatformAdminAccessService source contains no PLATFORM_ADMIN_DUAL_READ_ENABLED',
    ok: !/PLATFORM_ADMIN_DUAL_READ_ENABLED/.test(svcStripped),
    detail: /PLATFORM_ADMIN_DUAL_READ_ENABLED/.test(svcStripped) ? 'still referenced' : 'absent' });
  out.push({ name: '2. PlatformAdminAccessService source contains no PLATFORM_ADMIN_LEGACY_AGENCY_FALLBACK',
    ok: !/PLATFORM_ADMIN_LEGACY_AGENCY_FALLBACK/.test(svcStripped),
    detail: /PLATFORM_ADMIN_LEGACY_AGENCY_FALLBACK/.test(svcStripped) ? 'still referenced' : 'absent' });

  // 3 — src/ walk for non-comment agency.isSystem
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
  out.push({ name: '3. src/ contains no runtime agency.isSystem authorization read outside allow-list',
    ok: violations.length === 0, detail: violations.length === 0 ? 'clean' : `${violations.length} sites` });

  // 4
  const schemaSrc = await fs.readFile(SCHEMA_PATH, 'utf8');
  const schemaHasIsSystem = /model\s+Agency\b[\s\S]+?\bisSystem\s+Boolean/.test(schemaSrc);
  out.push({ name: '4. Prisma schema no longer contains Agency.isSystem',
    ok: !schemaHasIsSystem, detail: schemaHasIsSystem ? 'present' : 'absent' });
  // 5
  const schemaHasModel = /model\s+PlatformAuditLog\s*\{[\s\S]+?@@map\("platform_audit_logs"\)/.test(schemaSrc);
  out.push({ name: '5. Prisma schema contains PlatformAuditLog model',
    ok: schemaHasModel, detail: schemaHasModel ? 'present' : 'missing' });

  // 6-8 — migration SQL
  const up = await fs.readFile(UP_SQL, 'utf8');
  const dn = await fs.readFile(DN_SQL, 'utf8');
  out.push({ name: '6. migration creates platform_audit_logs',
    ok: /CREATE TABLE IF NOT EXISTS "platform_audit_logs"/i.test(up),
    detail: 'CREATE TABLE present' });
  // Strip SQL comments before regex so doc comments mentioning "DROP"
  // do not register as additional DROP statements.
  const dnNoComments = dn.replace(/--.*$/gm, '');
  const dropMatches = dnNoComments.match(/\bDROP\b/gi) ?? [];
  out.push({ name: '7. migration down drops only platform_audit_logs',
    ok: /DROP TABLE IF EXISTS "platform_audit_logs"/i.test(dnNoComments) && dropMatches.length === 1,
    detail: `dropStatements=${dropMatches.length}` });
  const noWrite = !/\b(UPDATE|DELETE)\s+/i.test(up.replace(/'[^']*'/g, "''"));
  out.push({ name: '8. migration has no UPDATE/DELETE data mutation',
    ok: noWrite, detail: noWrite ? 'no writes' : 'writes found' });

  // 9-10 — applying migration creates the table; verify columns/indexes
  const c = pgClient(url); await c.connect();
  try {
    await c.query(up);
    const tableExists = (await c.query<{ ok: boolean }>(
      `SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'platform_audit_logs') AS ok`)).rows[0].ok;
    out.push({ name: '9. applying migration creates the table in the fixture',
      ok: tableExists, detail: `tableExists=${tableExists}` });

    const colsResult = await c.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns WHERE table_name='platform_audit_logs' ORDER BY ordinal_position`);
    const cols = colsResult.rows.map((r) => r.column_name).sort();
    const expectedCols = ['action','actorId','createdAt','id','ip','reason','target','tenantId','userAgent'].sort();
    const idxResult = await c.query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes WHERE tablename='platform_audit_logs'`);
    const idxNames = idxResult.rows.map((r) => r.indexname);
    const hasActorIdx = idxNames.some((n) => /actorId/i.test(n) && /createdAt/i.test(n));
    const hasTenantIdx = idxNames.some((n) => /tenantId/i.test(n) && /createdAt/i.test(n));
    out.push({ name: '10. PlatformAuditLog indexes/columns match the Prisma model',
      ok: JSON.stringify(cols) === JSON.stringify(expectedCols) && hasActorIdx && hasTenantIdx,
      detail: `cols=${cols.length}/${expectedCols.length} actorIdx=${hasActorIdx} tenantIdx=${hasTenantIdx}` });
  } finally { await c.end(); }

  // 11-13 — JWT stamping
  const c2 = pgClient(url); await c2.connect();
  try {
    await teardown(c2);
    await seed(c2);
    await c2.end();
  } catch (err) { await c2.end().catch(() => undefined); throw err; }

  const prisma = new PrismaService();
  try {
    const svc = new PlatformAdminAccessService(prisma);
    const strategy = new JwtStrategy(prisma, svc);

    const rPa = await strategy.validate({ sub: ID.uPa });
    const rNone = await strategy.validate({ sub: ID.uNone });

    const expectedKeys = ['agencyId','agencyIsSystem','email','firstName','id','lastName','role','roleId'];
    out.push({ name: '11. req.user.agencyIsSystem output shape preserved (8 keys)',
      ok: JSON.stringify(Object.keys(rPa).sort()) === JSON.stringify(expectedKeys),
      detail: `keys=${Object.keys(rPa).sort().join(',')}` });
    out.push({ name: '12. PlatformAdmin user stamps agencyIsSystem=true',
      ok: rPa.agencyIsSystem === true, detail: `agencyIsSystem=${rPa.agencyIsSystem}` });
    out.push({ name: '13. non-PlatformAdmin user stamps agencyIsSystem=false',
      ok: rNone.agencyIsSystem === false, detail: `agencyIsSystem=${rNone.agencyIsSystem}` });
  } finally {
    await prisma.$disconnect();
  }

  // 14 — emission deferred (no runtime grant/revoke surface yet)
  const grantSrc = await (async () => {
    let found = false;
    const s2: string[] = [SRC_DIR];
    while (s2.length) {
      const dir = s2.pop()!;
      const entries = await fs.readdir(dir, { withFileTypes: true });
      for (const e of entries) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) { s2.push(full); continue; }
        if (!e.isFile() || !e.name.endsWith('.ts')) continue;
        const raw = await fs.readFile(full, 'utf8');
        if (/this\.prisma\.platformAdmin\.(create|delete|update)/.test(raw)
         || /platformAdmin\.\s*create\s*\(/.test(raw)) {
          found = true; break;
        }
      }
      if (found) break;
    }
    return found;
  })();
  // Phase 3.11 supersedes: runtime grant/revoke surface now exists in
  // PlatformAdminService and emits PlatformAuditLog rows. Either state
  // (deferred-no-surface OR implemented-with-emission) is acceptable.
  let emissionWired = false;
  try {
    const svcImpl = await fs.readFile(path.join(SRC_DIR, 'saas', 'platform-admin', 'platform-admin.service.ts'), 'utf8');
    emissionWired = /platformAuditLog\.create/.test(svcImpl);
  } catch { /* file may not exist */ }
  out.push({ name: '14. PlatformAdmin grant/revoke audit emission: implemented (Phase 3.11) or deferred',
    ok: emissionWired || grantSrc === false,
    detail: emissionWired ? 'implemented in PlatformAdminService' : (grantSrc ? 'unhandled grant surface' : 'deferred') });

  // 15-17 — cross-phase wiring
  const pkg = await fs.readFile(path.join(BACKEND_ROOT, 'package.json'), 'utf8');
  out.push({ name: '15. Phase 3.9 drop-agency-is-system wiring intact',
    ok: /saas:phase390-drop-agency-is-system/.test(pkg), detail: 'pkg.json' });
  out.push({ name: '16. Phase 3.8 runtime retirement wiring intact',
    ok: /saas:phase380-platform-admin-runtime-retirement/.test(pkg), detail: 'pkg.json' });
  out.push({ name: '17. Phase 3.7B bake check wiring intact',
    ok: /saas:phase37b-platform-admin-jwt-bake-check/.test(pkg), detail: 'pkg.json' });

  const sentinels = [
    ['phase2', 'pipeline-equivalence.json'], ['phase2', 'pipeline-isolation.json'],
    ['phase2', 'pipeline-mutation-isolation.json'], ['phase2', 'workflow-config-isolation.json'],
    ['phase3', 'product-migration-readiness.json'], ['phase3', 'phase31-readiness-check.json'],
    ['phase3', 'duplicate-cleanup-harness.json'], ['phase3', 'per-tenant-unique-constraints.json'],
    ['phase3', 'drop-employee-global-uniques.json'], ['phase3', 'platform-admin-backfill-harness.json'],
    ['phase3', 'platform-admin-dual-read-guard.json'], ['phase3', 'platform-admin-jwt-dual-read.json'],
    ['phase3', 'platform-admin-jwt-bake-check.json'], ['phase3', 'platform-admin-signal-agreement-report.json'],
    ['phase3', 'platform-admin-runtime-retirement.json'], ['phase3', 'drop-agency-is-system.json'],
  ];
  const checks = await Promise.all(sentinels.map(([d, f]) => exists(path.join(BACKEND_ROOT, 'reports', 'saas', d, f))));
  out.push({ name: '18. cumulative regression chain outputs present',
    ok: checks.every(Boolean), detail: `present=${checks.filter(Boolean).length}/${sentinels.length}` });

  // Cleanup
  const cClean = pgClient(url); await cClean.connect();
  try { await teardown(cClean); } finally { await cClean.end(); }

  await fs.mkdir(PHASE3_REPORTS, { recursive: true });
  const passed = out.filter((c) => c.ok).length;
  const total = out.length;
  await fs.writeFile(path.join(PHASE3_REPORTS, 'platform-admin-cleanup-audit-log.json'),
    JSON.stringify({ passed, total, cases: out, violations: violations.slice(0, 50) }, null, 2));
  const md = [
    `# Phase 3.10 — PlatformAdmin cleanup + PlatformAuditLog migration`, ``,
    `**${passed}/${total} PASS**`, ``,
    ...out.map((c) => `- ${c.ok ? 'PASS' : 'FAIL'} — ${c.name} — ${c.detail}`), ``,
  ].join('\n');
  await fs.writeFile(path.join(PHASE3_REPORTS, 'platform-admin-cleanup-audit-log.md'), md);
  console.log(`[platform-admin-cleanup-audit-log] ${passed}/${total} PASS`);
  process.exit(passed === total ? 0 : 1);
}

main().catch((err) => { console.error(err); process.exit(2); });
