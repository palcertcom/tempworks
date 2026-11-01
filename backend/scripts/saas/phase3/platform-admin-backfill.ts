/**
 * Phase 3.5 — PlatformAdmin backfill from Agency.isSystem (DRY-RUN BY DEFAULT).
 *
 * Promotes every active user attached to an `Agency.isSystem=true`
 * agency to a `PlatformAdmin{level: SUPER, grantedBy: 'phase350-backfill'}`
 * row. Idempotent (rows with existing PlatformAdmin are skipped via
 * the userId UNIQUE constraint + an explicit NOT EXISTS pre-check).
 *
 * Three gates required for any write:
 *   1. PLATFORM_ADMIN_BACKFILL_ENABLED=true
 *   2. PLATFORM_ADMIN_BACKFILL_APPLY=true
 *   3. classifyRuntimeEnv() ∈ { SAFE_CLONE, SAFE_STAGING }
 *
 * Never:
 *   - duplicates an existing PlatformAdmin row
 *   - mutates Agency.isSystem
 *   - touches User / Agency rows
 *   - hard-deletes anything
 *
 * PlatformAuditLog write is DEFERRED because the platform_audit_log
 * table is not present in the fixture (the Prisma model exists but no
 * migration creates the table). Each inserted row carries
 * `grantedBy='phase350-backfill'` so rollback is exact.
 *
 * Output: backend/reports/saas/phase3/platform-admin-backfill.{json,md}
 */
/* eslint-disable no-console */
import { promises as fs } from 'fs';
import path from 'path';
import { Client } from 'pg';
import { autoLoadEnv, formatDatabaseUrlMissingMessage } from './../phase1/reconciliation/lib/env';
import { classifyRuntimeEnv, isStagingClassification } from '../../../src/saas/tenancy/env-safety';

autoLoadEnv(__filename);

const OUT_DIR = path.resolve(__dirname, '..', '..', '..', 'reports', 'saas', 'phase3');
const GRANT_TAG = 'phase350-backfill';

function getDatabaseUrl(): string {
  const arg = process.argv.find((a) => a.startsWith('--db='))?.slice(5);
  return arg ?? process.env.DATABASE_URL ?? (() => { throw new Error(formatDatabaseUrlMissingMessage()); })();
}
function pgClient(url: string): Client {
  return new Client({ connectionString: url, ssl: /127\.0\.0\.1|localhost/.test(url) ? false : { rejectUnauthorized: false } });
}

interface SkippedCounts {
  alreadyPlatformAdmin: number;
  deletedOrInactiveUser: number;
  missingUser: number;
  nonSystemAgency: number;
  multipleSystemAgencies: number;
  ambiguousMembership: number;
}
interface BackfillOutcome {
  generatedAt: string;
  mode: 'dry-run' | 'apply';
  applied: boolean;
  safeClassification: boolean;
  classification: string;
  refusalReason: string | null;
  eligibleCount: number;
  insertedCount: number;
  skippedCounts: SkippedCounts;
  beforePlatformAdminCount: number;
  afterPlatformAdminCount: number;
  insertedUserIds: string[];
  platformAuditLogDeferred: boolean;
}

async function main(): Promise<void> {
  const url = getDatabaseUrl();
  const env = classifyRuntimeEnv();
  const enabled = process.env.PLATFORM_ADMIN_BACKFILL_ENABLED === 'true';
  const apply   = process.env.PLATFORM_ADMIN_BACKFILL_APPLY === 'true';
  const safe    = isStagingClassification(env.classification);

  let refusalReason: string | null = null;
  if (apply && !enabled) refusalReason = 'PLATFORM_ADMIN_BACKFILL_ENABLED is not true';
  else if (apply && !safe) refusalReason = `classification=${env.classification} is not SAFE_CLONE/SAFE_STAGING`;

  const mode: 'dry-run' | 'apply' = apply && enabled && safe ? 'apply' : 'dry-run';

  const out: BackfillOutcome = {
    generatedAt: new Date().toISOString(),
    mode,
    applied: false,
    safeClassification: safe,
    classification: env.classification,
    refusalReason,
    eligibleCount: 0,
    insertedCount: 0,
    skippedCounts: {
      alreadyPlatformAdmin: 0, deletedOrInactiveUser: 0, missingUser: 0,
      nonSystemAgency: 0, multipleSystemAgencies: 0, ambiguousMembership: 0,
    },
    beforePlatformAdminCount: 0,
    afterPlatformAdminCount: 0,
    insertedUserIds: [],
    platformAuditLogDeferred: true,
  };

  // If gates are closed for an apply attempt, write refusal report WITHOUT
  // opening DB so a misconfigured host (e.g. unreachable) cannot hang.
  if (apply && refusalReason !== null) {
    await fs.mkdir(OUT_DIR, { recursive: true });
    await fs.writeFile(path.join(OUT_DIR, 'platform-admin-backfill.json'), JSON.stringify(out, null, 2));
    await fs.writeFile(path.join(OUT_DIR, 'platform-admin-backfill.md'),
      `# Phase 3.5 — PlatformAdmin backfill\n\nRefused: ${refusalReason}\nMode: dry-run (apply gates closed)\n`);
    console.log(`[platform-admin-backfill] mode=dry-run refused="${refusalReason}"`);
    return;
  }

  const c = pgClient(url); await c.connect();
  try {
    out.beforePlatformAdminCount = Number((await c.query<{ c: string }>(
      `SELECT COUNT(*)::text AS c FROM platform_admins`)).rows[0].c);

    // Discovery: every active user attached to an isSystem agency.
    const candidates = await c.query<{ userId: string; agencyId: string; alreadyPa: boolean; deleted: boolean }>(`
      SELECT u.id::text       AS "userId",
             u."agencyId"::text AS "agencyId",
             EXISTS (SELECT 1 FROM platform_admins p WHERE p."userId" = u.id) AS "alreadyPa",
             (u."deletedAt" IS NOT NULL OR u.status <> 'ACTIVE') AS deleted
        FROM users u
        JOIN agencies a ON a.id = u."agencyId"
       WHERE false  /* phase390-agency-is-system-removed */
       ORDER BY u.id`);

    out.skippedCounts.alreadyPlatformAdmin = candidates.rows.filter((r) => r.alreadyPa).length;
    out.skippedCounts.deletedOrInactiveUser = candidates.rows.filter((r) => r.deleted).length;

    // multipleSystemAgencies — users appearing as members of more than one
    // isSystem agency. With users.agencyId being a single FK this should
    // always be 0, but we surface it anyway.
    out.skippedCounts.multipleSystemAgencies = Number((await c.query<{ c: string }>(`
      SELECT COUNT(*)::text AS c FROM (
        SELECT u.id FROM users u
          JOIN agencies a ON a.id = u."agencyId"
         WHERE false  /* phase390-agency-is-system-removed */
         GROUP BY u.id HAVING COUNT(DISTINCT u."agencyId") > 1
      ) x`)).rows[0].c);

    // missingUser — PlatformAdmin rows whose userId no longer maps to a user.
    out.skippedCounts.missingUser = Number((await c.query<{ c: string }>(`
      SELECT COUNT(*)::text AS c FROM platform_admins p
       WHERE NOT EXISTS (SELECT 1 FROM users u WHERE u.id = p."userId")
    `)).rows[0].c);

    const eligible = candidates.rows.filter((r) => !r.alreadyPa && !r.deleted);
    out.eligibleCount = eligible.length;

    if (mode === 'apply' && refusalReason === null) {
      // Apply: insert PlatformAdmin SUPER rows. ON CONFLICT (userId) DO NOTHING
      // guarantees idempotency even under racing runs.
      await c.query('BEGIN');
      try {
        for (const u of eligible) {
          const r = await c.query(`
            INSERT INTO platform_admins (id, "userId", level, "grantedBy", "grantedAt")
            VALUES (gen_random_uuid()::text, $1, 'SUPER', $2, now())
            ON CONFLICT ("userId") DO NOTHING`, [u.userId, GRANT_TAG]);
          if (r.rowCount && r.rowCount > 0) {
            out.insertedCount += 1;
            out.insertedUserIds.push(u.userId);
          }
        }
        await c.query('COMMIT');
        out.applied = true;
      } catch (err) {
        await c.query('ROLLBACK');
        throw err;
      }
    }

    out.afterPlatformAdminCount = Number((await c.query<{ c: string }>(
      `SELECT COUNT(*)::text AS c FROM platform_admins`)).rows[0].c);
  } finally { await c.end(); }

  await fs.mkdir(OUT_DIR, { recursive: true });
  await fs.writeFile(path.join(OUT_DIR, 'platform-admin-backfill.json'), JSON.stringify(out, null, 2));
  const md = [
    `# Phase 3.5 — PlatformAdmin backfill`,
    ``,
    `Generated: ${out.generatedAt}`,
    `Classification: **${out.classification}**`,
    `Mode: **${out.mode}** | Applied: **${out.applied}**${out.refusalReason ? ` (refused: ${out.refusalReason})` : ''}`,
    ``,
    `## Counts`,
    `- eligible: **${out.eligibleCount}**`,
    `- inserted this run: **${out.insertedCount}**`,
    `- before / after PlatformAdmin total: ${out.beforePlatformAdminCount} → ${out.afterPlatformAdminCount}`,
    ``,
    `## Skipped`,
    `- already PlatformAdmin: ${out.skippedCounts.alreadyPlatformAdmin}`,
    `- deleted or inactive user: ${out.skippedCounts.deletedOrInactiveUser}`,
    `- missing user (orphan PlatformAdmin): ${out.skippedCounts.missingUser}`,
    `- non-system agency: ${out.skippedCounts.nonSystemAgency} (not considered)`,
    `- multiple system agencies: ${out.skippedCounts.multipleSystemAgencies}`,
    `- ambiguous membership: ${out.skippedCounts.ambiguousMembership}`,
    ``,
    `## PlatformAuditLog`,
    `Deferred. The \`platform_audit_log\` table is not present in the active`,
    `database (Prisma model exists; no migration creates it). Each inserted`,
    `PlatformAdmin row is tagged with \`grantedBy='${GRANT_TAG}'\` for exact`,
    `rollback.`,
    ``,
    `## Rollback`,
    '```sql',
    `DELETE FROM platform_admins WHERE "grantedBy" = '${GRANT_TAG}';`,
    '```',
    ``,
  ].join('\n');
  await fs.writeFile(path.join(OUT_DIR, 'platform-admin-backfill.md'), md);
  console.log(`[platform-admin-backfill] mode=${out.mode} eligible=${out.eligibleCount} inserted=${out.insertedCount}${out.refusalReason ? ' refused="' + out.refusalReason + '"' : ''}`);
}

main().catch((err) => { console.error(err); process.exit(2); });
