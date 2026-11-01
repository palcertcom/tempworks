/**
 * Phase 3.6 — PlatformAdmin dual-read access harness.
 *
 * Directly invokes `PlatformAdminAccessService.isPlatformAdmin(userId)`
 * against synthetic seed rows that exercise every signal combination.
 *
 *   1.  legacy Agency.isSystem=true user → true
 *   2.  PlatformAdmin row user (non-system agency) → true
 *   3.  both signals true → true
 *   4.  neither signal → false
 *   5.  deleted/inactive user → false
 *   6.  PlatformAdmin row unchanged after probe
 *   7.  Agency.isSystem unchanged after probe
 *   8.  missing user → false
 *   9.  PLATFORM_ADMIN_DUAL_READ_ENABLED=false → legacy-only
 *  10.  source-level inventory enumerates all backend Agency.isSystem call sites
 *  11.  PlatformAuditLog write is not attempted (no rows written)
 *  12.  Phase 3.5 platform-admin-backfill wiring intact
 *  13.  Phase 3.4 employee unique harness wiring intact
 *  14.  cumulative regression chain outputs present
 */
/* eslint-disable no-console */
import { promises as fs } from 'fs';
import path from 'path';
import { Client } from 'pg';
import { autoLoadEnv, formatDatabaseUrlMissingMessage } from './../phase1/reconciliation/lib/env';
import { PrismaService } from '../../../src/prisma/prisma.service';
import { PlatformAdminAccessService } from '../../../src/saas/platform-admin/platform-admin-access.service';

autoLoadEnv(__filename);

// Phase 3.8 — this harness was authored under Phase 3.6 OR-semantics.
// Set the legacy fallback flag so PlatformAdminAccessService continues
// to grant authority for legacy Agency.isSystem-only users (the OR
// behaviour this harness asserts). Phase 3.8 introduces a new default
// where PlatformAdmin is the sole authority; that default is asserted
// by the Phase 3.8 harness (saas:phase380-platform-admin-runtime-retirement).
process.env.PLATFORM_ADMIN_LEGACY_AGENCY_FALLBACK = 'true';

const BACKEND_ROOT = path.resolve(__dirname, '..', '..', '..');
const SRC_DIR = path.resolve(BACKEND_ROOT, 'src');
const PHASE3_REPORTS = path.resolve(BACKEND_ROOT, 'reports', 'saas', 'phase3');

const SEED = '00000000-0000-0000-0000-0000000036';
const ID = {
  sysAgency:  `${SEED}SA`,
  normAgency: `${SEED}NA`,
  uLegacy:    `${SEED}U1`,  // active user on isSystem=true
  uNewOnly:   `${SEED}U2`,  // active user on non-system agency + PlatformAdmin row
  uBoth:      `${SEED}U3`,  // active user on isSystem=true + PlatformAdmin row
  uNeither:   `${SEED}U4`,  // active user on non-system agency, no PlatformAdmin
  uDeleted:   `${SEED}U5`,  // deleted user on isSystem=true (must return false)
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
    [[ID.uLegacy, ID.uNewOnly, ID.uBoth, ID.uNeither, ID.uDeleted]]);
  await c.query(`DELETE FROM users WHERE id = ANY($1)`,
    [[ID.uLegacy, ID.uNewOnly, ID.uBoth, ID.uNeither, ID.uDeleted]]);
  await c.query(`DELETE FROM agencies WHERE id = ANY($1)`,
    [[ID.sysAgency, ID.normAgency]]);
}

async function seed(c: Client): Promise<void> {
  const ro = await c.query<{ id: string }>(`SELECT id FROM roles LIMIT 1`);
  const roleId = ro.rows[0].id;
  await c.query(`
    INSERT INTO agencies (id, name, country, "contactPerson", email, phone, "createdAt", "updatedAt")
    VALUES
      ($1, 'Phase360 System', 'XX', 'C', 'sys@p360.test', '0', now(), now()),
      ($2, 'Phase360 Normal', 'XX', 'C', 'nor@p360.test', '0', now(), now())
    ON CONFLICT (id) DO NOTHING
  `, [ID.sysAgency, ID.normAgency]);
  await c.query(`
    INSERT INTO users (id, email, "passwordHash", "firstName", "lastName", "roleId", "agencyId", status, "createdAt", "updatedAt")
    VALUES
      ($1, 'p360-u1@e.com', 'h', 'L','Egc',  $6, $7, 'ACTIVE',   now(), now()),
      ($2, 'p360-u2@e.com', 'h', 'N','New',  $6, $8, 'ACTIVE',   now(), now()),
      ($3, 'p360-u3@e.com', 'h', 'B','Both', $6, $7, 'ACTIVE',   now(), now()),
      ($4, 'p360-u4@e.com', 'h', 'X','None', $6, $8, 'ACTIVE',   now(), now()),
      ($5, 'p360-u5@e.com', 'h', 'D','Del',  $6, $7, 'ACTIVE',   now(), now())
    ON CONFLICT (id) DO NOTHING
  `, [ID.uLegacy, ID.uNewOnly, ID.uBoth, ID.uNeither, ID.uDeleted, roleId, ID.sysAgency, ID.normAgency]);
  await c.query(`UPDATE users SET "deletedAt" = now() WHERE id = $1`, [ID.uDeleted]);
  await c.query(`
    INSERT INTO platform_admins (id, "userId", level, "grantedBy", "grantedAt")
    VALUES
      (gen_random_uuid()::text, $1, 'SUPER',    'phase360-test', now()),
      (gen_random_uuid()::text, $2, 'OPERATOR', 'phase360-test', now())
    ON CONFLICT ("userId") DO NOTHING
  `, [ID.uNewOnly, ID.uBoth]);
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
    const svc = new PlatformAdminAccessService(prisma);

    // Phase 3.9 — `Agency.isSystem` column dropped; the legacy signal
    // no longer exists. uLegacy has no PlatformAdmin row, so the new
    // PlatformAdmin-only authority resolver returns false. The legacy
    // fallback flag is inert because there's nothing to read.
    out.push({ name: '1. legacy user with no PlatformAdmin returns false (Phase 3.9 supersedes legacy signal)',
      ok: (await svc.isPlatformAdmin(ID.uLegacy)) === false, detail: `uLegacy` });
    out.push({ name: '2. PlatformAdmin row user (non-system agency) returns platform admin',
      ok: (await svc.isPlatformAdmin(ID.uNewOnly)) === true, detail: `uNewOnly` });
    out.push({ name: '3. user with both signals returns platform admin',
      ok: (await svc.isPlatformAdmin(ID.uBoth)) === true, detail: `uBoth` });
    out.push({ name: '4. user with neither signal returns false',
      ok: (await svc.isPlatformAdmin(ID.uNeither)) === false, detail: `uNeither` });
    out.push({ name: '5. deleted/inactive user returns false',
      ok: (await svc.isPlatformAdmin(ID.uDeleted)) === false, detail: `uDeleted` });

    // 6 / 7 / 11 — no mutations occurred. Snapshot counts before / after.
    const c2 = pgClient(getDatabaseUrl()); await c2.connect();
    try {
      const beforeRow = (await c2.query<{ level: string; grantedBy: string }>(
        `SELECT level, "grantedBy" FROM platform_admins WHERE "userId" = $1`, [ID.uNewOnly])).rows[0];
      // Phase 3.9 — `agencies.isSystem` column dropped; we now verify the
      // agency row itself remains untouched (id present).
      const sysRow = (await c2.query<{ id: string }>(
        `SELECT id FROM agencies WHERE id = $1`, [ID.sysAgency])).rows[0];
      for (const id of [ID.uLegacy, ID.uNewOnly, ID.uBoth, ID.uNeither, ID.uDeleted]) {
        await svc.isPlatformAdmin(id);
      }
      const afterRow = (await c2.query<{ level: string; grantedBy: string }>(
        `SELECT level, "grantedBy" FROM platform_admins WHERE "userId" = $1`, [ID.uNewOnly])).rows[0];
      const sysAfter = (await c2.query<{ id: string }>(
        `SELECT id FROM agencies WHERE id = $1`, [ID.sysAgency])).rows[0];

      out.push({ name: '6. existing PlatformAdmin row is not mutated by isPlatformAdmin()',
        ok: beforeRow?.level === afterRow?.level && beforeRow?.grantedBy === afterRow?.grantedBy,
        detail: `level=${afterRow?.level} grantedBy=${afterRow?.grantedBy}` });
      out.push({ name: '7. Agency row is not mutated by isPlatformAdmin() (column dropped in Phase 3.9; row presence preserved)',
        ok: sysRow?.id === ID.sysAgency && sysAfter?.id === ID.sysAgency,
        detail: `sysAgency=${sysAfter?.id ?? 'missing'}` });

      // 11 — PlatformAuditLog: ensure no rows were attempted. The
      // `platform_audit_log` table is absent in this fixture, so attempting
      // to write would have errored loudly. Confirm the service did not
      // even reference the table.
      const auditTableExists = (await c2.query<{ ok: boolean }>(
        `SELECT EXISTS (SELECT 1 FROM information_schema.tables
                         WHERE table_name = 'platform_audit_log') AS ok`)).rows[0].ok;
      out.push({ name: '11. PlatformAuditLog write is not attempted (table absent, no error raised)',
        ok: !auditTableExists, detail: `tableExists=${auditTableExists}` });
    } finally { await c2.end(); }

    // 8 — missing user returns false (no error).
    let missingFalse = false;
    try { missingFalse = (await svc.isPlatformAdmin('00000000-0000-0000-0000-000000000bad')) === false; }
    catch { missingFalse = false; }
    out.push({ name: '8. missing user returns false',
      ok: missingFalse, detail: `result=${missingFalse}` });

    // 9 — Phase 3.9 — legacy-fallback flag is now INERT (Agency.isSystem
    // column dropped). Setting it has no effect; authority is sourced
    // exclusively from PlatformAdmin. uNewOnly has a row → true; uLegacy
    // does not → false.
    process.env.PLATFORM_ADMIN_DUAL_READ_ENABLED = 'false';
    const svcLegacy = new PlatformAdminAccessService(prisma);
    process.env.PLATFORM_ADMIN_DUAL_READ_ENABLED = 'true';
    const legacyOnlyForNewOnly = await svcLegacy.isPlatformAdmin(ID.uNewOnly);
    const legacyOnlyForLegacy  = await svcLegacy.isPlatformAdmin(ID.uLegacy);
    out.push({ name: '9. PLATFORM_ADMIN_DUAL_READ_ENABLED flag inert under Phase 3.9 (PlatformAdmin sole authority)',
      ok: legacyOnlyForNewOnly === true && legacyOnlyForLegacy === false,
      detail: `uNewOnly=${legacyOnlyForNewOnly} uLegacy=${legacyOnlyForLegacy}` });
  } finally {
    await prisma.$disconnect();
  }

  // 10 — source-level inventory of Agency.isSystem call sites in backend/src.
  // We walk every .ts file and record any line that references `isSystem`
  // (case-sensitive) in a non-comment context. The inventory is written
  // alongside the report so Phase 3.7 can drive the endpoint switch.
  const inventory: Array<{ file: string; line: number; text: string }> = [];
  const stack: string[] = [SRC_DIR];
  while (stack.length) {
    const dir = stack.pop()!;
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) { stack.push(full); continue; }
      if (!e.isFile() || !e.name.endsWith('.ts')) continue;
      const raw = await fs.readFile(full, 'utf8');
      const lines = raw.split('\n');
      for (let i = 0; i < lines.length; i++) {
        const ln = lines[i];
        // Skip pure comment lines.
        if (/^\s*\/\//.test(ln) || /^\s*\*/.test(ln)) continue;
        if (/\bisSystem\b/.test(ln)) {
          inventory.push({ file: path.relative(BACKEND_ROOT, full), line: i + 1, text: ln.trim().slice(0, 200) });
        }
      }
    }
  }
  // Phase 3.9 — `jwt.strategy.ts` no longer has a non-comment isSystem
  // reference because the column was dropped. The other historical
  // sites still surface their (residual) references for audit purposes.
  const minExpected = ['src/auth/auth.service.ts', 'src/agencies/agencies.service.ts'];
  const haveAll = minExpected.every((f) => inventory.some((i) => i.file === f));
  out.push({ name: '10. source-level inventory captures remaining Agency.isSystem references',
    ok: haveAll && inventory.length >= minExpected.length,
    detail: `totalSites=${inventory.length} mustHave=${minExpected.length}` });

  // Cross-phase wiring
  const pkg = await fs.readFile(path.join(BACKEND_ROOT, 'package.json'), 'utf8');
  out.push({ name: '12. Phase 3.5 platform-admin-backfill wiring intact',
    ok: /saas:phase350-platform-admin-backfill-harness/.test(pkg), detail: 'pkg.json' });
  out.push({ name: '13. Phase 3.4 employee unique harness wiring intact',
    ok: /saas:phase340-drop-employee-global-uniques/.test(pkg), detail: 'pkg.json' });
  const sentinels = [
    ['phase2', 'pipeline-equivalence.json'], ['phase2', 'pipeline-isolation.json'],
    ['phase2', 'pipeline-mutation-isolation.json'], ['phase2', 'workflow-config-isolation.json'],
    ['phase3', 'product-migration-readiness.json'], ['phase3', 'phase31-readiness-check.json'],
    ['phase3', 'duplicate-cleanup-harness.json'], ['phase3', 'per-tenant-unique-constraints.json'],
    ['phase3', 'drop-employee-global-uniques.json'], ['phase3', 'platform-admin-backfill-harness.json'],
  ];
  const checks = await Promise.all(sentinels.map(([d, f]) => exists(path.join(BACKEND_ROOT, 'reports', 'saas', d, f))));
  out.push({ name: '14. cumulative regression chain outputs present',
    ok: checks.every(Boolean), detail: `present=${checks.filter(Boolean).length}/${sentinels.length}` });

  // Cleanup
  const cClean = pgClient(getDatabaseUrl()); await cClean.connect();
  try { await teardown(cClean); } finally { await cClean.end(); }

  await fs.mkdir(PHASE3_REPORTS, { recursive: true });
  const passed = out.filter((c) => c.ok).length;
  const total = out.length;
  await fs.writeFile(path.join(PHASE3_REPORTS, 'platform-admin-dual-read-guard.json'),
    JSON.stringify({ passed, total, cases: out, inventory: inventory.slice(0, 200), inventoryTotal: inventory.length }, null, 2));
  const md = [
    `# Phase 3.6 — PlatformAdmin dual-read guard`, ``,
    `**${passed}/${total} PASS**`, ``,
    ...out.map((c) => `- ${c.ok ? 'PASS' : 'FAIL'} — ${c.name} — ${c.detail}`), ``,
    `## Agency.isSystem inventory (${inventory.length} sites)`, ``,
    `| file | line | text |`, `| --- | --- | --- |`,
    ...inventory.slice(0, 40).map((i) => `| ${i.file} | ${i.line} | \`${i.text.replace(/\|/g, '\\|')}\` |`),
    inventory.length > 40 ? `| … | … | (+${inventory.length - 40} more) |` : '',
    ``,
  ].filter(Boolean).join('\n');
  await fs.writeFile(path.join(PHASE3_REPORTS, 'platform-admin-dual-read-guard.md'), md);
  console.log(`[platform-admin-dual-read-guard] ${passed}/${total} PASS`);
  process.exit(passed === total ? 0 : 1);
}

main().catch((err) => { console.error(err); process.exit(2); });
