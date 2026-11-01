/**
 * Phase 2C (#36) — Grant Agency Manager the attendance permissions.
 *
 * Idempotent: on every run it computes the missing rows and inserts
 * only those. Already-present permission grants are skipped silently.
 * Safe to run repeatedly and against any environment.
 *
 * Run from the backend folder:
 *   npx ts-node scripts/saas/grant-agency-manager-attendance.ts
 *
 * Background:
 * Before Phase 2C the seed didn't grant Agency Manager any
 * attendance:* permissions, so even after we updated the seed in
 * Phase 2B the existing role rows in production / staging DBs were
 * still missing them. This script aligns existing DBs with the new
 * seed without needing a full `prisma db seed` (which would touch
 * every other role too).
 */
/* eslint-disable no-console */
import { Client } from 'pg';
import { autoLoadEnv, formatDatabaseUrlMissingMessage } from './phase1/reconciliation/lib/env';

autoLoadEnv(__filename);

const TARGET_ROLE = 'Agency Manager';
const PERMS = [
  'attendance:read',
  'attendance:create',
  'attendance:update',
  'attendance:delete',
  'attendance:export',
];

function getDatabaseUrl(): string {
  const arg = process.argv.find((a) => a.startsWith('--db='))?.slice(5);
  return arg ?? process.env.DATABASE_URL ?? (() => { throw new Error(formatDatabaseUrlMissingMessage()); })();
}
function pgClient(url: string): Client {
  let host = ''; let clean = url;
  try { const u = new URL(url); host = u.hostname; u.searchParams.delete('sslmode'); clean = u.toString(); } catch { /* keep */ }
  const local = /^(127\.0\.0\.1|localhost|::1)$/.test(host) || /127\.0\.0\.1|localhost/.test(url);
  return new Client({ connectionString: clean, ssl: local ? false : { rejectUnauthorized: false } });
}

async function main() {
  const client = pgClient(getDatabaseUrl());
  await client.connect();
  try {
    const role = await client.query(`SELECT id FROM "roles" WHERE name = $1 LIMIT 1`, [TARGET_ROLE]);
    if (role.rowCount === 0) {
      console.log(`[skip] role "${TARGET_ROLE}" not found in this DB`);
      return;
    }
    const roleId = role.rows[0].id;

    const perms = await client.query(
      `SELECT id, name FROM "permissions" WHERE name = ANY($1::text[])`,
      [PERMS],
    );
    const permMap = new Map<string, string>(perms.rows.map((r: any) => [r.name, r.id]));
    const missingPerms = PERMS.filter((p) => !permMap.has(p));
    if (missingPerms.length) {
      console.log(`[warn] these permission rows are missing from the DB (seed not yet applied): ${missingPerms.join(', ')}`);
      console.log('       run `npx prisma db seed` or apply the seed pattern from backend/prisma/seed.ts first.');
    }

    const existing = await client.query(
      `SELECT "permissionId" FROM "role_permissions" WHERE "roleId" = $1`,
      [roleId],
    );
    const haveIds = new Set<string>(existing.rows.map((r: any) => r.permissionId));
    const targets = [...permMap.entries()].filter(([_, id]) => !haveIds.has(id));

    if (targets.length === 0) {
      console.log(`[ok] ${TARGET_ROLE} already has every requested attendance permission.`);
      return;
    }
    console.log(`[apply] adding ${targets.length} role_permission row(s) to "${TARGET_ROLE}":`);
    for (const [name, permissionId] of targets) {
      // role_permissions has a composite primary key (roleId, permissionId).
      // ON CONFLICT DO NOTHING makes this safe even if a concurrent run
      // inserted the same pair.
      await client.query(
        `INSERT INTO "role_permissions" ("roleId", "permissionId") VALUES ($1, $2) ON CONFLICT DO NOTHING`,
        [roleId, permissionId],
      );
      console.log(`   ✓ ${name}`);
    }

    const skipped = PERMS.filter((p) => permMap.has(p) && haveIds.has(permMap.get(p)!));
    if (skipped.length) {
      console.log(`[ok] already present (skipped): ${skipped.join(', ')}`);
    }
  } finally {
    await client.end();
  }
}

main().catch((e) => { console.error(e); process.exit(2); });
