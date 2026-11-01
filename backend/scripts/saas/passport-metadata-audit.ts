/**
 * Passport metadata audit — find Passport documents missing the now-required
 * Issue Date and/or Expiry Date.
 *
 * READ-ONLY by default. Scans `documents` joined to `document_types` for rows
 * whose type is a Passport (name ILIKE '%passport%' or code = 'PASS') that are
 * missing "issueDate" and/or "expiryDate", and reports them. New uploads are
 * already blocked by assertDocumentMetadata; this surfaces pre-existing rows.
 *
 * Remediation is opt-in + gated, mirroring phone-audit.ts:
 *   PASSPORT_AUDIT_REMEDIATE=true  — enable
 *   PASSPORT_AUDIT_APPLY=true      — actually write (else dry-run)
 *   classifyRuntimeEnv() ∈ { SAFE_CLONE, SAFE_STAGING }
 * When all three hold, each incomplete VERIFIED/EXPIRING_SOON passport is set
 * back to PENDING (it can't be "valid" without the required dates) so staff
 * re-collect the metadata. Data is NEVER deleted or invented; a JSON backup
 * of every changed row is written to reports/saas/passport-audit-backup.json
 * first. Documents already PENDING/REJECTED are left untouched.
 *
 * Usage:
 *   npx ts-node backend/scripts/saas/passport-metadata-audit.ts          # report
 *   PASSPORT_AUDIT_REMEDIATE=true PASSPORT_AUDIT_APPLY=true \
 *     npx ts-node backend/scripts/saas/passport-metadata-audit.ts        # mark incomplete (staging/clone)
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

interface Hit {
  id: string;
  docId: string | null;
  name: string;
  status: string;
  entityType: string;
  entityId: string;
  missingIssueDate: boolean;
  missingExpiryDate: boolean;
}

async function main() {
  const client = pgClient(getDatabaseUrl());
  await client.connect();
  const hits: Hit[] = [];
  try {
    const res = await client.query(`
      SELECT d.id, d."docId", d.name, d.status::text AS status,
             d."entityType"::text AS "entityType", d."entityId",
             (d."issueDate"  IS NULL) AS missing_issue,
             (d."expiryDate" IS NULL) AS missing_expiry
      FROM "documents" d
      JOIN "document_types" t ON t.id = d."documentTypeId"
      WHERE d."deletedAt" IS NULL
        AND (t.name ILIKE '%passport%' OR UPPER(COALESCE(t.code, '')) = 'PASS')
        AND (d."issueDate" IS NULL OR d."expiryDate" IS NULL)
      ORDER BY d."createdAt" DESC
    `);
    for (const r of res.rows) {
      hits.push({
        id: r.id, docId: r.docId, name: r.name, status: r.status,
        entityType: r.entityType, entityId: r.entityId,
        missingIssueDate: r.missing_issue, missingExpiryDate: r.missing_expiry,
      });
    }

    console.log(`\nPassport documents missing required dates: ${hits.length}\n`);
    for (const h of hits) {
      const miss = [h.missingIssueDate ? 'issueDate' : null, h.missingExpiryDate ? 'expiryDate' : null].filter(Boolean).join(' + ');
      console.log(`  [${h.status}] ${h.docId ?? h.id}  "${h.name}"  (${h.entityType} ${h.entityId})  missing: ${miss}`);
    }
    if (hits.length === 0) console.log('  ✓ All Passport documents have issue + expiry dates.');

    const remediate = process.env.PASSPORT_AUDIT_REMEDIATE === 'true';
    const apply = process.env.PASSPORT_AUDIT_APPLY === 'true';
    const env = classifyRuntimeEnv();
    // Only re-open docs that currently present as "valid"; leave PENDING/REJECTED as-is.
    const toReopen = hits.filter((h) => h.status === 'VERIFIED' || h.status === 'EXPIRING_SOON' || h.status === 'EXPIRED');
    let fixed = 0;
    if (remediate && toReopen.length > 0) {
      await fs.mkdir(OUT_DIR, { recursive: true });
      await fs.writeFile(path.join(OUT_DIR, 'passport-audit-backup.json'),
        JSON.stringify({ generatedAt: new Date().toISOString(), rows: toReopen }, null, 2));
      if (!apply) {
        console.log(`\n[dry-run] would set ${toReopen.length} incomplete passport(s) to PENDING. Backup written. Set PASSPORT_AUDIT_APPLY=true to apply.`);
      } else if (!isStagingClassification(env.classification)) {
        console.log(`\n[refused] remediation requires a staging/clone env. Current: ${env.classification} (${env.reason}).`);
      } else {
        for (const h of toReopen) {
          await client.query(`UPDATE "documents" SET "status" = 'PENDING' WHERE id = $1`, [h.id]);
          fixed++;
        }
        console.log(`\n[applied] marked ${fixed} incomplete passport(s) PENDING. Backup at reports/saas/passport-audit-backup.json`);
      }
    }

    await fs.mkdir(OUT_DIR, { recursive: true });
    await fs.writeFile(path.join(OUT_DIR, 'passport-audit.json'),
      JSON.stringify({ generatedAt: new Date().toISOString(), found: hits.length, fixed, hits }, null, 2));
    process.exitCode = hits.length > 0 && fixed === 0 ? 1 : 0;
  } finally {
    await client.end();
  }
}

main().catch((e) => { console.error(e); process.exit(2); });
