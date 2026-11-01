import { Pool } from 'pg';
import * as dotenv from 'dotenv';
import * as fs from 'fs';
import * as path from 'path';
import { resolvePoolSsl } from './pg-ssl';

dotenv.config({ path: path.resolve(__dirname, '../.env') });

async function run() {
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: resolvePoolSsl(process.env.DATABASE_URL),
  });
  const sql = fs.readFileSync(path.resolve(__dirname, 'add-vehicle-soft-deletes.sql'), 'utf8');
  try {
    await pool.query(sql);
    console.log('✅  Vehicle soft-delete migration applied successfully');
  } catch (err) {
    console.error('❌  Migration failed:', err);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

run();
