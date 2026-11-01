/**
 * Phase 3.2 — Duplicate cleanup harness.
 *
 * Seeds a deterministic mix of duplicate groups, runs plan + apply
 * under multiple flag/classification combinations, then asserts the
 * 22 safety invariants of Phase 3.2. Restores the fixture at exit.
 *
 *   1. plan runs read-only
 *   2. plan writes JSON and MD
 *   3. Employee.email exact same-tenant dup detected
 *   4. Employee.employeeNumber exact same-tenant dup detected
 *   5. Applicant.email exact same-tenant dup detected
 *   6. conflicting active dup classified as conflicting_active (not exact)
 *   7. NULL-tenant dup reported separately
 *   8. cross-tenant same email reported as observation, not blocker
 *   9. plan MD masks emails
 *  10. apply refused when PHASE3_DUPLICATE_CLEANUP_ENABLED=false
 *  11. apply refused when PHASE3_DUPLICATE_CLEANUP_APPLY=false
 *  12. apply refused outside SAFE_CLONE/SAFE_STAGING
 *  13. apply soft-deletes only exact duplicate lower-priority row
 *  14. apply does not mutate conflicting_active group
 *  15. apply does not mutate NULL-tenant rows
 *  16. apply does not mutate cross-tenant observation rows
 *  17. apply is idempotent (second run no-ops)
 *  18. before/after duplicate count decreases for exact groups
 *  19. no hard-delete source calls exist
 *  20. Phase 3.1 readiness wiring intact
 *  21. Phase 3.0 readiness wiring intact
 *  22. cumulative regression chain outputs present
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
const PHASE3_SCRIPTS = path.resolve(__dirname);

const SEED_PREFIX = '00000000-0000-0000-0000-0000000032';
const ID = {
  empExact1:  `${SEED_PREFIX}E1`, empExact2:  `${SEED_PREFIX}E2`,
  empNum1:    `${SEED_PREFIX}N1`, empNum2:    `${SEED_PREFIX}N2`,
  appExact1:  `${SEED_PREFIX}A1`, appExact2:  `${SEED_PREFIX}A2`,
  empConfA:   `${SEED_PREFIX}C1`, empConfB:   `${SEED_PREFIX}C2`,
  empNullA:   `${SEED_PREFIX}Z1`, empNullB:   `${SEED_PREFIX}Z2`,
  empXtA:     `${SEED_PREFIX}X1`, empXtB:     `${SEED_PREFIX}X2`,
};
const ALL_EMP_IDS = [ID.empExact1, ID.empExact2, ID.empNum1, ID.empNum2,
  ID.empConfA, ID.empConfB, ID.empNullA, ID.empNullB, ID.empXtA, ID.empXtB];
const ALL_APP_IDS = [ID.appExact1, ID.appExact2];

interface CaseResult { name: string; ok: boolean; detail: string; }

function getDatabaseUrl(): string {
  const arg = process.argv.find((a) => a.startsWith('--db='))?.slice(5);
  return arg ?? process.env.DATABASE_URL ?? (() => { throw new Error(formatDatabaseUrlMissingMessage()); })();
}
function pgClient(url: string): Client {
  return new Client({ connectionString: url, ssl: /127\.0\.0\.1|localhost/.test(url) ? false : { rejectUnauthorized: false } });
}
async function exists(p: string): Promise<boolean> { return fs.stat(p).then(() => true).catch(() => false); }

async function tenantIds(c: Client): Promise<{ tA: string; tB: string }> {
  const r = await c.query<{ id: string }>(`SELECT id FROM tenants ORDER BY name LIMIT 2`);
  return { tA: r.rows[0].id, tB: r.rows[1].id };
}

async function cleanupSeed(c: Client): Promise<void> {
  await c.query(`DELETE FROM applicants WHERE id = ANY($1)`, [ALL_APP_IDS]);
  await c.query(`DELETE FROM employees  WHERE id = ANY($1)`, [ALL_EMP_IDS]);
}

async function seed(c: Client, tA: string, tB: string): Promise<void> {
  await cleanupSeed(c);
  // Drop global UNIQUE indexes so synthetic dups can land.
  await c.query('ALTER TABLE employees DROP CONSTRAINT IF EXISTS "employees_email_key"');
  await c.query('ALTER TABLE employees DROP CONSTRAINT IF EXISTS "employees_employeeNumber_key"');
  await c.query('DROP INDEX IF EXISTS "employees_email_key"');
  await c.query('DROP INDEX IF EXISTS "employees_employeeNumber_key"');
  // Also drop Phase 3.3 partial unique indexes — they would block our
  // synthetic exact dups (same-tenant same-email/employeeNumber). Restored
  // at teardown together with the global constraints.
  await c.query('DROP INDEX IF EXISTS "employees_tenant_email_unique"');
  await c.query('DROP INDEX IF EXISTS "employees_tenant_employee_number_unique"');
  await c.query('DROP INDEX IF EXISTS "applicants_tenant_email_unique"');

  // exact employee.email — both active, no dependents
  await c.query(`
    INSERT INTO employees (id, "firstName", "lastName", email, phone, nationality, status,
        "dateOfBirth", "yearsExperience", "addressLine1", city, country, "postalCode",
        "createdAt", "updatedAt", "tenantId")
    VALUES
      ($1, 'X','exact','exact320@e.com','1','x','PENDING', now(), 0,'1','c','c','0', now() - interval '365 days', now() - interval '365 days', $3),
      ($2, 'X','exact','exact320@e.com','1','x','PENDING', now(), 0,'1','c','c','0', now(), now(), $3)
  `, [ID.empExact1, ID.empExact2, tA]);

  // exact employee.employeeNumber
  await c.query(`
    INSERT INTO employees (id, "firstName", "lastName", email, phone, nationality, status,
        "dateOfBirth", "yearsExperience", "addressLine1", city, country, "postalCode",
        "employeeNumber", "createdAt", "updatedAt", "tenantId")
    VALUES
      ($1, 'N','old','n320old@e.com','1','x','PENDING', now(), 0,'1','c','c','0','EMP-320', now() - interval '365 days', now() - interval '365 days', $3),
      ($2, 'N','new','n320new@e.com','1','x','PENDING', now(), 0,'1','c','c','0','EMP-320', now(), now(), $3)
  `, [ID.empNum1, ID.empNum2, tA]);

  // exact applicant.email
  await c.query(`
    INSERT INTO applicants (id, "firstName", "lastName", email, phone, status, "createdAt", "updatedAt", "tenantId")
    VALUES
      ($1, 'X','exact','exact320@a.com','1','NEW', now() - interval '365 days', now() - interval '365 days', $3),
      ($2, 'X','exact','exact320@a.com','1','NEW', now(), now(), $3)
  `, [ID.appExact1, ID.appExact2, tA]);

  // conflicting active employee.email — both active AND lower-priority has dependents.
  await c.query(`
    INSERT INTO employees (id, "firstName", "lastName", email, phone, nationality, status,
        "dateOfBirth", "yearsExperience", "addressLine1", city, country, "postalCode",
        "createdAt", "updatedAt", "tenantId")
    VALUES
      ($1, 'C','one','conf320@e.com','1','x','PENDING', now(), 0,'1','c','c','0', now() - interval '300 days', now() - interval '300 days', $3),
      ($2, 'C','two','conf320@e.com','1','x','PENDING', now(), 0,'1','c','c','0', now(), now(), $3)
  `, [ID.empConfA, ID.empConfB, tA]);
  // Give the OLDER row (which would otherwise be lower-priority) a dependent
  // so the classifier flips the group to conflicting_active.
  await c.query(`
    INSERT INTO attendance_records (id, "employeeId", date, status,
        "createdAt", "updatedAt", "tenantId")
    SELECT gen_random_uuid()::text, $1, current_date - 1, 'PRESENT',
           now(), now(), $2
    WHERE NOT EXISTS (SELECT 1 FROM attendance_records WHERE "employeeId" = $1)
  `, [ID.empConfA, tA]);

  // NULL-tenant
  await c.query(`
    INSERT INTO employees (id, "firstName", "lastName", email, phone, nationality, status,
        "dateOfBirth", "yearsExperience", "addressLine1", city, country, "postalCode",
        "createdAt", "updatedAt", "tenantId")
    VALUES
      ($1, 'Z','a','null320@e.com','1','x','PENDING', now(), 0,'1','c','c','0', now(), now(), NULL),
      ($2, 'Z','b','null320@e.com','1','x','PENDING', now(), 0,'1','c','c','0', now(), now(), NULL)
  `, [ID.empNullA, ID.empNullB]);

  // cross-tenant
  await c.query(`
    INSERT INTO employees (id, "firstName", "lastName", email, phone, nationality, status,
        "dateOfBirth", "yearsExperience", "addressLine1", city, country, "postalCode",
        "createdAt", "updatedAt", "tenantId")
    VALUES
      ($1, 'X','tA','xt320@e.com','1','x','PENDING', now(), 0,'1','c','c','0', now(), now(), $3),
      ($2, 'X','tB','xt320@e.com','1','x','PENDING', now(), 0,'1','c','c','0', now(), now(), $4)
  `, [ID.empXtA, ID.empXtB, tA, tB]);
}

async function teardown(c: Client): Promise<void> {
  await c.query(`DELETE FROM attendance_records WHERE "employeeId" = ANY($1)`, [ALL_EMP_IDS]);
  await cleanupSeed(c);
  await c.query('ALTER TABLE employees ADD CONSTRAINT "employees_email_key" UNIQUE (email)');
  await c.query('ALTER TABLE employees ADD CONSTRAINT "employees_employeeNumber_key" UNIQUE ("employeeNumber")');
  // Restore the Phase 3.3 partial unique indexes if they existed before this run.
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

function runScript(rel: string, env: Record<string, string | undefined>): { stdout: string; code: number } {
  try {
    const stdout = execSync(`node -r ts-node/register ${path.resolve(PHASE3_SCRIPTS, rel)}`,
      { cwd: BACKEND_ROOT, env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'] }).toString();
    return { stdout, code: 0 };
  } catch (err: any) {
    return { stdout: (err.stdout?.toString() ?? '') + (err.stderr?.toString() ?? ''), code: err.status ?? 1 };
  }
}

async function main(): Promise<void> {
  const url = getDatabaseUrl();
  const out: CaseResult[] = [];
  const c = pgClient(url); await c.connect();

  try {
    const { tA, tB } = await tenantIds(c);
    await seed(c, tA, tB);
    await c.end();

    // --- Run plan (refuses outside SAFE; localhost is SAFE_CLONE).
    const planRun = runScript('duplicate-cleanup-plan.ts', { DATABASE_URL: url });
    const planJson = JSON.parse(await fs.readFile(path.join(PHASE3_REPORTS, 'duplicate-cleanup-plan.json'), 'utf8'));
    const planMd   = await fs.readFile(path.join(PHASE3_REPORTS, 'duplicate-cleanup-plan.md'), 'utf8');

    // 1
    const planSrcRaw = await fs.readFile(path.resolve(PHASE3_SCRIPTS, 'duplicate-cleanup-plan.ts'), 'utf8');
    const planSrc = planSrcRaw.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
    const planNoWrites = !/\b(INSERT|UPDATE|DELETE)\s/i.test(planSrc.replace(/'[^']*'/g, "''"));
    out.push({ name: '1. plan runs read-only', ok: planJson.readOnly === true && planNoWrites && planRun.code === 0,
      detail: `roJson=${planJson.readOnly} noWrites=${planNoWrites} exit=${planRun.code}` });

    // 2
    const planMdOk = await exists(path.join(PHASE3_REPORTS, 'duplicate-cleanup-plan.md'));
    out.push({ name: '2. plan writes JSON and MD', ok: planMdOk, detail: `md=${planMdOk}` });

    const groups: any[] = planJson.groups;
    const findExact = (table: string, column: string) => groups.find((g) =>
      g.bucket === 'exact' && g.table === table && g.column === column && g.softDeleteIds.length > 0);

    const empEmailExact = findExact('employees', 'email');
    const empNumExact   = findExact('employees', 'employeeNumber');
    const appEmailExact = findExact('applicants', 'email');

    out.push({ name: '3. Employee.email exact same-tenant dup detected',
      ok: !!empEmailExact && empEmailExact.softDeleteIds.includes(ID.empExact1),
      detail: empEmailExact ? `keep=${empEmailExact.keepId?.slice(0,8)} del=${empEmailExact.softDeleteIds.length}` : 'missing' });
    out.push({ name: '4. Employee.employeeNumber exact same-tenant dup detected',
      ok: !!empNumExact && empNumExact.softDeleteIds.includes(ID.empNum1),
      detail: empNumExact ? `keep=${empNumExact.keepId?.slice(0,8)}` : 'missing' });
    out.push({ name: '5. Applicant.email exact same-tenant dup detected',
      ok: !!appEmailExact && appEmailExact.softDeleteIds.includes(ID.appExact1),
      detail: appEmailExact ? `keep=${appEmailExact.keepId?.slice(0,8)}` : 'missing' });

    // 6 conflicting_active
    const confGroup = groups.find((g) => g.bucket === 'conflicting_active' &&
      g.members.some((m: any) => m.id === ID.empConfA || m.id === ID.empConfB));
    out.push({ name: '6. conflicting active dup classified as conflicting_active',
      ok: !!confGroup && confGroup.softDeleteIds.length === 0,
      detail: confGroup ? `softDel=${confGroup.softDeleteIds.length}` : 'missing' });

    // 7 null tenant
    const nullGroup = groups.find((g) => g.bucket === 'null_tenant_assignment_required' &&
      g.members.some((m: any) => m.id === ID.empNullA));
    out.push({ name: '7. NULL-tenant dup reported separately', ok: !!nullGroup, detail: nullGroup ? 'present' : 'missing' });

    // 8 cross tenant
    const xtGroup = groups.find((g) => g.bucket === 'cross_tenant_observation' && g.key === 'xt320@e.com');
    out.push({ name: '8. cross-tenant same email reported as observation, not blocker',
      ok: !!xtGroup && xtGroup.softDeleteIds.length === 0, detail: xtGroup ? 'present' : 'missing' });

    // 9 MD masks emails
    const rawEmail = /[A-Za-z0-9._%+-]{2,}@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;
    const cleaned = planMd.replace(/[A-Za-z]\*{3}@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '');
    out.push({ name: '9. plan MD masks emails', ok: !rawEmail.test(cleaned),
      detail: rawEmail.test(cleaned) ? 'raw email leaked' : 'masked' });

    // 10 apply refused when enabled=false
    const a10 = runScript('duplicate-cleanup-apply.ts', { DATABASE_URL: url,
      PHASE3_DUPLICATE_CLEANUP_ENABLED: 'false', PHASE3_DUPLICATE_CLEANUP_APPLY: 'true' });
    const o10 = JSON.parse(await fs.readFile(path.join(PHASE3_REPORTS, 'duplicate-cleanup-apply.json'), 'utf8'));
    out.push({ name: '10. apply refused when PHASE3_DUPLICATE_CLEANUP_ENABLED=false',
      ok: o10.dryRun === true && /ENABLED/.test(o10.refusedReason ?? '') && o10.rowsSoftDeleted === 0,
      detail: `dryRun=${o10.dryRun} reason="${o10.refusedReason}" rows=${o10.rowsSoftDeleted}` });
    void a10;

    // 11 apply refused when APPLY=false
    const a11 = runScript('duplicate-cleanup-apply.ts', { DATABASE_URL: url,
      PHASE3_DUPLICATE_CLEANUP_ENABLED: 'true', PHASE3_DUPLICATE_CLEANUP_APPLY: 'false' });
    const o11 = JSON.parse(await fs.readFile(path.join(PHASE3_REPORTS, 'duplicate-cleanup-apply.json'), 'utf8'));
    out.push({ name: '11. apply refused when PHASE3_DUPLICATE_CLEANUP_APPLY=false',
      ok: o11.dryRun === true && /APPLY/.test(o11.refusedReason ?? '') && o11.rowsSoftDeleted === 0,
      detail: `dryRun=${o11.dryRun} reason="${o11.refusedReason}" rows=${o11.rowsSoftDeleted}` });
    void a11;

    // 12 apply refused outside SAFE — simulate by pointing classification to UNKNOWN.
    // We do this by overriding NODE_ENV and STAGING_HOST_ALLOWLIST so env-safety
    // returns UNKNOWN/UNSAFE. Easier: point DATABASE_URL at a "remote" host. We
    // pick an unresolvable host but expect the script to refuse BEFORE
    // attempting connection, since classification is computed first.
    const a12 = runScript('duplicate-cleanup-apply.ts', {
      DATABASE_URL: 'postgres://tempworks:tempworks@example.com:5432/db',
      PHASE3_DUPLICATE_CLEANUP_ENABLED: 'true', PHASE3_DUPLICATE_CLEANUP_APPLY: 'true' });
    const o12 = JSON.parse(await fs.readFile(path.join(PHASE3_REPORTS, 'duplicate-cleanup-apply.json'), 'utf8'));
    out.push({ name: '12. apply refused outside SAFE_CLONE/SAFE_STAGING',
      ok: o12.dryRun === true && (/classification|SAFE/.test(o12.refusedReason ?? '')) && o12.rowsSoftDeleted === 0,
      detail: `dryRun=${o12.dryRun} reason="${o12.refusedReason}"` });
    void a12;

    // Reset apply outcome file by running the gated apply now (this is the real run).
    // 13 apply soft-deletes only exact duplicate lower-priority row.
    const beforeC = pgClient(url); await beforeC.connect();
    const beforeActive = Number((await beforeC.query<{ c: string }>(
      `SELECT COUNT(*)::text AS c FROM employees WHERE email='exact320@e.com' AND "tenantId"=$1 AND "deletedAt" IS NULL`, [tA])).rows[0].c);
    await beforeC.end();

    const a13 = runScript('duplicate-cleanup-apply.ts', { DATABASE_URL: url,
      PHASE3_DUPLICATE_CLEANUP_ENABLED: 'true', PHASE3_DUPLICATE_CLEANUP_APPLY: 'true' });
    const o13 = JSON.parse(await fs.readFile(path.join(PHASE3_REPORTS, 'duplicate-cleanup-apply.json'), 'utf8'));

    const afterC = pgClient(url); await afterC.connect();
    const afterActive = Number((await afterC.query<{ c: string }>(
      `SELECT COUNT(*)::text AS c FROM employees WHERE email='exact320@e.com' AND "tenantId"=$1 AND "deletedAt" IS NULL`, [tA])).rows[0].c);
    const oldDeleted = (await afterC.query<{ deletedAt: string | null }>(
      `SELECT "deletedAt" FROM employees WHERE id=$1`, [ID.empExact1])).rows[0]?.deletedAt;
    const newKept   = (await afterC.query<{ deletedAt: string | null }>(
      `SELECT "deletedAt" FROM employees WHERE id=$1`, [ID.empExact2])).rows[0]?.deletedAt;

    out.push({ name: '13. apply soft-deletes only exact duplicate lower-priority row',
      ok: o13.dryRun === false && o13.rowsSoftDeleted >= 1
          && oldDeleted !== null && newKept === null && afterActive === 1,
      detail: `softDeleted=${o13.rowsSoftDeleted} old.deletedAt=${oldDeleted ? 'set' : 'null'} new.deletedAt=${newKept ? 'set' : 'null'} active=${afterActive}` });

    // 14 conflicting active untouched
    const confA = (await afterC.query<{ deletedAt: string | null }>(`SELECT "deletedAt" FROM employees WHERE id=$1`, [ID.empConfA])).rows[0]?.deletedAt;
    const confB = (await afterC.query<{ deletedAt: string | null }>(`SELECT "deletedAt" FROM employees WHERE id=$1`, [ID.empConfB])).rows[0]?.deletedAt;
    out.push({ name: '14. apply does not mutate conflicting_active group',
      ok: confA === null && confB === null, detail: `A=${confA ? 'set' : 'null'} B=${confB ? 'set' : 'null'}` });

    // 15 null-tenant untouched
    const nA = (await afterC.query<{ deletedAt: string | null }>(`SELECT "deletedAt" FROM employees WHERE id=$1`, [ID.empNullA])).rows[0]?.deletedAt;
    const nB = (await afterC.query<{ deletedAt: string | null }>(`SELECT "deletedAt" FROM employees WHERE id=$1`, [ID.empNullB])).rows[0]?.deletedAt;
    out.push({ name: '15. apply does not mutate NULL-tenant rows',
      ok: nA === null && nB === null, detail: `A=${nA ? 'set' : 'null'} B=${nB ? 'set' : 'null'}` });

    // 16 cross-tenant untouched
    const xA = (await afterC.query<{ deletedAt: string | null }>(`SELECT "deletedAt" FROM employees WHERE id=$1`, [ID.empXtA])).rows[0]?.deletedAt;
    const xB = (await afterC.query<{ deletedAt: string | null }>(`SELECT "deletedAt" FROM employees WHERE id=$1`, [ID.empXtB])).rows[0]?.deletedAt;
    out.push({ name: '16. apply does not mutate cross-tenant observation rows',
      ok: xA === null && xB === null, detail: `A=${xA ? 'set' : 'null'} B=${xB ? 'set' : 'null'}` });

    await afterC.end();
    void a13;

    // 17 idempotency — run apply again. Must succeed and softDeleted=0.
    const a17 = runScript('duplicate-cleanup-apply.ts', { DATABASE_URL: url,
      PHASE3_DUPLICATE_CLEANUP_ENABLED: 'true', PHASE3_DUPLICATE_CLEANUP_APPLY: 'true' });
    const o17 = JSON.parse(await fs.readFile(path.join(PHASE3_REPORTS, 'duplicate-cleanup-apply.json'), 'utf8'));
    out.push({ name: '17. apply is idempotent (second run no-ops)',
      ok: o17.dryRun === false && o17.rowsSoftDeleted === 0 && o17.rowsAlreadyDeleted >= 1,
      detail: `softDeleted=${o17.rowsSoftDeleted} alreadyDeleted=${o17.rowsAlreadyDeleted}` });
    void a17;

    // 18 before/after duplicate count decreases for exact groups
    out.push({ name: '18. before/after duplicate count decreases for exact groups',
      ok: beforeActive === 2 && afterActive === 1, detail: `before=${beforeActive} after=${afterActive}` });

    // 19 no hard-delete source calls in plan/apply
    const applySrcRaw = await fs.readFile(path.resolve(PHASE3_SCRIPTS, 'duplicate-cleanup-apply.ts'), 'utf8');
    const planSrcLite = planSrcRaw.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '').replace(/'[^']*'/g, "''");
    const applySrcLite = applySrcRaw.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '').replace(/'[^']*'/g, "''");
    const hardDelete = /\bDELETE\s+FROM\b/i.test(planSrcLite) || /\bDELETE\s+FROM\b/i.test(applySrcLite);
    out.push({ name: '19. no hard-delete (DELETE FROM) source calls exist',
      ok: !hardDelete, detail: hardDelete ? 'DELETE FROM found' : 'none' });

    // 20/21/22 wiring intact
    const pkg = await fs.readFile(path.join(BACKEND_ROOT, 'package.json'), 'utf8');
    out.push({ name: '20. Phase 3.1 readiness wiring intact',
      ok: /saas:phase310-readiness-check/.test(pkg), detail: 'pkg.json' });
    out.push({ name: '21. Phase 3.0 readiness wiring intact',
      ok: /saas:phase300-product-migration-readiness/.test(pkg), detail: 'pkg.json' });
    const sentinels = [
      ['phase2', 'pipeline-equivalence.json'], ['phase2', 'pipeline-isolation.json'],
      ['phase2', 'pipeline-mutation-isolation.json'], ['phase2', 'workflow-config-isolation.json'],
      ['phase3', 'product-migration-readiness.json'], ['phase3', 'phase31-readiness-check.json'],
    ];
    const checks = await Promise.all(sentinels.map(([d, f]) => exists(path.join(BACKEND_ROOT, 'reports', 'saas', d, f))));
    out.push({ name: '22. cumulative regression chain outputs present',
      ok: checks.every(Boolean), detail: `present=${checks.filter(Boolean).length}/${sentinels.length}` });

    void planRun;
  } finally {
    const cClean = pgClient(url); await cClean.connect();
    try { await teardown(cClean); } finally { await cClean.end(); }
  }

  await fs.mkdir(PHASE3_REPORTS, { recursive: true });
  const passed = out.filter((c) => c.ok).length;
  const total = out.length;
  await fs.writeFile(path.join(PHASE3_REPORTS, 'duplicate-cleanup-harness.json'),
    JSON.stringify({ passed, total, cases: out }, null, 2));
  const md = [
    `# Phase 3.2 — duplicate cleanup harness`, ``,
    `**${passed}/${total} PASS**`, ``,
    ...out.map((c) => `- ${c.ok ? 'PASS' : 'FAIL'} — ${c.name} — ${c.detail}`), ``,
  ].join('\n');
  await fs.writeFile(path.join(PHASE3_REPORTS, 'duplicate-cleanup-harness.md'), md);
  console.log(`[duplicate-cleanup-harness] ${passed}/${total} PASS`);
  process.exit(passed === total ? 0 : 1);
}

main().catch((err) => { console.error(err); process.exit(2); });
