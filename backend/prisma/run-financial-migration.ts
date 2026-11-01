/**
 * Migration: create financial_records and financial_record_attachments tables.
 *
 * Run with:
 *   npx ts-node prisma/run-financial-migration.ts
 *
 * Or from the backend directory:
 *   npx ts-node prisma/run-financial-migration.ts
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

    // Check if the tables already exist
    const check = await client.query(`
      SELECT tablename FROM pg_tables
      WHERE schemaname = 'public'
        AND tablename IN ('financial_records', 'financial_record_attachments')
      ORDER BY tablename;
    `);

    const existing = check.rows.map((r: any) => r.tablename);
    if (existing.includes('financial_records') && existing.includes('financial_record_attachments')) {
      console.log('✅  Tables already exist — nothing to do.');
      return;
    }

    // Read and execute the migration SQL
    const sqlPath = join(__dirname, 'migrations', 'add_financial_records.sql');
    const sql = readFileSync(sqlPath, 'utf-8');

    console.log('🚀  Running migration: add_financial_records.sql …');
    await client.query(sql);

    // Verify
    const verify = await client.query(`
      SELECT tablename FROM pg_tables
      WHERE schemaname = 'public'
        AND tablename IN ('financial_records', 'financial_record_attachments')
      ORDER BY tablename;
    `);
    const created = verify.rows.map((r: any) => r.tablename);
    console.log(`\n✅  Migration complete. Tables created:`);
    created.forEach((t: string) => console.log(`     • ${t}`));

    if (!created.includes('financial_records') || !created.includes('financial_record_attachments')) {
      console.error('\n⚠️  Warning: some tables may not have been created. Check the output above.');
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
