/**
 * Phase 3 (#27) — Agency tenant audit.
 *
 * Finds agencies whose `tenantId` is NULL or points at a tenant that no
 * longer exists, and tries to infer the correct tenant from the records
 * linked to that agency (users, employees, applicants). The agency
 * dropdowns that drive Applicant/Candidate/Employee/User forms scope by
 * `agency.tenantId`, so tenant-less agencies effectively disappear from
 * the UI once SUPER selects any tenant — this report makes the gap
 * visible and offers a safe, opt-in fix.
 *
 * READ-ONLY by default. For each hit it reports:
 *   agency id, name, currentTenantId, tenantExists, linkedUsers,
 *   linkedEmployees, linkedApplicants, distinct tenants observed on
 *   children, inferredTenantId (when unambiguous).
 *
 * Remediation rules (opt-in + gated, mirrors applicant-jobad-tenant-audit):
 *   • Only assign a tenant when there is exactly ONE non-null tenant
 *     observed across linked users + employees + applicants — ambiguous
 *     agencies are left alone and reported.
 *   • Never null out an existing tenantId. If `tenantExists === false`,
 *     the row is still reported but we don't auto-remap it; the operator
 *     decides because it might be a renamed/merged tenant.
 *   • Agencies are NEVER deleted by this script.
 *
 * Env flags:
 *   AGENCY_TENANT_AUDIT_REMEDIATE=true  — enable
 *   AGENCY_TENANT_AUDIT_APPLY=true      — actually write (else dry-run)
 *   AGENCY_TENANT_AUDIT_FORCE=true      — apply on a DB classifyRuntimeEnv
 *                                          can't prove is staging/clone
 *   classifyRuntimeEnv() ∈ { SAFE_CLONE, SAFE_STAGING } unless FORCE
 *
 * A JSON backup of every changed row is written before any UPDATE.
 *
 * Usage:
 *   npx ts-node backend/scripts/saas/agency-tenant-audit.ts                 # report
 *   AGENCY_TENANT_AUDIT_REMEDIATE=true AGENCY_TENANT_AUDIT_APPLY=true \
 *     npx ts-node backend/scripts/saas/agency-tenant-audit.ts               # repair (staging/clone)
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
  currentTenantId: string | null;
  tenantExists: boolean;
  linkedUsers: number;
  linkedEmployees: number;
  linkedApplicants: number;
  observedTenants: string[];   // distinct non-null tenants across children
  inferredTenantId: string | null; // unambiguous inferred tenant, when safe
  reason: 'missing-tenant' | 'stale-tenant' | 'mismatched-children';
}

async function main() {
  const client = pgClient(getDatabaseUrl());
  await client.connect();
  const hits: Hit[] = [];
  const ambiguous: Hit[] = [];
  try {
    // Pull every non-deleted agency with counts and the set of distinct
    // tenant ids on its linked users / employees / applicants. We do the
    // work in a single round-trip per agency so the script stays fast
    // even on large tables.
    const agencies = await client.query(`
      SELECT a.id, a.name, a."tenantId" AS current_tenant
      FROM "agencies" a
      WHERE a."deletedAt" IS NULL
      ORDER BY a.name
    `);

    const tenantIds = new Set<string>();
    for (const a of agencies.rows) if (a.current_tenant) tenantIds.add(a.current_tenant);
    const tenantExistsMap = new Map<string, boolean>();
    if (tenantIds.size > 0) {
      const list = Array.from(tenantIds);
      const params = list.map((_, i) => `$${i + 1}`).join(',');
      const t = await client.query(`SELECT id FROM "tenants" WHERE id IN (${params})`, list);
      for (const row of t.rows) tenantExistsMap.set(row.id, true);
    }

    for (const a of agencies.rows) {
      const current: string | null = a.current_tenant ?? null;
      const tenantExists = current ? !!tenantExistsMap.get(current) : false;

      // `users` table has no `tenantId` column — User scope flows via
      // `agencyId` → `agencies.tenantId` (Phase 1 schema decision,
      // documented in SPIKE-007 and Phase 3 #1 R-9). Count linked users
      // without trying to read a non-existent column; the user count
      // is informational only (it doesn't contribute to the inferred
      // tenant set, because that would be circular — we'd be inferring
      // the agency's tenant from itself).
      const [users, emps, apps] = await Promise.all([
        client.query(`SELECT COUNT(*)::int AS n FROM "users" WHERE "agencyId" = $1 AND "deletedAt" IS NULL`, [a.id]),
        client.query(`SELECT "tenantId", COUNT(*)::int AS n FROM "employees" WHERE "agencyId" = $1 AND "deletedAt" IS NULL GROUP BY "tenantId"`, [a.id]),
        client.query(`SELECT "tenantId", COUNT(*)::int AS n FROM "applicants" WHERE "agencyId" = $1 AND "deletedAt" IS NULL GROUP BY "tenantId"`, [a.id]),
      ]);

      const observed = new Set<string>();
      let linkedUsers = 0, linkedEmployees = 0, linkedApplicants = 0;
      for (const r of users.rows)     { linkedUsers      += Number(r.n); }
      for (const r of emps.rows)      { linkedEmployees  += Number(r.n); if (r.tenantId) observed.add(r.tenantId); }
      for (const r of apps.rows)      { linkedApplicants += Number(r.n); if (r.tenantId) observed.add(r.tenantId); }

      const observedTenants = Array.from(observed);
      const inferred = observedTenants.length === 1 ? observedTenants[0] : null;

      // Bucket the agency:
      //   • missing-tenant   → currentTenantId IS NULL
      //   • stale-tenant     → currentTenantId set but the tenant row is gone
      //   • mismatched-children → currentTenantId is set, exists, but every
      //                           observed child tenant disagrees with it
      const isMismatched =
        !!current && tenantExists &&
        observedTenants.length > 0 &&
        !observedTenants.includes(current);

      if (!current || !tenantExists || isMismatched) {
        const hit: Hit = {
          id: a.id, name: a.name,
          currentTenantId: current,
          tenantExists,
          linkedUsers, linkedEmployees, linkedApplicants,
          observedTenants,
          // Safety rules:
          //   - missing-tenant + single observed tenant → propose it
          //   - stale-tenant  → do NOT auto-remap (operator decides)
          //   - mismatched-children → flag, never auto-fix
          inferredTenantId: !current && observedTenants.length === 1 ? inferred : null,
          reason: !current ? 'missing-tenant'
                : !tenantExists ? 'stale-tenant'
                : 'mismatched-children',
        };
        if (hit.inferredTenantId) hits.push(hit);
        else ambiguous.push(hit);
      }
    }

    console.log(`\nAgencies safely correctable (single inferred tenant): ${hits.length}`);
    for (const h of hits) {
      console.log(`  ${h.name}  [${h.id}]  tenant=${h.currentTenantId ?? 'NULL'}  →  ${h.inferredTenantId}  (users=${h.linkedUsers} emps=${h.linkedEmployees} apps=${h.linkedApplicants})`);
    }
    if (hits.length === 0) console.log('  ✓ Every agency with linked records can be matched, or already has a tenant.');

    if (ambiguous.length > 0) {
      console.log(`\n⚠ ${ambiguous.length} agency(ies) need manual review:`);
      for (const h of ambiguous.slice(0, 40)) {
        const obs = h.observedTenants.length === 0 ? '∅' : h.observedTenants.join(',');
        console.log(`    ${h.name}  [${h.id}]  reason=${h.reason}  tenant=${h.currentTenantId ?? 'NULL'} tenantExists=${h.tenantExists}  childTenants=${obs}  (users=${h.linkedUsers} emps=${h.linkedEmployees} apps=${h.linkedApplicants})`);
      }
      if (ambiguous.length > 40) console.log(`    … (${ambiguous.length - 40} more in JSON report)`);
    }

    const remediate = process.env.AGENCY_TENANT_AUDIT_REMEDIATE === 'true';
    const apply = process.env.AGENCY_TENANT_AUDIT_APPLY === 'true';
    const force = process.env.AGENCY_TENANT_AUDIT_FORCE === 'true';
    const env = classifyRuntimeEnv();
    let fixed = 0;
    if (remediate && hits.length > 0) {
      await fs.mkdir(OUT_DIR, { recursive: true });
      await fs.writeFile(path.join(OUT_DIR, 'agency-tenant-backup.json'),
        JSON.stringify({ generatedAt: new Date().toISOString(), rows: hits }, null, 2));
      if (!apply) {
        console.log(`\n[dry-run] would set tenantId on ${hits.length} agency(ies). Backup written to reports/saas/agency-tenant-backup.json. Set AGENCY_TENANT_AUDIT_APPLY=true to apply.`);
      } else if (!isStagingClassification(env.classification) && !force) {
        console.log(`\n[refused] remediation requires a staging/clone env. Current: ${env.classification} (${env.reason}).`);
        console.log('  If this is a DB you own and have backed up, re-run with AGENCY_TENANT_AUDIT_FORCE=true.');
      } else {
        for (const h of hits) {
          // Defence in depth: only update when currentTenantId IS NULL.
          // A racing write between read and apply must not overwrite a
          // value we never inspected.
          const r = await client.query(
            `UPDATE "agencies" SET "tenantId" = $1 WHERE id = $2 AND "tenantId" IS NULL`,
            [h.inferredTenantId, h.id],
          );
          fixed += r.rowCount ?? 0;
        }
        console.log(`\n[applied${force && !isStagingClassification(env.classification) ? ' via FORCE' : ''}] corrected ${fixed} agency tenantId(s). Backup at reports/saas/agency-tenant-backup.json`);
      }
    }

    await fs.mkdir(OUT_DIR, { recursive: true });
    await fs.writeFile(path.join(OUT_DIR, 'agency-tenant-audit.json'),
      JSON.stringify({
        generatedAt: new Date().toISOString(),
        correctable: hits.length,
        ambiguousCount: ambiguous.length,
        fixed,
        hits,
        ambiguous,
      }, null, 2));
    process.exitCode = hits.length > 0 && fixed === 0 ? 1 : 0;
  } finally {
    await client.end();
  }
}

main().catch((e) => { console.error(e); process.exit(2); });
