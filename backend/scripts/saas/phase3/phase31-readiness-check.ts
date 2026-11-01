/**
 * Phase 3.1 — Readiness check harness.
 *
 * Runs the three Phase 3.1 reports against the SAFE clone, validates
 * their JSON+MD outputs, asserts source-level read-only invariants,
 * and confirms Phase 3.0 + Phase 2 sentinel wiring is intact.
 *
 *  1.  tenant backfill report runs read-only
 *  2.  tenant backfill report writes JSON and MD
 *  3.  Employee NULL-tenant count reported
 *  4.  Applicant NULL-tenant count reported
 *  5.  production duplicate scan runs read-only
 *  6.  production duplicate scan writes JSON and MD
 *  7.  duplicate scan includes all 7 detection sections
 *  8.  duplicate scan masks (or omits) PII in MD
 *  9.  cross-tenant same email classified as observation, not blocker
 * 10.  PlatformAdmin readiness runs read-only
 * 11.  PlatformAdmin readiness writes JSON and MD
 * 12.  PlatformAdmin readiness detects existing model/table
 * 13.  source-level: scripts contain no INSERT/UPDATE/DELETE
 * 14.  no schema migration added in Phase 3.1
 * 15.  Phase 3.0 product-migration-readiness wiring intact
 * 16.  cumulative regression chain outputs present from prior runs
 */
/* eslint-disable no-console */
import { promises as fs } from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { autoLoadEnv, formatDatabaseUrlMissingMessage } from './../phase1/reconciliation/lib/env';

autoLoadEnv(__filename);

const BACKEND_ROOT = path.resolve(__dirname, '..', '..', '..');
const REPO_ROOT = path.resolve(BACKEND_ROOT, '..');
const PHASE3_REPORTS = path.resolve(BACKEND_ROOT, 'reports', 'saas', 'phase3');
const PHASE3_SCRIPTS = path.resolve(__dirname);
const MIGRATIONS_DIR = path.resolve(BACKEND_ROOT, 'prisma', 'migrations');

interface CaseResult { name: string; ok: boolean; detail: string; }

function getDatabaseUrl(): string {
  const arg = process.argv.find((a) => a.startsWith('--db='))?.slice(5);
  return arg ?? process.env.DATABASE_URL ?? (() => { throw new Error(formatDatabaseUrlMissingMessage()); })();
}

async function exists(p: string): Promise<boolean> {
  return fs.stat(p).then(() => true).catch(() => false);
}
async function runScript(rel: string, url: string): Promise<void> {
  execSync(`node -r ts-node/register ${path.resolve(PHASE3_SCRIPTS, rel)}`,
    { cwd: BACKEND_ROOT, env: { ...process.env, DATABASE_URL: url }, stdio: 'pipe' });
}
async function readSource(rel: string): Promise<string> {
  const raw = await fs.readFile(path.resolve(PHASE3_SCRIPTS, rel), 'utf8');
  return raw.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
}

async function main(): Promise<void> {
  const url = getDatabaseUrl();
  const out: CaseResult[] = [];

  // Run all three reports against the SAFE clone first.
  await runScript('tenant-backfill-completeness-report.ts', url);
  await runScript('production-duplicate-scan.ts', url);
  await runScript('platform-admin-readiness-report.ts', url);

  // Read outputs.
  const tbcJson = JSON.parse(await fs.readFile(path.join(PHASE3_REPORTS, 'tenant-backfill-completeness-report.json'), 'utf8'));
  const pdsJson = JSON.parse(await fs.readFile(path.join(PHASE3_REPORTS, 'production-duplicate-scan.json'), 'utf8'));
  const pdsMd   = await fs.readFile(path.join(PHASE3_REPORTS, 'production-duplicate-scan.md'), 'utf8');
  const parJson = JSON.parse(await fs.readFile(path.join(PHASE3_REPORTS, 'platform-admin-readiness-report.json'), 'utf8'));

  // Source-level read-only invariants
  const tbcSrc = await readSource('tenant-backfill-completeness-report.ts');
  const pdsSrc = await readSource('production-duplicate-scan.ts');
  const parSrc = await readSource('platform-admin-readiness-report.ts');
  const noWrites = (s: string) => !/\b(INSERT|UPDATE|DELETE)\s/i.test(s.replace(/'[^']*'/g, "''"));
  const hasReadOnlyTxn = (s: string) => /BEGIN READ ONLY/.test(s);

  // 1
  out.push({ name: '1. tenant backfill report runs read-only',
    ok: tbcJson.readOnly === true && hasReadOnlyTxn(tbcSrc) && noWrites(tbcSrc),
    detail: `readOnlyJson=${tbcJson.readOnly} readOnlyTxn=${hasReadOnlyTxn(tbcSrc)} noWrites=${noWrites(tbcSrc)}` });
  // 2
  const tbcMdOk = await exists(path.join(PHASE3_REPORTS, 'tenant-backfill-completeness-report.md'));
  out.push({ name: '2. tenant backfill report writes JSON and MD', ok: tbcMdOk, detail: `md=${tbcMdOk}` });
  // 3
  out.push({ name: '3. Employee NULL-tenant count reported',
    ok: typeof tbcJson.tables?.employee?.nullTenant === 'number',
    detail: `null=${tbcJson.tables?.employee?.nullTenant}` });
  // 4
  out.push({ name: '4. Applicant NULL-tenant count reported',
    ok: typeof tbcJson.tables?.applicant?.nullTenant === 'number',
    detail: `null=${tbcJson.tables?.applicant?.nullTenant}` });
  // 5
  out.push({ name: '5. production duplicate scan runs read-only',
    ok: pdsJson.readOnly === true && hasReadOnlyTxn(pdsSrc) && noWrites(pdsSrc),
    detail: `readOnlyJson=${pdsJson.readOnly} readOnlyTxn=${hasReadOnlyTxn(pdsSrc)} noWrites=${noWrites(pdsSrc)}` });
  // 6
  const pdsMdOk = await exists(path.join(PHASE3_REPORTS, 'production-duplicate-scan.md'));
  out.push({ name: '6. production duplicate scan writes JSON and MD', ok: pdsMdOk, detail: `md=${pdsMdOk}` });
  // 7
  const sectionKeys = Object.keys(pdsJson.sections ?? {});
  out.push({ name: '7. duplicate scan includes all 7 detection sections',
    ok: sectionKeys.length === 7, detail: `sections=${sectionKeys.length}` });
  // 8 — MD must mask emails (no raw "x@y.tld" tokens that match a real email regex)
  const rawEmail = /[A-Za-z0-9._%+-]{2,}@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;
  // Allow masked form like "j***@example.com". Strip masked variants before scan.
  const cleaned = pdsMd.replace(/[A-Za-z]\*{3}@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '');
  const hasRawEmail = rawEmail.test(cleaned);
  out.push({ name: '8. duplicate scan masks (or avoids) PII in MD',
    ok: !hasRawEmail, detail: hasRawEmail ? 'raw email detected' : 'masked' });
  // 9
  const xtCount = (pdsJson.sections?.['7_cross_tenant_email_observation'] ?? []).length;
  const blocking = pdsJson.blockingDuplicateGroups ?? -1;
  // Blocking total must equal sum of sections 1-6 only (NOT include section 7).
  const oneToSix = ['1_employee_email_same_tenant','2_employee_email_null_tenant',
    '3_applicant_email_same_tenant','4_applicant_email_null_tenant',
    '5_employee_number_same_tenant','6_employee_number_null_tenant']
    .reduce((acc, k) => acc + ((pdsJson.sections?.[k] ?? []).length), 0);
  out.push({ name: '9. cross-tenant same email classified as observation, not blocker',
    ok: blocking === oneToSix && xtCount === pdsJson.crossTenantObservationGroups,
    detail: `blocking=${blocking} sum1-6=${oneToSix} xtObs=${xtCount}` });
  // 10
  out.push({ name: '10. PlatformAdmin readiness runs read-only',
    ok: parJson.readOnly === true && hasReadOnlyTxn(parSrc) && noWrites(parSrc),
    detail: `readOnlyJson=${parJson.readOnly} readOnlyTxn=${hasReadOnlyTxn(parSrc)} noWrites=${noWrites(parSrc)}` });
  // 11
  const parMdOk = await exists(path.join(PHASE3_REPORTS, 'platform-admin-readiness-report.md'));
  out.push({ name: '11. PlatformAdmin readiness writes JSON and MD', ok: parMdOk, detail: `md=${parMdOk}` });
  // 12
  out.push({ name: '12. PlatformAdmin readiness detects existing model/table',
    ok: parJson.modelExists === true && parJson.tableExists === true,
    detail: `model=${parJson.modelExists} table=${parJson.tableExists}` });
  // 13
  const allReadOnly = noWrites(tbcSrc) && noWrites(pdsSrc) && noWrites(parSrc);
  out.push({ name: '13. source-level: scripts contain no INSERT/UPDATE/DELETE', ok: allReadOnly, detail: `noWrites=${allReadOnly}` });
  // 14 — no Phase 3.1 schema migration added
  const migDirs = await fs.readdir(MIGRATIONS_DIR).catch(() => [] as string[]);
  // Match Phase 3.1 migrations specifically — exclude Phase 3.10+ which
  // share the `phase31` prefix but are not Phase 3.1 work.
  const phase31 = migDirs.filter((d) => /(^|_)saas_phase31_/.test(d) || /(^|_)phase31_/.test(d));
  out.push({ name: '14. no Phase 3.1 schema migration added',
    ok: phase31.length === 0, detail: phase31.length === 0 ? 'none' : phase31.join(',') });
  // 15 — Phase 3.0 wiring intact
  const pkg = await fs.readFile(path.join(BACKEND_ROOT, 'package.json'), 'utf8');
  const phase30wire =
    /saas:phase300-uniqueness-duplicate-report/.test(pkg) &&
    /saas:phase300-product-migration-readiness/.test(pkg);
  out.push({ name: '15. Phase 3.0 product-migration-readiness wiring intact', ok: phase30wire, detail: phase30wire ? 'present' : 'missing' });
  // 16 — sentinel outputs present
  const sentinels = [
    ['phase2', 'pipeline-equivalence.json'],
    ['phase2', 'pipeline-isolation.json'],
    ['phase2', 'pipeline-mutation-isolation.json'],
    ['phase2', 'workflow-config-isolation.json'],
    ['phase3', 'product-migration-readiness.json'],
  ];
  const checks = await Promise.all(sentinels.map(([d, f]) => exists(path.join(BACKEND_ROOT, 'reports', 'saas', d, f))));
  out.push({ name: '16. cumulative regression chain outputs present from prior runs',
    ok: checks.every(Boolean), detail: `present=${checks.filter(Boolean).length}/${sentinels.length}` });

  await fs.mkdir(PHASE3_REPORTS, { recursive: true });
  const passed = out.filter((c) => c.ok).length;
  const total = out.length;
  await fs.writeFile(path.join(PHASE3_REPORTS, 'phase31-readiness-check.json'),
    JSON.stringify({ passed, total, cases: out }, null, 2));
  const md = [
    `# Phase 3.1 — readiness check`, ``,
    `**${passed}/${total} PASS**`, ``,
    ...out.map((c) => `- ${c.ok ? 'PASS' : 'FAIL'} — ${c.name} — ${c.detail}`), ``,
  ].join('\n');
  await fs.writeFile(path.join(PHASE3_REPORTS, 'phase31-readiness-check.md'), md);
  console.log(`[phase31-readiness-check] ${passed}/${total} PASS`);
  process.exit(passed === total ? 0 : 1);
}

void REPO_ROOT;
main().catch((err) => { console.error(err); process.exit(2); });
