/**
 * Phone duplication audit — find + (optionally) repair phone values that
 * carry a duplicated country code, e.g. "+90 +905394308925".
 *
 * READ-ONLY by default. Scans applicants.phone, employees.phone,
 * employees."emergencyPhone", users.phone for values that contain two
 * '+' signs (the duplicated-code signature) and reports the canonical
 * E.164 each would normalize to.
 *
 * Remediation is opt-in + gated, mirroring super-user-audit.ts:
 *   PHONE_AUDIT_REMEDIATE=true  — enable
 *   PHONE_AUDIT_APPLY=true      — actually write (else dry-run)
 *   classifyRuntimeEnv() ∈ { SAFE_CLONE, SAFE_STAGING }
 * When all three hold, each affected row is updated to its normalized
 * value. A JSON backup of every changed row (id, column, before, after)
 * is written to backend/reports/saas/phone-audit-backup.json first.
 *
 * Usage:
 *   npx ts-node backend/scripts/saas/phone-audit.ts            # report
 *   PHONE_AUDIT_REMEDIATE=true PHONE_AUDIT_APPLY=true \
 *     npx ts-node backend/scripts/saas/phone-audit.ts          # repair (staging/clone)
 */
/* eslint-disable no-console */
import { promises as fs } from 'fs';
import path from 'path';
import { Client } from 'pg';
import { autoLoadEnv, formatDatabaseUrlMissingMessage } from './phase1/reconciliation/lib/env';
import { classifyRuntimeEnv, isStagingClassification } from '../../src/saas/tenancy/env-safety';
import { normalizePhoneE164 } from '../../src/common/phone/normalize-phone';

autoLoadEnv(__filename);

const OUT_DIR = path.resolve(__dirname, '..', '..', 'reports', 'saas');

function getDatabaseUrl(): string {
  const arg = process.argv.find((a) => a.startsWith('--db='))?.slice(5);
  return arg ?? process.env.DATABASE_URL ?? (() => { throw new Error(formatDatabaseUrlMissingMessage()); })();
}
function pgClient(url: string): Client {
  let host = ''; let clean = url;
  try { const u = new URL(url); host = u.hostname; u.searchParams.delete('sslmode'); clean = u.toString(); } catch { /* keep */ }
  const local = /^(127\.0\.0\.1|localhost|::1)$/.test(host) || /127\.0\.0\.1|localhost/.test(url);
  return new Client({ connectionString: clean, ssl: local ? false : { rejectUnauthorized: false } });
}

interface Target { table: string; column: string }
const TARGETS: Target[] = [
  { table: 'applicants', column: 'phone' },
  { table: 'employees',  column: 'phone' },
  { table: 'employees',  column: 'emergencyPhone' },
  { table: 'users',      column: 'phone' },
];

interface Hit { table: string; column: string; id: string; before: string; after: string }

async function main() {
  const client = pgClient(getDatabaseUrl());
  await client.connect();
  const hits: Hit[] = [];
  try {
    for (const t of TARGETS) {
      // Duplicated-code signature: a non-leading '+' anywhere in the value.
      let rows: any[] = [];
      try {
        const res = await client.query(
          `SELECT id, "${t.column}" AS val FROM "${t.table}"
           WHERE "${t.column}" IS NOT NULL
             AND "${t.column}" ~ '\\+.*\\+'`,
        );
        rows = res.rows;
      } catch (e: any) {
        console.log(`  (skip ${t.table}.${t.column}: ${e.message})`);
        continue;
      }
      for (const r of rows) {
        const after = normalizePhoneE164(r.val);
        if (after !== r.val) hits.push({ table: t.table, column: t.column, id: r.id, before: r.val, after });
      }
    }

    console.log(`\nDuplicated-code phone values found: ${hits.length}\n`);
    for (const h of hits) console.log(`  ${h.table}.${h.column} [${h.id}]  "${h.before}"  →  "${h.after}"`);
    if (hits.length === 0) console.log('  ✓ No duplicated phone codes in the database.');

    const remediate = process.env.PHONE_AUDIT_REMEDIATE === 'true';
    const apply = process.env.PHONE_AUDIT_APPLY === 'true';
    const env = classifyRuntimeEnv();
    let fixed = 0;
    if (remediate && hits.length > 0) {
      await fs.mkdir(OUT_DIR, { recursive: true });
      await fs.writeFile(path.join(OUT_DIR, 'phone-audit-backup.json'),
        JSON.stringify({ generatedAt: new Date().toISOString(), rows: hits }, null, 2));
      if (!apply) {
        console.log(`\n[dry-run] would update ${hits.length} row(s). Backup written. Set PHONE_AUDIT_APPLY=true to apply.`);
      } else if (!isStagingClassification(env.classification)) {
        console.log(`\n[refused] remediation requires a staging/clone env. Current: ${env.classification} (${env.reason}).`);
      } else {
        for (const h of hits) {
          await client.query(`UPDATE "${h.table}" SET "${h.column}" = $1 WHERE id = $2`, [h.after, h.id]);
          fixed++;
        }
        console.log(`\n[applied] normalized ${fixed} row(s). Backup at reports/saas/phone-audit-backup.json`);
      }
    }

    await fs.mkdir(OUT_DIR, { recursive: true });
    await fs.writeFile(path.join(OUT_DIR, 'phone-audit.json'),
      JSON.stringify({ generatedAt: new Date().toISOString(), found: hits.length, fixed, hits }, null, 2));
    process.exitCode = hits.length > 0 && fixed === 0 ? 1 : 0;
  } finally {
    await client.end();
  }
}

main().catch((e) => { console.error(e); process.exit(2); });
