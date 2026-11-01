/**
 * Phase 1 Preflight — runs every audit, aggregates the worst-case status
 * and writes both a JSON and Markdown summary.
 *
 * Usage:
 *   DATABASE_URL=postgres://... npx ts-node backend/scripts/saas/phase1/run-preflight.ts
 *   npx ts-node backend/scripts/saas/phase1/run-preflight.ts --db=postgres://...
 */
import { execFileSync } from 'child_process';
import { promises as fs } from 'fs';
import path from 'path';

const SUITES = [
  '01-agency-structure',
  '02-user-identity',
  '03-data-ownership',
  '04-uniqueness-collisions',
  '05-permissions',
  '06-storage',
  '07-reports-sql',
];

const SEV_RANK = { OK: 0, INFO: 1, WARN: 2, BLOCKER: 3 } as const;
type Severity = keyof typeof SEV_RANK;

async function main(): Promise<void> {
  const reportsDir = path.resolve(__dirname, '..', '..', '..', 'reports', 'saas', 'phase1');
  await fs.mkdir(reportsDir, { recursive: true });

  // Run each suite as a child process so a single failure doesn't abort the run.
  for (const s of SUITES) {
    const file = path.resolve(__dirname, `${s}.audit.ts`);
    try {
      execFileSync('npx', ['ts-node', file, ...process.argv.slice(2)], { stdio: 'inherit' });
    } catch {
      // The audit itself records a BLOCKER finding on failure; runner continues.
    }
  }

  // Aggregate
  const aggregate: Array<{ slug: string; status: Severity; findings: any[]; metrics: any[] }> = [];
  for (const s of SUITES) {
    const j = path.join(reportsDir, `${s}.json`);
    try {
      const r = JSON.parse(await fs.readFile(j, 'utf8'));
      aggregate.push({ slug: s, status: r.status, findings: r.findings ?? [], metrics: r.metrics ?? [] });
    } catch {
      aggregate.push({
        slug: s,
        status: 'BLOCKER',
        findings: [{ severity: 'BLOCKER', rule: 'audit.report-missing', message: `No JSON report from ${s}` }],
        metrics: [],
      });
    }
  }

  let overall: Severity = 'OK';
  for (const a of aggregate) if (SEV_RANK[a.status] > SEV_RANK[overall]) overall = a.status;

  const blockers = aggregate.flatMap((a) => a.findings.filter((f: any) => f.severity === 'BLOCKER').map((f: any) => ({ ...f, suite: a.slug })));
  const warns    = aggregate.flatMap((a) => a.findings.filter((f: any) => f.severity === 'WARN').map((f: any) => ({ ...f, suite: a.slug })));

  const json = {
    generatedAt: new Date().toISOString(),
    overall,
    suites: aggregate.map((a) => ({ slug: a.slug, status: a.status, findings: a.findings.length })),
    blockers,
    warnings: warns,
  };
  await fs.writeFile(path.join(reportsDir, 'PHASE1_PREFLIGHT_SUMMARY.json'), JSON.stringify(json, null, 2));

  const md: string[] = [];
  md.push(`# Phase 1 Pre-Flight Summary`);
  md.push('');
  md.push(`- **Generated:** ${json.generatedAt}`);
  md.push(`- **Overall status:** **${overall}**`);
  md.push(`- **Risk:** ${overall === 'BLOCKER' ? 'HIGH — backfill must NOT proceed.' : overall === 'WARN' ? 'MEDIUM — reconcile warnings before backfill.' : overall === 'INFO' ? 'LOW — informational only.' : 'NONE — ready to proceed.'}`);
  md.push('');
  md.push('## Per-suite');
  md.push('');
  md.push('| Suite | Status | Findings |');
  md.push('|------|--------|----------|');
  for (const a of aggregate) md.push(`| \`${a.slug}\` | **${a.status}** | ${a.findings.length} |`);
  md.push('');
  if (blockers.length) {
    md.push('## Blocking issues (must resolve before backfill)');
    md.push('');
    for (const b of blockers) md.push(`- **\`${b.suite}\` / \`${b.rule}\`** — ${b.message}`);
    md.push('');
  }
  if (warns.length) {
    md.push('## Warnings (recommended to resolve)');
    md.push('');
    for (const w of warns) md.push(`- **\`${w.suite}\` / \`${w.rule}\`** — ${w.message}`);
    md.push('');
  }
  md.push('## Recommended manual decisions');
  md.push('');
  md.push('- Confirm slug for each backfilled tenant (default: kebab-case of agency name; collision-suffixed).');
  md.push('- Confirm PlatformAdmin level for each system-agency user (default: SUPPORT; promote on request).');
  md.push('- Confirm disposition for `users.no-agency` rows (assign / deactivate / promote-to-platform-admin).');
  md.push('- Confirm `attendance_locked_periods` per-tenant policy (replicate existing locks across all tenants by default).');
  md.push('- Confirm `Workshop` / `MaintenanceType` / `DocumentType` catalog vs override resolution policy.');
  md.push('');
  await fs.writeFile(path.join(reportsDir, 'PHASE1_PREFLIGHT_SUMMARY.md'), md.join('\n'));

  // eslint-disable-next-line no-console
  console.log('\nPHASE1 preflight: ' + overall);
  // Exit codes: 0=OK/INFO, 2=WARN, 3=BLOCKER. Useful for CI gates.
  if (overall === 'BLOCKER') process.exit(3);
  if (overall === 'WARN') process.exit(2);
}

main().catch((e) => { console.error(e); process.exit(1); });
