/**
 * Phase 1 — Staging-only orchestrator.
 *
 * Combines the four steps required for a full Phase 1 cutover-rehearsal
 * against a staging database:
 *
 *   1. preflight (read-only)
 *   2. reconciliation A..E in --apply mode (writes to saas_reconciliation_queue)
 *   3. dry-run-tenant-backfill (read-only with rollback OR --apply)
 *   4. snapshot-identifier-sequences (read-only OR --apply)
 *   5. verify-tenant-backfill
 *
 * SAFETY GATES (all must pass for any --apply step):
 *   - `--apply` flag passed
 *   - `NODE_ENV !== 'production'`
 *   - `ALLOW_SAAS_STAGING_MUTATION === 'true'`
 *   - DB host on the staging allow-list (or `ALLOW_NON_STAGING_APPLY=true`)
 *   - DB name does not match the production deny-list
 *
 * Without `--apply`, the orchestrator runs everything in dry-run mode.
 *
 * Output:
 *   - per-stage logs to stdout
 *   - aggregate report at backend/reports/saas/phase1/PHASE1_APPLY_STAGING.{json,md}
 */
/* eslint-disable no-console */
import { execFileSync } from 'child_process';
import { promises as fs } from 'fs';
import path from 'path';
import { autoLoadEnv, formatDatabaseUrlMissingMessage } from './reconciliation/lib/env';

autoLoadEnv(__filename);

const STAGING_HOST_PATTERNS = [
  /^127\.0\.0\.1$/, /^localhost$/, /^staging[-.]/, /^stg[-.]/,
  /\.staging\./, /\.stg\./, /^postgres-staging-/,
];
const PROD_DENY = [
  /^prod[-.]/, /\.prod\./, /^postgres-prod-/, /\.production\./,
];
const PROD_DB_DENY = [/prod/i, /production/i];

interface StageResult {
  name: string;
  ok: boolean;
  durationMs: number;
  exitCode: number;
  detail?: string;
}

function getDatabaseUrl(): string {
  const argDb = process.argv.find((a) => a.startsWith('--db='))?.slice(5);
  const url = argDb ?? process.env.DATABASE_URL;
  if (!url) throw new Error(formatDatabaseUrlMissingMessage());
  return url;
}

function safetyCheck(apply: boolean, url: string): void {
  if (!apply) return;
  if (process.env.NODE_ENV === 'production') {
    throw new Error('Refusing to --apply with NODE_ENV=production');
  }
  if (process.env.ALLOW_SAAS_STAGING_MUTATION !== 'true') {
    throw new Error('Refusing to --apply: set ALLOW_SAAS_STAGING_MUTATION=true to confirm');
  }
  let host = '';
  let dbName = '';
  try {
    const u = new URL(url);
    host = u.hostname;
    dbName = u.pathname.replace(/^\//, '');
  } catch { /* invalid URL — fall through to deny */ }
  if (PROD_DENY.some((re) => re.test(host))) throw new Error(`Refusing: host "${host}" matches prod deny pattern`);
  if (PROD_DB_DENY.some((re) => re.test(dbName))) throw new Error(`Refusing: database name "${dbName}" matches prod deny pattern`);
  if (
    !STAGING_HOST_PATTERNS.some((re) => re.test(host)) &&
    process.env.ALLOW_NON_STAGING_APPLY !== 'true'
  ) {
    throw new Error(
      `Refusing: host "${host}" not on staging allow-list. Set ALLOW_NON_STAGING_APPLY=true ONLY for non-prod sandboxes.`,
    );
  }
}

/**
 * Resolve the local `ts-node` binary directly to avoid `npx` resolution
 * differences across shells. On Windows the binary is `ts-node.cmd`;
 * on POSIX it is `ts-node`. Both ship under `node_modules/.bin/`.
 */
function resolveTsNode(): string {
  const isWin = process.platform === 'win32';
  // From this file: ../../../../../node_modules/.bin/ts-node
  // (apply-tenant-backfill-staging.ts is at backend/scripts/saas/phase1/)
  return path.resolve(
    __dirname, '..', '..', '..', 'node_modules', '.bin',
    isWin ? 'ts-node.cmd' : 'ts-node',
  );
}

function runStage(name: string, scriptPath: string, args: string[]): StageResult {
  const t0 = Date.now();
  let exitCode = 0;
  let detail: string | undefined;
  const tsNode = resolveTsNode();
  try {
    execFileSync(tsNode, [scriptPath, ...args], {
      stdio: 'inherit',
      env: { ...process.env },
      // `shell: true` is required on Windows when invoking a `.cmd`
      // file via execFileSync. Harmless on POSIX — Node uses /bin/sh.
      shell: process.platform === 'win32',
    });
  } catch (e: any) {
    exitCode = e.status ?? 1;
    detail = e.message;
    // Surface the failure so the operator can see WHY the stage didn't
    // run, instead of an empty "FAIL" with no context.
    // eslint-disable-next-line no-console
    console.error(`\n[stage:${name}] failed (exit ${exitCode}): ${detail ?? ''}\n`);
  }
  // Treat 2 (WARN) and 3 (BLOCKER findings from preflight runner) as
  // "stage ran successfully but surfaced findings", not as crashes. The
  // operator inspects per-stage reports to triage.
  const ranOk = exitCode === 0 || exitCode === 2 || exitCode === 3;
  return { name, ok: ranOk, durationMs: Date.now() - t0, exitCode, detail };
}

async function main(): Promise<void> {
  const apply = process.argv.includes('--apply');
  const url = getDatabaseUrl();
  safetyCheck(apply, url);

  console.log(`\n=== Phase 1 staging orchestrator (${apply ? 'APPLY' : 'DRY-RUN'}) ===`);
  console.log(`Database: ${url.replace(/:[^:@/]+@/, ':***@')}`);
  console.log('');

  const results: StageResult[] = [];
  const ROOT = path.resolve(__dirname);
  const RECON = path.resolve(__dirname, 'reconciliation');

  // Stage 1: preflight (always read-only)
  results.push(runStage('preflight', path.join(ROOT, 'run-preflight.ts'), []));

  // Stage 2: reconciliation A..E (apply or dry-run)
  for (const s of ['A-user-identity', 'B-agency-tenant-projection', 'C-unique-constraints', 'D-data-ownership', 'E-reports-sql']) {
    const args = apply ? ['--apply'] : [];
    results.push(runStage(`recon-${s}`, path.join(RECON, `${s}.recon.ts`), args));
  }

  // Stage 3: dry-run-tenant-backfill (with hardening)
  {
    const args = apply
      ? ['--apply', '--resume', '--max-quarantine', '50']
      : ['--max-quarantine', '50'];
    results.push(runStage('tenant-backfill', path.join(ROOT, 'dry-run-tenant-backfill.ts'), args));
  }

  // Stage 4: identifier-sequence snapshot
  {
    const args = apply ? ['--apply'] : [];
    results.push(runStage('seq-snapshot', path.join(ROOT, 'snapshot-identifier-sequences.ts'), args));
  }

  // Stage 5: verification
  results.push(runStage('verify', path.join(ROOT, 'verify-tenant-backfill.ts'), []));

  // Aggregate
  const overallOk = results.every((r) => r.ok);
  const aggregate = {
    mode: apply ? 'apply' : 'dry-run',
    database: url.replace(/:[^:@/]+@/, ':***@'),
    nodeEnv: process.env.NODE_ENV ?? 'unset',
    allowed: process.env.ALLOW_SAAS_STAGING_MUTATION === 'true',
    overallOk,
    stages: results,
    finishedAt: new Date().toISOString(),
  };
  const out = path.resolve(__dirname, '..', '..', '..', 'reports', 'saas', 'phase1');
  await fs.mkdir(out, { recursive: true });
  await fs.writeFile(path.join(out, 'PHASE1_APPLY_STAGING.json'), JSON.stringify(aggregate, null, 2));

  const md: string[] = [];
  md.push('# Phase 1 — Staging Apply Orchestrator');
  md.push('');
  md.push(`- **Mode:** ${aggregate.mode}`);
  md.push(`- **Database:** \`${aggregate.database}\``);
  md.push(`- **NODE_ENV:** ${aggregate.nodeEnv}`);
  md.push(`- **Allowed:** ${aggregate.allowed}`);
  md.push(`- **Overall:** ${overallOk ? 'OK' : '**FAIL**'}`);
  md.push('');
  md.push('| Stage | Result | Exit | Duration |');
  md.push('|-------|--------|------|----------|');
  for (const r of results) {
    md.push(`| ${r.name} | ${r.ok ? 'OK' : '**FAIL**'} | ${r.exitCode} | ${r.durationMs} ms |`);
  }
  md.push('');
  md.push('## Rollback');
  md.push('');
  md.push('- `--dry-run`: nothing to roll back; the tenant backfill ROLLs BACK its own transaction.');
  md.push('- `--apply` on staging: restore the pre-run database snapshot. The tenant backfill is destructive at step 5.4 (DELETE FROM agencies WHERE id = old).');
  md.push('- Re-running `--apply` is idempotent for stages 1, 2, 4, 5; stage 3 supports `--resume` via `agency_split_progress`.');
  md.push('');
  await fs.writeFile(path.join(out, 'PHASE1_APPLY_STAGING.md'), md.join('\n'));

  console.log(`\n=== Done. Overall: ${overallOk ? 'OK' : 'FAIL'} ===`);
  if (!overallOk) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(2); });
