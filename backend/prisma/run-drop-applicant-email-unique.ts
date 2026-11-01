/**
 * Migration: Drop unique constraint on applicants.email
 *
 * Allows multiple applications to be submitted with the same email address.
 *
 * Run with:
 *   npx ts-node prisma/run-drop-applicant-email-unique.ts
 *
 * Or:
 *   npm run db:migrate:drop-applicant-email-unique
 *
 * Idempotent — safe to run multiple times.
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
  const pool = new Pool({ connectionString: DATABASE_URL, ssl: resolvePoolSsl(DATABASE_URL) });
  const client = await pool.connect();

  try {
    console.log('🔌  Connected to database.');
    const sqlPath = join(__dirname, 'migrations', 'drop-applicant-email-unique.sql');
    const sql = readFileSync(sqlPath, 'utf-8');
    console.log('🚀  Dropping unique constraint on applicants.email…');
    await client.query(sql);
    console.log('✅  Done. Multiple applications per email are now allowed.');
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch(err => {
  console.error('❌  Migration failed:', err.message ?? err);
  process.exit(1);
});
