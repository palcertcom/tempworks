/**
 * User tenant-membership audit.
 *
 * Finds ACTIVE users that hold NO active TenantMembership and therefore
 * cannot log in via /auth/login-v2 (the membership-required multi-tenant
 * flow). The fix proposed per row is the user's primary agency tenant
 * (agency.tenantId). Users whose agency also lacks a tenant are reported
 * as "unassignable" — they need a tenant chosen by hand.
 *
 * READ-ONLY by default. Remediation is opt-in + gated, mirroring
 * phone-audit.ts and applicant-jobad-tenant-audit.ts:
 *   USER_MEMBERSHIP_AUDIT_REMEDIATE=true  — enable
 *   USER_MEMBERSHIP_AUDIT_APPLY=true      — actually write (else dry-run)
 *   USER_MEMBERSHIP_AUDIT_EMAILS=a@x.com,b@y.com   — optional: only these users
 *   classifyRuntimeEnv() ∈ { SAFE_CLONE, SAFE_STAGING }
 *   USER_MEMBERSHIP_AUDIT_FORCE=true     — apply on a DB you own that can't
 *     be auto-classified as staging (backup is still written first)
 *
 * Usage:
 *   npx ts-node backend/scripts/saas/user-tenant-membership-audit.ts                 # report
 *   USER_MEMBERSHIP_AUDIT_REMEDIATE=true \
 *     npx ts-node backend/scripts/saas/user-tenant-membership-audit.ts               # dry-run
 *   USER_MEMBERSHIP_AUDIT_REMEDIATE=true USER_MEMBERSHIP_AUDIT_APPLY=true \
 *   USER_MEMBERSHIP_AUDIT_FORCE=true \
 *     npx ts-node backend/scripts/saas/user-tenant-membership-audit.ts               # apply
 *
 *   # Target a single user (e.g. Hussain):
 *   USER_MEMBERSHIP_AUDIT_EMAILS=partners@nsghq.com \
 *     npx ts-node backend/scripts/saas/user-tenant-membership-audit.ts
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
  email: string;
  status: string;
  agencyId: string | null;
  agencyTenantId: string | null;
}

async function main() {
  const client = pgClient(getDatabaseUrl());
  await client.connect();
  try {
    const emails = (process.env.USER_MEMBERSHIP_AUDIT_EMAILS ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
    const params: any[] = [];
    let sql = `
      SELECT u.id, u.email, u.status::text AS status,
             u."agencyId", a."tenantId" AS agency_tenant
      FROM "users" u
      LEFT JOIN "agencies" a ON a.id = u."agencyId"
      LEFT JOIN "tenant_memberships" tm
             ON tm."userId" = u.id AND tm.status = 'ACTIVE'
      WHERE u."deletedAt" IS NULL
        AND u.status::text = 'ACTIVE'
        AND tm.id IS NULL
    `;
    if (emails.length) {
      sql += ` AND lower(u.email) = ANY($1::text[])`;
      params.push(emails);
    }
    sql += ` ORDER BY u.email`;
    const res = await client.query(sql, params);
    const fixable: Hit[] = [];
    const unassignable: Hit[] = [];
    for (const r of res.rows) {
      const hit: Hit = {
        id: r.id, email: r.email, status: r.status,
        agencyId: r.agencyId, agencyTenantId: r.agency_tenant,
      };
      if (hit.agencyTenantId) fixable.push(hit); else unassignable.push(hit);
    }

    console.log(`\nACTIVE users without an ACTIVE TenantMembership: ${fixable.length + unassignable.length}`);
    console.log(`  • Fixable from agency.tenantId: ${fixable.length}`);
    console.log(`  • Unassignable (agency has no tenant): ${unassignable.length}\n`);
    for (const h of fixable) {
      console.log(`  [fixable]      ${h.email}  →  tenant ${h.agencyTenantId}  (via agency ${h.agencyId})`);
    }
    for (const h of unassignable) {
      console.log(`  [unassignable] ${h.email}  (agencyId=${h.agencyId ?? 'none'}, agency tenant=NULL)`);
    }
    if (fixable.length + unassignable.length === 0) console.log('  ✓ Every active user has an ACTIVE TenantMembership.');

    const remediate = process.env.USER_MEMBERSHIP_AUDIT_REMEDIATE === 'true';
    const apply = process.env.USER_MEMBERSHIP_AUDIT_APPLY === 'true';
    const force = process.env.USER_MEMBERSHIP_AUDIT_FORCE === 'true';
    const env = classifyRuntimeEnv();
    let fixed = 0;
    if (remediate && fixable.length > 0) {
      await fs.mkdir(OUT_DIR, { recursive: true });
      await fs.writeFile(path.join(OUT_DIR, 'user-membership-backup.json'),
        JSON.stringify({ generatedAt: new Date().toISOString(), rows: fixable }, null, 2));
      if (!apply) {
        console.log(`\n[dry-run] would create ${fixable.length} TenantMembership row(s). Backup written. Set USER_MEMBERSHIP_AUDIT_APPLY=true to apply.`);
      } else if (!isStagingClassification(env.classification) && !force) {
        console.log(`\n[refused] remediation requires a staging/clone env. Current: ${env.classification} (${env.reason}).`);
        console.log('  If this is a DB you own and have backed up, re-run with USER_MEMBERSHIP_AUDIT_FORCE=true.');
      } else {
        for (const h of fixable) {
          // gen_random_uuid() is available on every Postgres 13+.
          await client.query(`
            INSERT INTO "tenant_memberships" (id, "userId", "tenantId", status, "joinedAt", "createdAt", "updatedAt")
            VALUES (gen_random_uuid()::text, $1, $2, 'ACTIVE', NOW(), NOW(), NOW())
            ON CONFLICT ("userId", "tenantId") DO UPDATE SET status = 'ACTIVE'
          `, [h.id, h.agencyTenantId]);
          fixed++;
        }
        console.log(`\n[applied${force && !isStagingClassification(env.classification) ? ' via FORCE' : ''}] created ${fixed} TenantMembership row(s).`);
      }
    }

    await fs.mkdir(OUT_DIR, { recursive: true });
    await fs.writeFile(path.join(OUT_DIR, 'user-membership-audit.json'),
      JSON.stringify({ generatedAt: new Date().toISOString(), fixable: fixable.length, unassignable: unassignable.length, fixed, fixableHits: fixable, unassignableHits: unassignable }, null, 2));
    process.exitCode = fixable.length + unassignable.length > 0 && fixed === 0 ? 1 : 0;
  } finally {
    await client.end();
  }
}

main().catch((e) => { console.error(e); process.exit(2); });
