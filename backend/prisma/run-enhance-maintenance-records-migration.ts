/**
 * Migration: enhance maintenance records with driver tracking, drop-off/pick-up, and approval fields
 *
 * Adds fields for service driver, drop-off/pick-up driver tracking with timestamps,
 * approval user tracking, and work description for comprehensive maintenance logging
 *
 * Run with:
 *   npm run db:migrate:enhance-maintenance-records
 *
 * Safe to run multiple times — all ALTER TABLE statements use IF NOT EXISTS
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

    // Read and execute the migration SQL
    const sqlPath = join(__dirname, 'migrations', 'enhance_maintenance_records.sql');
    const sql = readFileSync(sqlPath, 'utf-8');

    console.log('🚀  Running migration: enhance_maintenance_records.sql …');
    await client.query(sql);

    console.log('\n✅  Migration complete. MaintenanceRecord table enhanced with:');
    console.log('     • Service driver tracking (internal driver ID or external driver name)');
    console.log('     • Drop-off driver tracking with timestamp');
    console.log('     • Pick-up driver tracking with timestamp');
    console.log('     • Approval user tracking with approval timestamp');
    console.log('     • Detailed work description field');
    console.log('     • MaintenanceRecordAttachment table for invoices and documents');
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch(err => {
  console.error('❌  Migration failed:', err.message ?? err);
  process.exit(1);
});
