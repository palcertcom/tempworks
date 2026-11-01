/**
 * Phase 2.55 — Audit retention runbook check.
 *
 * Lightweight, doc-level harness. Asserts the operator-facing
 * runbook covers every phase from 2.50 → 2.54, that the
 * destructive scripts still honour their soft-delete-only and
 * grace-window invariants at the source level, and that the
 * earlier audit harnesses are still wired into npm scripts.
 *
 * No DB connection is required.
 */
/* eslint-disable no-console */
import { promises as fs } from 'fs';
import path from 'path';
import { autoLoadEnv } from './../phase1/reconciliation/lib/env';

autoLoadEnv(__filename);

const REPO_ROOT  = path.resolve(__dirname, '..', '..', '..', '..');
const OUT_DIR    = path.resolve(__dirname, '..', '..', '..', 'reports', 'saas', 'phase2');

const RUNBOOK    = path.join(REPO_ROOT, 'docs', 'runbooks', 'audit-retention-rollout.md');
const POINTER    = path.join(REPO_ROOT, 'AUDIT_LOG_RETENTION_RUNBOOK.md');
const HARD_DEL   = path.resolve(__dirname, 'audit-log-hard-delete.ts');
const SOFT_DEL   = path.resolve(__dirname, 'audit-log-retention-enforce.ts');
const PACKAGE    = path.resolve(__dirname, '..', '..', '..', 'package.json');

interface CaseResult { name: string; ok: boolean; detail: string; }

async function read(p: string): Promise<string> {
  return fs.readFile(p, 'utf8');
}

async function exists(p: string): Promise<boolean> {
  try { await fs.access(p); return true; } catch { return false; }
}

async function main(): Promise<void> {
  const out: CaseResult[] = [];

  // 1, 2 — required docs exist
  out.push({ name: '1. docs/runbooks/audit-retention-rollout.md exists', ok: await exists(RUNBOOK), detail: RUNBOOK });
  out.push({ name: '2. AUDIT_LOG_RETENTION_RUNBOOK.md exists',          ok: await exists(POINTER), detail: POINTER });

  const runbook = await exists(RUNBOOK) ? await read(RUNBOOK) : '';
  const pointer = await exists(POINTER) ? await read(POINTER) : '';
  const both = `${runbook}\n${pointer}`;

  // 3–7 — phase coverage
  const phases: Array<[string, RegExp]> = [
    ['3. runbook mentions Phase 2.50', /(Phase\s*2\.50|phase250)/],
    ['4. runbook mentions Phase 2.51', /(Phase\s*2\.51|phase251)/],
    ['5. runbook mentions Phase 2.52', /(Phase\s*2\.52|phase252)/],
    ['6. runbook mentions Phase 2.53', /(Phase\s*2\.53|phase253)/],
    ['7. runbook mentions Phase 2.54', /(Phase\s*2\.54|phase254)/],
  ];
  for (const [name, re] of phases) {
    out.push({ name, ok: re.test(both), detail: re.source });
  }

  // 8 — dry-run commands present
  out.push({ name: '8. runbook includes dry-run commands', ok: /dry-run/i.test(runbook) && /npm run saas:phase25\d/i.test(runbook), detail: 'dry-run + npm script' });
  // 9 — apply commands present
  out.push({ name: '9. runbook includes apply commands', ok: /AUDIT_LOG_(RETENTION|HARD_DELETE)_APPLY=true/.test(runbook), detail: 'APPLY=true env shown' });
  // 10 — soft-delete snapshot SQL
  out.push({ name: '10. runbook includes snapshot SQL for soft-delete',
    ok: /SET\s+"deletedAt"\s*=\s*NULL/i.test(runbook) && /phase253_pre_apply_snapshot/.test(runbook),
    detail: 'soft-delete snapshot/restore SQL' });
  // 11 — full-row snapshot SQL for hard-delete
  out.push({ name: '11. runbook includes full-row snapshot SQL for hard-delete',
    ok: /SELECT\s*\*\s*FROM\s+audit_logs/i.test(runbook) && /phase254_pre_apply_full_rows/.test(runbook),
    detail: 'full-row snapshot SQL' });
  // 12 — hard-delete cannot be configuration-rolled back
  out.push({ name: '12. runbook states hard-delete cannot be configuration-rolled back',
    ok: /hard-delete cannot be configuration[- ]rolled back/i.test(both) ||
        /Configuration alone does not revert/i.test(runbook) && /full-row snapshot/i.test(runbook),
    detail: 'configuration-rollback negation' });
  // 13 — pg_dump requirement
  out.push({ name: '13. runbook includes pg_dump audit_logs requirement', ok: /pg_dump/.test(runbook) && /audit_logs/.test(runbook), detail: 'pg_dump audit_logs' });
  // 14 — operator approval checklist
  out.push({ name: '14. runbook includes operator approval checklist', ok: /\bOperator approval recorded\b/i.test(runbook) || /operator approval/i.test(runbook), detail: 'approval text' });
  // 15 — go/no-go gates
  out.push({ name: '15. runbook includes go/no-go gates', ok: /Go\s*\/\s*no-go gates/i.test(runbook) && /- \[ \]/.test(runbook), detail: 'gates section + checkboxes' });
  // 16 — tenant/null-tenant/all scope descriptions
  out.push({ name: '16. runbook includes tenant/null-tenant/all scope descriptions',
    ok: /tenant scope/i.test(runbook) && /null-tenant/i.test(runbook) && /\ball scope\b/i.test(runbook),
    detail: 'three scopes mentioned' });
  // 17 — sign-off table
  out.push({ name: '17. runbook includes sign-off table',
    ok: /\| Step \| Owner \| Timestamp/.test(runbook),
    detail: 'sign-off table header' });

  // 18 — hard-delete script still soft-delete-only-eligible
  if (await exists(HARD_DEL)) {
    const src = await read(HARD_DEL);
    const stripped = src.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
    // Eligibility predicate must require deletedAt IS NOT NULL.
    const requiresSoftDeleted = /"deletedAt"\s+IS\s+NOT\s+NULL/.test(stripped);
    // Must use a grace cutoff (deletedAt < cutoff)
    const usesGraceCutoff = /"deletedAt"\s*<\s*\$/.test(stripped) || /"deletedAt"\s*<\s*['"]/.test(stripped);
    out.push({ name: '18. audit-log-hard-delete.ts still requires soft-deleted rows + grace cutoff',
      ok: requiresSoftDeleted && usesGraceCutoff,
      detail: `softDeleted=${requiresSoftDeleted} graceCutoff=${usesGraceCutoff}` });
  } else {
    out.push({ name: '18. audit-log-hard-delete.ts present', ok: false, detail: 'missing' });
  }

  // 19 — soft-delete script still UPDATE only (no DELETE)
  if (await exists(SOFT_DEL)) {
    const src = await read(SOFT_DEL);
    const stripped = src.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
    const noHardDelete =
      !/\.delete(Many)?\s*\(/.test(stripped) &&
      !/\$executeRaw/.test(stripped) &&
      !/DELETE\s+FROM/i.test(stripped);
    const setsDeletedAt = /SET\s+"deletedAt"\s*=\s*now\(\)/.test(stripped);
    out.push({ name: '19. audit-log-retention-enforce.ts performs soft-delete only',
      ok: noHardDelete && setsDeletedAt,
      detail: `noHardDelete=${noHardDelete} setsDeletedAt=${setsDeletedAt}` });
  } else {
    out.push({ name: '19. audit-log-retention-enforce.ts present', ok: false, detail: 'missing' });
  }

  // 20–22 — earlier harnesses are wired into npm scripts (sentinel for the
  // "remains green" acceptance criterion — the runner runs them separately)
  const pkg = await read(PACKAGE);
  out.push({ name: '20. saas:phase254-audit-log-hard-delete-harness wired in package.json',
    ok: /saas:phase254-audit-log-hard-delete-harness/.test(pkg), detail: 'script entry present' });
  out.push({ name: '21. saas:phase253-audit-log-retention-enforce-harness wired',
    ok: /saas:phase253-audit-log-retention-enforce-harness/.test(pkg), detail: 'script entry present' });
  out.push({ name: '22. audit read + preview harnesses wired',
    ok: /saas:phase252-audit-log-read-equivalence/.test(pkg) &&
        /saas:phase252-audit-log-read-isolation/.test(pkg) &&
        /saas:phase252-audit-log-retention-preview/.test(pkg),
    detail: 'three phase252 scripts wired' });

  await fs.mkdir(OUT_DIR, { recursive: true });
  const passed = out.filter((c) => c.ok).length;
  const total  = out.length;
  await fs.writeFile(path.join(OUT_DIR, 'audit-retention-runbook-check.json'),
    JSON.stringify({ passed, total, cases: out }, null, 2));
  const md = [
    `# Phase 2.55 — audit retention runbook check`, ``,
    `**${passed}/${total} PASS**`, ``,
    ...out.map((c) => `- ${c.ok ? 'PASS' : 'FAIL'} — ${c.name} — ${c.detail}`), ``,
  ].join('\n');
  await fs.writeFile(path.join(OUT_DIR, 'audit-retention-runbook-check.md'), md);
  console.log(`[audit-retention-runbook-check] ${passed}/${total} PASS`);
  process.exit(passed === total ? 0 : 1);
}

main().catch((err) => { console.error(err); process.exit(2); });
