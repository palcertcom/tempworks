/**
 * Migration: enhance workshop table with comprehensive fields
 *
 * Adds fields for company info, contact details, banking, tax ID, specializations
 *
 * Run with:
 *   npm run db:migrate:enhance-workshop
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
    const sqlPath = join(__dirname, 'migrations', 'enhance_workshop_fields.sql');
    const sql = readFileSync(sqlPath, 'utf-8');

    console.log('🚀  Running migration: enhance_workshop_fields.sql …');
    await client.query(sql);

    console.log('\n✅  Migration complete. Workshop table enhanced with:');
    console.log('     • Company information (companyName, logo)');
    console.log('     • Extended contact details (telephone, mobile, telefax)');
    console.log('     • Tax identifiers (VAT number, business registration number)');
    console.log('     • Contact person details (email, phone, mobile, address)');
    console.log('     • Banking information (bank name, IBAN, SWIFT/BIC)');
    console.log('     • Business details (establishment year, specializations, status)');
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch(err => {
  console.error('❌  Migration failed:', err.message ?? err);
  process.exit(1);
});
