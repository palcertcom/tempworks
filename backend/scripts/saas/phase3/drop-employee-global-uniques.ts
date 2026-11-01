/**
 * Phase 3.4 — Drop legacy global Employee UNIQUEs harness.
 *
 * Source-level assertions on migration SQL (what it touches and what
 * it leaves alone) plus DB-level behaviour assertions after applying
 * the migration. Restores the fixture state at exit so other harnesses
 * keep running.
 *
 *   1.  migration SQL contains no DROP for User.email
 *   2.  migration SQL contains no DROP for Applicant indexes
 *   3.  migration SQL does not drop Phase 3.3 per-tenant indexes
 *   4.  migration SQL drops only exact global Employee.email uniqueness
 *   5.  migration SQL drops only exact global Employee.employeeNumber uniqueness
 *   6.  migration SQL contains no UPDATE/DELETE data mutation
 *   7.  after migration, same Employee.email in different tenants is allowed
 *   8.  after migration, same Employee.employeeNumber in different tenants is allowed
 *   9.  same Employee.email in same tenant is still rejected by employees_tenant_email_unique
 *  10.  same Employee.employeeNumber in same tenant is still rejected by employees_tenant_employee_number_unique
 *  11.  User.email duplicate is still rejected globally
 *  12.  Applicant same-tenant email duplicate is still rejected
 *  13.  Applicant cross-tenant same email behavior remains as Phase 3.3 (allowed)
 *  14.  down migration restores global Employee.email uniqueness
 *  15.  down migration restores global Employee.employeeNumber uniqueness
 *  16.  down migration failure caveat documented when cross-tenant duplicates exist
 *  17.  Phase 3.3 harness wiring intact in package.json (updated for new behavior)
 *  18.  Phase 3.2 cleanup harness wiring intact
 *  19.  Phase 3.1 readiness wiring intact
 *  20.  cumulative regression chain outputs present
 */
/* eslint-disable no-console */
import { promises as fs } from 'fs';
import path from 'path';
import { Client } from 'pg';
import { autoLoadEnv, formatDatabaseUrlMissingMessage } from './../phase1/reconciliation/lib/env';

autoLoadEnv(__filename);

const BACKEND_ROOT = path.resolve(__dirname, '..', '..', '..');
const OUT_DIR = path.resolve(BACKEND_ROOT, 'reports', 'saas', 'phase3');
const MIG_DIR = path.resolve(BACKEND_ROOT, 'prisma', 'migrations', 'saas_phase34_drop_employee_global_uniques');
const UP_SQL  = path.join(MIG_DIR, 'migration.sql');
const DN_SQL  = path.join(MIG_DIR, 'migration.down.sql');

const SEED = '00000000-0000-0000-0000-0000000034';
const ID = {
  xA: `${SEED}xA`, xB: `${SEED}xB`,
  nA: `${SEED}nA`, nB: `${SEED}nB`,
  sA: `${SEED}sA`, sB: `${SEED}sB`,
  qA: `${SEED}qA`, qB: `${SEED}qB`,
  uA: `${SEED}uA`, uB: `${SEED}uB`, // users
  aA: `${SEED}aA`, aB: `${SEED}aB`,
  yA: `${SEED}yA`, yB: `${SEED}yB`,
};
const ALL_EMP = [ID.xA, ID.xB, ID.nA, ID.nB, ID.sA, ID.sB, ID.qA, ID.qB];
const ALL_USR = [ID.uA, ID.uB];
const ALL_APP = [ID.aA, ID.aB, ID.yA, ID.yB];

interface CaseResult { name: string; ok: boolean; detail: string; }

function getDatabaseUrl(): string {
  const arg = process.argv.find((a) => a.startsWith('--db='))?.slice(5);
  return arg ?? process.env.DATABASE_URL ?? (() => { throw new Error(formatDatabaseUrlMissingMessage()); })();
}
function pgClient(url: string): Client {
  return new Client({ connectionString: url, ssl: /127\.0\.0\.1|localhost/.test(url) ? false : { rejectUnauthorized: false } });
}
async function tryInsert(c: Client, sql: string, params: any[]): Promise<{ ok: boolean; code: string | null; constraint: string | null }> {
  try { await c.query(sql, params); return { ok: true, code: null, constraint: null }; }
  catch (err: any) { return { ok: false, code: err?.code ?? null, constraint: err?.constraint ?? null }; }
}
async function exists(p: string): Promise<boolean> { return fs.stat(p).then(() => true).catch(() => false); }

async function cleanupSeed(c: Client): Promise<void> {
  await c.query(`DELETE FROM applicants WHERE id = ANY($1)`, [ALL_APP]);
  await c.query(`DELETE FROM employees  WHERE id = ANY($1)`, [ALL_EMP]);
  await c.query(`DELETE FROM users      WHERE id = ANY($1)`, [ALL_USR]);
}

async function main(): Promise<void> {
  const url = getDatabaseUrl();
  const out: CaseResult[] = [];

  // --- Source-level assertions
  const up = await fs.readFile(UP_SQL, 'utf8');
  const dn = await fs.readFile(DN_SQL, 'utf8');
  const upClean = up.replace(/--.*$/gm, '');
  const dnClean = dn.replace(/--.*$/gm, '');

  out.push({ name: '1. migration SQL contains no DROP for User.email',
    ok: !/(users_email_key|users\([^)]*email\))/i.test(upClean) && !/\busers\b/i.test(upClean.replace(/'[^']*'/g, "''")),
    detail: /users/i.test(upClean) ? 'users mentioned' : 'no users mention' });
  out.push({ name: '2. migration SQL contains no DROP for Applicant indexes',
    ok: !/applicants_/i.test(upClean) && !/\bapplicants\b/i.test(upClean),
    detail: /applicants/i.test(upClean) ? 'applicants mentioned' : 'none' });
  out.push({ name: '3. migration SQL does not drop Phase 3.3 per-tenant indexes',
    ok: !/employees_tenant_email_unique|employees_tenant_employee_number_unique|applicants_tenant_email_unique/i.test(upClean),
    detail: 'no per-tenant index name in up' });
  // Look for the standard Prisma-generated constraint names and verify the
  // migration contains a partial-index safety check (`WHERE` clause guard)
  // before any DROP INDEX. The DO block's `def !~* 'WHERE'` guard ensures
  // partial indexes are never dropped.
  const hasEmailDrop = /employees_email_key/.test(upClean) && /DROP\s+CONSTRAINT|DROP\s+INDEX/i.test(upClean);
  const hasWhereGuard = /def\s*!~\*\s*'WHERE'/i.test(upClean);
  out.push({ name: '4. migration SQL drops only exact global Employee.email uniqueness',
    ok: hasEmailDrop && hasWhereGuard,
    detail: `emailDrop=${hasEmailDrop} whereGuard=${hasWhereGuard}` });
  out.push({ name: '5. migration SQL drops only exact global Employee.employeeNumber uniqueness',
    ok: /employees_employeeNumber_key/.test(upClean) && /"employeeNumber"/.test(upClean) && hasWhereGuard,
    detail: 'guarded by partial-index check' });
  out.push({ name: '6. migration SQL contains no UPDATE/DELETE data mutation',
    ok: !/\b(UPDATE|DELETE)\s+(?:FROM\s+)?["a-z_]+/i.test(upClean.replace(/'[^']*'/g, "''")),
    detail: 'no UPDATE/DELETE in up' });

  // --- DB-level: apply migration, run behavioural tests, restore at teardown.
  const c = pgClient(url); await c.connect();
  let restoreNeeded = false;
  let tA = '', tB = '';
  try {
    await cleanupSeed(c);

    // Self-heal: ensure globals are present before applying Phase 3.4 (so the
    // migration has something to drop and case 11 has a baseline). Also
    // ensure Phase 3.3 partial indexes exist.
    try { await c.query('ALTER TABLE employees ADD CONSTRAINT "employees_email_key" UNIQUE (email)'); }
    catch { /* already present */ }
    try { await c.query('ALTER TABLE employees ADD CONSTRAINT "employees_employeeNumber_key" UNIQUE ("employeeNumber")'); }
    catch { /* already present */ }
    await c.query(`CREATE UNIQUE INDEX IF NOT EXISTS "employees_tenant_email_unique"
      ON "employees" ("tenantId", lower(email))
      WHERE "tenantId" IS NOT NULL AND email IS NOT NULL AND "deletedAt" IS NULL`);
    await c.query(`CREATE UNIQUE INDEX IF NOT EXISTS "employees_tenant_employee_number_unique"
      ON "employees" ("tenantId", "employeeNumber")
      WHERE "tenantId" IS NOT NULL AND "employeeNumber" IS NOT NULL AND "deletedAt" IS NULL`);
    await c.query(`CREATE UNIQUE INDEX IF NOT EXISTS "applicants_tenant_email_unique"
      ON "applicants" ("tenantId", lower(email))
      WHERE "tenantId" IS NOT NULL AND email IS NOT NULL AND "deletedAt" IS NULL`);

    const tn = await c.query<{ id: string }>(`SELECT id FROM tenants ORDER BY name LIMIT 2`);
    tA = tn.rows[0].id; tB = tn.rows[1].id;

    // Apply Phase 3.4 migration
    await c.query(up);
    restoreNeeded = true;

    // 7 — cross-tenant Employee.email now allowed
    await c.query(`INSERT INTO employees (id,"firstName","lastName",email,phone,nationality,status,
        "dateOfBirth","yearsExperience","addressLine1",city,country,"postalCode","createdAt","updatedAt","tenantId")
      VALUES ($1,'X','A','xt340@e.com','1','x','PENDING',now(),0,'1','c','c','0',now(),now(),$2)`,
      [ID.xA, tA]);
    const r7 = await tryInsert(c, `INSERT INTO employees (id,"firstName","lastName",email,phone,nationality,status,
        "dateOfBirth","yearsExperience","addressLine1",city,country,"postalCode","createdAt","updatedAt","tenantId")
      VALUES ($1,'X','B','xt340@e.com','1','x','PENDING',now(),0,'1','c','c','0',now(),now(),$2)`,
      [ID.xB, tB]);
    out.push({ name: '7. after migration, same Employee.email in different tenants is allowed',
      ok: r7.ok, detail: r7.ok ? 'inserted' : `rejected ${r7.code} ${r7.constraint}` });

    // 8 — cross-tenant Employee.employeeNumber now allowed
    await c.query(`INSERT INTO employees (id,"firstName","lastName",email,phone,nationality,status,
        "dateOfBirth","yearsExperience","addressLine1",city,country,"postalCode","employeeNumber","createdAt","updatedAt","tenantId")
      VALUES ($1,'N','A','n340a@e.com','1','x','PENDING',now(),0,'1','c','c','0','EMP-340',now(),now(),$2)`,
      [ID.nA, tA]);
    const r8 = await tryInsert(c, `INSERT INTO employees (id,"firstName","lastName",email,phone,nationality,status,
        "dateOfBirth","yearsExperience","addressLine1",city,country,"postalCode","employeeNumber","createdAt","updatedAt","tenantId")
      VALUES ($1,'N','B','n340b@e.com','1','x','PENDING',now(),0,'1','c','c','0','EMP-340',now(),now(),$2)`,
      [ID.nB, tB]);
    out.push({ name: '8. after migration, same Employee.employeeNumber in different tenants is allowed',
      ok: r8.ok, detail: r8.ok ? 'inserted' : `rejected ${r8.code} ${r8.constraint}` });

    // 9 — same-tenant Employee.email still rejected by per-tenant partial index
    const r9 = await tryInsert(c, `INSERT INTO employees (id,"firstName","lastName",email,phone,nationality,status,
        "dateOfBirth","yearsExperience","addressLine1",city,country,"postalCode","createdAt","updatedAt","tenantId")
      VALUES ($1,'S','dup','xt340@e.com','1','x','PENDING',now(),0,'1','c','c','0',now(),now(),$2)`,
      [ID.sA, tA]);
    out.push({ name: '9. same-tenant Employee.email still rejected by employees_tenant_email_unique',
      ok: !r9.ok && /employees_tenant_email_unique/.test(r9.constraint ?? ''),
      detail: `code=${r9.code} constraint=${r9.constraint}` });

    // 10 — same-tenant Employee.employeeNumber still rejected
    const r10 = await tryInsert(c, `INSERT INTO employees (id,"firstName","lastName",email,phone,nationality,status,
        "dateOfBirth","yearsExperience","addressLine1",city,country,"postalCode","employeeNumber","createdAt","updatedAt","tenantId")
      VALUES ($1,'Q','dup','q340@e.com','1','x','PENDING',now(),0,'1','c','c','0','EMP-340',now(),now(),$2)`,
      [ID.qA, tA]);
    out.push({ name: '10. same-tenant Employee.employeeNumber still rejected by employees_tenant_employee_number_unique',
      ok: !r10.ok && /employees_tenant_employee_number_unique/.test(r10.constraint ?? ''),
      detail: `code=${r10.code} constraint=${r10.constraint}` });

    // 11 — User.email global UNIQUE still in place. We need a valid agencyId and roleId.
    const ag = await c.query<{ id: string }>(`SELECT id FROM agencies LIMIT 1`);
    const ro = await c.query<{ id: string }>(`SELECT id FROM roles LIMIT 1`);
    const agencyId = ag.rows[0]?.id, roleId = ro.rows[0]?.id;
    if (agencyId && roleId) {
      await c.query(`INSERT INTO users (id, email, "passwordHash", "firstName","lastName","roleId","agencyId","createdAt","updatedAt")
        VALUES ($1,'u340@e.com','h','U','A',$2,$3,now(),now())`, [ID.uA, roleId, agencyId]);
      const r11 = await tryInsert(c, `INSERT INTO users (id, email, "passwordHash", "firstName","lastName","roleId","agencyId","createdAt","updatedAt")
        VALUES ($1,'u340@e.com','h','U','B',$2,$3,now(),now())`, [ID.uB, roleId, agencyId]);
      out.push({ name: '11. User.email duplicate is still rejected globally',
        ok: !r11.ok && r11.code === '23505',
        detail: `code=${r11.code} constraint=${r11.constraint}` });
    } else {
      out.push({ name: '11. User.email duplicate is still rejected globally',
        ok: false, detail: `missing agency or role (agency=${!!agencyId} role=${!!roleId})` });
    }

    // 12 — Applicant same-tenant email duplicate still rejected
    await c.query(`INSERT INTO applicants (id,"firstName","lastName",email,phone,status,"createdAt","updatedAt","tenantId")
      VALUES ($1,'A','A','a340@a.com','1','NEW',now(),now(),$2)`, [ID.aA, tA]);
    const r12 = await tryInsert(c, `INSERT INTO applicants (id,"firstName","lastName",email,phone,status,"createdAt","updatedAt","tenantId")
      VALUES ($1,'A','B','A340@a.com','1','NEW',now(),now(),$2)`, [ID.aB, tA]);
    out.push({ name: '12. Applicant same-tenant email duplicate is still rejected',
      ok: !r12.ok && /applicants_tenant_email_unique/.test(r12.constraint ?? ''),
      detail: `code=${r12.code} constraint=${r12.constraint}` });

    // 13 — Applicant cross-tenant same email allowed (Phase 3.3 behaviour preserved)
    await c.query(`INSERT INTO applicants (id,"firstName","lastName",email,phone,status,"createdAt","updatedAt","tenantId")
      VALUES ($1,'A','C','y340@a.com','1','NEW',now(),now(),$2)`, [ID.yA, tA]);
    const r13 = await tryInsert(c, `INSERT INTO applicants (id,"firstName","lastName",email,phone,status,"createdAt","updatedAt","tenantId")
      VALUES ($1,'A','D','y340@a.com','1','NEW',now(),now(),$2)`, [ID.yB, tB]);
    out.push({ name: '13. Applicant cross-tenant same email behavior remains (allowed)',
      ok: r13.ok, detail: r13.ok ? 'inserted' : `rejected ${r13.code} ${r13.constraint}` });

    // 14 / 15 — down migration restores globals. We must first delete the
    // cross-tenant duplicates we just inserted (cases 7+8) so the recreate
    // succeeds. This is exactly the operator-side workflow.
    await c.query(`DELETE FROM employees WHERE id = ANY($1)`, [[ID.xB, ID.nB]]);
    await c.query(dn);
    const cons = await c.query<{ name: string }>(
      `SELECT conname AS name FROM pg_constraint
        WHERE conrelid='employees'::regclass AND contype='u'`);
    const conNames = cons.rows.map((r) => r.name);
    const idx = await c.query<{ name: string }>(
      `SELECT indexname AS name FROM pg_indexes WHERE tablename='employees'`);
    const idxNames = idx.rows.map((r) => r.name);
    const hasEmail = conNames.includes('employees_email_key') || idxNames.includes('employees_email_key');
    const hasNum   = conNames.includes('employees_employeeNumber_key') || idxNames.includes('employees_employeeNumber_key');
    out.push({ name: '14. down migration restores global Employee.email uniqueness',
      ok: hasEmail, detail: hasEmail ? 'present' : 'missing' });
    out.push({ name: '15. down migration restores global Employee.employeeNumber uniqueness',
      ok: hasNum, detail: hasNum ? 'present' : 'missing' });

    // 16 — down migration failure caveat documented in down SQL
    const downHasCaveat = /WILL FAIL|FAIL.*cross-tenant duplicate|backup/i.test(dn);
    out.push({ name: '16. down migration failure caveat documented when cross-tenant duplicates exist',
      ok: downHasCaveat, detail: downHasCaveat ? 'documented' : 'missing' });

    // Re-apply Phase 3.4 so we leave the DB in the post-migration state
    // (this is the production-target state). Cross-tenant duplicates have
    // already been cleaned, so re-apply is safe.
    await c.query(up);
    // restoreNeeded stays true so teardown will re-add globals.

  } finally {
    try { await cleanupSeed(c); } catch { /* noop */ }
    // Restore globals for downstream harnesses (and rollback Phase 3.4 in the
    // shared fixture so other phases continue to operate as before).
    if (restoreNeeded) {
      try { await c.query('ALTER TABLE employees ADD CONSTRAINT "employees_email_key" UNIQUE (email)'); }
      catch { /* may already exist */ }
      try { await c.query('ALTER TABLE employees ADD CONSTRAINT "employees_employeeNumber_key" UNIQUE ("employeeNumber")'); }
      catch { /* may already exist */ }
    }
    await c.end();
  }

  // --- Cross-phase wiring
  const pkg = await fs.readFile(path.join(BACKEND_ROOT, 'package.json'), 'utf8');
  out.push({ name: '17. Phase 3.3 per-tenant unique harness wiring intact in package.json',
    ok: /saas:phase330-per-tenant-unique-constraints/.test(pkg), detail: 'pkg.json' });
  out.push({ name: '18. Phase 3.2 cleanup harness wiring intact',
    ok: /saas:phase320-duplicate-cleanup-harness/.test(pkg), detail: 'pkg.json' });
  out.push({ name: '19. Phase 3.1 readiness wiring intact',
    ok: /saas:phase310-readiness-check/.test(pkg), detail: 'pkg.json' });
  const sentinels = [
    ['phase2', 'pipeline-equivalence.json'], ['phase2', 'pipeline-isolation.json'],
    ['phase2', 'pipeline-mutation-isolation.json'], ['phase2', 'workflow-config-isolation.json'],
    ['phase3', 'product-migration-readiness.json'], ['phase3', 'phase31-readiness-check.json'],
    ['phase3', 'duplicate-cleanup-harness.json'], ['phase3', 'per-tenant-unique-constraints.json'],
  ];
  const checks = await Promise.all(sentinels.map(([d, f]) => exists(path.join(BACKEND_ROOT, 'reports', 'saas', d, f))));
  out.push({ name: '20. cumulative regression chain outputs present',
    ok: checks.every(Boolean), detail: `present=${checks.filter(Boolean).length}/${sentinels.length}` });

  await fs.mkdir(OUT_DIR, { recursive: true });
  const passed = out.filter((c) => c.ok).length;
  const total = out.length;
  await fs.writeFile(path.join(OUT_DIR, 'drop-employee-global-uniques.json'),
    JSON.stringify({ passed, total, cases: out }, null, 2));
  const md = [
    `# Phase 3.4 — drop legacy global Employee UNIQUEs`, ``,
    `**${passed}/${total} PASS**`, ``,
    ...out.map((c) => `- ${c.ok ? 'PASS' : 'FAIL'} — ${c.name} — ${c.detail}`), ``,
  ].join('\n');
  await fs.writeFile(path.join(OUT_DIR, 'drop-employee-global-uniques.md'), md);
  console.log(`[drop-employee-global-uniques] ${passed}/${total} PASS`);
  process.exit(passed === total ? 0 : 1);
}

main().catch((err) => { console.error(err); process.exit(2); });
