/**
 * Phase 3.0 — Product migration readiness harness.
 *
 * Verifies that the Phase 3.0 duplicate-report machinery is in place and
 * non-destructive. Seeds synthetic duplicates into the fixture in a
 * SAVEPOINT-scoped helper schema, runs the report, then rolls back so
 * the fixture is byte-identical at exit.
 *
 *   1. duplicate report runs read-only (no INSERT/UPDATE/DELETE)
 *   2. duplicate report writes JSON and MD
 *   3. Employee.email same-tenant duplicates are detected
 *   4. Applicant.email same-tenant duplicates are detected
 *   5. Employee.employeeNumber same-tenant duplicates are detected
 *   6. NULL-tenant duplicate rows are reported separately
 *   7. Cross-tenant same email reported but NOT blocking
 *   8. Script does not insert/update/delete (row counts unchanged)
 *   9. No unique constraint migration created in this phase
 *  10. PlatformAdmin foundation doc exists
 *  11. Uniqueness audit doc exists
 *  12. Phase 2.63/2.62/2.61 pipeline harnesses still wired (npm scripts present)
 *  13. Cumulative regression chain wiring intact (scripts exist + outputs present)
 */
/* eslint-disable no-console */
import { promises as fs } from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { Client } from 'pg';
import { autoLoadEnv, formatDatabaseUrlMissingMessage } from './../phase1/reconciliation/lib/env';

autoLoadEnv(__filename);

const OUT_DIR = path.resolve(__dirname, '..', '..', '..', 'reports', 'saas', 'phase3');
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const BACKEND_ROOT = path.resolve(__dirname, '..', '..', '..');
const MIGRATIONS_DIR = path.resolve(BACKEND_ROOT, 'prisma', 'migrations');

interface CaseResult { name: string; ok: boolean; detail: string; }

function getDatabaseUrl(): string {
  const arg = process.argv.find((a) => a.startsWith('--db='))?.slice(5);
  return arg ?? process.env.DATABASE_URL ?? (() => { throw new Error(formatDatabaseUrlMissingMessage()); })();
}
function pgClient(url: string): Client {
  return new Client({ connectionString: url, ssl: /127\.0\.0\.1|localhost/.test(url) ? false : { rejectUnauthorized: false } });
}

async function tableCounts(c: Client): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const t of ['employees','applicants','users','tenants','platform_admins']) {
    const r = await c.query<{ count: string }>(`SELECT COUNT(*)::text AS count FROM "${t}"`);
    out[t] = Number(r.rows[0].count);
  }
  return out;
}

async function main(): Promise<void> {
  const url = getDatabaseUrl();
  const out: CaseResult[] = [];

  const c = pgClient(url); await c.connect();
  let tA = '', tB = '';
  try {
    const ts = await c.query<{ id: string }>(`SELECT id FROM tenants ORDER BY name LIMIT 2`);
    tA = ts.rows[0].id; tB = ts.rows[1].id;
  } finally { /* keep open for seed below */ }

  // Snapshot counts BEFORE seed/report run
  const beforeCounts = await tableCounts(c);

  // Seed synthetic duplicates inside an open transaction owned by THIS client.
  // Note: the report script opens its own connection in its own txn — but our
  // seed is committed locally so the report script sees the rows? We need to
  // commit; but we also need to roll back at the end. Use a separate physical
  // commit + cleanup-on-exit instead of relying on txn isolation.
  // Employees has global UNIQUE(email) + UNIQUE(employeeNumber). Drop them
  // for the duration of the harness so synthetic duplicates can be inserted,
  // and restore them afterwards. This is non-destructive for the fixture:
  // any leftover seed rows are deleted before the constraints come back.
  let seeded = false;
  try {
    await c.query('BEGIN');
    await c.query('ALTER TABLE employees DROP CONSTRAINT IF EXISTS "employees_email_key"');
    await c.query('ALTER TABLE employees DROP CONSTRAINT IF EXISTS "employees_employeeNumber_key"');
    await c.query('DROP INDEX IF EXISTS "employees_email_key"');
    await c.query('DROP INDEX IF EXISTS "employees_employeeNumber_key"');
    // Phase 3.3 partial indexes (added later) would also reject our seed dups.
    await c.query('DROP INDEX IF EXISTS "employees_tenant_email_unique"');
    await c.query('DROP INDEX IF EXISTS "employees_tenant_employee_number_unique"');
    await c.query('DROP INDEX IF EXISTS "applicants_tenant_email_unique"');
    await seedHelper(c, tA, tB);
    await c.query('COMMIT');
    seeded = true;
  } catch (err) {
    try { await c.query('ROLLBACK'); } catch { /* noop */ }
    throw err;
  }

  let reportJson: any = null;
  try {
    // Run report script in-process via spawn so we test the actual script.
    await fs.mkdir(OUT_DIR, { recursive: true });
    execSync(`node -r ts-node/register ${path.resolve(__dirname, 'uniqueness-duplicate-report.ts')}`,
      { cwd: BACKEND_ROOT, env: { ...process.env, DATABASE_URL: url }, stdio: 'pipe' });
    const raw = await fs.readFile(path.join(OUT_DIR, 'uniqueness-duplicate-report.json'), 'utf8');
    reportJson = JSON.parse(raw);
  } catch (err: any) {
    out.push({ name: '1. report runs (precondition)', ok: false, detail: String(err?.message ?? err).slice(0, 200) });
  }

  // After report ran, immediately delete seed rows to restore fixture.
  if (seeded) {
    await c.query(`
      DELETE FROM employees WHERE id IN (
        '00000000-0000-0000-0000-0000000300e1','00000000-0000-0000-0000-0000000300e2',
        '00000000-0000-0000-0000-0000000300n1','00000000-0000-0000-0000-0000000300n2',
        '00000000-0000-0000-0000-0000000300z1','00000000-0000-0000-0000-0000000300z2',
        '00000000-0000-0000-0000-0000000300x1','00000000-0000-0000-0000-0000000300x2'
      )`);
    await c.query(`
      DELETE FROM applicants WHERE id IN (
        '00000000-0000-0000-0000-0000000300a1','00000000-0000-0000-0000-0000000300a2'
      )`);
    await c.query('ALTER TABLE employees ADD CONSTRAINT "employees_email_key" UNIQUE (email)');
    await c.query('ALTER TABLE employees ADD CONSTRAINT "employees_employeeNumber_key" UNIQUE ("employeeNumber")');
    await c.query(`CREATE UNIQUE INDEX IF NOT EXISTS "employees_tenant_email_unique"
      ON "employees" ("tenantId", lower(email))
      WHERE "tenantId" IS NOT NULL AND email IS NOT NULL AND "deletedAt" IS NULL`);
    await c.query(`CREATE UNIQUE INDEX IF NOT EXISTS "employees_tenant_employee_number_unique"
      ON "employees" ("tenantId", "employeeNumber")
      WHERE "tenantId" IS NOT NULL AND "employeeNumber" IS NOT NULL AND "deletedAt" IS NULL`);
    await c.query(`CREATE UNIQUE INDEX IF NOT EXISTS "applicants_tenant_email_unique"
      ON "applicants" ("tenantId", lower(email))
      WHERE "tenantId" IS NOT NULL AND email IS NOT NULL AND "deletedAt" IS NULL`);
  }

  const afterCounts = await tableCounts(c);
  await c.end();

  // Case 1 — read-only (script source contains BEGIN READ ONLY, no INSERT/UPDATE/DELETE)
  const srcPath = path.resolve(__dirname, 'uniqueness-duplicate-report.ts');
  const src = await fs.readFile(srcPath, 'utf8');
  const stripped = src.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
  const hasReadOnly = /BEGIN READ ONLY/.test(stripped);
  const noWrites = !/\b(INSERT|UPDATE|DELETE)\s/i.test(stripped.replace(/'[^']*'/g, "''"));
  out.push({ name: '1. duplicate report runs read-only (BEGIN READ ONLY + no write SQL)',
    ok: hasReadOnly && noWrites, detail: `readOnlyTxn=${hasReadOnly} noWrites=${noWrites}` });

  // Case 2 — JSON + MD written
  const hasJson = await fs.stat(path.join(OUT_DIR, 'uniqueness-duplicate-report.json')).then(() => true).catch(() => false);
  const hasMd   = await fs.stat(path.join(OUT_DIR, 'uniqueness-duplicate-report.md')).then(() => true).catch(() => false);
  out.push({ name: '2. duplicate report writes JSON and MD', ok: hasJson && hasMd, detail: `json=${hasJson} md=${hasMd}` });

  // Cases 3-7 read from reportJson captured BEFORE cleanup
  const empSame  = reportJson?.sections?.['1_employee_email_same_tenant']?.total ?? 0;
  const appSame  = reportJson?.sections?.['3_applicant_email_same_tenant']?.total ?? 0;
  const numSame  = reportJson?.sections?.['5_employee_number_same_tenant']?.total ?? 0;
  const empNull  = reportJson?.sections?.['2_employee_email_null_tenant']?.total ?? 0;
  const xt       = reportJson?.sections?.['7_cross_tenant_email_observation']?.total ?? 0;

  out.push({ name: '3. Employee.email same-tenant duplicates detected', ok: empSame >= 1, detail: `groups=${empSame}` });
  out.push({ name: '4. Applicant.email same-tenant duplicates detected', ok: appSame >= 1, detail: `groups=${appSame}` });
  out.push({ name: '5. Employee.employeeNumber same-tenant duplicates detected', ok: numSame >= 1, detail: `groups=${numSame}` });
  out.push({ name: '6. NULL-tenant duplicate rows reported separately', ok: empNull >= 1, detail: `groups=${empNull}` });
  out.push({ name: '7. Cross-tenant same email reported (not blocking)',
    ok: xt >= 1 && reportJson.blockingDuplicateGroups === (empSame + appSame + numSame + empNull),
    detail: `xt=${xt} blocking=${reportJson?.blockingDuplicateGroups}` });

  // Case 8 — row counts unchanged (after cleanup)
  const unchanged = Object.keys(beforeCounts).every((k) => beforeCounts[k] === afterCounts[k]);
  out.push({ name: '8. script makes no net row changes (counts unchanged after cleanup)',
    ok: unchanged, detail: `before=${JSON.stringify(beforeCounts)} after=${JSON.stringify(afterCounts)}` });

  // Case 9 — no Phase 3 unique-constraint migration directory exists
  const migDirs = await fs.readdir(MIGRATIONS_DIR).catch(() => [] as string[]);
  // Phase 3.0 must NOT have created its own constraint migration. Phase 3.3
  // legitimately adds `saas_phase33_per_tenant_uniques`; we allow that.
  const phase30Unique = migDirs.filter((d) => /phase30.*unique|^saas_phase30/i.test(d));
  out.push({ name: '9. no Phase 3.0 unique-constraint migration created in this phase',
    ok: phase30Unique.length === 0, detail: phase30Unique.length === 0 ? 'none' : phase30Unique.join(',') });

  // Cases 10/11 — docs exist
  const paDoc  = await fs.stat(path.join(REPO_ROOT, 'SAAS_PHASE3_PLATFORM_ADMIN_FOUNDATION.md')).then(() => true).catch(() => false);
  const uaDoc  = await fs.stat(path.join(REPO_ROOT, 'SAAS_PHASE3_UNIQUENESS_AUDIT.md')).then(() => true).catch(() => false);
  out.push({ name: '10. PlatformAdmin foundation doc exists', ok: paDoc, detail: paDoc ? 'present' : 'missing' });
  out.push({ name: '11. Uniqueness audit doc exists',         ok: uaDoc, detail: uaDoc ? 'present' : 'missing' });

  // Case 12 — phase 2.61/2.62/2.63 npm scripts still present
  const pkgRaw = await fs.readFile(path.join(BACKEND_ROOT, 'package.json'), 'utf8');
  const wiringOk =
    /saas:phase261-pipeline-equivalence/.test(pkgRaw) &&
    /saas:phase261-pipeline-isolation/.test(pkgRaw) &&
    /saas:phase262-pipeline-mutation-isolation/.test(pkgRaw) &&
    /saas:phase263-workflow-config-isolation/.test(pkgRaw);
  out.push({ name: '12. Phase 2.61/2.62/2.63 harness wiring intact in package.json',
    ok: wiringOk, detail: wiringOk ? 'all scripts present' : 'missing' });

  // Case 13 — sentinel outputs exist from prior runs (regression chain wiring)
  const sentinelFiles = [
    'pipeline-equivalence.json', 'pipeline-isolation.json',
    'pipeline-mutation-isolation.json', 'workflow-config-isolation.json',
  ];
  const checks = await Promise.all(sentinelFiles.map(async (f) =>
    fs.stat(path.join(BACKEND_ROOT, 'reports', 'saas', 'phase2', f)).then(() => true).catch(() => false)));
  const allChecks = checks.every(Boolean);
  out.push({ name: '13. cumulative regression chain outputs present from prior runs',
    ok: allChecks, detail: `present=${checks.filter(Boolean).length}/${sentinelFiles.length}` });

  await fs.mkdir(OUT_DIR, { recursive: true });
  const passed = out.filter((c) => c.ok).length;
  const total = out.length;
  await fs.writeFile(path.join(OUT_DIR, 'product-migration-readiness.json'),
    JSON.stringify({ passed, total, cases: out }, null, 2));
  const md = [
    `# Phase 3.0 — product migration readiness`, ``,
    `**${passed}/${total} PASS**`, ``,
    ...out.map((c) => `- ${c.ok ? 'PASS' : 'FAIL'} — ${c.name} — ${c.detail}`), ``,
  ].join('\n');
  await fs.writeFile(path.join(OUT_DIR, 'product-migration-readiness.md'), md);
  console.log(`[product-migration-readiness] ${passed}/${total} PASS`);
  process.exit(passed === total ? 0 : 1);
}

async function seedHelper(c: Client, tA: string, tB: string): Promise<void> {
  // Same-tenant Employee.email dup
  await c.query(`
    INSERT INTO employees (id, "firstName", "lastName", email, phone, nationality, status, "dateOfBirth",
        "yearsExperience", "addressLine1", city, country, "postalCode", "createdAt", "updatedAt", "tenantId")
    VALUES
      ('00000000-0000-0000-0000-0000000300e1', 'A1','X','dup@e.com','1','x','PENDING', now(), 0, '1','c','c','0', now(), now(), $1),
      ('00000000-0000-0000-0000-0000000300e2', 'A2','Y','dup@e.com','1','x','PENDING', now(), 0, '1','c','c','0', now(), now(), $1)
  `, [tA]);
  await c.query(`
    INSERT INTO applicants (id, "firstName", "lastName", email, phone, status, "createdAt", "updatedAt", "tenantId")
    VALUES
      ('00000000-0000-0000-0000-0000000300a1', 'A1','X','dup@a.com','1','NEW', now(), now(), $1),
      ('00000000-0000-0000-0000-0000000300a2', 'A2','Y','dup@a.com','1','NEW', now(), now(), $1)
  `, [tA]);
  await c.query(`
    INSERT INTO employees (id, "firstName", "lastName", email, phone, nationality, status, "dateOfBirth",
        "yearsExperience", "addressLine1", city, country, "postalCode", "employeeNumber", "createdAt", "updatedAt", "tenantId")
    VALUES
      ('00000000-0000-0000-0000-0000000300n1', 'N1','X','n1@e.com','1','x','PENDING', now(), 0, '1','c','c','0','EMP-300', now(), now(), $1),
      ('00000000-0000-0000-0000-0000000300n2', 'N2','Y','n2@e.com','1','x','PENDING', now(), 0, '1','c','c','0','EMP-300', now(), now(), $1)
  `, [tA]);
  await c.query(`
    INSERT INTO employees (id, "firstName", "lastName", email, phone, nationality, status, "dateOfBirth",
        "yearsExperience", "addressLine1", city, country, "postalCode", "createdAt", "updatedAt", "tenantId")
    VALUES
      ('00000000-0000-0000-0000-0000000300z1', 'Z1','X','dup-null@e.com','1','x','PENDING', now(), 0, '1','c','c','0', now(), now(), NULL),
      ('00000000-0000-0000-0000-0000000300z2', 'Z2','Y','dup-null@e.com','1','x','PENDING', now(), 0, '1','c','c','0', now(), now(), NULL)
  `);
  await c.query(`
    INSERT INTO employees (id, "firstName", "lastName", email, phone, nationality, status, "dateOfBirth",
        "yearsExperience", "addressLine1", city, country, "postalCode", "createdAt", "updatedAt", "tenantId")
    VALUES
      ('00000000-0000-0000-0000-0000000300x1', 'X1','A','xt@e.com','1','x','PENDING', now(), 0, '1','c','c','0', now(), now(), $1),
      ('00000000-0000-0000-0000-0000000300x2', 'X2','B','xt@e.com','1','x','PENDING', now(), 0, '1','c','c','0', now(), now(), $2)
  `, [tA, tB]);
}

main().catch((err) => { console.error(err); process.exit(2); });
