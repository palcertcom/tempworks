/**
 * SUPER USER audit — detect PlatformAdmin grants on non-System-Admin users.
 *
 * The core security rule (see docs/saas/TENANT_GUIDE.md §2 and the
 * guards in platform-admin.service.ts / users.service.ts) is that any
 * PlatformAdmin level — SUPPORT, OPERATOR, SUPER — may only attach to a
 * user whose tenant-level role is `System Admin`. Every platform-admin
 * grant flips `agencyIsSystem=true` and bypasses tenant isolation, so a
 * grant sitting on a recruiter / agency manager / finance / HR user is a
 * cross-tenant privilege-escalation risk.
 *
 * This script is READ-ONLY by default: it lists every PlatformAdmin row
 * whose owner is not a System Admin and explains why each is invalid.
 *
 * Remediation is opt-in and gated, mirroring the backfill script:
 *   SUPER_USER_AUDIT_REMEDIATE=true   — enable remediation
 *   SUPER_USER_AUDIT_APPLY=true       — actually write (else dry-run)
 *   classifyRuntimeEnv() ∈ { SAFE_CLONE, SAFE_STAGING }
 * When all three hold, the script DELETES the offending platform_admins
 * rows (the safe remediation: strip platform authority, leave the user
 * and their tenant role untouched). It never promotes anyone to System
 * Admin — that's a deliberate human decision.
 *
 * Usage:
 *   npx ts-node backend/scripts/saas/super-user-audit.ts            # report only
 *   SUPER_USER_AUDIT_REMEDIATE=true SUPER_USER_AUDIT_APPLY=true \
 *     npx ts-node backend/scripts/saas/super-user-audit.ts          # remediate (staging/clone)
 *
 * Output: backend/reports/saas/super-user-audit.{json,md}
 */
/* eslint-disable no-console */
import { promises as fs } from 'fs';
import path from 'path';
import { Client } from 'pg';
import { autoLoadEnv, formatDatabaseUrlMissingMessage } from './phase1/reconciliation/lib/env';
import { classifyRuntimeEnv, isStagingClassification } from '../../src/saas/tenancy/env-safety';

autoLoadEnv(__filename);

const OUT_DIR = path.resolve(__dirname, '..', '..', 'reports', 'saas');

function getDatabaseUrl(): string {
  const arg = process.argv.find((a) => a.startsWith('--db='))?.slice(5);
  return arg ?? process.env.DATABASE_URL ?? (() => { throw new Error(formatDatabaseUrlMissingMessage()); })();
}
function pgClient(url: string): Client {
  // pg-connection-string (v2.7+) now maps `sslmode=require|prefer|
  // verify-ca` to verify-full semantics, which rejects the
  // self-signed certs most managed Postgres instances present. Strip
  // the sslmode from the connection string and set the ssl options
  // explicitly so this script behaves like the app's PrismaService
  // (rejectUnauthorized:false for remote hosts, no ssl for local).
  let host = '';
  let cleanUrl = url;
  try {
    const parsed = new URL(url);
    host = parsed.hostname;
    parsed.searchParams.delete('sslmode');
    cleanUrl = parsed.toString();
  } catch {
    /* leave url as-is if it doesn't parse */
  }
  const isLocal = /^(127\.0\.0\.1|localhost|::1)$/.test(host) || /127\.0\.0\.1|localhost/.test(url);
  return new Client({
    connectionString: cleanUrl,
    ssl: isLocal ? false : { rejectUnauthorized: false },
  });
}

interface OffenderRow {
  userId: string;
  email: string;
  level: string;
  roleName: string | null;
  reason: string;
}

async function main() {
  const url = getDatabaseUrl();
  const client = pgClient(url);
  await client.connect();

  try {
    // Every platform_admins row joined to its user + role. A row is
    // INVALID when the user's role isn't 'System Admin' (or the user
    // has no role / is soft-deleted).
    const res = await client.query(`
      SELECT pa."userId"        AS user_id,
             u.email            AS email,
             pa.level           AS level,
             r.name             AS role_name,
             u."deletedAt"      AS deleted_at
      FROM   platform_admins pa
      JOIN   users u ON u.id = pa."userId"
      LEFT   JOIN roles r ON r.id = u."roleId"
      ORDER  BY pa.level, u.email
    `);

    const all = res.rows as Array<{ user_id: string; email: string; level: string; role_name: string | null; deleted_at: string | null }>;
    const offenders: OffenderRow[] = [];
    for (const row of all) {
      if (row.deleted_at) {
        offenders.push({ userId: row.user_id, email: row.email, level: row.level, roleName: row.role_name, reason: 'user is soft-deleted but still holds a platform_admins row' });
      } else if (row.role_name !== 'System Admin') {
        offenders.push({ userId: row.user_id, email: row.email, level: row.level, roleName: row.role_name, reason: `role is "${row.role_name ?? '(none)'}", not System Admin` });
      }
    }

    console.log(`\nPlatformAdmin rows total: ${all.length}`);
    console.log(`Invalid (non-System-Admin / deleted): ${offenders.length}\n`);
    for (const o of offenders) {
      console.log(`  ✗ ${o.email}  level=${o.level}  — ${o.reason}`);
    }
    if (offenders.length === 0) {
      console.log('  ✓ All platform-admin grants belong to active System Admins.');
    }

    // ── Remediation (opt-in, gated) ────────────────────────────────────────
    const remediate = process.env.SUPER_USER_AUDIT_REMEDIATE === 'true';
    const apply = process.env.SUPER_USER_AUDIT_APPLY === 'true';
    const env = classifyRuntimeEnv();
    let remediated = 0;
    if (remediate && offenders.length > 0) {
      const envOk = isStagingClassification(env.classification);
      if (!apply) {
        console.log(`\n[dry-run] would DELETE ${offenders.length} platform_admins row(s). Set SUPER_USER_AUDIT_APPLY=true to apply.`);
      } else if (!envOk) {
        console.log(`\n[refused] remediation requires a staging/clone env. Current: ${env.classification} (${env.reason}).`);
      } else {
        for (const o of offenders) {
          await client.query('DELETE FROM platform_admins WHERE "userId" = $1', [o.userId]);
          remediated++;
        }
        console.log(`\n[applied] deleted ${remediated} invalid platform_admins row(s).`);
      }
    }

    // ── Report files ───────────────────────────────────────────────────────
    await fs.mkdir(OUT_DIR, { recursive: true });
    const stamp = new Date().toISOString();
    await fs.writeFile(
      path.join(OUT_DIR, 'super-user-audit.json'),
      JSON.stringify({ generatedAt: stamp, total: all.length, invalid: offenders, remediated }, null, 2),
    );
    const md = [
      `# SUPER USER Audit`,
      ``,
      `Generated: ${stamp}`,
      ``,
      `- PlatformAdmin rows total: **${all.length}**`,
      `- Invalid (non-System-Admin or deleted): **${offenders.length}**`,
      `- Remediated this run: **${remediated}**`,
      ``,
      offenders.length ? `## Invalid grants\n\n| Email | Level | Role | Why |\n|---|---|---|---|\n${offenders.map(o => `| ${o.email} | ${o.level} | ${o.roleName ?? '(none)'} | ${o.reason} |`).join('\n')}` : `_No invalid grants._`,
      ``,
      `## Remediation`,
      ``,
      `Default run is read-only. To strip invalid grants on a staging/clone DB:`,
      ``,
      '```',
      `SUPER_USER_AUDIT_REMEDIATE=true SUPER_USER_AUDIT_APPLY=true \\`,
      `  npx ts-node backend/scripts/saas/super-user-audit.ts`,
      '```',
      ``,
      `This DELETEs the offending platform_admins rows only. It never`,
      `promotes anyone to System Admin and never touches users/roles.`,
    ].join('\n');
    await fs.writeFile(path.join(OUT_DIR, 'super-user-audit.md'), md);
    console.log(`\nReport: ${path.join(OUT_DIR, 'super-user-audit.md')}`);

    process.exitCode = offenders.length > 0 && remediated === 0 ? 1 : 0;
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(2);
});
