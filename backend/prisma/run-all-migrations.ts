/**
 * Run ALL SQL migrations in /prisma/migrations against the database.
 *
 * Safe to run multiple times — every migration in this codebase is written
 * to be idempotent (IF NOT EXISTS / DO blocks with column checks).
 *
 * Use this on first deployment or whenever you suspect the database is
 * behind the schema. For a single targeted change, prefer the dedicated
 * npm run db:migrate:* scripts.
 *
 * Run with:
 *   npm run db:migrate:all
 */
import { Pool } from 'pg';
import { readFileSync, readdirSync } from 'fs';
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

    const migrationsDir = join(__dirname, 'migrations');
    const files = readdirSync(migrationsDir)
      .filter((f) => f.endsWith('.sql'))
      .sort(); // alphabetical, which lines up with chronological prefixes

    console.log(`📁  Found ${files.length} migration file(s):\n`);
    files.forEach((f) => console.log(`     · ${f}`));
    console.log('');

    const results: { file: string; ok: boolean; error?: string }[] = [];

    for (const file of files) {
      const sqlPath = join(migrationsDir, file);
      const sql = readFileSync(sqlPath, 'utf-8');
      process.stdout.write(`🚀  Running ${file} … `);
      try {
        await client.query(sql);
        console.log('✅');
        results.push({ file, ok: true });
      } catch (err: any) {
        console.log('❌');
        console.error(`     ${err.message ?? err}`);
        results.push({ file, ok: false, error: err.message ?? String(err) });
      }
    }

    console.log('\n────────────────────────────────────────');
    const ok = results.filter((r) => r.ok).length;
    const failed = results.filter((r) => !r.ok);
    console.log(`✅  Succeeded: ${ok}/${files.length}`);
    if (failed.length) {
      console.log(`❌  Failed: ${failed.length}`);
      failed.forEach((f) => console.log(`     · ${f.file}: ${f.error}`));
      process.exit(1);
    } else {
      console.log('🎉  All migrations applied successfully.');
    }
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch(err => {
  console.error('❌  Migration runner failed:', err.message ?? err);
  process.exit(1);
});
