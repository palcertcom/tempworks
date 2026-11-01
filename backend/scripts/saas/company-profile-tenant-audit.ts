/**
 * Company Export Profile tenant audit.
 *
 * Finds Company Export Profiles with no tenantId — the rows that show up
 * for the user who created them (when their session somehow inherits the
 * null tenant) but disappear for every tenant-scoped user. Reports them
 * for review; opt-in remediation sets tenantId to a value of your choice.
 *
 * READ-ONLY by default. Remediation is opt-in + gated, mirroring
 * phone-audit.ts and applicant-jobad-tenant-audit.ts:
 *   COMPANY_PROFILE_AUDIT_REMEDIATE=true          — enable
 *   COMPANY_PROFILE_AUDIT_APPLY=true              — actually write (else dry-run)
 *   COMPANY_PROFILE_AUDIT_TENANT_ID=<tenant uuid> — target tenant (required for apply)
 *   COMPANY_PROFILE_AUDIT_IDS=id1,id2,…           — optional: only these ids
 *   classifyRuntimeEnv() ∈ { SAFE_CLONE, SAFE_STAGING }
 *   COMPANY_PROFILE_AUDIT_FORCE=true              — apply on a DB you own that
 *     can't be auto-classified as staging (backup is still written first)
 * A JSON backup of every changed row is written before any update.
 *
 * Usage:
 *   npx ts-node backend/scripts/saas/company-profile-tenant-audit.ts                # report
 *   COMPANY_PROFILE_AUDIT_REMEDIATE=true \
 *   COMPANY_PROFILE_AUDIT_TENANT_ID=<uuid> \
 *     npx ts-node backend/scripts/saas/company-profile-tenant-audit.ts              # dry-run
 *   COMPANY_PROFILE_AUDIT_REMEDIATE=true COMPANY_PROFILE_AUDIT_APPLY=true \
 *   COMPANY_PROFILE_AUDIT_TENANT_ID=<uuid> COMPANY_PROFILE_AUDIT_FORCE=true \
 *     npx ts-node backend/scripts/saas/company-profile-tenant-audit.ts              # apply
 */
/* eslint-disable no-console */
import { promises as fs } from 'fs';
import path from 'path';
import { Client } from 'pg';
import { autoLoadEnv, formatDatabaseUrlMissingMessage } from './phase1/reconciliation/lib/env';
import { classifyRuntimeEnv, isStagingClassification } from '../../src/saas/tenancy/env-safety';

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

async function main() {
  const client = pgClient(getDatabaseUrl());
  await client.connect();
  try {
    const idFilter = (process.env.COMPANY_PROFILE_AUDIT_IDS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    const params: any[] = [];
    let sql = `
      SELECT id, name, "legalName", "isDefault", "createdAt"
      FROM "company_export_profiles"
      WHERE "deletedAt" IS NULL AND "tenantId" IS NULL
    `;
    if (idFilter.length) {
      sql += ` AND id = ANY($1::text[])`;
      params.push(idFilter);
    }
    sql += ` ORDER BY "isDefault" DESC, "createdAt" DESC`;
    const res = await client.query(sql, params);
    const hits = res.rows;

    console.log(`\nCompany Export Profiles with NULL tenantId: ${hits.length}\n`);
    for (const h of hits) {
      const def = h.isDefault ? '★ ' : '  ';
      console.log(`  ${def}${h.id}  "${h.name}"${h.legalName ? ` (${h.legalName})` : ''}  created ${h.createdAt?.toISOString?.() ?? h.createdAt}`);
    }
    if (hits.length === 0) console.log('  ✓ Every profile carries a tenantId.');

    const remediate = process.env.COMPANY_PROFILE_AUDIT_REMEDIATE === 'true';
    const apply = process.env.COMPANY_PROFILE_AUDIT_APPLY === 'true';
    const force = process.env.COMPANY_PROFILE_AUDIT_FORCE === 'true';
    const target = (process.env.COMPANY_PROFILE_AUDIT_TENANT_ID ?? '').trim();
    const env = classifyRuntimeEnv();
    let fixed = 0;
    if (remediate && hits.length > 0) {
      if (!target) {
        console.log('\n[refused] remediation requires COMPANY_PROFILE_AUDIT_TENANT_ID=<tenant uuid> so the script knows which tenant to attach.');
      } else {
        // Verify the tenant exists before writing — no inventing rows.
        const tres = await client.query(`SELECT id FROM tenants WHERE id = $1`, [target]);
        if (tres.rowCount === 0) {
          console.log(`\n[refused] tenant ${target} not found.`);
        } else {
          await fs.mkdir(OUT_DIR, { recursive: true });
          await fs.writeFile(path.join(OUT_DIR, 'company-profile-tenant-backup.json'),
            JSON.stringify({ generatedAt: new Date().toISOString(), targetTenantId: target, rows: hits }, null, 2));
          if (!apply) {
            console.log(`\n[dry-run] would attach ${hits.length} profile(s) to tenant ${target}. Backup written. Set COMPANY_PROFILE_AUDIT_APPLY=true to apply.`);
          } else if (!isStagingClassification(env.classification) && !force) {
            console.log(`\n[refused] remediation requires a staging/clone env. Current: ${env.classification} (${env.reason}).`);
            console.log('  If this is a DB you own and have backed up, re-run with COMPANY_PROFILE_AUDIT_FORCE=true.');
          } else {
            for (const h of hits) {
              await client.query(`UPDATE "company_export_profiles" SET "tenantId" = $1 WHERE id = $2`, [target, h.id]);
              fixed++;
            }
            console.log(`\n[applied${force && !isStagingClassification(env.classification) ? ' via FORCE' : ''}] attached ${fixed} profile(s) to tenant ${target}.`);
          }
        }
      }
    }

    await fs.mkdir(OUT_DIR, { recursive: true });
    await fs.writeFile(path.join(OUT_DIR, 'company-profile-tenant-audit.json'),
      JSON.stringify({ generatedAt: new Date().toISOString(), found: hits.length, fixed, hits }, null, 2));
    process.exitCode = hits.length > 0 && fixed === 0 ? 1 : 0;
  } finally {
    await client.end();
  }
}

main().catch((e) => { console.error(e); process.exit(2); });
