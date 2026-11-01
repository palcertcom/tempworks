/**
 * Phase 3.2 — Duplicate cleanup apply (DRY-RUN BY DEFAULT).
 *
 * Reads `reports/saas/phase3/duplicate-cleanup-plan.json` (must be
 * pre-generated) and soft-deletes the rows listed under each `exact`
 * group's `softDeleteIds`. Never mutates `conflicting_active`,
 * `null_tenant_assignment_required`, or `cross_tenant_observation`
 * groups.
 *
 * Three gates, all required for any write to happen:
 *   1. PHASE3_DUPLICATE_CLEANUP_ENABLED=true
 *   2. PHASE3_DUPLICATE_CLEANUP_APPLY=true
 *   3. classifyRuntimeEnv() ∈ { SAFE_CLONE, SAFE_STAGING }
 *
 * Soft-delete only. No hard-delete. Idempotent (rows already with
 * deletedAt set are skipped). Stamps `deletedBy='phase320'` and
 * `deletionReason='phase320-duplicate-cleanup'`.
 *
 * Output: backend/reports/saas/phase3/duplicate-cleanup-apply.{json,md}
 */
/* eslint-disable no-console */
import { promises as fs } from 'fs';
import path from 'path';
import { Client } from 'pg';
import { autoLoadEnv, formatDatabaseUrlMissingMessage } from './../phase1/reconciliation/lib/env';
import { classifyRuntimeEnv, isStagingClassification } from '../../../src/saas/tenancy/env-safety';

autoLoadEnv(__filename);

const OUT_DIR = path.resolve(__dirname, '..', '..', '..', 'reports', 'saas', 'phase3');
const PLAN_PATH = path.join(OUT_DIR, 'duplicate-cleanup-plan.json');

function getDatabaseUrl(): string {
  const arg = process.argv.find((a) => a.startsWith('--db='))?.slice(5);
  return arg ?? process.env.DATABASE_URL ?? (() => { throw new Error(formatDatabaseUrlMissingMessage()); })();
}
function pgClient(url: string): Client {
  return new Client({ connectionString: url, ssl: /127\.0\.0\.1|localhost/.test(url) ? false : { rejectUnauthorized: false } });
}

interface ApplyOutcome {
  generatedAt: string;
  classification: string;
  enabled: boolean;
  apply: boolean;
  refusedReason: string | null;
  dryRun: boolean;
  exactGroupsConsidered: number;
  rowsSoftDeleted: number;
  rowsAlreadyDeleted: number;
  refusedConflictingActive: number;
  refusedNullTenant: number;
  refusedCrossTenant: number;
  beforeActiveCount: Record<string, number>;
  afterActiveCount: Record<string, number>;
}

async function activeCount(c: Client, table: string): Promise<number> {
  const r = await c.query<{ c: string }>(`SELECT COUNT(*)::text AS c FROM "${table}" WHERE "deletedAt" IS NULL`);
  return Number(r.rows[0].c);
}

async function main(): Promise<void> {
  const url = getDatabaseUrl();
  const env = classifyRuntimeEnv();
  const enabled = process.env.PHASE3_DUPLICATE_CLEANUP_ENABLED === 'true';
  const apply   = process.env.PHASE3_DUPLICATE_CLEANUP_APPLY === 'true';
  const safeEnv = isStagingClassification(env.classification);

  let refusedReason: string | null = null;
  if (!enabled) refusedReason = 'PHASE3_DUPLICATE_CLEANUP_ENABLED is not true';
  else if (!apply) refusedReason = 'PHASE3_DUPLICATE_CLEANUP_APPLY is not true';
  else if (!safeEnv) refusedReason = `classification=${env.classification} is not SAFE_CLONE/SAFE_STAGING`;

  // Load plan (may not exist yet on first run — treat as no-op)
  let plan: any = null;
  try { plan = JSON.parse(await fs.readFile(PLAN_PATH, 'utf8')); }
  catch { refusedReason ??= 'plan file missing — run saas:phase320-duplicate-cleanup-plan first'; }

  const exactGroups = (plan?.groups ?? []).filter((g: any) => g.bucket === 'exact' && (g.softDeleteIds?.length ?? 0) > 0);
  const refusedConflicting = (plan?.groups ?? []).filter((g: any) => g.bucket === 'conflicting_active').length;
  const refusedNull        = (plan?.groups ?? []).filter((g: any) => g.bucket === 'null_tenant_assignment_required').length;
  const refusedCross       = (plan?.groups ?? []).filter((g: any) => g.bucket === 'cross_tenant_observation').length;

  const out: ApplyOutcome = {
    generatedAt: new Date().toISOString(),
    classification: env.classification,
    enabled, apply,
    refusedReason,
    dryRun: refusedReason !== null,
    exactGroupsConsidered: exactGroups.length,
    rowsSoftDeleted: 0,
    rowsAlreadyDeleted: 0,
    refusedConflictingActive: refusedConflicting,
    refusedNullTenant: refusedNull,
    refusedCrossTenant: refusedCross,
    beforeActiveCount: {},
    afterActiveCount: {},
  };

  // If any gate is closed, write the refusal report WITHOUT opening the DB —
  // refusal must happen even when the connection target is unreachable.
  if (refusedReason !== null) {
    await fs.mkdir(OUT_DIR, { recursive: true });
    await fs.writeFile(path.join(OUT_DIR, 'duplicate-cleanup-apply.json'), JSON.stringify(out, null, 2));
    await fs.writeFile(path.join(OUT_DIR, 'duplicate-cleanup-apply.md'),
      `# Phase 3.2 — Duplicate cleanup apply\n\nRefused: ${refusedReason}\nClassification: ${env.classification}\nDry-run: true\n`);
    console.log(`[duplicate-cleanup-apply] dryRun=true refused="${refusedReason}"`);
    return;
  }

  const c = pgClient(url); await c.connect();
  try {
    out.beforeActiveCount.employees  = await activeCount(c, 'employees');
    out.beforeActiveCount.applicants = await activeCount(c, 'applicants');

    if (refusedReason === null) {
      // Apply within a single transaction so we either fully commit or fully roll back.
      await c.query('BEGIN');
      try {
        for (const g of exactGroups) {
          const table = g.table === 'employees' ? 'employees' : 'applicants';
          for (const id of g.softDeleteIds) {
            // Idempotent: only flip rows still active.
            const r = await c.query(
              `UPDATE "${table}"
                  SET "deletedAt" = COALESCE("deletedAt", now()),
                      "deletedBy" = COALESCE("deletedBy", 'phase320'),
                      "deletionReason" = COALESCE("deletionReason", 'phase320-duplicate-cleanup')
                WHERE id = $1 AND "deletedAt" IS NULL`, [id]);
            if (r.rowCount && r.rowCount > 0) out.rowsSoftDeleted += r.rowCount;
            else out.rowsAlreadyDeleted += 1;
          }
        }
        await c.query('COMMIT');
      } catch (err) {
        await c.query('ROLLBACK');
        throw err;
      }
    }

    out.afterActiveCount.employees  = await activeCount(c, 'employees');
    out.afterActiveCount.applicants = await activeCount(c, 'applicants');
  } finally { await c.end(); }

  await fs.mkdir(OUT_DIR, { recursive: true });
  await fs.writeFile(path.join(OUT_DIR, 'duplicate-cleanup-apply.json'), JSON.stringify(out, null, 2));
  const md = [
    `# Phase 3.2 — Duplicate cleanup apply`, ``,
    `Generated: ${out.generatedAt}`,
    `Classification: **${out.classification}**`,
    `Enabled: **${out.enabled}** | Apply: **${out.apply}**`,
    `Dry-run: **${out.dryRun}**${out.refusedReason ? ` (refused: ${out.refusedReason})` : ''}`,
    ``,
    `## Counts`,
    ``,
    `- exact groups considered: ${out.exactGroupsConsidered}`,
    `- rows soft-deleted this run: **${out.rowsSoftDeleted}**`,
    `- rows already soft-deleted (idempotent): ${out.rowsAlreadyDeleted}`,
    `- conflicting_active groups refused: ${out.refusedConflictingActive}`,
    `- null_tenant groups refused: ${out.refusedNullTenant}`,
    `- cross_tenant observation groups refused: ${out.refusedCrossTenant}`,
    ``,
    `## Active counts (before / after)`,
    ``,
    `- employees: ${out.beforeActiveCount.employees} → ${out.afterActiveCount.employees}`,
    `- applicants: ${out.beforeActiveCount.applicants} → ${out.afterActiveCount.applicants}`,
    ``,
    `Soft-delete only. No hard-delete. No tenantId mutation. Rollback via:`,
    ``,
    '```sql',
    `UPDATE employees   SET "deletedAt"=NULL, "deletedBy"=NULL, "deletionReason"=NULL WHERE "deletionReason"='phase320-duplicate-cleanup';`,
    `UPDATE applicants  SET "deletedAt"=NULL, "deletedBy"=NULL, "deletionReason"=NULL WHERE "deletionReason"='phase320-duplicate-cleanup';`,
    '```',
    ``,
  ].join('\n');
  await fs.writeFile(path.join(OUT_DIR, 'duplicate-cleanup-apply.md'), md);
  console.log(`[duplicate-cleanup-apply] dryRun=${out.dryRun} softDeleted=${out.rowsSoftDeleted} considered=${out.exactGroupsConsidered}${out.refusedReason ? ' refused=' + out.refusedReason : ''}`);
}

main().catch((err) => { console.error(err); process.exit(2); });
