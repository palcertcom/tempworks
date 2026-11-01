/**
 * Migration: document management enhancements.
 *
 * Adds: docId (business ID), rejectionReason, issueCountry, renewedFromId
 *       to documents; code to document_types;
 *       document_type_permissions table; performance indexes.
 *
 * Run with:
 *   npx ts-node prisma/run-document-enhancements.ts
 *
 * Or from the backend directory:
 *   npm run db:migrate:doc-enhancements
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
    const sqlPath = join(__dirname, 'migrations', 'add-document-enhancements.sql');
    const sql = readFileSync(sqlPath, 'utf-8');
    console.log('🚀  Running document enhancement migration…');
    await client.query(sql);

    // Verify key columns
    const cols = await client.query(`
      SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'documents'
        AND column_name IN ('docId', 'rejectionReason', 'issueCountry', 'renewedFromId')
    `);
    const tableExists = await client.query(`
      SELECT tablename FROM pg_tables
      WHERE schemaname = 'public' AND tablename = 'document_type_permissions'
    `);

    console.log('\n✅  Migration complete:');
    console.log(`     • documents columns added: ${cols.rows.map((r: any) => r.column_name).join(', ')}`);
    console.log(`     • document_type_permissions table: ${tableExists.rows.length > 0 ? 'exists' : 'NOT FOUND'}`);
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch(err => {
  console.error('❌  Migration failed:', err.message ?? err);
  process.exit(1);
});
