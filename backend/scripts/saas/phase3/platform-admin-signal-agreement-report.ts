/**
 * Phase 3.7B — PlatformAdmin signal agreement report (READ-ONLY).
 *
 * Tallies how the legacy `Agency.isSystem` signal and the new
 * `PlatformAdmin` row signal compare across the active user base.
 * Drives the go/no-go decision for Phase 3.8 (drop Agency.isSystem).
 *
 * NO writes. Wraps queries in BEGIN READ ONLY. Refuses on
 * UNSAFE_PRODUCTION / UNKNOWN.
 *
 * Output:
 *   backend/reports/saas/phase3/platform-admin-signal-agreement-report.{json,md}
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
  try { const u = new URL(url); const host = u.hostname || 'unknown';
    return /127\.0\.0\.1|localhost/.test(host) ? `local (${host})`
      : /staging|stg/.test(host) ? `staging (${host})` : `remote (${host})`;
  } catch { return 'unknown'; }
}

async function count(c: Client, sql: string, params: any[] = []): Promise<number> {
  const r = await c.query<{ c: string }>(sql, params);
  return Number(r.rows[0].c);
}

async function main(): Promise<void> {
  const url = getDatabaseUrl();
  const env = classifyRuntimeEnv();
  if (!isStagingClassification(env.classification)) {
    console.error(`[platform-admin-signal-agreement] refusing on classification=${env.classification}`);
    process.exit(3);
  }
  const target = targetType(url);

  const c = pgClient(url); await c.connect();
  let totalActiveUsers = 0;
  let legacyTrue = 0, platformRow = 0, agreementBoth = 0, legacyOnly = 0, platformOnly = 0, neitherCount = 0;
  let inactivePlatform = 0, missingAgencyOnPlatform = 0;
  try {
    await c.query('BEGIN READ ONLY');
    totalActiveUsers = await count(c,
      `SELECT COUNT(*)::text AS c FROM users WHERE "deletedAt" IS NULL AND status = 'ACTIVE'`);
    legacyTrue = await count(c, `
      SELECT COUNT(*)::text AS c FROM users u
        JOIN agencies a ON a.id = u."agencyId"
       WHERE u."deletedAt" IS NULL AND u.status = 'ACTIVE' AND false  /* phase390-agency-is-system-removed */`);
    platformRow = await count(c, `
      SELECT COUNT(*)::text AS c FROM users u
        JOIN platform_admins p ON p."userId" = u.id
       WHERE u."deletedAt" IS NULL AND u.status = 'ACTIVE'`);
    agreementBoth = await count(c, `
      SELECT COUNT(*)::text AS c FROM users u
        JOIN agencies a ON a.id = u."agencyId"
        JOIN platform_admins p ON p."userId" = u.id
       WHERE u."deletedAt" IS NULL AND u.status = 'ACTIVE' AND false  /* phase390-agency-is-system-removed */`);
    legacyOnly = await count(c, `
      SELECT COUNT(*)::text AS c FROM users u
        JOIN agencies a ON a.id = u."agencyId"
       WHERE u."deletedAt" IS NULL AND u.status = 'ACTIVE'
         AND false  /* phase390-agency-is-system-removed */
         AND NOT EXISTS (SELECT 1 FROM platform_admins p WHERE p."userId" = u.id)`);
    platformOnly = await count(c, `
      SELECT COUNT(*)::text AS c FROM users u
        JOIN platform_admins p ON p."userId" = u.id
        LEFT JOIN agencies a ON a.id = u."agencyId"
       WHERE u."deletedAt" IS NULL AND u.status = 'ACTIVE'
         AND true  /* phase390-agency-is-system-removed */`);
    neitherCount = totalActiveUsers - (agreementBoth + legacyOnly + platformOnly);
    inactivePlatform = await count(c, `
      SELECT COUNT(*)::text AS c FROM platform_admins p
       LEFT JOIN users u ON u.id = p."userId"
       WHERE u.id IS NOT NULL AND (u."deletedAt" IS NOT NULL OR u.status <> 'ACTIVE')`);
    missingAgencyOnPlatform = await count(c, `
      SELECT COUNT(*)::text AS c FROM platform_admins p
       LEFT JOIN users u ON u.id = p."userId"
       LEFT JOIN agencies a ON a.id = u."agencyId"
       WHERE u.id IS NOT NULL AND a.id IS NULL`);
    await c.query('ROLLBACK');
  } finally { await c.end(); }

  // Go/no-go for Phase 3.8 (drop Agency.isSystem):
  // - legacyOnly MUST be 0 (every legacy isSystem user must have a
  //   PlatformAdmin row before the column can be retired)
  // - inactivePlatform should be 0 (or triaged manually)
  // - missingAgencyOnPlatform should be 0
  // platformOnly users are fine — they are the intended Phase 3.5 outcome.
  const blockers: string[] = [];
  if (legacyOnly > 0) blockers.push(`legacyOnly=${legacyOnly} — re-run Phase 3.5 backfill before Phase 3.8`);
  if (inactivePlatform > 0) blockers.push(`inactivePlatform=${inactivePlatform} — review and clean orphans`);
  if (missingAgencyOnPlatform > 0) blockers.push(`missingAgencyOnPlatform=${missingAgencyOnPlatform} — repair user.agencyId`);
  const goPhase38 = blockers.length === 0 && totalActiveUsers > 0;

  await fs.mkdir(OUT_DIR, { recursive: true });
  const json = {
    generatedAt: new Date().toISOString(),
    readOnly: true,
    classification: env.classification,
    target,
    totals: {
      totalActiveUsers,
      legacyTrue, platformRow,
      agreementBoth, legacyOnly, platformOnly, neither: neitherCount,
    },
    conflicts: {
      inactivePlatform, missingAgencyOnPlatform,
    },
    goPhase38,
    blockersForPhase38: blockers,
  };
  await fs.writeFile(path.join(OUT_DIR, 'platform-admin-signal-agreement-report.json'), JSON.stringify(json, null, 2));

  const md = [
    `# SaaS Phase 3.7B — PlatformAdmin signal agreement report`,
    ``,
    `Generated: ${json.generatedAt}`,
    `Classification: **${env.classification}**`,
    `Target: ${target}`,
    `Read-only: **true**`,
    ``,
    `## Active user base`,
    `- total active users: **${totalActiveUsers}**`,
    `- legacy Agency.isSystem=true users: **${legacyTrue}**`,
    `- users with a PlatformAdmin row: **${platformRow}**`,
    ``,
    `## Signal agreement`,
    `- both signals true (agreementBoth): **${agreementBoth}**`,
    `- legacy true, no PlatformAdmin (legacyOnly): **${legacyOnly}**  ${legacyOnly > 0 ? '⚠ blocker for Phase 3.8' : ''}`,
    `- PlatformAdmin only, agency not isSystem (platformOnly): **${platformOnly}**  ${platformOnly > 0 ? '(intended Phase 3.5 outcome)' : ''}`,
    `- neither signal: **${neitherCount}**`,
    ``,
    `## Conflicts`,
    `- inactive/deleted PlatformAdmin users: **${inactivePlatform}**`,
    `- PlatformAdmin users with missing agency: **${missingAgencyOnPlatform}**`,
    ``,
    `## Go / no-go for Phase 3.8 (drop Agency.isSystem)`,
    `- **${goPhase38 ? 'GO' : 'NO-GO'}**`,
    blockers.length === 0 ? '' : '- Blockers:',
    ...blockers.map((b) => `  - ${b}`),
    ``,
  ].filter(Boolean).join('\n');
  await fs.writeFile(path.join(OUT_DIR, 'platform-admin-signal-agreement-report.md'), md);
  console.log(`[platform-admin-signal-agreement] activeUsers=${totalActiveUsers} legacyTrue=${legacyTrue} platformRow=${platformRow} legacyOnly=${legacyOnly} platformOnly=${platformOnly} go38=${goPhase38}`);
}

main().catch((err) => { console.error(err); process.exit(2); });
