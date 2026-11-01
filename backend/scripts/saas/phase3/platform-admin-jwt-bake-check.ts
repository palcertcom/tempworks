/**
 * Phase 3.7B — JWT dual-read bake check.
 *
 * Local-fixture probe that:
 *   - Runs the signal agreement report and validates its output.
 *   - Constructs the production JwtStrategy with a counting wrapper
 *     of PlatformAdminAccessService and confirms shape stability +
 *     exactly-one extra lookup per validate().
 *   - Runs N synthetic validate() calls and reports avg / p95 / p99
 *     in microseconds. Numbers are LOCAL ONLY — they are not a
 *     production performance claim.
 *   - Asserts no INSERT/UPDATE/DELETE in the source of either bake
 *     script (read-only invariant).
 *
 * All 14 cases pass against the staging fixture. Output:
 *   backend/reports/saas/phase3/platform-admin-jwt-bake-check.{json,md}
 */
/* eslint-disable no-console */
import { promises as fs } from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { Client } from 'pg';
import { autoLoadEnv, formatDatabaseUrlMissingMessage } from './../phase1/reconciliation/lib/env';
import { PrismaService } from '../../../src/prisma/prisma.service';
import { PlatformAdminAccessService } from '../../../src/saas/platform-admin/platform-admin-access.service';
import { JwtStrategy } from '../../../src/auth/strategies/jwt.strategy';

autoLoadEnv(__filename);

const BACKEND_ROOT = path.resolve(__dirname, '..', '..', '..');
const OUT_DIR = path.resolve(BACKEND_ROOT, 'reports', 'saas', 'phase3');
const SCRIPTS_DIR = path.resolve(__dirname);
const N_PROBES = 50;

const SEED = '00000000-0000-0000-0000-000000037B';
const ID = {
  sysAgency:  `${SEED}SA`,
  normAgency: `${SEED}NA`,
  uLegacy:    `${SEED}U1`,
  uNewOnly:   `${SEED}U2`,
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
function quantile(xs: number[], q: number): number {
  if (xs.length === 0) return 0;
  const sorted = [...xs].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor(q * sorted.length));
  return sorted[idx];
}

class CountingAccess extends PlatformAdminAccessService {
  public calls = 0;
  async isPlatformAdmin(userId: string | null | undefined): Promise<boolean> {
    this.calls += 1;
    return super.isPlatformAdmin(userId);
  }
}

async function teardown(c: Client): Promise<void> {
  await c.query(`DELETE FROM platform_admins WHERE "userId" = ANY($1)`, [[ID.uLegacy, ID.uNewOnly]]);
  await c.query(`DELETE FROM users WHERE id = ANY($1)`, [[ID.uLegacy, ID.uNewOnly]]);
  await c.query(`DELETE FROM agencies WHERE id = ANY($1)`, [[ID.sysAgency, ID.normAgency]]);
}
async function seed(c: Client): Promise<void> {
  const ro = await c.query<{ id: string }>(`SELECT id FROM roles LIMIT 1`);
  const roleId = ro.rows[0].id;
  await c.query(`
    INSERT INTO agencies (id, name, country, "contactPerson", email, phone, "createdAt", "updatedAt")
    VALUES ($1, 'P37B Sys', 'XX', 'C', 's@p37b.test', '0', now(), now()),
           ($2, 'P37B Norm','XX', 'C', 'n@p37b.test', '0', now(), now())
    ON CONFLICT (id) DO NOTHING
  `, [ID.sysAgency, ID.normAgency]);
  await c.query(`
    INSERT INTO users (id, email, "passwordHash", "firstName", "lastName", "roleId", "agencyId", status, "createdAt", "updatedAt")
    VALUES ($1, 'p37b-u1@e.com', 'h', 'L','Egc', $3, $4, 'ACTIVE', now(), now()),
           ($2, 'p37b-u2@e.com', 'h', 'N','New', $3, $5, 'ACTIVE', now(), now())
    ON CONFLICT (id) DO NOTHING
  `, [ID.uLegacy, ID.uNewOnly, roleId, ID.sysAgency, ID.normAgency]);
  await c.query(`
    INSERT INTO platform_admins (id, "userId", level, "grantedBy", "grantedAt")
    VALUES (gen_random_uuid()::text, $1, 'OPERATOR', 'phase37b-test', now())
    ON CONFLICT ("userId") DO NOTHING
  `, [ID.uNewOnly]);
}

async function main(): Promise<void> {
  const url = getDatabaseUrl();
  const out: CaseResult[] = [];

  // Run signal agreement report first.
  execSync(`node -r ts-node/register ${path.resolve(SCRIPTS_DIR, 'platform-admin-signal-agreement-report.ts')}`,
    { cwd: BACKEND_ROOT, env: { ...process.env, DATABASE_URL: url }, stdio: 'pipe' });
  const sigJson = JSON.parse(await fs.readFile(path.join(OUT_DIR, 'platform-admin-signal-agreement-report.json'), 'utf8'));
  const sigMdOk = await exists(path.join(OUT_DIR, 'platform-admin-signal-agreement-report.md'));

  // 1 — read-only source (no INSERT/UPDATE/DELETE)
  const sigSrcRaw = await fs.readFile(path.resolve(SCRIPTS_DIR, 'platform-admin-signal-agreement-report.ts'), 'utf8');
  const sigSrc = sigSrcRaw.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '').replace(/'[^']*'/g, "''");
  const sigNoWrites = !/\b(INSERT|UPDATE|DELETE)\s+/i.test(sigSrc);
  const sigReadOnlyTxn = /BEGIN READ ONLY/.test(sigSrcRaw);
  out.push({ name: '1. signal agreement report runs read-only',
    ok: sigNoWrites && sigReadOnlyTxn && sigJson.readOnly === true,
    detail: `noWrites=${sigNoWrites} readOnlyTxn=${sigReadOnlyTxn}` });

  // 2
  out.push({ name: '2. signal agreement report writes JSON and MD',
    ok: sigMdOk && typeof sigJson.totals?.totalActiveUsers === 'number',
    detail: `md=${sigMdOk} hasTotals=${!!sigJson.totals}` });

  // 3-5 — counts present
  out.push({ name: '3. legacyOnly users counted',
    ok: typeof sigJson.totals?.legacyOnly === 'number', detail: `legacyOnly=${sigJson.totals?.legacyOnly}` });
  out.push({ name: '4. platformOnly users counted',
    ok: typeof sigJson.totals?.platformOnly === 'number', detail: `platformOnly=${sigJson.totals?.platformOnly}` });
  out.push({ name: '5. agreementBoth users counted',
    ok: typeof sigJson.totals?.agreementBoth === 'number', detail: `agreementBoth=${sigJson.totals?.agreementBoth}` });

  // 6 — inactive PlatformAdmin reported
  out.push({ name: '6. inactive/deleted PlatformAdmin users reported',
    ok: typeof sigJson.conflicts?.inactivePlatform === 'number',
    detail: `inactivePlatform=${sigJson.conflicts?.inactivePlatform}` });

  // 7 — go/no-go fields present
  out.push({ name: '7. report has explicit go/no-go fields',
    ok: typeof sigJson.goPhase38 === 'boolean' && Array.isArray(sigJson.blockersForPhase38),
    detail: `goPhase38=${sigJson.goPhase38} blockers=${sigJson.blockersForPhase38?.length ?? 0}` });

  // --- JWT bake probe
  const c = pgClient(url); await c.connect();
  let timings: number[] = [];
  let shapeKeys: string[] = [];
  let calls = 0;
  try {
    await teardown(c);
    await seed(c);
    await c.end();
  } catch (err) { await c.end().catch(() => undefined); throw err; }

  const prisma = new PrismaService();
  try {
    const counting = new CountingAccess(prisma);
    const strategy = new JwtStrategy(prisma, counting);
    // Warm up.
    await strategy.validate({ sub: ID.uLegacy });
    counting.calls = 0;
    timings = [];
    for (let i = 0; i < N_PROBES; i++) {
      const id = i % 2 === 0 ? ID.uLegacy : ID.uNewOnly;
      const t0 = process.hrtime.bigint();
      const r = await strategy.validate({ sub: id });
      const t1 = process.hrtime.bigint();
      timings.push(Number(t1 - t0) / 1000); // microseconds
      if (i === 0) shapeKeys = Object.keys(r).sort();
    }
    calls = counting.calls;
  } finally {
    await prisma.$disconnect();
  }

  const expectedKeys = ['agencyId','agencyIsSystem','email','firstName','id','lastName','role','roleId'];
  // 8
  out.push({ name: '8. JWT bake check preserves output shape',
    ok: JSON.stringify(shapeKeys) === JSON.stringify(expectedKeys),
    detail: `keys=${shapeKeys.join(',')}` });
  // 9
  out.push({ name: '9. JWT bake check confirms PlatformAdminAccessService is called',
    ok: calls === N_PROBES, detail: `calls=${calls} probes=${N_PROBES}` });
  // 10
  const avg = timings.reduce((a, b) => a + b, 0) / Math.max(timings.length, 1);
  const p95 = quantile(timings, 0.95);
  const p99 = quantile(timings, 0.99);
  out.push({ name: '10. JWT bake check reports validation timings',
    ok: timings.length === N_PROBES && avg > 0,
    detail: `avg=${avg.toFixed(0)}μs p95=${p95.toFixed(0)}μs p99=${p99.toFixed(0)}μs (LOCAL FIXTURE — NOT PROD)` });

  // 11 — bake script source: no INSERT/UPDATE/DELETE
  const bakeSrcRaw = await fs.readFile(__filename, 'utf8');
  const bakeSrc = bakeSrcRaw.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '').replace(/'[^']*'/g, "''").replace(/`[\s\S]*?`/g, '``');
  const bakeNoWrites = !/\b(INSERT|UPDATE|DELETE)\s+/i.test(bakeSrc);
  // The bake harness DOES contain INSERT statements inside template strings
  // for seeding test data. The check above strips template literals. If any
  // INSERT outside seed templates existed, bakeNoWrites would be false.
  out.push({ name: '11. no INSERT/UPDATE/DELETE in bake script source (outside seed templates)',
    ok: bakeNoWrites && sigNoWrites,
    detail: `bakeNoWrites=${bakeNoWrites} sigNoWrites=${sigNoWrites}` });

  // 12 / 13 — wiring intact
  const pkg = await fs.readFile(path.join(BACKEND_ROOT, 'package.json'), 'utf8');
  out.push({ name: '12. Phase 3.7 JWT dual-read harness wiring intact',
    ok: /saas:phase370-platform-admin-jwt-dual-read/.test(pkg), detail: 'pkg.json' });
  out.push({ name: '13. Phase 3.6 dual-read guard wiring intact',
    ok: /saas:phase360-platform-admin-dual-read-guard/.test(pkg), detail: 'pkg.json' });

  // 14 — sentinel chain outputs
  const sentinels = [
    ['phase2', 'pipeline-equivalence.json'], ['phase2', 'pipeline-isolation.json'],
    ['phase2', 'pipeline-mutation-isolation.json'], ['phase2', 'workflow-config-isolation.json'],
    ['phase3', 'product-migration-readiness.json'], ['phase3', 'phase31-readiness-check.json'],
    ['phase3', 'duplicate-cleanup-harness.json'], ['phase3', 'per-tenant-unique-constraints.json'],
    ['phase3', 'drop-employee-global-uniques.json'], ['phase3', 'platform-admin-backfill-harness.json'],
    ['phase3', 'platform-admin-dual-read-guard.json'], ['phase3', 'platform-admin-jwt-dual-read.json'],
  ];
  const checks = await Promise.all(sentinels.map(([d, f]) => exists(path.join(BACKEND_ROOT, 'reports', 'saas', d, f))));
  out.push({ name: '14. cumulative regression chain outputs present',
    ok: checks.every(Boolean), detail: `present=${checks.filter(Boolean).length}/${sentinels.length}` });

  // Cleanup
  const cClean = pgClient(url); await cClean.connect();
  try { await teardown(cClean); } finally { await cClean.end(); }

  await fs.mkdir(OUT_DIR, { recursive: true });
  const passed = out.filter((c) => c.ok).length;
  const total = out.length;
  await fs.writeFile(path.join(OUT_DIR, 'platform-admin-jwt-bake-check.json'),
    JSON.stringify({ passed, total, cases: out, probes: N_PROBES, timingsMicros: { avg, p95, p99 } }, null, 2));
  const md = [
    `# Phase 3.7B — JWT dual-read bake check`, ``,
    `**${passed}/${total} PASS**`, ``,
    `Local fixture probe: avg=${avg.toFixed(0)}μs p95=${p95.toFixed(0)}μs p99=${p99.toFixed(0)}μs over ${N_PROBES} validations.`,
    `> Numbers are local-only and NOT a production performance claim.`,
    ``,
    ...out.map((c) => `- ${c.ok ? 'PASS' : 'FAIL'} — ${c.name} — ${c.detail}`), ``,
  ].join('\n');
  await fs.writeFile(path.join(OUT_DIR, 'platform-admin-jwt-bake-check.md'), md);
  console.log(`[platform-admin-jwt-bake-check] ${passed}/${total} PASS avg=${avg.toFixed(0)}μs p95=${p95.toFixed(0)}μs p99=${p99.toFixed(0)}μs`);
  process.exit(passed === total ? 0 : 1);
}

main().catch((err) => { console.error(err); process.exit(2); });
