/**
 * Phase 1 — Tenant backfill verifier.
 *
 * Read-only. Asserts post-backfill invariants. Exits non-zero on any
 * failure so it can be wired into CI / sign-off automation.
 *
 * If run BEFORE the backfill (i.e. tenants table empty), every projected
 * check is reported as `SKIPPED` rather than failed, so the script also
 * functions as a sanity gate before kickoff.
 */
import { runRecon, tableExists, columnExists } from './reconciliation/lib/recon';

interface Check {
  name: string;
  result: 'PASS' | 'FAIL' | 'SKIPPED';
  detail?: any;
}

async function main(): Promise<void> {
  await runRecon('verify-backfill', 'Phase 1 — Tenant Backfill Verifier', async ({ c }) => {
    const checks: Check[] = [];
    const metrics: { key: string; value: any; note?: string }[] = [];

    if (!(await tableExists(c, 'tenants'))) {
      checks.push({ name: 'tenants.table-exists', result: 'FAIL' });
      return { metrics, actions: checks.map(toAction), status: 'BLOCKER', notes: ['tenants table missing — run Phase 0 + 1 prep migrations'] };
    }
    const tCount = (await c.query<{ n: number }>(`SELECT count(*)::int n FROM tenants`)).rows[0].n;
    metrics.push({ key: 'tenants.count', value: tCount });
    if (tCount === 0) {
      // Treat as "before backfill" — return SKIPPED for projection-related checks.
      checks.push({ name: 'tenants.populated', result: 'SKIPPED', detail: 'tenants.count=0 (pre-backfill)' });
      return {
        metrics, actions: checks.map(toAction), status: 'OK',
        notes: ['No tenants row found — verifier ran before backfill. Re-run after `--apply`.'],
      };
    }

    // 1. Every projected tenant exists. We approximate "projected" as
    //    `count(distinct old customer agencies)` from agency_split_progress.
    if (await tableExists(c, 'agency_split_progress')) {
      const expected = (await c.query<{ n: number }>(
        `SELECT count(*)::int n FROM agency_split_progress WHERE status = 'DONE'`,
      )).rows[0].n;
      checks.push({
        name: 'tenants.count-matches-progress',
        result: tCount === expected ? 'PASS' : 'FAIL',
        detail: { tenants: tCount, progressDone: expected },
      });
    } else {
      checks.push({ name: 'tenants.count-matches-progress', result: 'SKIPPED', detail: 'agency_split_progress missing' });
    }

    // 2. Every tenant has its DefaultAgency child.
    const defaultMissing = (await c.query<{ n: number }>(
      `SELECT count(*)::int n FROM tenants t
        WHERE NOT EXISTS (
          SELECT 1 FROM agencies a WHERE a."tenantId" = t.id AND a."isDefault" = true
        )`,
    )).rows[0].n;
    checks.push({
      name: 'tenants.have-default-agency',
      result: defaultMissing === 0 ? 'PASS' : 'FAIL',
      detail: { withoutDefault: defaultMissing },
    });

    // 3. Every eligible user has a tenant membership (or is a platform admin).
    if (await tableExists(c, 'users')) {
      const orphan = (await c.query<{ n: number }>(
        `SELECT count(*)::int n FROM users u
          WHERE u."agencyId" IS NOT NULL
            AND u.id::text NOT IN (SELECT "userId" FROM tenant_memberships)
            AND (u."deletedAt" IS NULL)`,
      )).rows[0].n;
      checks.push({
        name: 'users.with-agency-have-membership',
        result: orphan === 0 ? 'PASS' : 'FAIL',
        detail: { count: orphan },
      });

      const sysOrphan = (await c.query<{ n: number }>(
        `SELECT count(*)::int n FROM users u
          WHERE u."agencyId" IS NULL
            AND u.id::text NOT IN (SELECT "userId" FROM platform_admins)
            AND u.id::text NOT IN (
              SELECT (subject->>'id') FROM saas_reconciliation_queue
                WHERE kind IN ('user.no-agency', 'user.no-agency-after-backfill')
            )`,
      )).rows[0].n;
      checks.push({
        name: 'users.no-agency.handled',
        result: sysOrphan === 0 ? 'PASS' : 'FAIL',
        detail: { count: sysOrphan },
      });
    }

    // 4. Every membership has at least one AgencyMembership.
    const memWithoutAgency = (await c.query<{ n: number }>(
      `SELECT count(*)::int n FROM tenant_memberships m
        WHERE NOT EXISTS (SELECT 1 FROM agency_memberships am WHERE am."membershipId" = m.id)`,
    )).rows[0].n;
    checks.push({
      name: 'memberships.have-agency-membership',
      result: memWithoutAgency === 0 ? 'PASS' : 'FAIL',
      detail: { without: memWithoutAgency },
    });

    // 5. Phase 1 leading models have tenantId populated for every active row.
    for (const t of ['applicants', 'employees', 'vehicles']) {
      if (!(await tableExists(c, t))) {
        checks.push({ name: `${t}.tenantId-populated`, result: 'SKIPPED' });
        continue;
      }
      if (!(await columnExists(c, t, 'tenantId'))) {
        checks.push({ name: `${t}.tenantId-populated`, result: 'SKIPPED', detail: 'column missing' });
        continue;
      }
      // Only count rows that have an agency (i.e. should have been backfilled).
      // Orphan rows with agencyId IS NULL are quarantined and tracked separately.
      const hasAgency = await columnExists(c, t, 'agencyId');
      const hasDeleted = await columnExists(c, t, 'deletedAt');
      const filters = [
        '"tenantId" IS NULL',
        hasAgency  ? '"agencyId" IS NOT NULL' : '',
        hasDeleted ? '"deletedAt" IS NULL'    : '',
      ].filter(Boolean).join(' AND ');
      const stillNull = (await c.query<{ n: number }>(
        `SELECT count(*)::int n FROM "${t}" WHERE ${filters}`,
      )).rows[0].n;
      checks.push({
        name: `${t}.tenantId-populated`,
        result: stillNull === 0 ? 'PASS' : 'FAIL',
        detail: { stillNull },
      });
    }

    // 6. PlatformAdmin candidates created for every system-agency-derived user.
    const paCount = (await c.query<{ n: number }>(`SELECT count(*)::int n FROM platform_admins`)).rows[0].n;
    metrics.push({ key: 'platform_admins.count', value: paCount });
    checks.push({
      name: 'platform_admins.exists',
      result: paCount > 0 ? 'PASS' : 'SKIPPED',
      detail: paCount === 0 ? 'no platform admins (acceptable if there were no system-agency users)' : { count: paCount },
    });

    // 7. No duplicate slugs.
    const slugDupes = (await c.query<{ n: number }>(
      `SELECT count(*)::int n FROM (SELECT slug FROM tenants GROUP BY slug HAVING count(*) > 1) x`,
    )).rows[0].n;
    checks.push({ name: 'tenants.no-duplicate-slug', result: slugDupes === 0 ? 'PASS' : 'FAIL', detail: { dupes: slugDupes } });

    // 8. No duplicate (userId, tenantId) memberships.
    const memDupes = (await c.query<{ n: number }>(
      `SELECT count(*)::int n FROM (
         SELECT "userId", "tenantId" FROM tenant_memberships GROUP BY 1,2 HAVING count(*) > 1
       ) x`,
    )).rows[0].n;
    checks.push({ name: 'memberships.no-duplicate-pair', result: memDupes === 0 ? 'PASS' : 'FAIL', detail: { dupes: memDupes } });

    // 9. No partially-applied checkpoint.
    if (await tableExists(c, 'agency_split_progress')) {
      const partial = (await c.query<{ n: number; samples: any }>(
        `SELECT count(*)::int n, json_agg(distinct status) AS samples
           FROM agency_split_progress WHERE status NOT IN ('DONE','SKIPPED')`,
      )).rows[0];
      checks.push({
        name: 'checkpoint.no-partial',
        result: (partial.n ?? 0) === 0 ? 'PASS' : 'FAIL',
        detail: partial,
      });
    }

    // 10. Quarantine queue size — informational
    if (await tableExists(c, 'saas_reconciliation_queue')) {
      const pending = (await c.query<{ n: number }>(
        `SELECT count(*)::int n FROM saas_reconciliation_queue WHERE decision IS NULL OR decision = 'pending'`,
      )).rows[0].n;
      metrics.push({ key: 'reconciliation_queue.pending', value: pending });
      checks.push({
        name: 'reconciliation.queue-pending',
        result: 'SKIPPED',  // informational only
        detail: { pending },
      });
    }

    const failed = checks.filter((c) => c.result === 'FAIL').length;
    const status = failed === 0 ? 'OK' : 'BLOCKER';
    return {
      metrics, actions: checks.map(toAction), status,
      notes: [
        `Verification ${status === 'OK' ? 'PASSED' : 'FAILED'}: ${checks.filter((c) => c.result === 'PASS').length} pass, ${failed} fail, ${checks.filter((c) => c.result === 'SKIPPED').length} skipped`,
      ],
    };
  });
}

function toAction(c: Check) {
  return {
    kind: c.name,
    subject: c.detail ?? {},
    proposedDecision: c.result,
    applied: false,
  };
}

if (require.main === module) main().catch((e) => { console.error(e); process.exit(2); });
export {};
