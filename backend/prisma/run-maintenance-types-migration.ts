/**
 * Migration: create maintenance_type table.
 *
 * Run with:
 *   npm run db:migrate:maintenance-types
 *
 * Safe to run multiple times — all CREATE TABLE / CREATE INDEX statements
 * use IF NOT EXISTS so re-running is idempotent.
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

    // Check if the table already exists
    const check = await client.query(`
      SELECT tablename FROM pg_tables
      WHERE schemaname = 'public'
        AND tablename = 'maintenance_type';
    `);

    if (check.rows.length > 0) {
      console.log('✅  Table already exists — nothing to do.');
      return;
    }

    // Read and execute the migration SQL
    const sqlPath = join(__dirname, 'migrations', 'add_maintenance_types.sql');
    const sql = readFileSync(sqlPath, 'utf-8');

    console.log('🚀  Running migration: add_maintenance_types.sql …');
    await client.query(sql);

    // Verify
    const verify = await client.query(`
      SELECT tablename FROM pg_tables
      WHERE schemaname = 'public'
        AND tablename = 'maintenance_type';
    `);

    if (verify.rows.length > 0) {
      console.log('\n✅  Migration complete. Table created:');
      console.log('     • maintenance_type');
      console.log('     • IntervalMode enum');
    } else {
      console.error('\n⚠️  Warning: maintenance_type table may not have been created.');
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
