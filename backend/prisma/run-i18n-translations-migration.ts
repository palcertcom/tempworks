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
  const sql = readFileSync(join(__dirname, 'add-i18n-translations.sql'), 'utf8');
  try {
    await pool.query(sql);
    console.log('i18n translations columns added: document_types, job_types, workflow_stages.');
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
