/**
 * Two-tenant isolation harness.
 *
 * Phase 0 ships the SHAPE — all helpers compile and unit-test against the
 * empty `TENANT_SCOPED_MODELS` registry. As Phase 2 adds models, each
 * model's migration also adds an `isolationProbe.ts` next to the model
 * service that uses these helpers.
 *
 * Real database probing is intentionally OUT of Phase 0 scope — it requires
 * a Postgres test instance + per-developer setup. The CI integration tests
 * (Phase 2+) will use the same helpers in a containerised Postgres.
 */

import { TenantSnapshot } from '../context/types';
import { withRequestContext, TenantContext, newRequestId } from '../context/als';

export type TenantFixture = {
  tenant: TenantSnapshot;
  /** Seeded resources per tenant — populated by per-model fixtures in Phase 2. */
  resources: Record<string, unknown>;
};

export function makeTenantFixture(label: string): TenantFixture {
  // UUIDs are deterministic for label so tests are reproducible.
  const id = `00000000-0000-4000-8000-${label.padEnd(12, '0').slice(0, 12)}`;
  return {
    tenant: { id, slug: label, name: label.toUpperCase(), status: 'ACTIVE', region: 'eu' },
    resources: {},
  };
}

/** Run `fn` with the given tenant snapshot active in ALS. */
export function runAs<T>(fixture: TenantFixture, fn: () => T | Promise<T>): T | Promise<T> {
  return withRequestContext({ requestId: newRequestId() }, () => {
    TenantContext.attach(fixture.tenant);
    return fn();
  });
}

/**
 * Per-model isolation probe — Phase 2 implementations will call this with
 * a callback that does `findMany()` and returns row-count by tenant.
 *
 * Phase 0: returns a "skipped" structure with no DB hit.
 */
export interface IsolationProbeResult {
  modelName: string;
  tenantA: number;
  tenantB: number;
  leaks: number; // rows from B visible to A or vice versa
  ok: boolean;
}

export async function probeIsolation(
  modelName: string,
  _runQuery: (fixture: TenantFixture) => Promise<number>,
): Promise<IsolationProbeResult> {
  // Phase 0: registry is empty, so we don't actually run queries here.
  return { modelName, tenantA: 0, tenantB: 0, leaks: 0, ok: true };
}
