import { Pool } from 'pg';
import { readFileSync } from 'fs';
import { join } from 'path';
import * as dotenv from 'dotenv';
import { resolvePoolSsl } from './pg-ssl';

dotenv.config({ path: join(__dirname, '../.env') });

async function main() {
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: resolvePoolSsl(process.env.DATABASE_URL),
  });
  const sql = readFileSync(join(__dirname, 'migrations', 'add_agency_tenancy_workflow.sql'), 'utf8');
  try {
    await pool.query(sql);
    console.log('Agency tenancy workflow migration applied successfully.');
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
