/**
 * Phase 2.12 — Pilot regression runner.
 *
 * Runs every pilot's equivalence + isolation harness in sequence
 * against the same DATABASE_URL. Reports the per-harness PASS/FAIL
 * line and exits with code 2 if any harness exited non-zero.
 *
 * Usage:
 *   DATABASE_URL=... npm run saas:phase2-pilot-regression
 */
/* eslint-disable no-console */
import { spawnSync } from 'child_process';
import { promises as fs } from 'fs';
import path from 'path';
import { abortUnlessStaging, writeReport, type CaseResult } from './lib/harness';

const HARNESSES: Array<{ name: string; script: string }> = [
  { name: 'roles equivalence',     script: 'scripts/saas/phase2/tenantprisma-pilot-equivalence.ts' },
  { name: 'roles isolation',       script: 'scripts/saas/phase2/tenantprisma-pilot-isolation.ts' },
  { name: 'employee-work-history equivalence', script: 'scripts/saas/phase2/employee-work-history-equivalence.ts' },
  { name: 'employee-work-history isolation',   script: 'scripts/saas/phase2/employee-work-history-isolation.ts' },
  { name: 'compliance equivalence', script: 'scripts/saas/phase2/compliance-equivalence.ts' },
  { name: 'compliance isolation',   script: 'scripts/saas/phase2/compliance-isolation.ts' },
  { name: 'job-ads equivalence',    script: 'scripts/saas/phase2/job-ads-equivalence.ts' },
  { name: 'job-ads isolation',      script: 'scripts/saas/phase2/job-ads-isolation.ts' },
  { name: 'notifications equivalence', script: 'scripts/saas/phase2/notifications-equivalence.ts' },
  { name: 'notifications isolation',   script: 'scripts/saas/phase2/notifications-isolation.ts' },
  { name: 'recycle-bin equivalence',   script: 'scripts/saas/phase2/recycle-bin-equivalence.ts' },
  { name: 'recycle-bin isolation',     script: 'scripts/saas/phase2/recycle-bin-isolation.ts' },
];

const REPO = path.resolve(__dirname, '..', '..', '..');

interface RunResult {
  name: string;
  exitCode: number;
  headline: string;
  durationMs: number;
}

async function runOne(h: typeof HARNESSES[number]): Promise<RunResult> {
  const start = Date.now();
  const r = spawnSync('npx', ['ts-node', h.script], {
    cwd: REPO,
    env: process.env,
    encoding: 'utf8',
  });
  const out = (r.stdout ?? '') + (r.stderr ?? '');
  const lines = out.split('\n').filter(Boolean);
  // Pull the final headline that matches "<name>: N/M cases PASS".
  const headline = [...lines].reverse().find((l) => /\d+\/\d+ cases PASS/.test(l)) ?? lines[lines.length - 1] ?? '';
  return {
    name: h.name,
    exitCode: r.status ?? -1,
    headline: headline.trim(),
    durationMs: Date.now() - start,
  };
}

async function main(): Promise<void> {
  const env = abortUnlessStaging('pilot-regression');
  console.log(`pilot-regression: running ${HARNESSES.length} harnesses against ${env.classification}...`);

  const out: CaseResult[] = [];
  for (const h of HARNESSES) {
    const r = await runOne(h);
    const ok = r.exitCode === 0;
    console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${r.name} — ${r.headline} (${r.durationMs}ms)`);
    out.push({
      name: r.name,
      ok,
      detail: `${r.headline} | exit=${r.exitCode}`,
      durationMs: r.durationMs,
    });
  }

  await writeReport({
    title: 'Phase 2.12 — Pilot Regression',
    name: 'pilot-regression',
    out,
    environment: env,
  });
}

main().catch((e) => { console.error(e); process.exit(3); });
