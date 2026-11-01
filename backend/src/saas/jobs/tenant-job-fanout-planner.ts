/**
 * Phase 2.13 — Tenant job fanout planner.
 *
 * Given a list of candidate tenants, produces a deterministic plan
 * that the queue runner executes later. The planner:
 *
 *   - filters by status (active-only by default)
 *   - excludes platform/system tenants (a small allow-list)
 *   - applies a `maxTenants` cap and reports the rest as skipped
 *   - runs in dry-run mode for staging rehearsal
 *   - computes idempotency keys for each scheduled execution
 *
 * The planner DOES NOT execute business logic. It returns an
 * `ExecutionPlan` that another caller (cron orchestrator, queue
 * enqueuer, manual operator) decides how to consume.
 */
import { TenantJobPayload, makeIdempotencyKey } from './tenant-job.payload';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface CandidateTenant {
  readonly id: string;
  readonly slug?: string;
  readonly status: 'ACTIVE' | 'SUSPENDED' | 'INACTIVE';
  /** Optional tag; tenants with this label are treated as platform /
   *  system tenants and are skipped by default. */
  readonly isSystem?: boolean;
}

export interface FanoutOptions {
  /** When true (default), only ACTIVE tenants are scheduled. */
  readonly activeOnly?: boolean;
  /** When true (default), platform/system tenants are excluded. */
  readonly excludeSystem?: boolean;
  /** Hard cap on tenants per run. Excess tenants are reported as
   *  skipped with reason `over-max`. */
  readonly maxTenants?: number;
  /** When true, the plan is computed without writing anything. The
   *  consumer (queue runner) is expected to log the plan and exit. */
  readonly dryRun?: boolean;
  /**
   * The scheduled wall-clock for this fanout. Used to compute the
   * idempotency key buckets so two cron ticks that fire within the
   * same minute generate the same set of keys (= safe dedupe). */
  readonly scheduledAt?: Date;
  /** Optional explicit tenant allow-list (bypasses status / system
   *  exclusion). Used by the operator runbook for one-off backfills. */
  readonly explicitTenantIds?: ReadonlyArray<string>;
}

export interface PlannedExecution<TBody = Record<string, unknown>> {
  readonly tenantId: string;
  readonly idempotencyKey: string;
  readonly sourceJobName: string;
  readonly scheduledAt: string;
  readonly body: TBody;
}

export interface SkippedTenant {
  readonly tenantId: string;
  /**
   * - `'inactive'`         — status filter
   * - `'system-tenant'`    — system / platform allow-list
   * - `'over-max'`         — `maxTenants` exceeded
   * - `'invalid-tenant-id'`— malformed UUID
   * - `'duplicate-id'`     — same tenant id appeared twice
   */
  readonly reason: 'inactive' | 'system-tenant' | 'over-max' | 'invalid-tenant-id' | 'duplicate-id';
  readonly detail?: string;
}

export interface ExecutionPlan<TBody = Record<string, unknown>> {
  readonly sourceJobName: string;
  readonly dryRun: boolean;
  readonly scheduledAt: string;
  readonly tenants: PlannedExecution<TBody>[];
  readonly skipped: SkippedTenant[];
}

export class TenantJobFanoutPlanner {
  /**
   * Build an execution plan.
   *
   * `bodyFor(tenantId)` may return any JSON-serializable object — the
   * planner stays opaque to the body shape. It's invoked once per
   * accepted tenant to compute the per-tenant payload body.
   */
  plan<TBody extends Record<string, unknown> = Record<string, unknown>>(
    sourceJobName: string,
    candidates: ReadonlyArray<CandidateTenant>,
    bodyFor: (tenantId: string) => TBody,
    opts: FanoutOptions = {},
  ): ExecutionPlan<TBody> {
    const activeOnly  = opts.activeOnly  ?? true;
    const excludeSys  = opts.excludeSystem ?? true;
    const maxTenants  = opts.maxTenants ?? Number.POSITIVE_INFINITY;
    const scheduledAt = opts.scheduledAt ?? new Date();
    const explicit    = new Set((opts.explicitTenantIds ?? []).filter((id) => UUID_RE.test(id)));

    const tenants: PlannedExecution<TBody>[] = [];
    const skipped: SkippedTenant[] = [];
    const seen = new Set<string>();

    for (const c of candidates) {
      if (typeof c.id !== 'string' || !UUID_RE.test(c.id)) {
        skipped.push({ tenantId: String(c.id), reason: 'invalid-tenant-id' });
        continue;
      }
      if (seen.has(c.id)) {
        skipped.push({ tenantId: c.id, reason: 'duplicate-id' });
        continue;
      }
      seen.add(c.id);

      // Explicit allow-list bypasses status / system filters.
      if (!explicit.has(c.id)) {
        if (activeOnly && c.status !== 'ACTIVE') {
          skipped.push({ tenantId: c.id, reason: 'inactive', detail: `status=${c.status}` });
          continue;
        }
        if (excludeSys && c.isSystem === true) {
          skipped.push({ tenantId: c.id, reason: 'system-tenant' });
          continue;
        }
      }

      if (tenants.length >= maxTenants) {
        skipped.push({ tenantId: c.id, reason: 'over-max', detail: `maxTenants=${maxTenants}` });
        continue;
      }

      const body = bodyFor(c.id);
      tenants.push({
        tenantId: c.id,
        idempotencyKey: makeIdempotencyKey({
          sourceJobName, tenantId: c.id, scheduledAt, body,
        }),
        sourceJobName,
        scheduledAt: scheduledAt.toISOString(),
        body,
      });
    }

    return {
      sourceJobName,
      dryRun: !!opts.dryRun,
      scheduledAt: scheduledAt.toISOString(),
      tenants,
      skipped,
    };
  }

  /** Convenience: turn an `ExecutionPlan` into full job payloads. The
   *  consumer typically calls this just before enqueueing. */
  toPayloads<TBody extends Record<string, unknown> = Record<string, unknown>>(
    plan: ExecutionPlan<TBody>,
    opts: { actorLabel?: string; maxAttempts?: number } = {},
  ): TenantJobPayload<TBody>[] {
    return plan.tenants.map((p) => ({
      tenantId: p.tenantId,
      actor: { kind: 'system', label: opts.actorLabel ?? `cron:${plan.sourceJobName}` },
      idempotencyKey: p.idempotencyKey,
      sourceJobName: p.sourceJobName,
      scheduledAt: p.scheduledAt,
      retry: { attempt: 0, maxAttempts: opts.maxAttempts ?? 3, backoff: 'exponential' },
      body: p.body,
    }));
  }
}
