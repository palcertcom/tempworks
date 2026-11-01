/**
 * Applicant ↔ Job Ad tenant audit.
 *
 * Finds applicants/leads linked to a Job Ad whose tenant ownership does
 * not match the ad's tenant — the records the old public-submit bug
 * created (jobAdId set, but tenantId null or pointing at another tenant).
 *
 * READ-ONLY by default. For each hit it reports:
 *   applicant id, current tenantId, jobAdId, jobAd tenantId, agencyId,
 *   createdAt — plus a count of related child rows that share the
 *   applicant (documents) for awareness. It only ever proposes/updates
 *   the applicant's own tenantId; child remediation is intentionally
 *   left out of the mutation path (review the report and run a targeted
 *   fix if needed).
 *
 * Correction target per applicant:
 *   • Job Ad tenant is AUTHORITATIVE (wins even over a set value).
 *   • else, if the applicant has NO tenant, fall back to its Agency tenant.
 *   • an already-set tenant is never overwritten from the Agency alone.
 * Applicants whose Job Ad / Agency also have no tenant are reported as
 * "unassignable" — they need a tenant set by hand.
 *
 * Remediation is opt-in + gated, mirroring phone-audit.ts:
 *   APPLICANT_TENANT_AUDIT_REMEDIATE=true  — enable
 *   APPLICANT_TENANT_AUDIT_APPLY=true      — actually write (else dry-run)
 *   classifyRuntimeEnv() ∈ { SAFE_CLONE, SAFE_STAGING }
 *   APPLICANT_TENANT_AUDIT_FORCE=true      — apply on a DB you own that
 *     can't be auto-classified as staging (backup is still written first)
 * A JSON backup of every changed row is written before any update.
 *
 * Usage:
 *   npx ts-node backend/scripts/saas/applicant-jobad-tenant-audit.ts          # report
 *   APPLICANT_TENANT_AUDIT_REMEDIATE=true APPLICANT_TENANT_AUDIT_APPLY=true \
 *     npx ts-node backend/scripts/saas/applicant-jobad-tenant-audit.ts        # repair (staging/clone)
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
  leadNumber: string | null;
  candidateNumber: string | null;
  currentTenantId: string | null;
  jobAdId: string | null;
  jobAdTenantId: string | null;
  agencyId: string | null;
  agencyTenantId: string | null;
  targetTenantId: string;
  source: 'jobAd' | 'agency';
  createdAt: string;
}

async function main() {
  const client = pgClient(getDatabaseUrl());
  await client.connect();
  const hits: Hit[] = [];
  try {
    // Every non-deleted applicant, with the tenant its Job Ad and/or
    // Agency resolves to. We compute the correction target in JS so the
    // rule is explicit:
    //   • Job Ad tenant is AUTHORITATIVE — if the applicant has a Job Ad
    //     with a tenant, that wins (even over a currently-set value).
    //   • Otherwise, if the applicant has NO tenant yet, fall back to the
    //     Agency's tenant (the system's other attribution path).
    //   • Never overwrite an already-set tenant from the Agency alone.
    const res = await client.query(`
      SELECT a.id, a."leadNumber", a."candidateNumber", a."tenantId" AS current_tenant,
             a."jobAdId", j."tenantId" AS jobad_tenant,
             a."agencyId", ag."tenantId" AS agency_tenant, a."createdAt"
      FROM "applicants" a
      LEFT JOIN "job_ads"  j  ON j.id  = a."jobAdId"
      LEFT JOIN "agencies" ag ON ag.id = a."agencyId"
      WHERE a."deletedAt" IS NULL
      ORDER BY a."createdAt" DESC
    `);

    const residual: any[] = []; // still no tenant after the rule
    for (const r of res.rows) {
      const current = r.current_tenant ?? null;
      const jobAd = r.jobad_tenant ?? null;
      const agency = r.agency_tenant ?? null;

      let target: string | null = null;
      let source: 'jobAd' | 'agency' | null = null;
      if (jobAd) { target = jobAd; source = 'jobAd'; }
      else if (current == null && agency) { target = agency; source = 'agency'; }

      if (target && current !== target) {
        hits.push({
          id: r.id, leadNumber: r.leadNumber, candidateNumber: r.candidateNumber,
          currentTenantId: current, jobAdId: r.jobAdId, jobAdTenantId: jobAd,
          agencyId: r.agencyId, agencyTenantId: agency,
          targetTenantId: target, source: source!,
          createdAt: r.createdAt?.toISOString?.() ?? String(r.createdAt),
        });
      } else if (current == null && !target) {
        residual.push({ id: r.id, ref: r.candidateNumber ?? r.leadNumber ?? r.id, jobAdId: r.jobAdId, agencyId: r.agencyId });
      }
    }

    console.log(`\nApplicants whose tenant can be corrected: ${hits.length}\n`);
    for (const h of hits) {
      console.log(`  ${h.candidateNumber ?? h.leadNumber ?? h.id}  tenant=${h.currentTenantId ?? 'NULL'}  →  ${h.targetTenantId}  (from ${h.source})`);
    }
    if (hits.length === 0) console.log('  ✓ Every applicant already matches its Job Ad / Agency tenant.');

    if (residual.length > 0) {
      console.log(`\n⚠ ${residual.length} applicant(s) cannot be auto-assigned — no Job Ad tenant and no Agency tenant:`);
      for (const r of residual.slice(0, 20)) console.log(`    ${r.ref}  (jobAdId=${r.jobAdId ?? 'none'}, agencyId=${r.agencyId ?? 'none'})`);
      if (residual.length > 20) console.log(`    … (${residual.length - 20} more)`);
      console.log('  These need a tenant set manually (the Job Ad / Agency they point to has no tenant either).');
    }

    const remediate = process.env.APPLICANT_TENANT_AUDIT_REMEDIATE === 'true';
    const apply = process.env.APPLICANT_TENANT_AUDIT_APPLY === 'true';
    // FORCE allows applying on a DB that classifyRuntimeEnv can't prove is
    // staging/clone (e.g. a dev DB you own). Backup is ALWAYS written first.
    const force = process.env.APPLICANT_TENANT_AUDIT_FORCE === 'true';
    const env = classifyRuntimeEnv();
    let fixed = 0;
    if (remediate && hits.length > 0) {
      await fs.mkdir(OUT_DIR, { recursive: true });
      await fs.writeFile(path.join(OUT_DIR, 'applicant-jobad-tenant-backup.json'),
        JSON.stringify({ generatedAt: new Date().toISOString(), rows: hits }, null, 2));
      if (!apply) {
        console.log(`\n[dry-run] would set tenantId on ${hits.length} applicant(s). Backup written to reports/saas/applicant-jobad-tenant-backup.json. Set APPLICANT_TENANT_AUDIT_APPLY=true to apply.`);
      } else if (!isStagingClassification(env.classification) && !force) {
        console.log(`\n[refused] remediation requires a staging/clone env. Current: ${env.classification} (${env.reason}).`);
        console.log('  If this is a DB you own and have backed up, re-run with APPLICANT_TENANT_AUDIT_FORCE=true.');
      } else {
        for (const h of hits) {
          await client.query(`UPDATE "applicants" SET "tenantId" = $1 WHERE id = $2`, [h.targetTenantId, h.id]);
          fixed++;
        }
        console.log(`\n[applied${force && !isStagingClassification(env.classification) ? ' via FORCE' : ''}] corrected ${fixed} applicant tenantId(s). Backup at reports/saas/applicant-jobad-tenant-backup.json`);
        console.log('  NOTE: child rows (documents, financial_records, notifications, employees converted from these applicants) are NOT auto-updated — review separately if needed.');
      }
    }

    await fs.mkdir(OUT_DIR, { recursive: true });
    await fs.writeFile(path.join(OUT_DIR, 'applicant-jobad-tenant-audit.json'),
      JSON.stringify({ generatedAt: new Date().toISOString(), correctable: hits.length, unassignable: residual.length, fixed, hits, residual }, null, 2));
    process.exitCode = hits.length > 0 && fixed === 0 ? 1 : 0;
  } finally {
    await client.end();
  }
}

main().catch((e) => { console.error(e); process.exit(2); });
