/**
 * Migration: add recycle-bin metadata fields.
 *
 * Adds deletedBy + deletionReason to all soft-deletable entities.
 * Adds deletedAt / deletedBy / deletionReason to document_types.
 *
 * Run with:
 *   npx ts-node prisma/run-recycle-bin-migration.ts
 *
 * Or from the backend directory:
 *   npm run db:migrate:recycle-bin
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
    const sqlPath = join(__dirname, 'migrations', 'add-recycle-bin-fields.sql');
    const sql = readFileSync(sqlPath, 'utf-8');
    console.log('🚀  Running recycle-bin fields migration…');
    await client.query(sql);

    // Verify key columns
    const cols = await client.query(`
      SELECT table_name, column_name
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND column_name IN ('deletedBy', 'deletionReason')
        AND table_name IN (
          'users','agencies','employees','applicants','documents',
          'roles','job_ads','financial_records','document_types'
        )
      ORDER BY table_name, column_name
    `);

    console.log('\n✅  Migration complete. New columns:');
    const grouped: Record<string, string[]> = {};
    for (const row of cols.rows) {
      if (!grouped[row.table_name]) grouped[row.table_name] = [];
      grouped[row.table_name].push(row.column_name);
    }
    for (const [table, columns] of Object.entries(grouped)) {
      console.log(`     • ${table}: ${columns.join(', ')}`);
    }

    const dtCheck = await client.query(`
      SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'document_types'
        AND column_name = 'deletedAt'
    `);
    console.log(`     • document_types.deletedAt: ${dtCheck.rows.length > 0 ? 'exists' : 'NOT FOUND'}`);
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch(err => {
  console.error('❌  Migration failed:', err.message ?? err);
  process.exit(1);
});
