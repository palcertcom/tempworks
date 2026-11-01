/**
 * Phase 2.13 — Tenant-aware job context.
 *
 * The job-equivalent of an HTTP request's tenant middleware. Cron
 * ticks, queue runners, and any other no-request entry point need a
 * way to enter an ALS frame carrying a single tenant before they
 * execute domain code. `runForTenant` is that entry point.
 *
 * Behaviour matrix:
 *
 *   TENANT_AWARE_JOBS_ENABLED=false (production default)
 *     `runForTenant` THROWS unless explicitly opted in via
 *     `{ allowDormant: true }`. In production the framework refuses
 *     to engage so existing schedulers keep their pre-pilot semantics.
 *
 *   TENANT_AWARE_JOBS_ENABLED=true + SAFE_CLONE/SAFE_STAGING
 *     `runForTenant(tenantId, fn)` runs `fn` inside a fresh
 *     `withRequestContext` frame with `TenantContext.attach(...)`. ALS
 *     isolation is enforced by node's `AsyncLocalStorage`; the
 *     framework adds the `runForTenant -> withRequestContext` adapter.
 *
 *   TENANT_AWARE_JOBS_ENABLED=true + UNSAFE_PRODUCTION
 *     The framework REFUSES to run (exits with `MissingSafeEnvError`).
 *     This protects against an accidental flag flip in production.
 *
 * Test-only opt-in: `runForTenant(..., { allowDormant: true })` is
 * accepted regardless of flag. Used by the in-process harness so it
 * can verify ALS attachment without any flag flipping.
 */
import {
  withRequestContext,
  newRequestId,
  TenantContext,
  currentRequestContext,
  MissingTenantContextError,
} from '../context/als';
import {
  classifyRuntimeEnv,
  isStagingClassification,
} from '../tenancy/env-safety';
import { FeatureFlagsService } from '../feature-flags/feature-flags.service';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class MissingSafeEnvError extends Error {
  constructor(reason: string) {
    super(`tenant-aware jobs refused: ${reason}`);
    this.name = 'MissingSafeEnvError';
  }
}

export class InvalidTenantIdError extends Error {
  constructor(input: string) {
    super(`tenant-aware jobs: tenantId is not a UUID (got: ${input})`);
    this.name = 'InvalidTenantIdError';
  }
}

export interface RunForTenantOptions {
  /** Test-only: bypass the `TENANT_AWARE_JOBS_ENABLED` gate. Never use
   *  in production code. The harness uses it to exercise the ALS
   *  attach behaviour without flipping any flag. */
  readonly allowDormant?: boolean;
  /** Optional flag service. When omitted the framework constructs a
   *  fresh `FeatureFlagsService` (which reads `process.env`). */
  readonly flags?: FeatureFlagsService;
  /** Optional pre-set request id (for log correlation). */
  readonly requestId?: string;
  /** Optional human label for diagnostics. */
  readonly label?: string;
}

export interface JobResult<T = unknown> {
  readonly tenantId: string;
  readonly ok: boolean;
  readonly value?: T;
  readonly error?: { name: string; message: string };
  readonly durationMs: number;
}

function gateOrThrow(opts: RunForTenantOptions): void {
  if (opts.allowDormant) return;
  const flags = opts.flags ?? new FeatureFlagsService();
  if (!flags.tenantAwareJobsEnabled()) {
    throw new MissingSafeEnvError(
      'TENANT_AWARE_JOBS_ENABLED=false (default) — set the flag in SAFE_CLONE/SAFE_STAGING to enable',
    );
  }
  const env = classifyRuntimeEnv();
  if (!isStagingClassification(env.classification)) {
    throw new MissingSafeEnvError(
      `env=${env.classification} (${env.reason}) is not SAFE_CLONE/SAFE_STAGING`,
    );
  }
}

/**
 * Execute `fn` inside a tenant-attached ALS frame for `tenantId`.
 * Returns whatever `fn` returns. Throws on:
 *   - invalid `tenantId` (not a UUID)
 *   - flag off + env unsafe (unless `allowDormant: true`)
 *   - errors thrown by `fn` (no swallowing)
 *
 * `fn` may be sync or async.
 */
export async function runForTenant<T>(
  tenantId: string,
  fn: () => T | Promise<T>,
  opts: RunForTenantOptions = {},
): Promise<T> {
  if (typeof tenantId !== 'string' || !UUID_RE.test(tenantId)) {
    throw new InvalidTenantIdError(String(tenantId));
  }
  gateOrThrow(opts);

  const requestId = opts.requestId ?? newRequestId();
  return await withRequestContext({ requestId }, async () => {
    // Snapshot fields are minimal in the job context; status / region /
    // slug / name come from the resolver in HTTP land but are not yet
    // hot-pathed in jobs. Domain code that needs them can fetch them
    // via a tenant lookup on the injected PrismaService.
    TenantContext.attach({
      id: tenantId,
      slug: '',
      name: '',
      status: 'ACTIVE',
      region: '',
    });
    return await fn();
  }) as Promise<T>;
}

export interface BatchOptions extends RunForTenantOptions {
  /** Maximum tenants to process in this batch. Excess tenants are
   *  reported as `skipped` with reason `'over-batch-limit'`. */
  readonly maxTenants?: number;
  /**
   * Per-tenant timeout in milliseconds. When a tenant's `fn` exceeds
   * this, the result is recorded with `ok=false` and an error of
   * `name: 'TimeoutError'` — but the harness does NOT abort the
   * other tenants. Default: no timeout.
   */
  readonly perTenantTimeoutMs?: number;
  /**
   * Concurrency limit. Default 1 (sequential). The framework runs at
   * most this many `runForTenant(...)` invocations concurrently. ALS
   * isolation guarantees per-tenant frames stay separate even at
   * concurrency > 1.
   */
  readonly concurrency?: number;
}

export interface BatchOutcome<T = unknown> {
  readonly results: JobResult<T>[];
  readonly skipped: { tenantId: string; reason: string }[];
}

/**
 * Run `fn` once per tenant, in parallel up to `concurrency`.
 *
 * Failures of one tenant's run do NOT abort the others. The
 * framework records each tenant's outcome and returns the full set.
 */
export async function runForTenantBatch<T>(
  tenantIds: ReadonlyArray<string>,
  fn: (tenantId: string) => T | Promise<T>,
  opts: BatchOptions = {},
): Promise<BatchOutcome<T>> {
  // We intentionally gate ONCE here, then let `runForTenant` skip its
  // own gate (since we've already proven the env is safe).
  gateOrThrow(opts);
  const downstreamOpts: RunForTenantOptions = { ...opts, allowDormant: true };

  const max = opts.maxTenants ?? Number.POSITIVE_INFINITY;
  const concurrency = Math.max(1, opts.concurrency ?? 1);

  const accepted = tenantIds.slice(0, max);
  const skipped = tenantIds.slice(max).map((id) => ({
    tenantId: id,
    reason: 'over-batch-limit',
  }));

  const results: JobResult<T>[] = [];
  // Simple bounded-parallelism worker pool.
  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, accepted.length) }, async () => {
      while (true) {
        const i = cursor++;
        if (i >= accepted.length) return;
        const tid = accepted[i];
        const start = Date.now();
        try {
          const value = await maybeWithTimeout(
            () => runForTenant(tid, () => fn(tid), downstreamOpts),
            opts.perTenantTimeoutMs,
          );
          results.push({ tenantId: tid, ok: true, value, durationMs: Date.now() - start });
        } catch (e) {
          const err = e as Error;
          results.push({
            tenantId: tid, ok: false,
            error: { name: err.name, message: err.message },
            durationMs: Date.now() - start,
          });
        }
      }
    }),
  );
  // Order by tenant input order so consumers can join with a tenants[] list.
  results.sort((a, b) => accepted.indexOf(a.tenantId) - accepted.indexOf(b.tenantId));
  return { results, skipped };
}

async function maybeWithTimeout<T>(
  fn: () => Promise<T>,
  timeoutMs: number | undefined,
): Promise<T> {
  if (!timeoutMs || timeoutMs <= 0) return fn();
  return await Promise.race<T>([
    fn(),
    new Promise<T>((_, reject) =>
      setTimeout(() => {
        const err = new Error(`per-tenant timeout: ${timeoutMs}ms`);
        err.name = 'TimeoutError';
        reject(err);
      }, timeoutMs),
    ),
  ]);
}

/**
 * Diagnostic accessor: returns the active tenant id from ALS, or null
 * when no tenant is attached. Equivalent to
 * `TenantContext.optional()?.id ?? null`. Provided here so business
 * code in jobs has a stable import.
 */
export function currentJobTenantId(): string | null {
  const t = TenantContext.optional();
  return t?.id ?? null;
}

/** Throw `MissingTenantContextError` if no tenant is in scope. */
export function requireJobTenantId(operation = 'job'): string {
  const t = currentJobTenantId();
  if (!t) throw new MissingTenantContextError(operation);
  return t;
}

/** Return whether an ALS frame is in scope right now. */
export function inJobContext(): boolean {
  return currentRequestContext() !== undefined;
}
