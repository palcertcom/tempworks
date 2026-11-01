/**
 * Migration: create job_ads table and add job_ad_id FK to applicants.
 *
 * Run with:
 *   npx ts-node prisma/run-job-ads-migration.ts
 *
 * Or from the backend directory:
 *   npm run db:migrate:job-ads
 *
 * Safe to run multiple times — all statements use IF NOT EXISTS / DO $$ blocks
 * so re-running is idempotent.
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

    // Check if job_ads table already exists
    const check = await client.query(`
      SELECT tablename FROM pg_tables
      WHERE schemaname = 'public'
        AND tablename = 'job_ads';
    `);

    // Check if applicants.jobAdId column already exists
    const colCheck = await client.query(`
      SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name   = 'applicants'
        AND column_name  = 'jobAdId';
    `);

    const tableExists  = check.rows.length > 0;
    const columnExists = colCheck.rows.length > 0;

    if (tableExists && columnExists) {
      console.log('✅  job_ads table and applicants.jobAdId column already exist — nothing to do.');
      return;
    }

    // Read and execute the migration SQL
    const sqlPath = join(__dirname, 'migrations', 'add_job_ads.sql');
    const sql = readFileSync(sqlPath, 'utf-8');

    console.log('🚀  Running migration: add_job_ads.sql …');
    await client.query(sql);

    // Verify
    const verify = await client.query(`
      SELECT tablename FROM pg_tables
      WHERE schemaname = 'public'
        AND tablename = 'job_ads';
    `);
    const colVerify = await client.query(`
      SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name   = 'applicants'
        AND column_name  = 'jobAdId';
    `);

    console.log('\n✅  Migration complete:');
    if (verify.rows.length > 0) console.log('     • job_ads table created');
    if (colVerify.rows.length > 0) console.log('     • applicants.jobAdId column added');

    if (verify.rows.length === 0 || colVerify.rows.length === 0) {
      console.error('\n⚠️  Warning: some objects may not have been created. Check output above.');
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
