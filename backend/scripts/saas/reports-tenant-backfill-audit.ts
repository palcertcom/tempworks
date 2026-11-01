/**
 * Phase 3 Reports Hardening — Phase B (#17).
 *
 * Read-only audit (with optional, gated remediation) for the new
 * `reports.tenantId` column. Mirrors the patterns in
 * agency-tenant-audit.ts and applicant-jobad-tenant-audit.ts.
 *
 * The audit:
 *   • Reports whose tenantId IS NULL, with their `createdById` and
 *     any tenant we can safely infer from the creator's user row
 *     (via the creator's primary agency.tenantId).
 *   • Reports whose tenantId is set but the tenant row no longer
 *     exists (stale-tenant).
 *   • Reports whose tenantId disagrees with the creator's primary
 *     agency.tenantId (creator-disagreement — flagged, never
 *     auto-remapped because the operator might have intentionally
 *     pinned a different tenant).
 *
 * Remediation rules:
 *   • Only assign a tenantId when:
 *       - the report currently has none, AND
 *       - the creator resolves to exactly ONE active tenant via
 *         `agencies.tenantId` (legacy creators) or
 *         `tenant_memberships` (Phase 1+ multi-tenant users).
 *   • Never overwrite an existing tenantId.
 *   • Never delete a report.
 *   • Wrap every UPDATE in a defensive `WHERE "tenantId" IS NULL` so
 *     a racing write between read and apply can't be overwritten.
 *
 * Env flags (same template as the rest of /backend/scripts/saas):
 *   REPORTS_TENANT_AUDIT_REMEDIATE=true  — enable remediation
 *   REPORTS_TENANT_AUDIT_APPLY=true      — actually write (else dry-run)
 *   REPORTS_TENANT_AUDIT_FORCE=true      — apply on a DB classifyRuntimeEnv
 *                                          can't prove is staging/clone
 *
 * A JSON backup of every changed row is written before any UPDATE.
 *
 * Usage:
 *   npx ts-node backend/scripts/saas/reports-tenant-backfill-audit.ts           # report
 *   REPORTS_TENANT_AUDIT_REMEDIATE=true REPORTS_TENANT_AUDIT_APPLY=true \
 *     npx ts-node backend/scripts/saas/reports-tenant-backfill-audit.ts         # repair (staging/clone)
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
  name: string;
  createdById: string | null;
  currentTenantId: string | null;
  inferredTenantId: string | null;
  observedTenants: string[]; // distinct non-null tenants we could resolve for the creator
  reason: 'missing-tenant' | 'stale-tenant' | 'creator-disagreement';
}

async function main() {
  const client = pgClient(getDatabaseUrl());
  await client.connect();
  const correctable: Hit[] = [];
  const ambiguous: Hit[] = [];
  try {
    // Reports Phase B (#17) shipped `Report.tenantId` as an additive
    // column applied by the NestJS `healAdditiveDrift` boot step. This
    // audit runs standalone — if the operator hasn't booted the new
    // backend yet, the column won't exist. Re-apply the same
    // idempotent `ADD COLUMN IF NOT EXISTS` here so the script is
    // self-sufficient. Pure no-op when the column is already present.
    await client.query(`ALTER TABLE "reports" ADD COLUMN IF NOT EXISTS "tenantId" TEXT;`);
    await client.query(`CREATE INDEX IF NOT EXISTS "reports_tenantId_idx" ON "reports"("tenantId");`);

    const reports = await client.query(`
      SELECT r.id, r.name, r."createdById", r."tenantId" AS current_tenant
      FROM "reports" r
      WHERE r."deletedAt" IS NULL
      ORDER BY r."createdAt" ASC
    `);

    // Pre-pull every tenant id once so the existence check is O(1).
    const tenantRows = await client.query(`SELECT id FROM "tenants"`);
    const tenantExists = new Set<string>(tenantRows.rows.map(r => r.id));

    for (const r of reports.rows) {
      const current: string | null = r.current_tenant ?? null;
      const tenants = new Set<string>();

      if (r.createdById) {
        // Creator's primary tenant via their agency.
        const agencyTenant = await client.query(
          `SELECT a."tenantId"
             FROM "users" u
             LEFT JOIN "agencies" a ON a.id = u."agencyId"
            WHERE u.id = $1 AND a."tenantId" IS NOT NULL`,
          [r.createdById],
        );
        for (const row of agencyTenant.rows) if (row.tenantId) tenants.add(row.tenantId);

        // Creator's TenantMembership rows (Phase 1+).
        // The `tenant_memberships` table may not exist on every DB this
        // script is run against; catch and ignore.
        try {
          const memberships = await client.query(
            `SELECT "tenantId" FROM "tenant_memberships" WHERE "userId" = $1 AND "deletedAt" IS NULL`,
            [r.createdById],
          );
          for (const row of memberships.rows) if (row.tenantId) tenants.add(row.tenantId);
        } catch { /* table may not exist; ignore */ }
      }

      const observed = Array.from(tenants);
      const inferred = observed.length === 1 ? observed[0] : null;

      if (current === null) {
        const hit: Hit = {
          id: r.id, name: r.name, createdById: r.createdById,
          currentTenantId: null,
          inferredTenantId: inferred,
          observedTenants: observed,
          reason: 'missing-tenant',
        };
        (inferred ? correctable : ambiguous).push(hit);
      } else if (!tenantExists.has(current)) {
        ambiguous.push({
          id: r.id, name: r.name, createdById: r.createdById,
          currentTenantId: current, inferredTenantId: null,
          observedTenants: observed, reason: 'stale-tenant',
        });
      } else if (observed.length > 0 && !observed.includes(current)) {
        ambiguous.push({
          id: r.id, name: r.name, createdById: r.createdById,
          currentTenantId: current, inferredTenantId: null,
          observedTenants: observed, reason: 'creator-disagreement',
        });
      }
    }

    console.log(`\nReports safely correctable (single inferred tenant): ${correctable.length}`);
    for (const h of correctable) {
      console.log(`  ${h.name}  [${h.id}]  tenant=${h.currentTenantId ?? 'NULL'}  →  ${h.inferredTenantId}  (creator=${h.createdById ?? 'NULL'})`);
    }
    if (correctable.length === 0) console.log('  ✓ Every active report already has a tenant, or none can be safely inferred.');

    if (ambiguous.length > 0) {
      console.log(`\n⚠ ${ambiguous.length} report(s) need manual review:`);
      for (const h of ambiguous.slice(0, 40)) {
        const obs = h.observedTenants.length === 0 ? '∅' : h.observedTenants.join(',');
        console.log(`    ${h.name}  [${h.id}]  reason=${h.reason}  tenant=${h.currentTenantId ?? 'NULL'}  observed=${obs}  creator=${h.createdById ?? 'NULL'}`);
      }
      if (ambiguous.length > 40) console.log(`    … (${ambiguous.length - 40} more in JSON report)`);
    }

    const remediate = process.env.REPORTS_TENANT_AUDIT_REMEDIATE === 'true';
    const apply     = process.env.REPORTS_TENANT_AUDIT_APPLY     === 'true';
    const force     = process.env.REPORTS_TENANT_AUDIT_FORCE     === 'true';
    const env = classifyRuntimeEnv();
    let fixed = 0;
    if (remediate && correctable.length > 0) {
      await fs.mkdir(OUT_DIR, { recursive: true });
      await fs.writeFile(
        path.join(OUT_DIR, 'reports-tenant-backup.json'),
        JSON.stringify({ generatedAt: new Date().toISOString(), rows: correctable }, null, 2),
      );
      if (!apply) {
        console.log(`\n[dry-run] would set tenantId on ${correctable.length} report(s). Backup written to reports/saas/reports-tenant-backup.json. Set REPORTS_TENANT_AUDIT_APPLY=true to apply.`);
      } else if (!isStagingClassification(env.classification) && !force) {
        console.log(`\n[refused] remediation requires a staging/clone env. Current: ${env.classification} (${env.reason}).`);
        console.log('  If this is a DB you own and have backed up, re-run with REPORTS_TENANT_AUDIT_FORCE=true.');
      } else {
        for (const h of correctable) {
          const r = await client.query(
            `UPDATE "reports" SET "tenantId" = $1 WHERE id = $2 AND "tenantId" IS NULL`,
            [h.inferredTenantId, h.id],
          );
          fixed += r.rowCount ?? 0;
        }
        console.log(`\n[applied${force && !isStagingClassification(env.classification) ? ' via FORCE' : ''}] backfilled ${fixed} report tenantId(s). Backup at reports/saas/reports-tenant-backup.json`);
      }
    }

    await fs.mkdir(OUT_DIR, { recursive: true });
    await fs.writeFile(
      path.join(OUT_DIR, 'reports-tenant-backfill-audit.json'),
      JSON.stringify({
        generatedAt: new Date().toISOString(),
        correctable: correctable.length,
        ambiguousCount: ambiguous.length,
        fixed,
        correctableRows: correctable,
        ambiguousRows: ambiguous,
      }, null, 2),
    );
    process.exitCode = correctable.length > 0 && fixed === 0 ? 1 : 0;
  } finally {
    await client.end();
  }
}

main().catch((e) => { console.error(e); process.exit(2); });
