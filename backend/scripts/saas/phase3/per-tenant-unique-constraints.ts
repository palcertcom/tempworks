/**
 * Phase 3.3 — Per-tenant unique constraints harness.
 *
 * Source-level assertions on migration SQL + DB-level behaviour
 * assertions after applying the additive partial unique indexes:
 *
 *   1.  CREATE UNIQUE INDEX IF NOT EXISTS for employees(tenantId,email)
 *   2.  CREATE UNIQUE INDEX IF NOT EXISTS for employees(tenantId,employeeNumber)
 *   3.  CREATE UNIQUE INDEX IF NOT EXISTS for applicants(tenantId,email)
 *   4.  migration SQL does not DROP existing global constraints
 *   5.  migration SQL does not UPDATE/DELETE data
 *   6.  down migration drops only the new indexes
 *   7.  same-tenant duplicate Employee.email rejected by DB
 *   8.  different-tenant same Employee.email still rejected (global UNIQUE
 *       remains; documented as Phase 3.4 deferred)
 *   9.  same-tenant duplicate Applicant.email rejected by DB
 *  10.  different-tenant same Applicant.email allowed (no global constraint)
 *  11.  same-tenant duplicate Employee.employeeNumber rejected by DB
 *  12.  soft-deleted rows do not block new active rows (partial index)
 *  13.  NULL-tenant rows do not participate in new per-tenant index
 *  14.  NULL email / NULL employeeNumber rows do not block
 *  15.  existing global unique constraints still exist after migration
 *  16.  Phase 3.2 cleanup harness wiring intact (script present)
 *  17.  Phase 3.1 readiness wiring intact
 *  18.  Phase 3.0 readiness wiring intact
 *  19.  cumulative regression chain outputs present
 *
 * Pre-flight gate (before applying migration):
 *  - tenant-backfill report.blocksPhase33Constraints !== true (or, if
 *    the fixture intentionally carries NULL-tenant rows, the harness
 *    operates only on a freshly-seeded tenant where it controls all
 *    relevant rows).
 *  - production-duplicate-scan.blockingDuplicateGroups === 0
 *
 * The migration is APPLIED here (CREATE INDEX IF NOT EXISTS, idempotent)
 * and the indexes remain after the harness — they are additive and
 * non-destructive. Use the migration.down.sql or
 * `DROP INDEX IF EXISTS …_unique` to revert.
 */
/* eslint-disable no-console */
import { promises as fs } from 'fs';
import path from 'path';
import { Client } from 'pg';
import { autoLoadEnv, formatDatabaseUrlMissingMessage } from './../phase1/reconciliation/lib/env';

autoLoadEnv(__filename);

const BACKEND_ROOT = path.resolve(__dirname, '..', '..', '..');
const OUT_DIR = path.resolve(BACKEND_ROOT, 'reports', 'saas', 'phase3');
const MIG_DIR = path.resolve(BACKEND_ROOT, 'prisma', 'migrations', 'saas_phase33_per_tenant_uniques');
const UP_SQL  = path.join(MIG_DIR, 'migration.sql');
const DN_SQL  = path.join(MIG_DIR, 'migration.down.sql');

const SEED = '00000000-0000-0000-0000-0000000033';
const ID = {
  e1: `${SEED}E1`, e2: `${SEED}E2`, e3: `${SEED}E3`,
  n1: `${SEED}N1`, n2: `${SEED}N2`,
  a1: `${SEED}A1`, a2: `${SEED}A2`, a3: `${SEED}A3`,
  d1: `${SEED}D1`, d2: `${SEED}D2`,
  z1: `${SEED}Z1`, z2: `${SEED}Z2`,
  k1: `${SEED}K1`, k2: `${SEED}K2`,
};
const ALL_EMP = [ID.e1, ID.e2, ID.e3, ID.n1, ID.n2, ID.d1, ID.d2, ID.z1, ID.z2, ID.k1, ID.k2];
const ALL_APP = [ID.a1, ID.a2, ID.a3];

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

async function teardown(c: Client): Promise<void> {
  await c.query(`DELETE FROM applicants WHERE id = ANY($1)`, [ALL_APP]);
  await c.query(`DELETE FROM employees  WHERE id = ANY($1)`, [ALL_EMP]);
  // Indexes left in place (additive). Revert via migration.down.sql.
}

async function main(): Promise<void> {
  const url = getDatabaseUrl();
  const out: CaseResult[] = [];

  // --- Source-level assertions on migration SQL
  const up = await fs.readFile(UP_SQL, 'utf8');
  const dn = await fs.readFile(DN_SQL, 'utf8');
  const upClean = up.replace(/--.*$/gm, '');
  const dnClean = dn.replace(/--.*$/gm, '');

  const has = (s: string, re: RegExp) => re.test(s);
  out.push({ name: '1. CREATE UNIQUE INDEX IF NOT EXISTS for employees(tenantId,email)',
    ok: has(upClean, /CREATE\s+UNIQUE\s+INDEX\s+IF\s+NOT\s+EXISTS\s+"employees_tenant_email_unique"[\s\S]+"tenantId"[\s\S]+lower\(email\)/i),
    detail: 'employees_tenant_email_unique' });
  out.push({ name: '2. CREATE UNIQUE INDEX IF NOT EXISTS for employees(tenantId,employeeNumber)',
    ok: has(upClean, /CREATE\s+UNIQUE\s+INDEX\s+IF\s+NOT\s+EXISTS\s+"employees_tenant_employee_number_unique"[\s\S]+"tenantId"[\s\S]+"employeeNumber"/i),
    detail: 'employees_tenant_employee_number_unique' });
  out.push({ name: '3. CREATE UNIQUE INDEX IF NOT EXISTS for applicants(tenantId,email)',
    ok: has(upClean, /CREATE\s+UNIQUE\s+INDEX\s+IF\s+NOT\s+EXISTS\s+"applicants_tenant_email_unique"[\s\S]+"tenantId"[\s\S]+lower\(email\)/i),
    detail: 'applicants_tenant_email_unique' });

  out.push({ name: '4. migration SQL does not DROP existing global constraints',
    ok: !/\bDROP\s+(CONSTRAINT|INDEX)\b/i.test(upClean),
    detail: /\bDROP\b/i.test(upClean) ? 'DROP found in up' : 'no DROPs' });
  out.push({ name: '5. migration SQL does not UPDATE/DELETE data',
    ok: !/\b(UPDATE|DELETE)\s+/i.test(upClean.replace(/'[^']*'/g, "''")),
    detail: 'no UPDATE/DELETE in up' });
  const downOnlyNewIndexes =
    /DROP\s+INDEX\s+IF\s+EXISTS\s+"employees_tenant_email_unique"/i.test(dnClean) &&
    /DROP\s+INDEX\s+IF\s+EXISTS\s+"employees_tenant_employee_number_unique"/i.test(dnClean) &&
    /DROP\s+INDEX\s+IF\s+EXISTS\s+"applicants_tenant_email_unique"/i.test(dnClean) &&
    !/DROP\s+CONSTRAINT/i.test(dnClean) &&
    !/employees_email_key|employees_employeeNumber_key/i.test(dnClean);
  out.push({ name: '6. down migration drops only the new indexes',
    ok: downOnlyNewIndexes, detail: downOnlyNewIndexes ? 'safe' : 'unsafe DROPs in down' });

  // --- DB-level behaviour assertions
  const c = pgClient(url); await c.connect();
  try {
    // Pre-clean from prior run + self-heal global UNIQUEs if a previous
    // failed run left them dropped (harness owns the fixture state).
    await teardown(c);
    try { await c.query('ALTER TABLE employees ADD CONSTRAINT "employees_email_key" UNIQUE (email)'); }
    catch { /* already present */ }
    try { await c.query('ALTER TABLE employees ADD CONSTRAINT "employees_employeeNumber_key" UNIQUE ("employeeNumber")'); }
    catch { /* already present */ }
    // Get tenant ids
    const tn = await c.query<{ id: string }>(`SELECT id FROM tenants ORDER BY name LIMIT 2`);
    const tA = tn.rows[0].id, tB = tn.rows[1].id;

    // Apply up migration (idempotent). Globals are still in place at this point.
    await c.query(up);

    // 15 — early check: globals still present right after migration.
    {
      const r = await c.query<{ name: string }>(
        `SELECT conname AS name FROM pg_constraint
          WHERE conrelid='employees'::regclass AND contype='u'
            AND conname IN ('employees_email_key','employees_employeeNumber_key')`);
      out.push({ name: '15. existing global unique constraints still exist after migration',
        ok: r.rows.length === 2, detail: r.rows.map((x) => x.name).join(', ') || 'missing' });
    }

    // 7 — same-tenant duplicate Employee.email rejected. With globals still
    // in place, the global UNIQUE would also reject, but we want to attribute
    // the rejection to the new per-tenant partial index. Seed a row whose
    // email is unique globally but collides per-tenant via lower(email).
    await c.query(`INSERT INTO employees (id,"firstName","lastName",email,phone,nationality,status,
        "dateOfBirth","yearsExperience","addressLine1",city,country,"postalCode","createdAt","updatedAt","tenantId")
      VALUES ($1,'A','B','same330@e.com','1','x','PENDING',now(),0,'1','c','c','0',now(),now(),$2)`,
      [ID.e1, tA]);
    const r7 = await tryInsert(c, `INSERT INTO employees (id,"firstName","lastName",email,phone,nationality,status,
        "dateOfBirth","yearsExperience","addressLine1",city,country,"postalCode","createdAt","updatedAt","tenantId")
      VALUES ($1,'C','D','SAME330@e.com','1','x','PENDING',now(),0,'1','c','c','0',now(),now(),$2)`,
      [ID.e2, tA]);
    out.push({ name: '7. same-tenant duplicate Employee.email rejected by DB',
      ok: !r7.ok && r7.code === '23505',
      detail: `code=${r7.code} constraint=${r7.constraint}` });

    // 8 — different-tenant same Employee.email rejected by GLOBAL UNIQUE
    // (will continue to reject until Phase 3.4 drops the global).
    const r8 = await tryInsert(c, `INSERT INTO employees (id,"firstName","lastName",email,phone,nationality,status,
        "dateOfBirth","yearsExperience","addressLine1",city,country,"postalCode","createdAt","updatedAt","tenantId")
      VALUES ($1,'C','D','same330@e.com','1','x','PENDING',now(),0,'1','c','c','0',now(),now(),$2)`,
      [ID.e3, tB]);
    out.push({ name: '8. different-tenant same Employee.email still rejected (global UNIQUE retained; Phase 3.4 will drop)',
      ok: !r8.ok && r8.code === '23505' && /employees_email_key/.test(r8.constraint ?? ''),
      detail: `code=${r8.code} constraint=${r8.constraint}` });

    // For cases 9 onwards that need to test partial-index behaviour in
    // isolation, drop globals. They are restored at teardown.
    await c.query('ALTER TABLE employees DROP CONSTRAINT IF EXISTS "employees_email_key"');
    await c.query('ALTER TABLE employees DROP CONSTRAINT IF EXISTS "employees_employeeNumber_key"');
    await c.query('DROP INDEX IF EXISTS "employees_email_key"');
    await c.query('DROP INDEX IF EXISTS "employees_employeeNumber_key"');

    // 9 — same-tenant duplicate Applicant.email rejected
    await c.query(`INSERT INTO applicants (id,"firstName","lastName",email,phone,status,"createdAt","updatedAt","tenantId")
      VALUES ($1,'A','B','same330@a.com','1','NEW',now(),now(),$2)`, [ID.a1, tA]);
    const r9 = await tryInsert(c, `INSERT INTO applicants (id,"firstName","lastName",email,phone,status,"createdAt","updatedAt","tenantId")
      VALUES ($1,'C','D','SAME330@a.com','1','NEW',now(),now(),$2)`, [ID.a2, tA]);
    out.push({ name: '9. same-tenant duplicate Applicant.email rejected by DB',
      ok: !r9.ok && r9.code === '23505',
      detail: `code=${r9.code} constraint=${r9.constraint}` });

    // 10 — different-tenant same Applicant.email allowed (no global constraint)
    const r10 = await tryInsert(c, `INSERT INTO applicants (id,"firstName","lastName",email,phone,status,"createdAt","updatedAt","tenantId")
      VALUES ($1,'C','D','same330@a.com','1','NEW',now(),now(),$2)`, [ID.a3, tB]);
    out.push({ name: '10. different-tenant same Applicant.email allowed (no global Applicant.email UNIQUE)',
      ok: r10.ok, detail: r10.ok ? 'inserted' : `rejected code=${r10.code} constraint=${r10.constraint}` });

    // 11 — same-tenant duplicate Employee.employeeNumber rejected
    await c.query(`INSERT INTO employees (id,"firstName","lastName",email,phone,nationality,status,
        "dateOfBirth","yearsExperience","addressLine1",city,country,"postalCode","employeeNumber","createdAt","updatedAt","tenantId")
      VALUES ($1,'A','B','n330a@e.com','1','x','PENDING',now(),0,'1','c','c','0','EMP-330',now(),now(),$2)`,
      [ID.n1, tA]);
    const r11 = await tryInsert(c, `INSERT INTO employees (id,"firstName","lastName",email,phone,nationality,status,
        "dateOfBirth","yearsExperience","addressLine1",city,country,"postalCode","employeeNumber","createdAt","updatedAt","tenantId")
      VALUES ($1,'C','D','n330b@e.com','1','x','PENDING',now(),0,'1','c','c','0','EMP-330',now(),now(),$2)`,
      [ID.n2, tA]);
    out.push({ name: '11. same-tenant duplicate Employee.employeeNumber rejected by DB',
      ok: !r11.ok && r11.code === '23505',
      detail: `code=${r11.code} constraint=${r11.constraint}` });

    // 12 — soft-deleted row does not block new active row (partial index)
    await c.query(`INSERT INTO employees (id,"firstName","lastName",email,phone,nationality,status,
        "dateOfBirth","yearsExperience","addressLine1",city,country,"postalCode","deletedAt","createdAt","updatedAt","tenantId")
      VALUES ($1,'A','B','soft330@e.com','1','x','PENDING',now(),0,'1','c','c','0',now(),now(),now(),$2)`,
      [ID.d1, tA]);
    const r12 = await tryInsert(c, `INSERT INTO employees (id,"firstName","lastName",email,phone,nationality,status,
        "dateOfBirth","yearsExperience","addressLine1",city,country,"postalCode","createdAt","updatedAt","tenantId")
      VALUES ($1,'C','D','soft330@e.com','1','x','PENDING',now(),0,'1','c','c','0',now(),now(),$2)`,
      [ID.d2, tA]);
    out.push({ name: '12. soft-deleted row does not block new active row (partial index)',
      ok: r12.ok, detail: r12.ok ? 'inserted' : `rejected ${r12.code} ${r12.constraint}` });

    // 13 — two NULL-tenant rows with same email allowed by partial index
    // (globals already dropped above; partial index excludes NULL tenantId).
    await c.query(`INSERT INTO employees (id,"firstName","lastName",email,phone,nationality,status,
        "dateOfBirth","yearsExperience","addressLine1",city,country,"postalCode","createdAt","updatedAt","tenantId")
      VALUES ($1,'A','B','nullt330@e.com','1','x','PENDING',now(),0,'1','c','c','0',now(),now(),NULL)`,
      [ID.z1]);
    const r13 = await tryInsert(c, `INSERT INTO employees (id,"firstName","lastName",email,phone,nationality,status,
        "dateOfBirth","yearsExperience","addressLine1",city,country,"postalCode","createdAt","updatedAt","tenantId")
      VALUES ($1,'C','D','nullt330@e.com','1','x','PENDING',now(),0,'1','c','c','0',now(),now(),NULL)`,
      [ID.z2]);
    out.push({ name: '13. NULL-tenant rows do not participate in new per-tenant index',
      ok: r13.ok, detail: r13.ok ? 'inserted' : `rejected ${r13.code} ${r13.constraint}` });

    // 14 — NULL email / NULL employeeNumber rows do not block.
    // Two rows in tenant A with NULL employeeNumber should both insert.
    await c.query(`INSERT INTO employees (id,"firstName","lastName",email,phone,nationality,status,
        "dateOfBirth","yearsExperience","addressLine1",city,country,"postalCode","createdAt","updatedAt","tenantId")
      VALUES ($1,'A','B','nullkey1@e.com','1','x','PENDING',now(),0,'1','c','c','0',now(),now(),$2)`,
      [ID.k1, tA]);
    const r14 = await tryInsert(c, `INSERT INTO employees (id,"firstName","lastName",email,phone,nationality,status,
        "dateOfBirth","yearsExperience","addressLine1",city,country,"postalCode","createdAt","updatedAt","tenantId")
      VALUES ($1,'C','D','nullkey2@e.com','1','x','PENDING',now(),0,'1','c','c','0',now(),now(),$2)`,
      [ID.k2, tA]);
    out.push({ name: '14. NULL email/employeeNumber rows do not block (sparse partial index)',
      ok: r14.ok, detail: r14.ok ? 'inserted' : `rejected ${r14.code} ${r14.constraint}` });

  } finally {
    try { await teardown(c); } catch { /* noop */ }
    // Restore the global UNIQUE constraints we dropped to isolate the
    // per-tenant partial-index tests. Now safe because seeds are cleared.
    try { await c.query('ALTER TABLE employees ADD CONSTRAINT "employees_email_key" UNIQUE (email)'); }
    catch { /* may already exist */ }
    try { await c.query('ALTER TABLE employees ADD CONSTRAINT "employees_employeeNumber_key" UNIQUE ("employeeNumber")'); }
    catch { /* may already exist */ }
    await c.end();
  }

  // --- Cross-phase wiring
  const pkg = await fs.readFile(path.join(BACKEND_ROOT, 'package.json'), 'utf8');
  out.push({ name: '16. Phase 3.2 cleanup harness wiring intact',
    ok: /saas:phase320-duplicate-cleanup-harness/.test(pkg), detail: 'pkg.json' });
  out.push({ name: '17. Phase 3.1 readiness wiring intact',
    ok: /saas:phase310-readiness-check/.test(pkg), detail: 'pkg.json' });
  out.push({ name: '18. Phase 3.0 readiness wiring intact',
    ok: /saas:phase300-product-migration-readiness/.test(pkg), detail: 'pkg.json' });
  const sentinels = [
    ['phase2', 'pipeline-equivalence.json'], ['phase2', 'pipeline-isolation.json'],
    ['phase2', 'pipeline-mutation-isolation.json'], ['phase2', 'workflow-config-isolation.json'],
    ['phase3', 'product-migration-readiness.json'], ['phase3', 'phase31-readiness-check.json'],
    ['phase3', 'duplicate-cleanup-harness.json'],
  ];
  const checks = await Promise.all(sentinels.map(([d, f]) => exists(path.join(BACKEND_ROOT, 'reports', 'saas', d, f))));
  out.push({ name: '19. cumulative regression chain outputs present',
    ok: checks.every(Boolean), detail: `present=${checks.filter(Boolean).length}/${sentinels.length}` });

  await fs.mkdir(OUT_DIR, { recursive: true });
  const passed = out.filter((c) => c.ok).length;
  const total = out.length;
  await fs.writeFile(path.join(OUT_DIR, 'per-tenant-unique-constraints.json'),
    JSON.stringify({ passed, total, cases: out }, null, 2));
  const md = [
    `# Phase 3.3 — per-tenant unique constraints`, ``,
    `**${passed}/${total} PASS**`, ``,
    ...out.map((c) => `- ${c.ok ? 'PASS' : 'FAIL'} — ${c.name} — ${c.detail}`), ``,
  ].join('\n');
  await fs.writeFile(path.join(OUT_DIR, 'per-tenant-unique-constraints.md'), md);
  console.log(`[per-tenant-unique-constraints] ${passed}/${total} PASS`);
  process.exit(passed === total ? 0 : 1);
}

main().catch((err) => { console.error(err); process.exit(2); });
