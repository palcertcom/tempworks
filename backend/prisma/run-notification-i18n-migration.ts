/**
 * Migration: add nullable i18n metadata columns to the `notifications` table
 * (titleKey, messageKey, params) — Phase 3.F.
 *
 * Run with:
 *   npm run db:migrate:notification-i18n
 *
 * Strictly additive and idempotent. The SQL uses `ADD COLUMN IF NOT EXISTS`,
 * so re-running on a database that already has the columns is a no-op.
 */
import { Pool } from 'pg';
import { readFileSync } from 'fs';
import { join } from 'path';
import * as dotenv from 'dotenv';
import { resolvePoolSsl } from './pg-ssl';

dotenv.config();

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error('❌  DATABASE_URL environment variable is not set.');
  console.error('    Set it in your .env file or environment before running this script.');
  process.exit(1);
}

async function main() {
  const pool = new Pool({
    connectionString: DATABASE_URL,
    ssl: resolvePoolSsl(DATABASE_URL),
  });

  const client = await pool.connect();

  try {
    console.log('🔌  Connected to database.');

    // Detect whether all three columns already exist.
    const before = await client.query(`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name   = 'notifications'
        AND column_name  IN ('titleKey', 'messageKey', 'params');
    `);
    if (before.rows.length === 3) {
      console.log('✅  Columns already present — nothing to do.');
      return;
    }

    const sqlPath = join(__dirname, 'migrations', 'add_notification_i18n_fields.sql');
    const sql = readFileSync(sqlPath, 'utf-8');

    console.log('🚀  Running migration: add_notification_i18n_fields.sql …');
    await client.query(sql);

    const after = await client.query(`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name   = 'notifications'
        AND column_name  IN ('titleKey', 'messageKey', 'params')
      ORDER BY column_name;
    `);

    if (after.rows.length === 3) {
      console.log('\n✅  Migration complete. Columns now present on notifications:');
      for (const r of after.rows) console.log(`     • ${r.column_name}`);
    } else {
      console.error('\n⚠️  Warning: expected 3 i18n columns; found:', after.rows.map(r => r.column_name).join(', '));
      process.exit(1);
    }
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch(err => {
  console.error('❌  Migration failed:', err.message ?? err);
  process.exit(1);
});
