/**
 * Phase 3.5 — PlatformAdmin backfill harness.
 *
 * Seeds a synthetic isSystem agency, an eligible active user, a deleted
 * user, and a non-system-agency user. Runs the backfill in dry-run
 * mode, then under each gate-refusal combination, then with both gates
 * open. Cleans up at teardown so the fixture exits in baseline state.
 *
 *   1.  dry-run inserts zero rows
 *   2.  dry-run reports eligible system-agency user
 *   3.  apply refused when PLATFORM_ADMIN_BACKFILL_ENABLED=false
 *   4.  apply refused when PLATFORM_ADMIN_BACKFILL_APPLY=false
 *   5.  apply refused outside SAFE_CLONE/SAFE_STAGING
 *   6.  apply inserts PlatformAdmin SUPER for eligible user
 *   7.  apply does not duplicate an existing PlatformAdmin row
 *   8.  apply skips deleted/inactive user
 *   9.  apply does not promote a user attached to a non-system agency
 *  10.  multiple system-agency membership handled deterministically or reported
 *  11.  Agency.isSystem unchanged after apply
 *  12.  rerun apply is idempotent (second run inserts 0)
 *  13.  PlatformAuditLog write status documented (deferred or present)
 *  14.  PlatformAdmin readiness report wiring intact
 *  15.  Phase 3.4 employee unique harness wiring intact
 *  16.  cumulative regression chain outputs present
 */
/* eslint-disable no-console */
import { promises as fs } from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { Client } from 'pg';
import { autoLoadEnv, formatDatabaseUrlMissingMessage } from './../phase1/reconciliation/lib/env';

autoLoadEnv(__filename);

const BACKEND_ROOT = path.resolve(__dirname, '..', '..', '..');
const PHASE3_REPORTS = path.resolve(BACKEND_ROOT, 'reports', 'saas', 'phase3');
const SCRIPT = path.resolve(__dirname, 'platform-admin-backfill.ts');

const SEED = '00000000-0000-0000-0000-0000000035';
const ID = {
  sysAgency:  `${SEED}SA`,
  normAgency: `${SEED}NA`,
  eligible:   `${SEED}U1`,  // active user on system agency
  deleted:    `${SEED}U2`,  // deleted user on system agency
  inactive:   `${SEED}U3`,  // inactive user on system agency
  normal:     `${SEED}U4`,  // active user on non-system agency
  preExist:   `${SEED}U5`,  // active user on system agency that already has PlatformAdmin
};

interface CaseResult { name: string; ok: boolean; detail: string; }

function getDatabaseUrl(): string {
  const arg = process.argv.find((a) => a.startsWith('--db='))?.slice(5);
  return arg ?? process.env.DATABASE_URL ?? (() => { throw new Error(formatDatabaseUrlMissingMessage()); })();
}
function pgClient(url: string): Client {
  return new Client({ connectionString: url, ssl: /127\.0\.0\.1|localhost/.test(url) ? false : { rejectUnauthorized: false } });
}
function runScript(env: Record<string, string | undefined>): { stdout: string; code: number } {
  try {
    const stdout = execSync(`node -r ts-node/register ${SCRIPT}`,
      { cwd: BACKEND_ROOT, env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'] }).toString();
    return { stdout, code: 0 };
  } catch (err: any) {
    return { stdout: (err.stdout?.toString() ?? '') + (err.stderr?.toString() ?? ''), code: err.status ?? 1 };
  }
}
async function exists(p: string): Promise<boolean> { return fs.stat(p).then(() => true).catch(() => false); }

async function seed(c: Client): Promise<{ roleId: string }> {
  // We need a Role. Pick the first existing one (read-only).
  const ro = await c.query<{ id: string }>(`SELECT id FROM roles LIMIT 1`);
  const roleId = ro.rows[0].id;

  // Two synthetic agencies — one isSystem, one not.
  await c.query(`
    INSERT INTO agencies (id, name, country, "contactPerson", email, phone, "createdAt", "updatedAt")
    VALUES
      ($1, 'Phase350 System', 'XX', 'C', 'sys@p350.test', '0', now(), now()),
      ($2, 'Phase350 Normal', 'XX', 'C', 'nor@p350.test', '0', now(), now())
    ON CONFLICT (id) DO NOTHING
  `, [ID.sysAgency, ID.normAgency]);

  // Five users.
  await c.query(`
    INSERT INTO users (id, email, "passwordHash", "firstName", "lastName", "roleId", "agencyId", status, "createdAt", "updatedAt")
    VALUES
      ($1, 'p350-u1@e.com', 'h', 'E','One',  $6, $7, 'ACTIVE',   now(), now()),
      ($2, 'p350-u2@e.com', 'h', 'D','Del',  $6, $7, 'ACTIVE',   now(), now()),
      ($3, 'p350-u3@e.com', 'h', 'I','Nact', $6, $7, 'INACTIVE', now(), now()),
      ($4, 'p350-u4@e.com', 'h', 'N','Norm', $6, $8, 'ACTIVE',   now(), now()),
      ($5, 'p350-u5@e.com', 'h', 'P','Pre',  $6, $7, 'ACTIVE',   now(), now())
    ON CONFLICT (id) DO NOTHING
  `, [ID.eligible, ID.deleted, ID.inactive, ID.normal, ID.preExist, roleId, ID.sysAgency, ID.normAgency]);

  // Mark u2 as soft-deleted (status stays ACTIVE; deletedAt set).
  await c.query(`UPDATE users SET "deletedAt" = now() WHERE id = $1`, [ID.deleted]);

  // u5 already has a PlatformAdmin row (level SUPPORT — we will verify the
  // backfill does not overwrite the level).
  await c.query(`
    INSERT INTO platform_admins (id, "userId", level, "grantedBy", "grantedAt")
    VALUES (gen_random_uuid()::text, $1, 'SUPPORT', 'pre-existing', now())
    ON CONFLICT ("userId") DO NOTHING
  `, [ID.preExist]);

  return { roleId };
}

async function teardown(c: Client): Promise<void> {
  await c.query(`DELETE FROM platform_admins WHERE "userId" = ANY($1)`,
    [[ID.eligible, ID.deleted, ID.inactive, ID.normal, ID.preExist]]);
  await c.query(`DELETE FROM users WHERE id = ANY($1)`,
    [[ID.eligible, ID.deleted, ID.inactive, ID.normal, ID.preExist]]);
  await c.query(`DELETE FROM agencies WHERE id = ANY($1)`,
    [[ID.sysAgency, ID.normAgency]]);
}

async function main(): Promise<void> {
  const url = getDatabaseUrl();
  const out: CaseResult[] = [];
  const c = pgClient(url); await c.connect();

  try {
    await teardown(c);
    await seed(c);

    // 1 — dry-run (no flags) inserts zero rows.
    const beforeC = Number((await c.query<{ c: string }>(`SELECT COUNT(*)::text AS c FROM platform_admins`)).rows[0].c);
    runScript({ DATABASE_URL: url });
    const dryJson = JSON.parse(await fs.readFile(path.join(PHASE3_REPORTS, 'platform-admin-backfill.json'), 'utf8'));
    const afterDry = Number((await c.query<{ c: string }>(`SELECT COUNT(*)::text AS c FROM platform_admins`)).rows[0].c);
    out.push({ name: '1. dry-run inserts zero rows',
      ok: dryJson.mode === 'dry-run' && dryJson.insertedCount === 0 && beforeC === afterDry,
      detail: `mode=${dryJson.mode} inserted=${dryJson.insertedCount} before=${beforeC} after=${afterDry}` });
    // 2 — dry-run reports eligible system-agency user
    // Phase 3.9 — Agency.isSystem column dropped; the backfill discovery
    // criterion is now unreachable. Dry-run reports 0 eligible users.
    out.push({ name: '2. dry-run reports 0 eligible (Phase 3.9 retired legacy criterion)',
      ok: dryJson.eligibleCount === 0, detail: `eligible=${dryJson.eligibleCount}` });

    // 3 — apply refused when ENABLED=false
    runScript({ DATABASE_URL: url, PLATFORM_ADMIN_BACKFILL_ENABLED: 'false', PLATFORM_ADMIN_BACKFILL_APPLY: 'true' });
    const j3 = JSON.parse(await fs.readFile(path.join(PHASE3_REPORTS, 'platform-admin-backfill.json'), 'utf8'));
    out.push({ name: '3. apply refused when PLATFORM_ADMIN_BACKFILL_ENABLED=false',
      ok: j3.mode === 'dry-run' && /ENABLED/.test(j3.refusalReason ?? '') && j3.insertedCount === 0,
      detail: `mode=${j3.mode} reason="${j3.refusalReason}"` });
    // 4 — apply refused when APPLY=false (no refusal recorded, but mode should remain dry-run)
    runScript({ DATABASE_URL: url, PLATFORM_ADMIN_BACKFILL_ENABLED: 'true', PLATFORM_ADMIN_BACKFILL_APPLY: 'false' });
    const j4 = JSON.parse(await fs.readFile(path.join(PHASE3_REPORTS, 'platform-admin-backfill.json'), 'utf8'));
    out.push({ name: '4. apply refused when PLATFORM_ADMIN_BACKFILL_APPLY=false',
      ok: j4.mode === 'dry-run' && j4.insertedCount === 0,
      detail: `mode=${j4.mode} reason="${j4.refusalReason}"` });

    // 5 — apply refused outside SAFE — point at example.com remote.
    runScript({ DATABASE_URL: 'postgres://x:y@example.com:5432/db',
      PLATFORM_ADMIN_BACKFILL_ENABLED: 'true', PLATFORM_ADMIN_BACKFILL_APPLY: 'true' });
    const j5 = JSON.parse(await fs.readFile(path.join(PHASE3_REPORTS, 'platform-admin-backfill.json'), 'utf8'));
    out.push({ name: '5. apply refused outside SAFE_CLONE/SAFE_STAGING',
      ok: j5.mode === 'dry-run' && /SAFE|classification/.test(j5.refusalReason ?? '') && j5.insertedCount === 0,
      detail: `mode=${j5.mode} reason="${j5.refusalReason}"` });

    // 6 — Phase 3.9 supersedes: Agency.isSystem column dropped, so the
    // backfill script always finds 0 eligible candidates (legacy criterion
    // unreachable). Apply runs cleanly with 0 inserts.
    runScript({ DATABASE_URL: url, PLATFORM_ADMIN_BACKFILL_ENABLED: 'true', PLATFORM_ADMIN_BACKFILL_APPLY: 'true' });
    const j6 = JSON.parse(await fs.readFile(path.join(PHASE3_REPORTS, 'platform-admin-backfill.json'), 'utf8'));
    out.push({ name: '6. apply inserts 0 PlatformAdmin rows (Phase 3.9 retired legacy criterion)',
      ok: j6.mode === 'apply' && j6.insertedCount === 0,
      detail: `inserted=${j6.insertedCount} mode=${j6.mode}` });

    // 7 — pre-existing PlatformAdmin row was not modified
    const preRow = (await c.query<{ level: string; grantedBy: string }>(
      `SELECT level, "grantedBy" FROM platform_admins WHERE "userId" = $1`, [ID.preExist])).rows[0];
    out.push({ name: '7. apply does not duplicate or modify existing PlatformAdmin row',
      ok: preRow?.level === 'SUPPORT' && preRow?.grantedBy === 'pre-existing',
      detail: `level=${preRow?.level} grantedBy=${preRow?.grantedBy}` });

    // 8 — deleted/inactive users not promoted
    const delRow = (await c.query<{ c: string }>(
      `SELECT COUNT(*)::text AS c FROM platform_admins WHERE "userId" IN ($1, $2)`,
      [ID.deleted, ID.inactive])).rows[0];
    out.push({ name: '8. apply skips deleted/inactive users',
      ok: delRow.c === '0', detail: `inserted-deleted/inactive=${delRow.c}` });

    // 9 — non-system agency user not promoted
    const normRow = (await c.query<{ c: string }>(
      `SELECT COUNT(*)::text AS c FROM platform_admins WHERE "userId" = $1`, [ID.normal])).rows[0];
    out.push({ name: '9. apply does not promote non-system agency user',
      ok: normRow.c === '0', detail: `inserted=${normRow.c}` });

    // 10 — multi-system-agency handling: report surfaces a count
    out.push({ name: '10. multiple system-agency membership handled deterministically or reported',
      ok: typeof j6.skippedCounts?.multipleSystemAgencies === 'number',
      detail: `multiSystemAgencies=${j6.skippedCounts?.multipleSystemAgencies}` });

    // 11 — Phase 3.9 — Agency.isSystem column dropped. Verify the agency
    // row itself is intact (not mutated by backfill apply).
    const sysRow = (await c.query<{ id: string }>(
      `SELECT id FROM agencies WHERE id = $1`, [ID.sysAgency])).rows[0];
    out.push({ name: '11. Agency row remains unchanged after apply (Phase 3.9 — column dropped)',
      ok: sysRow?.id === ID.sysAgency, detail: `sysAgency=${sysRow?.id ?? 'missing'}` });

    // 12 — idempotency: second apply inserts 0
    runScript({ DATABASE_URL: url, PLATFORM_ADMIN_BACKFILL_ENABLED: 'true', PLATFORM_ADMIN_BACKFILL_APPLY: 'true' });
    const j12 = JSON.parse(await fs.readFile(path.join(PHASE3_REPORTS, 'platform-admin-backfill.json'), 'utf8'));
    out.push({ name: '12. rerun apply is idempotent (second run inserts 0)',
      ok: j12.mode === 'apply' && j12.insertedCount === 0,
      detail: `inserted=${j12.insertedCount} eligible=${j12.eligibleCount}` });

    // 13 — PlatformAuditLog deferred status documented
    out.push({ name: '13. PlatformAuditLog status documented (deferred when table absent)',
      ok: j12.platformAuditLogDeferred === true,
      detail: `deferred=${j12.platformAuditLogDeferred}` });

  } finally {
    try { await teardown(c); } catch { /* noop */ }
    await c.end();
  }

  // Cross-phase wiring
  const pkg = await fs.readFile(path.join(BACKEND_ROOT, 'package.json'), 'utf8');
  out.push({ name: '14. PlatformAdmin readiness report wiring intact',
    ok: /saas:phase310-platform-admin-readiness-report/.test(pkg), detail: 'pkg.json' });
  out.push({ name: '15. Phase 3.4 employee unique harness wiring intact',
    ok: /saas:phase340-drop-employee-global-uniques/.test(pkg), detail: 'pkg.json' });
  const sentinels = [
    ['phase2', 'pipeline-equivalence.json'], ['phase2', 'pipeline-isolation.json'],
    ['phase2', 'pipeline-mutation-isolation.json'], ['phase2', 'workflow-config-isolation.json'],
    ['phase3', 'product-migration-readiness.json'], ['phase3', 'phase31-readiness-check.json'],
    ['phase3', 'duplicate-cleanup-harness.json'], ['phase3', 'per-tenant-unique-constraints.json'],
    ['phase3', 'drop-employee-global-uniques.json'],
  ];
  const checks = await Promise.all(sentinels.map(([d, f]) => exists(path.join(BACKEND_ROOT, 'reports', 'saas', d, f))));
  out.push({ name: '16. cumulative regression chain outputs present',
    ok: checks.every(Boolean), detail: `present=${checks.filter(Boolean).length}/${sentinels.length}` });

  await fs.mkdir(PHASE3_REPORTS, { recursive: true });
  const passed = out.filter((c) => c.ok).length;
  const total = out.length;
  await fs.writeFile(path.join(PHASE3_REPORTS, 'platform-admin-backfill-harness.json'),
    JSON.stringify({ passed, total, cases: out }, null, 2));
  const md = [
    `# Phase 3.5 — PlatformAdmin backfill harness`, ``,
    `**${passed}/${total} PASS**`, ``,
    ...out.map((c) => `- ${c.ok ? 'PASS' : 'FAIL'} — ${c.name} — ${c.detail}`), ``,
  ].join('\n');
  await fs.writeFile(path.join(PHASE3_REPORTS, 'platform-admin-backfill-harness.md'), md);
  console.log(`[platform-admin-backfill-harness] ${passed}/${total} PASS`);
  process.exit(passed === total ? 0 : 1);
}

main().catch((err) => { console.error(err); process.exit(2); });
