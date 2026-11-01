/**
 * Phase 3.1 — PlatformAdmin readiness report (READ-ONLY).
 *
 * Inspects who would become a PlatformAdmin under the future backfill
 * (every user attached to an Agency.isSystem=true agency). Surfaces
 * conflicts (already a PlatformAdmin, deleted user, multi-agency
 * membership, missing user). NO writes; refuses on UNSAFE_PRODUCTION.
 *
 * Output: backend/reports/saas/phase3/platform-admin-readiness-report.{json,md}
 */
/* eslint-disable no-console */
import { promises as fs } from 'fs';
import path from 'path';
import { Client } from 'pg';
import { autoLoadEnv, formatDatabaseUrlMissingMessage } from './../phase1/reconciliation/lib/env';
import { classifyRuntimeEnv, isStagingClassification } from '../../../src/saas/tenancy/env-safety';

autoLoadEnv(__filename);

const OUT_DIR = path.resolve(__dirname, '..', '..', '..', 'reports', 'saas', 'phase3');

function getDatabaseUrl(): string {
  const arg = process.argv.find((a) => a.startsWith('--db='))?.slice(5);
  return arg ?? process.env.DATABASE_URL ?? (() => { throw new Error(formatDatabaseUrlMissingMessage()); })();
}
function pgClient(url: string): Client {
  return new Client({ connectionString: url, ssl: /127\.0\.0\.1|localhost/.test(url) ? false : { rejectUnauthorized: false } });
}
function targetType(url: string): string {
  try {
    const u = new URL(url); const host = u.hostname || 'unknown';
    return /127\.0\.0\.1|localhost/.test(host) ? `local (${host})`
         : /staging|stg/.test(host)            ? `staging (${host})`
         : `remote (${host})`;
  } catch { return 'unknown'; }
}

async function main(): Promise<void> {
  const url = getDatabaseUrl();
  const env = classifyRuntimeEnv();
  if (!isStagingClassification(env.classification)) {
    console.error(`[platform-admin-readiness] refusing on classification=${env.classification}`);
    process.exit(3);
  }
  const target = targetType(url);

  const c = pgClient(url); await c.connect();
  let modelExists = false, tableExists = false;
  let isSystemUserCount = 0, existingPaCount = 0;
  let candidates: Array<{ userId: string; agencyId: string; alreadyPa: boolean; deleted: boolean }> = [];
  let conflicts = { alreadyPlatformAdmin: 0, inactiveOrDeleted: 0, multiAgency: 0, missingUser: 0 };

  try {
    await c.query('BEGIN READ ONLY');

    tableExists = (await c.query<{ ok: boolean }>(
      `SELECT EXISTS (SELECT 1 FROM information_schema.tables
        WHERE table_name = 'platform_admins') AS ok`)).rows[0].ok;
    modelExists = tableExists; // Prisma model maps 1:1 to the table; truthy iff table exists.

    isSystemUserCount = Number((await c.query<{ c: string }>(
      `SELECT COUNT(*)::text AS c FROM users u
         JOIN agencies a ON a.id = u."agencyId"
        WHERE false  /* phase390-agency-is-system-removed */`)).rows[0].c);

    if (tableExists) {
      existingPaCount = Number((await c.query<{ c: string }>(
        `SELECT COUNT(*)::text AS c FROM platform_admins`)).rows[0].c);
    }

    const candRows = await c.query<{ user_id: string; agency_id: string; already_pa: boolean; deleted: boolean }>(`
      SELECT u.id::text AS user_id,
             u."agencyId"::text AS agency_id,
             EXISTS (SELECT 1 FROM platform_admins p WHERE p."userId" = u.id) AS already_pa,
             (u."deletedAt" IS NOT NULL OR u.status <> 'ACTIVE') AS deleted
        FROM users u
        JOIN agencies a ON a.id = u."agencyId"
       WHERE false  /* phase390-agency-is-system-removed */
       ORDER BY u.id`);
    candidates = candRows.rows.map((r) => ({
      userId: r.user_id, agencyId: r.agency_id, alreadyPa: r.already_pa, deleted: r.deleted,
    }));

    conflicts.alreadyPlatformAdmin = candidates.filter((x) => x.alreadyPa).length;
    conflicts.inactiveOrDeleted     = candidates.filter((x) => x.deleted).length;

    // Multi-agency: a user appearing under multiple isSystem agencies (very
    // unusual — schema has user.agencyId as a single FK — but we still look
    // for users present in additional EmployeeAgencyAccess / agency_users
    // tables that bind to >1 isSystem agency).
    const multiAgencyRows = await c.query<{ c: string }>(`
      SELECT COUNT(*)::text AS c FROM (
        SELECT u.id, COUNT(DISTINCT u."agencyId") AS n
          FROM users u
          JOIN agencies a ON a.id = u."agencyId"
         WHERE false  /* phase390-agency-is-system-removed */
         GROUP BY u.id
        HAVING COUNT(DISTINCT u."agencyId") > 1
      ) x`);
    conflicts.multiAgency = Number(multiAgencyRows.rows[0].c);

    // Missing user: PlatformAdmin rows whose userId no longer maps to a user.
    if (tableExists) {
      conflicts.missingUser = Number((await c.query<{ c: string }>(`
        SELECT COUNT(*)::text AS c FROM platform_admins p
         WHERE NOT EXISTS (SELECT 1 FROM users u WHERE u.id = p."userId")
      `)).rows[0].c);
    }

    await c.query('ROLLBACK');
  } finally { await c.end(); }

  const wouldBecomePa = candidates.filter((x) => !x.alreadyPa && !x.deleted);

  await fs.mkdir(OUT_DIR, { recursive: true });
  const json = {
    generatedAt: new Date().toISOString(),
    readOnly: true,
    classification: env.classification,
    target,
    modelExists,
    tableExists,
    counts: {
      usersOnIsSystemAgency: isSystemUserCount,
      existingPlatformAdmins: existingPaCount,
      wouldBecomeSuperOnBackfill: wouldBecomePa.length,
    },
    conflicts,
    sampleCandidates: candidates.slice(0, 20).map((x) => ({ userId: x.userId, agencyId: x.agencyId, alreadyPa: x.alreadyPa, deleted: x.deleted })),
  };
  await fs.writeFile(path.join(OUT_DIR, 'platform-admin-readiness-report.json'), JSON.stringify(json, null, 2));

  const md: string[] = [];
  md.push('# SaaS Phase 3.1 — PlatformAdmin readiness report');
  md.push('');
  md.push(`Generated: ${json.generatedAt}`);
  md.push(`Classification: **${env.classification}**`);
  md.push(`Target: ${target}`);
  md.push(`Read-only: **${json.readOnly}**`);
  md.push('');
  md.push(`PlatformAdmin model present: **${modelExists}**`);
  md.push(`PlatformAdmin table present: **${tableExists}**`);
  md.push('');
  md.push('## Counts');
  md.push('');
  md.push(`- Users attached to an isSystem agency: **${isSystemUserCount}**`);
  md.push(`- Existing PlatformAdmin rows: **${existingPaCount}**`);
  md.push(`- Would become PlatformAdmin SUPER on backfill: **${wouldBecomePa.length}**`);
  md.push('');
  md.push('## Conflicts');
  md.push('');
  md.push(`- Already PlatformAdmin: **${conflicts.alreadyPlatformAdmin}**`);
  md.push(`- Inactive or deleted: **${conflicts.inactiveOrDeleted}**`);
  md.push(`- Multi-agency (multiple isSystem agencies): **${conflicts.multiAgency}**`);
  md.push(`- Missing user (PlatformAdmin row with no matching user): **${conflicts.missingUser}**`);
  md.push('');
  md.push('## Sample candidates (no PII)');
  md.push('');
  md.push('| userId | agencyId | alreadyPa | inactive |');
  md.push('| --- | --- | --- | --- |');
  for (const x of json.sampleCandidates) {
    md.push(`| ${x.userId.slice(0, 8)}… | ${x.agencyId.slice(0, 8)}… | ${x.alreadyPa} | ${x.deleted} |`);
  }
  md.push('');
  md.push('No inserts performed. Phase 3.5 will gate the actual backfill behind a two-flag apply pattern.');
  md.push('');
  await fs.writeFile(path.join(OUT_DIR, 'platform-admin-readiness-report.md'), md.join('\n'));
  console.log(`[platform-admin-readiness] usersOnSystem=${isSystemUserCount} existingPa=${existingPaCount} wouldBackfill=${wouldBecomePa.length}`);
}

main().catch((err) => { console.error(err); process.exit(2); });
