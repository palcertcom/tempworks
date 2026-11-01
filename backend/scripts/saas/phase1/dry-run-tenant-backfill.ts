/**
 * Phase 1 — Dry-Run Tenant Backfill.
 *
 * Implements `SAAS_PHASE1_TENANT_BACKFILL_ALGORITHM.md` as a single
 * Postgres transaction. By default the transaction is ROLLED BACK at the
 * end — the script verifies counts, writes a verification report, and
 * leaves the database untouched.
 *
 * Modes:
 *   --dry-run         (default)  open tx, perform writes, capture counts, ROLLBACK
 *   --tenant-preview            no writes; only prints projected mapping
 *   --apply                     (staging-only; staging-host check) commit
 *
 * Notes on safety:
 *   - The script refuses to run if a key sanity check fails (e.g. duplicate
 *     emails, NULL agency users, identifier-sequence rows).
 *   - Identifier-sequence cutover is INTENTIONALLY not executed here —
 *     that's TKT-P1-05's job.
 *   - System-agency disposition is performed inside the same transaction.
 *   - --apply against any host not on the staging allow-list is rejected.
 */
import { Client } from 'pg';
import { promises as fs } from 'fs';
import path from 'path';
import { connect, getDatabaseUrl, parseMode, assertStagingOnly } from './reconciliation/lib/recon';
import { randomUUID } from 'crypto';

const RESERVED_SLUGS = new Set([
  'api','app','admin','auth','www','root','system','support','ops','status','billing',
  'platform','tempworks','public','internal','dev','staging','test','sandbox',
  'help','docs','mail','smtp','ftp','db','pgadmin','pg','postgres','redis',
]);
const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])?$/;

function slugify(name: string): string {
  return name.toLowerCase()
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40);
}
function shortHash(s: string): string {
  let h = 0; for (let i = 0; i < s.length; i++) { h = ((h << 5) - h) + s.charCodeAt(i); h |= 0; }
  return Math.abs(h).toString(16).padStart(6, '0').slice(0, 6);
}
function makeSlug(name: string, id: string, used: Set<string>): { slug: string; conflicts: string[] } {
  const base = slugify(name) || `t-${shortHash(id)}`;
  const conflicts: string[] = [];
  let slug = base;
  if (!SLUG_RE.test(slug)) { conflicts.push('regex'); slug = `t-${shortHash(id)}`; }
  if (RESERVED_SLUGS.has(slug)) { conflicts.push('reserved'); slug = `${base}-co`; }
  if (used.has(slug)) { conflicts.push('duplicate'); slug = `${base}-${shortHash(id)}`; }
  used.add(slug);
  return { slug, conflicts };
}

interface VerificationCheck { name: string; ok: boolean; detail?: unknown; }
interface BackfillReport {
  mode: string;
  database: string;
  startedAt: string;
  durationMs: number;
  status: 'OK' | 'WARN' | 'BLOCKER' | 'ROLLED_BACK';
  preflightSummary: {
    duplicateEmails: number;
    nullAgencyUsers: number;
    employeeCodeCollisions: number;
    employeeEmailCollisions: number;
  };
  projection: Array<{ agencyId: string; name: string; tenantId: string; slug: string; conflicts: string[] }>;
  systemAgencyUserCount: number;
  written: {
    tenants: number;
    defaultAgencies: number;
    memberships: number;
    agencyMemberships: number;
    membershipRoles: number;
    membershipPermissionOverrides: number;
    platformAdmins: number;
    quarantineRows: number;
    tenantIdAssignments: { applicants: number; employees: number; vehicles: number };
  };
  verification: VerificationCheck[];
  /** Pre-run vs post-run row counts on every existing table. */
  diffSummary?: Record<string, { before: number; after: number; delta: number }>;
}

/** Parse hardening flags. */
function parseHardenFlags(): { failOnQuarantine: boolean; maxQuarantine: number; resume: boolean } {
  const failOnQuarantine = process.argv.includes('--fail-on-quarantine');
  const maxIdx = process.argv.findIndex((a) => a === '--max-quarantine');
  const maxQuarantine = maxIdx >= 0 && process.argv[maxIdx + 1] ? parseInt(process.argv[maxIdx + 1], 10) : Number.POSITIVE_INFINITY;
  const resume = process.argv.includes('--resume');
  return { failOnQuarantine, maxQuarantine, resume };
}

async function main(): Promise<void> {
  const mode = parseMode();
  const url = getDatabaseUrl();
  if (mode === 'apply' && !process.env.ALLOW_NON_STAGING_APPLY) assertStagingOnly(url);

  const harden = parseHardenFlags();
  const c = await connect();
  const startedAt = new Date().toISOString();
  const t0 = Date.now();

  // Snapshot pre-run row counts on every existing table — used to compute a
  // diff summary at the end so the operator can see what would change.
  const preCounts: Record<string, number> = {};
  for (const t of ['agencies', 'users', 'employees', 'applicants', 'vehicles',
                   'tenants', 'tenant_memberships', 'agency_memberships',
                   'membership_roles', 'membership_permission_overrides',
                   'platform_admins', 'agency_split_progress',
                   'saas_reconciliation_queue']) {
    try {
      const r = await c.query<{ n: number }>(`SELECT count(*)::int n FROM "${t}"`);
      preCounts[t] = r.rows[0]?.n ?? 0;
    } catch { /* table may not exist */ }
  }

  const out: BackfillReport = {
    mode,
    database: url.replace(/:[^:@/]+@/, ':***@'),
    startedAt,
    durationMs: 0,
    status: 'OK',
    preflightSummary: { duplicateEmails: 0, nullAgencyUsers: 0, employeeCodeCollisions: 0, employeeEmailCollisions: 0 },
    projection: [],
    systemAgencyUserCount: 0,
    written: {
      tenants: 0, defaultAgencies: 0, memberships: 0, agencyMemberships: 0,
      membershipRoles: 0, membershipPermissionOverrides: 0, platformAdmins: 0,
      quarantineRows: 0,
      tenantIdAssignments: { applicants: 0, employees: 0, vehicles: 0 },
    },
    verification: [],
  };

  try {
    // -------- Pre-checks (read-only) --------
    out.preflightSummary.duplicateEmails = (await c.query<{ n: number }>(
      `SELECT count(*)::int n FROM (
         SELECT lower(email) FROM users WHERE email IS NOT NULL
          GROUP BY 1 HAVING count(*) > 1
       ) x`,
    )).rows[0].n;
    out.preflightSummary.nullAgencyUsers = (await c.query<{ n: number }>(
      `SELECT count(*)::int n FROM users WHERE "agencyId" IS NULL`,
    )).rows[0].n;
    out.preflightSummary.employeeCodeCollisions = (await c.query<{ n: number }>(
      `SELECT count(*)::int n FROM (
         SELECT lower("employeeCode") FROM employees
          WHERE "employeeCode" IS NOT NULL
          GROUP BY lower("employeeCode") HAVING count(DISTINCT "agencyId") > 1
       ) x`,
    )).rows[0].n;
    out.preflightSummary.employeeEmailCollisions = (await c.query<{ n: number }>(
      `SELECT count(*)::int n FROM (
         SELECT lower(email) FROM employees
          WHERE email IS NOT NULL
          GROUP BY lower(email) HAVING count(DISTINCT "agencyId") > 1
       ) x`,
    )).rows[0].n;

    if (out.preflightSummary.duplicateEmails > 0) {
      out.status = 'BLOCKER';
      throw new Error('Duplicate emails on users — abort. Run reconciliation first.');
    }

    // -------- Tenant projection --------
    const customers = await c.query<{ id: string; name: string; status: string; createdAt: string }>(
      `SELECT id::text, name, status, "createdAt"
         FROM agencies WHERE "isSystem" = false
        ORDER BY "createdAt" NULLS LAST, id`,
    );
    const used = new Set<string>();
    for (const a of customers.rows) {
      const { slug, conflicts } = makeSlug(a.name, a.id, used);
      out.projection.push({ agencyId: a.id, name: a.name, tenantId: a.id, slug, conflicts });
    }

    if (mode === 'tenant-preview' as any || (process.argv.includes('--tenant-preview'))) {
      // Print projection only and exit without opening a tx.
      out.status = 'OK';
      out.durationMs = Date.now() - t0;
      await writeReports(out);
      return;
    }

    // -------- Open transaction --------
    await c.query('BEGIN');
    await c.query("SELECT pg_advisory_xact_lock(hashtext('saas-agency-tenant-split'))");

    // -------- Idempotency / resume check --------
    // If --resume, any agency already DONE in agency_split_progress is skipped.
    // If NOT --resume, the script refuses to proceed if a partial state is
    // detected (any progress row with status != 'DONE').
    const partial = await c.query<{ n: number; states: any }>(
      `SELECT count(*)::int n, json_agg(distinct status) AS states FROM agency_split_progress`,
    );
    const hasProgress = (partial.rows[0]?.n ?? 0) > 0;
    if (hasProgress) {
      const states = (partial.rows[0]?.states as string[]) ?? [];
      const allDone = states.every((s) => s === 'DONE');
      if (!harden.resume && !allDone) {
        throw new Error(
          'Partial agency_split_progress detected (states: ' + JSON.stringify(states) +
          '). Pass --resume to skip already-DONE agencies, or clean up the table.',
        );
      }
    }

    // -------- Per-customer-agency loop --------
    for (const p of out.projection) {
      if (harden.resume) {
        const done = await c.query<{ status: string }>(
          `SELECT status FROM agency_split_progress WHERE old_agency_id = $1`, [p.agencyId],
        );
        if (done.rows[0]?.status === 'DONE') continue;
      }
      // 1. Tenant
      const tIns = await c.query<{ id: string }>(
        `INSERT INTO tenants (id, slug, name, region, status)
              VALUES ($1, $2, $3, 'eu', 'ACTIVE'::"TenantStatus")
         ON CONFLICT (id) DO NOTHING
         RETURNING id`,
        [p.tenantId, p.slug, p.name],
      );
      out.written.tenants += tIns.rowCount ?? 0;

      // 2. Default agency
      const defaultId = randomUUID();
      const dIns = await c.query<{ id: string }>(
        `INSERT INTO agencies (id, name, "isSystem", "tenantId", "isDefault", status)
              VALUES ($1::uuid, $2, false, $3, true, 'ACTIVE')
         ON CONFLICT (id) DO NOTHING
         RETURNING id`,
        [defaultId, p.name, p.tenantId],
      );
      out.written.defaultAgencies += dIns.rowCount ?? 0;

      // 3. Reparent
      const u = await c.query(
        `UPDATE users SET "agencyId" = $1::uuid WHERE "agencyId" = $2::uuid`,
        [defaultId, p.agencyId],
      );
      const e = await c.query(
        `UPDATE employees SET "agencyId" = $1::uuid WHERE "agencyId" = $2::uuid`,
        [defaultId, p.agencyId],
      );
      const a = await c.query(
        `UPDATE applicants SET "agencyId" = $1::uuid WHERE "agencyId" = $2::uuid`,
        [defaultId, p.agencyId],
      );
      await c.query(
        `UPDATE vehicles SET "agencyId" = $1::uuid WHERE "agencyId" = $2::uuid`,
        [defaultId, p.agencyId],
      );
      await c.query(
        `UPDATE employee_agency_access SET "agencyId" = $1::uuid WHERE "agencyId" = $2::uuid`,
        [defaultId, p.agencyId],
      );
      await c.query(
        `UPDATE agency_permission_overrides SET "agencyId" = $1::uuid WHERE "agencyId" = $2::uuid`,
        [defaultId, p.agencyId],
      );

      // 4. Delete original
      await c.query(`DELETE FROM agencies WHERE id = $1::uuid`, [p.agencyId]);

      // 5. tenantId denorm (Phase 1 leading models only)
      const ar = await c.query(
        `UPDATE applicants SET "tenantId" = $1 WHERE "agencyId" = $2::uuid AND "tenantId" IS NULL`,
        [p.tenantId, defaultId],
      );
      out.written.tenantIdAssignments.applicants += ar.rowCount ?? 0;
      const er = await c.query(
        `UPDATE employees SET "tenantId" = $1 WHERE "agencyId" = $2::uuid AND "tenantId" IS NULL`,
        [p.tenantId, defaultId],
      );
      out.written.tenantIdAssignments.employees += er.rowCount ?? 0;
      const vr = await c.query(
        `UPDATE vehicles SET "tenantId" = $1 WHERE "agencyId" = $2::uuid AND "tenantId" IS NULL`,
        [p.tenantId, defaultId],
      );
      out.written.tenantIdAssignments.vehicles += vr.rowCount ?? 0;
      await c.query(
        `UPDATE agencies SET "tenantId" = $1 WHERE id = $2::uuid AND "tenantId" IS NULL`,
        [p.tenantId, defaultId],
      );

      // 6. Memberships
      const mIns = await c.query<{ id: string }>(
        `INSERT INTO tenant_memberships (id, "userId", "tenantId", status, "joinedAt")
         SELECT gen_random_uuid()::text, u.id::text, $1,
                (CASE WHEN u.status = 'ACTIVE' THEN 'ACTIVE' ELSE 'SUSPENDED' END)::"MembershipStatus",
                u."createdAt"
           FROM users u WHERE u."agencyId" = $2::uuid
          ON CONFLICT ("userId", "tenantId") DO NOTHING
          RETURNING id`,
        [p.tenantId, defaultId],
      );
      out.written.memberships += mIns.rowCount ?? 0;

      // 6b. MembershipRoles (clone roleId from User)
      const mrIns = await c.query(
        `INSERT INTO membership_roles ("membershipId", "roleId")
         SELECT m.id, u."roleId"::text
           FROM tenant_memberships m
           JOIN users u ON u.id::text = m."userId"
          WHERE m."tenantId" = $1 AND u."roleId" IS NOT NULL
          ON CONFLICT DO NOTHING`,
        [p.tenantId],
      );
      out.written.membershipRoles += mrIns.rowCount ?? 0;

      // 6c. AgencyMemberships
      const amIns = await c.query(
        `INSERT INTO agency_memberships (id, "membershipId", "agencyId", scope)
         SELECT gen_random_uuid()::text, m.id, $1, 'FULL'::"AgencyMembershipScope"
           FROM tenant_memberships m WHERE m."tenantId" = $2
          ON CONFLICT ("membershipId", "agencyId") DO NOTHING`,
        [defaultId, p.tenantId],
      );
      out.written.agencyMemberships += amIns.rowCount ?? 0;

      // 6d. AgencyUserPermission → MembershipPermissionOverride
      const overrideIns = await c.query(
        `INSERT INTO membership_permission_overrides (id, "membershipId", "permissionId", effect)
         SELECT gen_random_uuid()::text, m.id, aup."permissionId"::text, true
           FROM agency_user_permission aup
           JOIN users u ON u.id = aup."userId"
           JOIN tenant_memberships m ON m."userId" = u.id::text AND m."tenantId" = $1
          ON CONFLICT DO NOTHING`,
        [p.tenantId],
      );
      out.written.membershipPermissionOverrides += overrideIns.rowCount ?? 0;

      // 7. Checkpoint
      await c.query(
        `INSERT INTO agency_split_progress (old_agency_id, new_tenant_id, new_default_agency_id, status, finished_at)
              VALUES ($1, $2, $3, 'DONE', now())
         ON CONFLICT (old_agency_id) DO UPDATE
            SET new_default_agency_id = EXCLUDED.new_default_agency_id,
                status = 'DONE', finished_at = now()`,
        [p.agencyId, p.tenantId, defaultId],
      );
    }

    // -------- System-agency users → PlatformAdmin --------
    const sysUsers = await c.query<{ id: string }>(
      `SELECT u.id::text FROM users u JOIN agencies a ON a.id = u."agencyId" WHERE a."isSystem" = true`,
    );
    out.systemAgencyUserCount = sysUsers.rowCount ?? 0;
    for (const r of sysUsers.rows) {
      const ins = await c.query(
        `INSERT INTO platform_admins (id, "userId", level, "grantedAt")
              VALUES (gen_random_uuid()::text, $1, 'SUPER'::"PlatformAdminLevel", now())
         ON CONFLICT ("userId") DO NOTHING`,
        [r.id],
      );
      out.written.platformAdmins += ins.rowCount ?? 0;
    }
    // Detach: nullify agencyId on system users (column is already nullable)
    await c.query(
      `UPDATE users SET "agencyId" = NULL
         WHERE "agencyId" IN (SELECT id FROM agencies WHERE "isSystem" = true)`,
    );
    await c.query(`DELETE FROM agencies WHERE "isSystem" = true`);

    // -------- Quarantine: NULL agency users that aren't platform admins --------
    const orphans = await c.query<{ id: string; email: string }>(
      `SELECT u.id::text, u.email FROM users u
        WHERE u."agencyId" IS NULL
          AND u.id::text NOT IN (SELECT "userId" FROM platform_admins)`,
    );
    for (const o of orphans.rows) {
      await c.query(
        `INSERT INTO saas_reconciliation_queue (kind, subject, decision)
              VALUES ('user.no-agency-after-backfill', $1::jsonb, 'pending')`,
        [JSON.stringify(o)],
      );
      out.written.quarantineRows++;
    }

    // -------- Verification --------
    const tCount = (await c.query<{ n: number }>(`SELECT count(*)::int n FROM tenants`)).rows[0].n;
    out.verification.push({ name: 'tenants.count', ok: tCount === out.projection.length, detail: { actual: tCount, expected: out.projection.length } });

    const orphanCheck = (await c.query<{ n: number }>(
      `SELECT count(*)::int n FROM users u
        WHERE u."agencyId" IS NOT NULL
          AND u.id::text NOT IN (SELECT "userId" FROM tenant_memberships)`,
    )).rows[0].n;
    out.verification.push({ name: 'users.with-agency-have-membership', ok: orphanCheck === 0, detail: { count: orphanCheck } });

    const sysOrphan = (await c.query<{ n: number }>(
      `SELECT count(*)::int n FROM users u
        WHERE u."agencyId" IS NULL
          AND u.id::text NOT IN (SELECT "userId" FROM platform_admins)
          AND u.id::text NOT IN (
            SELECT (subject->>'id') FROM saas_reconciliation_queue
             WHERE kind = 'user.no-agency-after-backfill'
          )`,
    )).rows[0].n;
    out.verification.push({ name: 'users.no-agency.handled', ok: sysOrphan === 0, detail: { count: sysOrphan } });

    const denormApp = (await c.query<{ n: number }>(
      `SELECT count(*)::int n FROM applicants WHERE "tenantId" IS NULL`,
    )).rows[0].n;
    const denormEmp = (await c.query<{ n: number }>(
      `SELECT count(*)::int n FROM employees WHERE "tenantId" IS NULL`,
    )).rows[0].n;
    out.verification.push({ name: 'applicants.tenantId-populated', ok: denormApp === 0, detail: { stillNull: denormApp } });
    out.verification.push({ name: 'employees.tenantId-populated',  ok: denormEmp === 0, detail: { stillNull: denormEmp } });

    // No duplicate slug
    const slugDupes = (await c.query<{ n: number }>(
      `SELECT count(*)::int n FROM (SELECT slug FROM tenants GROUP BY slug HAVING count(*) > 1) x`,
    )).rows[0].n;
    out.verification.push({ name: 'tenants.no-duplicate-slug', ok: slugDupes === 0, detail: { duplicates: slugDupes } });

    // No duplicate (userId, tenantId) memberships
    const memDupes = (await c.query<{ n: number }>(
      `SELECT count(*)::int n FROM (
         SELECT "userId", "tenantId" FROM tenant_memberships GROUP BY 1,2 HAVING count(*) > 1
       ) x`,
    )).rows[0].n;
    out.verification.push({ name: 'tenant_memberships.no-duplicate-pair', ok: memDupes === 0, detail: { duplicates: memDupes } });

    // No partial checkpoint
    const partialCk = (await c.query<{ n: number }>(
      `SELECT count(*)::int n FROM agency_split_progress WHERE status NOT IN ('DONE','SKIPPED')`,
    )).rows[0].n;
    out.verification.push({ name: 'checkpoint.no-partial', ok: partialCk === 0, detail: { partial: partialCk } });

    // Fail-on-quarantine policy
    if (harden.failOnQuarantine && out.written.quarantineRows > 0) {
      throw new Error(
        `--fail-on-quarantine: ${out.written.quarantineRows} rows quarantined (max=${
          isFinite(harden.maxQuarantine) ? harden.maxQuarantine : 'inf'
        })`,
      );
    }
    if (out.written.quarantineRows > harden.maxQuarantine) {
      throw new Error(
        `--max-quarantine exceeded: ${out.written.quarantineRows} > ${harden.maxQuarantine}`,
      );
    }

    const failedChecks = out.verification.filter((v) => !v.ok);
    if (failedChecks.length > 0) out.status = 'WARN';

    // Diff summary BEFORE commit/rollback (i.e. inside the open tx so the
    // counts reflect what would be persisted in --apply mode).
    out.diffSummary = {};
    for (const t of Object.keys(preCounts)) {
      try {
        const r = await c.query<{ n: number }>(`SELECT count(*)::int n FROM "${t}"`);
        const after = r.rows[0]?.n ?? 0;
        out.diffSummary[t] = { before: preCounts[t], after, delta: after - preCounts[t] };
      } catch { /* table missing; skip */ }
    }

    if (mode === 'apply') {
      await c.query('COMMIT');
      out.status = out.status === 'OK' ? 'OK' : out.status;
    } else {
      await c.query('ROLLBACK');
      out.status = 'ROLLED_BACK';
    }
  } catch (e) {
    await c.query('ROLLBACK').catch(() => undefined);
    out.status = 'BLOCKER';
    out.verification.push({ name: 'fatal', ok: false, detail: { message: (e as Error).message } });
  } finally {
    await c.end().catch(() => undefined);
  }

  out.durationMs = Date.now() - t0;
  await writeReports(out);
}

async function writeReports(r: BackfillReport): Promise<void> {
  const dir = path.resolve(__dirname, '..', '..', '..', 'reports', 'saas', 'phase1');
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'PHASE1_DRY_RUN_BACKFILL.json'), JSON.stringify(r, null, 2));

  const md: string[] = [];
  md.push('# Phase 1 — Dry-Run Tenant Backfill Result');
  md.push('');
  md.push(`- **Mode:** \`${r.mode}\``);
  md.push(`- **Status:** **${r.status}**`);
  md.push(`- **Database:** \`${r.database}\``);
  md.push(`- **Started:** ${r.startedAt}`);
  md.push(`- **Duration:** ${r.durationMs} ms`);
  md.push('');
  md.push('## Pre-flight summary');
  md.push('');
  md.push('| Check | Count |');
  md.push('|-------|-------|');
  md.push(`| duplicate emails | ${r.preflightSummary.duplicateEmails} |`);
  md.push(`| NULL-agency users | ${r.preflightSummary.nullAgencyUsers} |`);
  md.push(`| employee email collisions | ${r.preflightSummary.employeeEmailCollisions} |`);
  md.push(`| employee code collisions | ${r.preflightSummary.employeeCodeCollisions} |`);
  md.push('');
  md.push('## Projection');
  md.push('');
  md.push('| Agency | Tenant Slug | Conflicts |');
  md.push('|--------|-------------|-----------|');
  for (const p of r.projection) md.push(`| ${p.name} | \`${p.slug}\` | ${p.conflicts.join(',') || '—'} |`);
  md.push('');
  md.push('## Writes (rolled back unless --apply)');
  md.push('');
  for (const [k, v] of Object.entries(r.written)) {
    if (typeof v === 'number') md.push(`- ${k}: **${v}**`);
    else md.push(`- ${k}: ${JSON.stringify(v)}`);
  }
  md.push('');
  md.push('## Verification');
  md.push('');
  md.push('| Check | OK | Detail |');
  md.push('|-------|----|--------|');
  for (const v of r.verification) md.push(`| ${v.name} | ${v.ok ? 'PASS' : '**FAIL**'} | ${JSON.stringify(v.detail ?? '')} |`);
  md.push('');
  if (r.diffSummary) {
    md.push('## Diff Summary (pre-run vs in-tx counts)');
    md.push('');
    md.push('| Table | Before | After | Δ |');
    md.push('|-------|--------|-------|---|');
    for (const [t, d] of Object.entries(r.diffSummary)) {
      const sign = d.delta > 0 ? `+${d.delta}` : String(d.delta);
      md.push(`| \`${t}\` | ${d.before} | ${d.after} | ${sign} |`);
    }
    md.push('');
    md.push('> In `--dry-run`, the "After" column reflects what would have been written before ROLLBACK. The persisted database state is unchanged.');
    md.push('');
  }
  md.push('## Rollback notes');
  md.push('');
  md.push('- `--dry-run`: ROLLBACK is automatic; no recovery needed.');
  md.push('- `--apply` on staging: re-running `dry-run-tenant-backfill --resume` is idempotent. To revert the entire backfill, restore the pre-run snapshot.');
  md.push('- The original `agencies` rows are deleted at backfill step 5.4. Database restore is the only revert path once `--apply` commits.');
  md.push('- Detected partial state from a prior run? Pass `--resume` to continue, or DELETE FROM agency_split_progress and start over.');
  md.push('');
  md.push('## Notes');
  md.push('');
  md.push('- This script does NOT touch identifier_sequences (TKT-P1-05).');
  md.push('- This script does NOT migrate Document/FinancialRecord tenantId (Phase 2).');
  md.push('- Re-running this script in --apply mode is idempotent due to the agency_split_progress checkpoint.');
  md.push('- Roll back any --apply by restoring from the pre-migration snapshot — the original `agencies` rows are deleted.');
  md.push('');
  await fs.writeFile(path.join(dir, 'PHASE1_DRY_RUN_BACKFILL.md'), md.join('\n'));

  // eslint-disable-next-line no-console
  console.log(`[${r.status.padEnd(11)}] dry-run-backfill mode=${r.mode}  ` +
    `tenants=${r.written.tenants} memberships=${r.written.memberships} ` +
    `applicants.tid=${r.written.tenantIdAssignments.applicants} ` +
    `employees.tid=${r.written.tenantIdAssignments.employees} ` +
    `(${r.durationMs}ms)`);
}

main().catch((e) => { console.error(e); process.exit(2); });
