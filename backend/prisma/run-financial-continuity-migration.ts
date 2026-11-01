/**
 * Migration: Financial Continuity — stable person identity across lifecycle stages.
 *
 * Adds:
 *   - financial_records.applicantId     (stable person reference)
 *   - financial_records.stageAtCreation (LEAD | CANDIDATE | EMPLOYEE)
 *   - applicant_financial_profiles.employeeId (links profile to converted employee)
 *
 * Backfills existing data so no records are orphaned.
 *
 * Run with:
 *   npx ts-node prisma/run-financial-continuity-migration.ts
 *
 * Or from the backend directory:
 *   npm run db:migrate:financial-continuity
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
    const sqlPath = join(__dirname, 'add-financial-continuity.sql');
    const sql = readFileSync(sqlPath, 'utf-8');
    console.log('🚀  Running financial continuity migration…');
    await client.query(sql);

    // Verify new columns
    const frCols = await client.query(`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'financial_records'
        AND column_name IN ('applicantId', 'stageAtCreation')
      ORDER BY column_name
    `);
    console.log('\n✅  financial_records columns:');
    for (const row of frCols.rows) {
      console.log(`     • ${row.column_name}: exists`);
    }

    const afpCols = await client.query(`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'applicant_financial_profiles'
        AND column_name = 'employeeId'
    `);
    console.log(`     • applicant_financial_profiles.employeeId: ${afpCols.rows.length > 0 ? 'exists' : 'NOT FOUND'}`);

    // Report backfill counts
    const backfillCounts = await client.query(`
      SELECT
        COUNT(*) FILTER (WHERE "applicantId" IS NOT NULL) AS with_applicant_id,
        COUNT(*) FILTER (WHERE "stageAtCreation" IS NOT NULL) AS with_stage,
        COUNT(*) AS total
      FROM financial_records
      WHERE "deletedAt" IS NULL
    `);
    const r = backfillCounts.rows[0];
    console.log(`\n📊  Financial records backfill:`);
    console.log(`     • Total active records: ${r.total}`);
    console.log(`     • With applicantId:     ${r.with_applicant_id}`);
    console.log(`     • With stageAtCreation: ${r.with_stage}`);

    const afpBackfill = await client.query(`
      SELECT COUNT(*) FILTER (WHERE "employeeId" IS NOT NULL) AS with_employee_id, COUNT(*) AS total
      FROM applicant_financial_profiles
    `);
    const ar = afpBackfill.rows[0];
    console.log(`\n📊  Financial profiles backfill:`);
    console.log(`     • Total profiles:       ${ar.total}`);
    console.log(`     • Linked to employee:   ${ar.with_employee_id}`);

  } finally {
    client.release();
    await pool.end();
  }
}

main().catch(err => {
  console.error('❌  Migration failed:', err.message ?? err);
  process.exit(1);
});
