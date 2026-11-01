/**
 * Migration: Add user profile fields, auth security, preferences,
 *            activation/reset token tables, candidate delete requests,
 *            agency manager field, and user number sequence.
 *
 * Run with:
 *   npx ts-node prisma/run-user-profile-migration.ts
 *
 * Or from the backend directory:
 *   npm run db:migrate:user-profile
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
    const sqlPath = join(__dirname, 'migrations', 'add-user-profile-auth-fields.sql');
    const sql = readFileSync(sqlPath, 'utf-8');
    console.log('🚀  Running user profile + auth migration…');
    await client.query(sql);

    // Verify key new columns
    const cols = await client.query(`
      SELECT table_name, column_name
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND (
          (table_name = 'users' AND column_name IN (
            'userNumber','failedLoginAttempts','lockedAt','passwordChangedAt',
            'passwordExpiresAt','preferredLanguage','timeZone','notificationPrefs',
            'middleName','jobTitle','department','startDate','photoUrl','createdById'
          ))
          OR (table_name = 'agencies' AND column_name = 'managerId')
        )
      ORDER BY table_name, column_name
    `);

    const tables = await client.query(`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_name IN (
          'activation_tokens',
          'password_reset_tokens',
          'candidate_delete_requests',
          'agency_user_permissions',
          'user_number_sequences'
        )
    `);

    console.log('\n✅  Migration complete.');
    console.log('\n   New columns:');
    const grouped: Record<string, string[]> = {};
    for (const row of cols.rows) {
      if (!grouped[row.table_name]) grouped[row.table_name] = [];
      grouped[row.table_name].push(row.column_name);
    }
    for (const [table, columns] of Object.entries(grouped)) {
      console.log(`     • ${table}: ${columns.join(', ')}`);
    }

    console.log('\n   New tables:');
    for (const row of tables.rows) {
      console.log(`     • ${row.table_name}`);
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
