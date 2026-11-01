/**
 * Migration: add requiredDocuments column to job_ads table.
 *
 * Run with:
 *   npx ts-node prisma/run-job-ads-required-documents-migration.ts
 *
 * Or from the backend directory:
 *   npm run db:migrate:job-ads-required-docs
 *
 * Safe to run multiple times — uses IF NOT EXISTS guard.
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

    const colCheck = await client.query(`
      SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name   = 'job_ads'
        AND column_name  = 'requiredDocuments';
    `);

    if (colCheck.rows.length > 0) {
      console.log('✅  job_ads.requiredDocuments column already exists — nothing to do.');
      return;
    }

    const sqlPath = join(__dirname, 'migrations', 'add_job_ads_required_documents.sql');
    const sql = readFileSync(sqlPath, 'utf-8');

    console.log('🚀  Running migration: add_job_ads_required_documents.sql …');
    await client.query(sql);

    const verify = await client.query(`
      SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name   = 'job_ads'
        AND column_name  = 'requiredDocuments';
    `);

    if (verify.rows.length > 0) {
      console.log('✅  Migration complete: job_ads.requiredDocuments column added.');
    } else {
      console.error('⚠️  Warning: column may not have been created. Check output above.');
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
