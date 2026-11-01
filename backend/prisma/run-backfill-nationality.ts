/**
 * Migration: Backfill nationality from citizenship for existing applicants.
 *
 * Fixes records created before the dual-write fix was deployed where
 * nationality was stored as NULL even though citizenship had a value.
 *
 * Run with:
 *   npx ts-node prisma/run-backfill-nationality.ts
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

    // Count affected rows before update
    const before = await client.query(`
      SELECT COUNT(*) AS count
      FROM   applicants
      WHERE  nationality IS NULL AND citizenship IS NOT NULL
    `);
    const affected = parseInt(before.rows[0].count, 10);
    console.log(`🔍  Found ${affected} applicant(s) with missing nationality.`);

    if (affected === 0) {
      console.log('✅  Nothing to do — all records already have nationality set.');
      return;
    }

    const sqlPath = join(__dirname, 'migrations', 'backfill-nationality.sql');
    const sql = readFileSync(sqlPath, 'utf-8');
    console.log('🚀  Running nationality backfill…');
    const result = await client.query(sql);
    console.log(`✅  Updated ${result.rowCount ?? affected} row(s).`);

    // Verify
    const after = await client.query(`
      SELECT COUNT(*) AS count
      FROM   applicants
      WHERE  nationality IS NULL AND citizenship IS NOT NULL
    `);
    const remaining = parseInt(after.rows[0].count, 10);
    if (remaining === 0) {
      console.log('✅  All applicants now have nationality populated.');
    } else {
      console.warn(`⚠️  ${remaining} applicant(s) still missing nationality — check for unexpected NULL citizenship values.`);
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
