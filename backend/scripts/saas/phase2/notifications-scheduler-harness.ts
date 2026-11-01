/**
 * Phase 2.14 — Notifications Scheduler Adapter Harness.
 *
 * Tests the dispatch behaviour of `NotificationsSchedulerService` and
 * the `runAllChecksTenantAware` path on `NotificationsService`.
 *
 * Cases:
 *   1. flags OFF → scheduler picks legacy `runAllChecks`.
 *   2. flags ON in SAFE_CLONE → scheduler picks `runAllChecksTenantAware`.
 *   3. fanout planner emits per-tenant entries (active-only, non-system).
 *   4. each tenant runs inside an ALS frame (verified via spy fn).
 *   5. inactive / system tenants skipped with documented reasons.
 *   6. `notifyUploaderAndRoles` refuses without ALS tenant in tenant-aware mode.
 *   7. `notifyUsersByRoles` refuses without ALS tenant in tenant-aware mode.
 *   8. fanout writers preserve legacy behaviour with flags OFF.
 *   9. flags ON outside staging is refused at the framework boundary.
 *  10. rollback to flags OFF immediately restores legacy path.
 *  11. cron timing constant is unchanged (six-hour interval).
 */
/* eslint-disable no-console */
import {
  abortUnlessStaging, withFlags, writeReport,
  type CaseResult,
} from './lib/harness';
import { PrismaService } from '../../../src/prisma/prisma.service';
import { TenantPrismaService } from '../../../src/saas/prisma/tenant-prisma.service';
import { PilotPrismaAccessor } from '../../../src/saas/prisma/pilot-prisma.accessor';
import { FeatureFlagsService } from '../../../src/saas/feature-flags/feature-flags.service';
import { NotificationsService } from '../../../src/notifications/notifications.service';
import { NotificationsSchedulerService } from '../../../src/notifications/notifications-scheduler.service';
import { TenantJobFanoutPlanner, runForTenant } from '../../../src/saas/jobs';
import { TenantContext, MissingTenantContextError } from '../../../src/saas/context/als';
import { promises as fs } from 'fs';
import path from 'path';

function makeSvc(flags: FeatureFlagsService) {
  const prisma = new PrismaService();
  const tp = new TenantPrismaService(prisma, flags);
  const pilot = new PilotPrismaAccessor(prisma, tp, flags);
  const svc = new NotificationsService(prisma, pilot, flags);
  return { prisma, svc };
}

async function main(): Promise<void> {
  const env = abortUnlessStaging('notifications-scheduler-harness');
  const out: CaseResult[] = [];

  const T1 = '11111111-1111-1111-1111-111111111111';
  const T2 = '22222222-2222-2222-2222-222222222222';
  const T3 = '33333333-3333-3333-3333-333333333333';

  // ── 1+10. Scheduler picks legacy path with flags OFF; rollback ──
  await withFlags({ TENANT_AWARE_JOBS_ENABLED: 'false', TENANT_JOB_FANOUT_ENABLED: 'false' },
    async () => {
      const flags = new FeatureFlagsService();
      const { svc, prisma } = makeSvc(flags);
      try {
        let legacyCalled = false;
        let tenantAwareCalled = false;
        const orig = svc.runAllChecks.bind(svc);
        const origTA = svc.runAllChecksTenantAware.bind(svc);
        (svc as any).runAllChecks = async () => { legacyCalled = true; return orig(); };
        (svc as any).runAllChecksTenantAware = async () => { tenantAwareCalled = true; return origTA(); };
        const sched = new NotificationsSchedulerService(svc, flags);
        await (sched as any).runOnce();
        out.push({
          name: 'flags OFF: scheduler invokes legacy runAllChecks (not tenant-aware)',
          ok: legacyCalled && !tenantAwareCalled,
          detail: `legacy=${legacyCalled} tenantAware=${tenantAwareCalled}`,
        });
      } finally { await prisma.$disconnect(); }
    });

  // ── 2. Scheduler picks tenant-aware path with both flags ON ────
  await withFlags(
    { TENANT_AWARE_JOBS_ENABLED: 'true', TENANT_JOB_FANOUT_ENABLED: 'true' },
    async () => {
      const flags = new FeatureFlagsService();
      const { svc, prisma } = makeSvc(flags);
      try {
        let legacyCalled = false;
        let tenantAwareCalled = false;
        const orig = svc.runAllChecks.bind(svc);
        const origTA = svc.runAllChecksTenantAware.bind(svc);
        (svc as any).runAllChecks = async () => { legacyCalled = true; return orig(); };
        (svc as any).runAllChecksTenantAware = async () => {
          tenantAwareCalled = true;
          return { plannedTenants: 0, executedTenants: 0, failedTenants: 0, skipped: 0 };
        };
        const sched = new NotificationsSchedulerService(svc, flags);
        await (sched as any).runOnce();
        out.push({
          name: 'flags ON in SAFE_CLONE: scheduler invokes runAllChecksTenantAware',
          ok: !legacyCalled && tenantAwareCalled,
          detail: `legacy=${legacyCalled} tenantAware=${tenantAwareCalled}`,
        });
      } finally { await prisma.$disconnect(); }
    });

  // ── 3+5. Fanout planner: ACTIVE non-system selected; others skipped ──
  {
    const planner = new TenantJobFanoutPlanner();
    const plan = planner.plan(
      'notifications.runAllChecks',
      [
        { id: T1, status: 'ACTIVE' },
        { id: T2, status: 'ACTIVE', isSystem: true },
        { id: T3, status: 'INACTIVE' },
      ],
      () => ({}),
    );
    const ids = plan.tenants.map((t) => t.tenantId);
    const reasons = plan.skipped.reduce<Record<string, number>>((acc, s) => {
      acc[s.reason] = (acc[s.reason] ?? 0) + 1; return acc;
    }, {});
    out.push({
      name: 'planner: 1 ACTIVE non-system selected; 1 system + 1 inactive skipped',
      ok: ids.length === 1 && ids[0] === T1
         && reasons['system-tenant'] === 1 && reasons.inactive === 1,
      detail: `selected=${ids.join(',')} skipped=${JSON.stringify(reasons)}`,
    });
  }

  // ── 4. Each tenant runs inside ALS frame (verified via runForTenant) ──
  {
    const seen: Array<{ tenantFromAls: string | null }> = [];
    await runForTenant(T1, async () => {
      seen.push({ tenantFromAls: TenantContext.optional()?.id ?? null });
    }, { allowDormant: true });
    out.push({
      name: 'runForTenant: ALS frame carries tenantId (smoke for fanout-tenant entry)',
      ok: seen.length === 1 && seen[0].tenantFromAls === T1,
      detail: `seen=${JSON.stringify(seen)}`,
    });
  }

  // ── 6. notifyUploaderAndRoles refuses without ALS tenant (tenant-aware) ──
  await withFlags(
    { TENANT_AWARE_JOBS_ENABLED: 'true', TENANT_JOB_FANOUT_ENABLED: 'true' },
    async () => {
      const flags = new FeatureFlagsService();
      const { svc, prisma } = makeSvc(flags);
      try {
        let threw = false;
        let isMissing = false;
        try {
          await svc.notifyUploaderAndRoles('00000000-0000-0000-0000-000000000111',
            ['FleetManager'], 'document.uploaded' as any,
            'title', 'msg');
        } catch (e) {
          threw = true;
          isMissing = e instanceof MissingTenantContextError;
        }
        out.push({
          name: 'tenant-aware ON: notifyUploaderAndRoles without ALS tenant raises MissingTenantContextError',
          ok: threw && isMissing,
          detail: `threw=${threw} isMissing=${isMissing}`,
        });
      } finally { await prisma.$disconnect(); }
    });

  // ── 7. notifyUsersByRoles refuses without ALS tenant (tenant-aware) ──
  await withFlags(
    { TENANT_AWARE_JOBS_ENABLED: 'true', TENANT_JOB_FANOUT_ENABLED: 'true' },
    async () => {
      const flags = new FeatureFlagsService();
      const { svc, prisma } = makeSvc(flags);
      try {
        let threw = false;
        let isMissing = false;
        try {
          await svc.notifyUsersByRoles(
            ['FleetManager'], 'document.uploaded' as any, 'title', 'msg');
        } catch (e) {
          threw = true;
          isMissing = e instanceof MissingTenantContextError;
        }
        out.push({
          name: 'tenant-aware ON: notifyUsersByRoles without ALS tenant raises MissingTenantContextError',
          ok: threw && isMissing,
          detail: `threw=${threw} isMissing=${isMissing}`,
        });
      } finally { await prisma.$disconnect(); }
    });

  // ── 8. Fanout writers preserve legacy behaviour with flags OFF ──
  await withFlags(
    { TENANT_AWARE_JOBS_ENABLED: 'false', TENANT_JOB_FANOUT_ENABLED: 'false' },
    async () => {
      const flags = new FeatureFlagsService();
      const { svc, prisma } = makeSvc(flags);
      try {
        // Legacy: no ALS tenant should NOT raise the new
        // MissingTenantContextError. Other errors (e.g. Prisma errors
        // from the role lookup) are unrelated to Phase 2.14.
        let raisedMissing = false;
        try {
          await svc.notifyUsersByRoles(
            ['NoSuchRoleProbably'], 'document.uploaded' as any,
            'title', 'msg');
        } catch (e) {
          raisedMissing = e instanceof MissingTenantContextError;
        }
        out.push({
          name: 'flags OFF: notifyUsersByRoles does NOT raise the new MissingTenantContextError',
          ok: !raisedMissing,
          detail: `raisedMissing=${raisedMissing} (other errors are unrelated to this case)`,
        });
      } finally { await prisma.$disconnect(); }
    });

  // ── 9. flags ON outside staging refused at the framework boundary ──
  await withFlags(
    { TENANT_AWARE_JOBS_ENABLED: 'true', TENANT_JOB_FANOUT_ENABLED: 'true',
      NODE_ENV: 'production',
      DATABASE_URL: 'postgres://postgres@prod-db.prod.example.com/tempworks_prod' },
    async () => {
      const flags = new FeatureFlagsService();
      const { svc, prisma } = makeSvc(flags);
      try {
        let legacyCalled = false;
        let tenantAwareCalled = false;
        const orig = svc.runAllChecks.bind(svc);
        const origTA = svc.runAllChecksTenantAware.bind(svc);
        (svc as any).runAllChecks = async () => { legacyCalled = true; return orig(); };
        (svc as any).runAllChecksTenantAware = async () => { tenantAwareCalled = true; return origTA(); };
        const sched = new NotificationsSchedulerService(svc, flags);
        await (sched as any).runOnce();
        out.push({
          name: 'flags ON outside staging: scheduler stays on legacy path (env classifier refuses tenant-aware)',
          ok: legacyCalled && !tenantAwareCalled,
          detail: `legacy=${legacyCalled} tenantAware=${tenantAwareCalled}`,
        });
      } finally { await prisma.$disconnect(); }
    });

  // ── 11. Cron timing constant unchanged ─────────────────────────
  {
    const src = await fs.readFile(
      path.resolve(__dirname, '..', '..', '..', 'src', 'notifications', 'notifications-scheduler.service.ts'),
      'utf8',
    );
    const ok = /6\s*\*\s*60\s*\*\s*60\s*\*\s*1000/.test(src);
    out.push({
      name: 'cron timing constant unchanged (6-hour interval)',
      ok,
      detail: `source contains 6 * 60 * 60 * 1000: ${ok}`,
    });
  }

  // ── 12. Phase 2.14.1: per-method tenant narrowing source-level checks
  //
  // These verify that each `check*` method now consults
  // `narrowingTenantId()` and spreads `tenantId: tid` / `agency: { tenantId: tid }`
  // into its where + data when active. Source-level assertions stay
  // light (regex on the file) and are paired with the runtime
  // dispatcher cases above.
  {
    const src = await fs.readFile(
      path.resolve(__dirname, '..', '..', '..', 'src', 'notifications', 'notifications.service.ts'),
      'utf8',
    );
    const checks = [
      'checkExpiringCompliance',
      'checkServiceDue',
      'checkOverdue',
      'checkScheduledMaintenance',
    ];
    for (const m of checks) {
      const body = new RegExp(`async ${m}\\(\\)[\\s\\S]*?narrowingTenantId\\(\\)`).test(src);
      out.push({
        name: `${m}: reads narrowingTenantId() at the top of its body`,
        ok: body,
        detail: `source matches: ${body}`,
      });
    }
    // 16. Each check method spreads `agency: { tenantId: tid }` into
    //     the User scan when tid is set.
    const agencyNarrowed = new RegExp(`agency:\\s*{\\s*tenantId:\\s*tid`).test(src);
    out.push({
      name: 'each check* method narrows User scan by agency.tenantId when tid set',
      ok: agencyNarrowed,
      detail: `agency: { tenantId: tid } appears in source: ${agencyNarrowed}`,
    });
    // 17. notification.create writes carry `tenantId: tid` in tenant-aware mode.
    // Count how many `notification.create` blocks include the tid spread
    // — there are 4 check* methods, each creates one notification, so we
    // expect at least 4 occurrences of `... ? { tenantId: tid }` near
    // notification.create.
    const writeNarrowed = (src.match(/\.\.\.\(tid \? \{ tenantId: tid \} : \{\}\)/g) ?? []).length;
    out.push({
      name: 'notification creates spread tenantId when tid set (≥ 4 sites)',
      ok: writeNarrowed >= 4,
      detail: `tenantId spread occurrences: ${writeNarrowed}`,
    });
    // 18. dedupe findFirst calls scope by tenantId when tid set.
    // The dedupe queries appear inside each check method just before
    // notification.create. We expect at least 4 such sites that include
    // `tenantId: tid` in the where clause.
    const dedupeNarrowed = (src.match(/notification\.findFirst[\s\S]*?\.\.\.\(tid \? \{ tenantId: tid \}/g) ?? []).length;
    out.push({
      name: 'notification dedupe queries scope by tenantId when tid set (≥ 4 sites)',
      ok: dedupeNarrowed >= 4,
      detail: `dedupe-scope occurrences: ${dedupeNarrowed}`,
    });
  }

  // ── 19. Legacy mode: narrowingTenantId() returns null
  await withFlags(
    { TENANT_AWARE_JOBS_ENABLED: 'false', TENANT_JOB_FANOUT_ENABLED: 'false' },
    async () => {
      const flags = new FeatureFlagsService();
      const { svc, prisma } = makeSvc(flags);
      try {
        const tid = (svc as any).narrowingTenantId();
        out.push({
          name: 'legacy mode: narrowingTenantId() returns null (no narrowing)',
          ok: tid === null,
          detail: `tid=${String(tid)}`,
        });
      } finally { await prisma.$disconnect(); }
    });

  // ── 20. Tenant-aware mode + ALS frame: narrowingTenantId() returns the active id
  await withFlags(
    { TENANT_AWARE_JOBS_ENABLED: 'true', TENANT_JOB_FANOUT_ENABLED: 'true' },
    async () => {
      const flags = new FeatureFlagsService();
      const { svc, prisma } = makeSvc(flags);
      try {
        const seen = await runForTenant(T1, () => (svc as any).narrowingTenantId(),
          { allowDormant: true });
        out.push({
          name: 'tenant-aware mode + ALS: narrowingTenantId() returns the active tenantId',
          ok: seen === T1,
          detail: `tid=${seen}`,
        });
      } finally { await prisma.$disconnect(); }
    });

  // ── 21. Tenant-aware mode without ALS: narrowingTenantId() returns null
  await withFlags(
    { TENANT_AWARE_JOBS_ENABLED: 'true', TENANT_JOB_FANOUT_ENABLED: 'true' },
    async () => {
      const flags = new FeatureFlagsService();
      const { svc, prisma } = makeSvc(flags);
      try {
        const tid = (svc as any).narrowingTenantId();
        out.push({
          name: 'tenant-aware mode without ALS frame: narrowingTenantId() returns null (legacy fallback)',
          ok: tid === null,
          detail: `tid=${String(tid)}`,
        });
      } finally { await prisma.$disconnect(); }
    });

  // ── Phase 2.15 fanout-writer narrowing — source-level checks ──────
  {
    const src = await fs.readFile(
      path.resolve(__dirname, '..', '..', '..', 'src', 'notifications', 'notifications.service.ts'),
      'utf8',
    );
    for (const m of ['notifyUploaderAndRoles', 'notifyUsersByRoles']) {
      const reads = new RegExp(`async ${m}\\([\\s\\S]*?narrowingTenantId\\(\\)`).test(src);
      out.push({
        name: `fanout: ${m} reads narrowingTenantId()`,
        ok: reads,
        detail: `source matches: ${reads}`,
      });
      const userScan = new RegExp(
        `async ${m}\\([\\s\\S]*?legacyPrisma\\.user\\.findMany[\\s\\S]*?agency:\\s*{\\s*tenantId:\\s*tid`,
      ).test(src);
      out.push({
        name: `fanout: ${m} narrows User.findMany via agency.tenantId when tid set`,
        ok: userScan,
        detail: `agency narrow present: ${userScan}`,
      });
    }
    const writeNarrowed = (src.match(/legacyPrisma\.notification\.create[\s\S]{1,2000}?\.\.\.\(tid \? \{ tenantId: tid \} : \{\}\)/g) ?? []).length;
    out.push({
      name: 'fanout: notification.create payloads spread tenantId when tid set (≥ 6 sites: 4 check* + 2 writers)',
      ok: writeNarrowed >= 6,
      detail: `tenantId spread occurrences in create blocks: ${writeNarrowed}`,
    });
    const uploaderProbe = /notifyUploaderAndRoles[\s\S]*?legacyPrisma\.user\.findFirst[\s\S]*?agency:\s*{\s*tenantId:\s*tid/.test(src);
    out.push({
      name: 'fanout: notifyUploaderAndRoles validates uploader belongs to tid via findFirst probe',
      ok: uploaderProbe,
      detail: `uploader probe present: ${uploaderProbe}`,
    });
  }

  // ── Phase 2.15 fanout — runtime narrowing checks ──────────────────
  //
  // Tenant A invokes notifyUsersByRoles for "Recruiter" (tenant A's
  // role) and for "HR Manager" (tenant B's role). The first should
  // create rows tagged tenantId=A; the second should create zero rows
  // (HR Managers belong to tenant B; the narrowed scan is empty).
  await withFlags(
    { TENANT_AWARE_JOBS_ENABLED: 'true', TENANT_JOB_FANOUT_ENABLED: 'true' },
    async () => {
      const flags = new FeatureFlagsService();
      const { svc, prisma } = makeSvc(flags);
      try {
        const markerA = 'phase215-fanout-A-' + Math.random().toString(36).slice(2, 8);
        const markerB = 'phase215-fanout-B-' + Math.random().toString(36).slice(2, 8);

        await runForTenant(T1, async () => {
          await svc.notifyUsersByRoles(['Recruiter'],
            'document.uploaded' as any,
            markerA, 'tenant A → recruiters',
            'Document', 'rel-A',
          );
        }, { allowDormant: true });

        await runForTenant(T1, async () => {
          await svc.notifyUsersByRoles(['HR Manager'],
            'document.uploaded' as any,
            markerB, 'tenant A → HR Managers (should be empty)',
            'Document', 'rel-A-hrm',
          );
        }, { allowDormant: true });

        const recruitedRows: Array<{ tenantId: string | null }> =
          await (prisma as any).notification.findMany({
            where: { title: markerA },
            select: { tenantId: true },
          });
        const hrmRows = await (prisma as any).notification.count({
          where: { title: markerB },
        });

        const allTidA = recruitedRows.length > 0
          && recruitedRows.every((r) => r.tenantId === T1);
        out.push({
          name: 'fanout: tenant A → notifyUsersByRoles(Recruiter) writes rows tagged tenantId=A',
          ok: allTidA,
          detail: `count=${recruitedRows.length}; allTidA=${allTidA}; sampleTids=${[...new Set(recruitedRows.map((r) => r.tenantId))].join(',')}`,
        });
        out.push({
          name: 'fanout: tenant A → notifyUsersByRoles(HR Manager) creates 0 rows (HR Managers are in tenant B only)',
          ok: hrmRows === 0,
          detail: `count=${hrmRows}`,
        });

        // Cleanup.
        await (prisma as any).notification.deleteMany({
          where: { OR: [{ title: markerA }, { title: markerB }] },
        });
      } finally { await prisma.$disconnect(); }
    });

  // Runtime legacy: notifyUsersByRoles(HR Manager) without flags
  // should still reach the B-tenant HR Managers — proving the legacy
  // path is unchanged.
  await withFlags(
    { TENANT_AWARE_JOBS_ENABLED: 'false', TENANT_JOB_FANOUT_ENABLED: 'false' },
    async () => {
      const flags = new FeatureFlagsService();
      const { svc, prisma } = makeSvc(flags);
      try {
        const marker = 'phase215-legacy-' + Math.random().toString(36).slice(2, 8);
        await svc.notifyUsersByRoles(['HR Manager'],
          'document.uploaded' as any,
          marker, 'legacy fanout',
          'Document', 'rel-legacy',
        );
        const created = await (prisma as any).notification.count({
          where: { title: marker },
        });
        out.push({
          name: 'fanout legacy: notifyUsersByRoles(HR Manager) reaches B-tenant users (cross-tenant fanout preserved)',
          ok: created > 0,
          detail: `created=${created}`,
        });
        await (prisma as any).notification.deleteMany({ where: { title: marker } });
      } finally { await prisma.$disconnect(); }
    });

  await writeReport({
    title: 'Phase 2.14/2.14.1/2.15 — Notifications Scheduler Harness',
    name: 'notifications-scheduler-harness',
    out,
    environment: env,
  });
}

main().catch((e) => { console.error(e); process.exit(3); });
