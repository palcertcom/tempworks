/**
 * Phase 2C (#33) — Attendance lock scope audit.
 *
 * Reports `attendance_locked_periods` rows whose `employeeId IS NULL`
 * (pre-2C global locks that cover EVERY employee for the same
 * (tenantId, year, month)). The new lock model creates employee-scoped
 * rows; existing global rows are intentionally left untouched so they
 * keep blocking writes until you've reviewed each one.
 *
 * READ-ONLY by default. No remediation is offered — converting a
 * global lock to per-employee rows requires choosing the employee set
 * to lock, which is a product decision; do it from the UI once the
 * employee-scoped lock screen is shipped.
 *
 * Run:
 *   npx ts-node backend/scripts/saas/attendance-lock-scope-audit.ts
 */
/* eslint-disable no-console */
import { promises as fs } from 'fs';
import path from 'path';
import { Client } from 'pg';
import { autoLoadEnv, formatDatabaseUrlMissingMessage } from './phase1/reconciliation/lib/env';

autoLoadEnv(__filename);

const OUT_DIR = path.resolve(__dirname, '..', '..', 'reports', 'saas');

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
    // Be tolerant: the new column may not be present yet if the boot
    // heal hasn't run. Detect by querying information_schema.
    const colExists = await client.query(`
      SELECT 1 FROM information_schema.columns
      WHERE table_name = 'attendance_locked_periods' AND column_name = 'employeeId'
    `);
    if (colExists.rowCount === 0) {
      console.log('[skip] attendance_locked_periods.employeeId column not present yet.');
      console.log('       Start the backend once so the heal step runs, then re-run this audit.');
      return;
    }

    const res = await client.query(`
      SELECT id, "tenantId", year, month, reason, "lockedAt", "lockedById"
      FROM "attendance_locked_periods"
      WHERE "employeeId" IS NULL
      ORDER BY "lockedAt" DESC
    `);
    const rows = res.rows;
    console.log(`\nLegacy / global attendance locks (employeeId IS NULL): ${rows.length}\n`);
    for (const r of rows) {
      console.log(`  ${r.id}  tenant=${r.tenantId ?? 'NULL'}  ${r.year}-${String(r.month).padStart(2, '0')}  reason="${r.reason ?? ''}"  lockedAt=${r.lockedAt?.toISOString?.() ?? r.lockedAt}`);
    }
    if (rows.length === 0) console.log('  ✓ Every lock is employee-scoped.');

    await fs.mkdir(OUT_DIR, { recursive: true });
    await fs.writeFile(
      path.join(OUT_DIR, 'attendance-lock-scope-audit.json'),
      JSON.stringify({ generatedAt: new Date().toISOString(), globalLocks: rows.length, rows }, null, 2),
    );
  } finally {
    await client.end();
  }
}

main().catch((e) => { console.error(e); process.exit(2); });
