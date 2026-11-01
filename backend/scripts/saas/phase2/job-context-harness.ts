/**
 * Phase 2.13 — Tenant job context harness.
 *
 * In-process tests of the framework's safety properties:
 *   1. runForTenant attaches ALS context.
 *   2. Concurrent tenant jobs do not bleed context.
 *   3. Batch fanout respects maxTenants limit.
 *   4. Inactive tenants are skipped by the planner.
 *   5. Dry-run plan produces no mutations (planner returns dryRun:true).
 *   6. Invalid tenantId is rejected.
 *   7. Production env with flags on is refused.
 *   8. Retry payload preserves tenantId + idempotencyKey.
 *   9. Idempotency key is stable across two minutes-aligned ticks.
 *  10. assertTenantJobPayload accepts a well-formed payload and
 *      rejects malformed ones.
 *
 * Output: backend/reports/saas/phase2/job-context-harness.{json,md}
 */
/* eslint-disable no-console */
import { abortUnlessStaging, withFlags, writeReport, type CaseResult } from './lib/harness';
import {
  runForTenant,
  runForTenantBatch,
  currentJobTenantId,
  TenantJobFanoutPlanner,
  buildTenantJobPayload,
  buildRetryPayload,
  assertTenantJobPayload,
  makeIdempotencyKey,
  MissingSafeEnvError,
  InvalidTenantIdError,
  TenantJobPayloadError,
} from '../../../src/saas/jobs';
import { FeatureFlagsService } from '../../../src/saas/feature-flags/feature-flags.service';

async function main(): Promise<void> {
  const env = abortUnlessStaging('job-context-harness');
  const out: CaseResult[] = [];

  const T1 = '11111111-1111-1111-1111-111111111111';
  const T2 = '22222222-2222-2222-2222-222222222222';
  const T3 = '33333333-3333-3333-3333-333333333333';
  const T4 = '44444444-4444-4444-4444-444444444444';

  // ── 1. runForTenant attaches ALS context ─────────────────────────
  {
    const seen = await runForTenant(T1, () => currentJobTenantId(),
      { allowDormant: true, label: 'case-1' });
    out.push({
      name: 'runForTenant attaches ALS tenant',
      ok: seen === T1,
      detail: `seen=${seen}`,
    });
  }

  // ── 2. Concurrent tenant jobs do not bleed ──────────────────────
  {
    const seen: Array<{ expected: string; actual: string | null }> = [];
    await Promise.all([
      runForTenant(T1, async () => {
        await new Promise((r) => setTimeout(r, 5));
        seen.push({ expected: T1, actual: currentJobTenantId() });
      }, { allowDormant: true }),
      runForTenant(T2, async () => {
        await new Promise((r) => setTimeout(r, 1));
        seen.push({ expected: T2, actual: currentJobTenantId() });
      }, { allowDormant: true }),
      runForTenant(T3, async () => {
        await new Promise((r) => setTimeout(r, 3));
        seen.push({ expected: T3, actual: currentJobTenantId() });
      }, { allowDormant: true }),
    ]);
    const ok = seen.length === 3 && seen.every((s) => s.expected === s.actual);
    out.push({
      name: 'concurrent runForTenant frames do not bleed',
      ok,
      detail: `seen=${JSON.stringify(seen)}`,
    });
  }

  // ── 3. Batch fanout respects maxTenants ─────────────────────────
  {
    const outcome = await runForTenantBatch(
      [T1, T2, T3, T4],
      async () => 1,
      { allowDormant: true, maxTenants: 2 },
    );
    out.push({
      name: 'runForTenantBatch respects maxTenants',
      ok: outcome.results.length === 2 && outcome.skipped.length === 2
         && outcome.skipped.every((s) => s.reason === 'over-batch-limit'),
      detail: `results=${outcome.results.length} skipped=${outcome.skipped.length}`,
    });
  }

  // ── 4. Planner skips inactive + system tenants ──────────────────
  {
    const planner = new TenantJobFanoutPlanner();
    const plan = planner.plan(
      'notifications.runAllChecks',
      [
        { id: T1, status: 'ACTIVE' },
        { id: T2, status: 'SUSPENDED' },
        { id: T3, status: 'ACTIVE', isSystem: true },
        { id: T4, status: 'INACTIVE' },
      ],
      () => ({}),
    );
    const tenantIds = plan.tenants.map((t) => t.tenantId);
    const skipReasons = plan.skipped.reduce<Record<string, number>>((acc, s) => {
      acc[s.reason] = (acc[s.reason] ?? 0) + 1; return acc;
    }, {});
    out.push({
      name: 'planner: ACTIVE non-system tenants accepted; others skipped with reason',
      ok: tenantIds.length === 1 && tenantIds[0] === T1
         && skipReasons.inactive === 2 && skipReasons['system-tenant'] === 1,
      detail: `accepted=${tenantIds.length} skipReasons=${JSON.stringify(skipReasons)}`,
    });
  }

  // ── 5. Dry-run plan flag set ────────────────────────────────────
  {
    const planner = new TenantJobFanoutPlanner();
    const plan = planner.plan(
      'notifications.runAllChecks',
      [{ id: T1, status: 'ACTIVE' }],
      () => ({ k: 1 }),
      { dryRun: true },
    );
    out.push({
      name: 'planner: dryRun=true preserved on the plan envelope',
      ok: plan.dryRun === true && plan.tenants.length === 1,
      detail: `dryRun=${plan.dryRun} tenants=${plan.tenants.length}`,
    });
  }

  // ── 6. Invalid tenantId rejected ─────────────────────────────────
  {
    let threw = false;
    let isInvalidErr = false;
    try {
      await runForTenant('not-a-uuid', () => 0, { allowDormant: true });
    } catch (e) {
      threw = true;
      isInvalidErr = e instanceof InvalidTenantIdError;
    }
    out.push({
      name: 'runForTenant rejects non-UUID tenantId with InvalidTenantIdError',
      ok: threw && isInvalidErr,
      detail: `threw=${threw} isInvalidErr=${isInvalidErr}`,
    });
  }

  // ── 7. Production env with flags on refused ──────────────────────
  await withFlags(
    { TENANT_AWARE_JOBS_ENABLED: 'true', NODE_ENV: 'production',
      DATABASE_URL: 'postgres://postgres@prod-db.prod.example.com/tempworks_prod' },
    async () => {
      const flags = new FeatureFlagsService();
      let threw = false;
      let isSafeErr = false;
      try {
        await runForTenant(T1, () => 0, { flags });
      } catch (e) {
        threw = true;
        isSafeErr = e instanceof MissingSafeEnvError;
      }
      out.push({
        name: 'runForTenant refuses on UNSAFE_PRODUCTION even with flag on',
        ok: threw && isSafeErr,
        detail: `threw=${threw} isSafeErr=${isSafeErr}`,
      });
    },
  );

  // Also verify the flag-off-default refusal (no allowDormant, no env override).
  await withFlags(
    { TENANT_AWARE_JOBS_ENABLED: undefined },  // unset so default false applies
    async () => {
      const flags = new FeatureFlagsService();
      let threw = false;
      let isSafeErr = false;
      try {
        await runForTenant(T1, () => 0, { flags });
      } catch (e) {
        threw = true;
        isSafeErr = e instanceof MissingSafeEnvError;
      }
      out.push({
        name: 'runForTenant refuses when TENANT_AWARE_JOBS_ENABLED=false (production default)',
        ok: threw && isSafeErr,
        detail: `threw=${threw} isSafeErr=${isSafeErr}`,
      });
    },
  );

  // ── 8. Retry payload preserves tenantId + idempotencyKey ─────────
  {
    const original = buildTenantJobPayload({
      tenantId: T1,
      sourceJobName: 'notifications.runAllChecks',
      body: { check: 'expiring-compliance' },
      maxAttempts: 3,
    });
    const retried = buildRetryPayload(original);
    out.push({
      name: 'buildRetryPayload preserves tenantId + idempotencyKey, increments attempt',
      ok: retried.tenantId === original.tenantId
         && retried.idempotencyKey === original.idempotencyKey
         && retried.retry.attempt === original.retry.attempt + 1
         && retried.retry.maxAttempts === original.retry.maxAttempts,
      detail: `attempt: ${original.retry.attempt}→${retried.retry.attempt}; key match: ${retried.idempotencyKey === original.idempotencyKey}`,
    });
  }

  // ── 9. Idempotency key stable within minute bucket ──────────────
  {
    const a = makeIdempotencyKey({
      sourceJobName: 'X', tenantId: T1,
      scheduledAt: new Date('2026-05-09T17:00:14.000Z'),
      body: { foo: 1, bar: 2 },
    });
    const b = makeIdempotencyKey({
      sourceJobName: 'X', tenantId: T1,
      scheduledAt: new Date('2026-05-09T17:00:58.000Z'),
      body: { bar: 2, foo: 1 }, // body-key order shouldn't matter
    });
    const c = makeIdempotencyKey({
      sourceJobName: 'X', tenantId: T1,
      scheduledAt: new Date('2026-05-09T17:01:14.000Z'),
      body: { foo: 1, bar: 2 },
    });
    out.push({
      name: 'idempotency key stable within minute bucket; differs across buckets',
      ok: a === b && a !== c,
      detail: `a=${a.slice(-12)} b=${b.slice(-12)} c=${c.slice(-12)}`,
    });
  }

  // ── 10. assertTenantJobPayload accept + reject ──────────────────
  {
    const good = buildTenantJobPayload({
      tenantId: T1, sourceJobName: 'X', body: {}, maxAttempts: 1,
    });
    let acceptOk = false;
    try { assertTenantJobPayload(good); acceptOk = true; } catch { /* unexpected */ }

    let rejectOk = false;
    try {
      assertTenantJobPayload({ ...good, tenantId: 'bad' });
    } catch (e) {
      rejectOk = e instanceof TenantJobPayloadError && (e as TenantJobPayloadError).field === 'tenantId';
    }
    out.push({
      name: 'assertTenantJobPayload: accepts well-formed; rejects bad tenantId',
      ok: acceptOk && rejectOk,
      detail: `accept=${acceptOk} reject=${rejectOk}`,
    });
  }

  await writeReport({
    title: 'Phase 2.13 — Tenant Job Context Harness',
    name: 'job-context-harness',
    out,
    environment: env,
  });
}

main().catch((e) => { console.error(e); process.exit(3); });
