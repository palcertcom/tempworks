/**
 * Migration: ensure all applicant columns from the Prisma schema exist in the database.
 *
 * Useful when several historical migrations were skipped — this is idempotent
 * and only adds columns that don't already exist.
 *
 * Run with:
 *   npm run db:migrate:ensure-applicant-columns
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
    const sqlPath = join(__dirname, 'migrations', 'ensure_applicant_columns.sql');
    const sql = readFileSync(sqlPath, 'utf-8');

    console.log('🚀  Running migration: ensure_applicant_columns.sql …');
    await client.query(sql);
    console.log('✅  Applicant table is up to date with the current schema.');
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch(err => {
  console.error('❌  Migration failed:', err.message ?? err);
  process.exit(1);
});
