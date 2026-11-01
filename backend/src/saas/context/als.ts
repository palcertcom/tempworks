import { AsyncLocalStorage } from 'node:async_hooks';
import { RequestContext, TenantSnapshot, UserSnapshot } from './types';

/**
 * Singleton ALS for the SaaS request/job context.
 *
 * Validated by SPIKE-002: propagates correctly across `await`, Promise.all,
 * EventEmitter, async iterators, error paths, detached timers. Worker
 * threads do NOT propagate — see TenantAwareJobProcessor for the
 * re-entry pattern.
 */
export const tenantALS = new AsyncLocalStorage<RequestContext>();

export class MissingTenantContextError extends Error {
  constructor(operation = 'unknown') {
    super(`No tenant context in scope for operation '${operation}'.`);
    this.name = 'MissingTenantContextError';
  }
}

/** Run `fn` inside a fresh request context. */
export function withRequestContext<T>(
  ctx: RequestContext,
  fn: () => T | Promise<T>,
): T | Promise<T> {
  return tenantALS.run(ctx, fn);
}

/** Read-only access to the active request context (or undefined). */
export function currentRequestContext(): RequestContext | undefined {
  return tenantALS.getStore();
}

export const TenantContext = {
  /** Throws if there is no tenant in scope. Use in code that requires one. */
  current(operation = 'tenant-required'): TenantSnapshot {
    const t = tenantALS.getStore()?.tenant;
    if (!t) throw new MissingTenantContextError(operation);
    return t;
  },
  /** Returns null when no tenant is in scope. */
  optional(): TenantSnapshot | null {
    return tenantALS.getStore()?.tenant ?? null;
  },
  /** Mutate the active context's tenant (used by middleware after resolve). */
  attach(t: TenantSnapshot): void {
    const s = tenantALS.getStore();
    if (!s) throw new MissingTenantContextError('attach-tenant');
    (s as { tenant?: TenantSnapshot }).tenant = t;
  },
};

export const UserContext = {
  current(): UserSnapshot {
    const u = tenantALS.getStore()?.user;
    if (!u) throw new MissingTenantContextError('user-required');
    return u;
  },
  optional(): UserSnapshot | null {
    return tenantALS.getStore()?.user ?? null;
  },
  attach(u: UserSnapshot): void {
    const s = tenantALS.getStore();
    if (!s) throw new MissingTenantContextError('attach-user');
    (s as { user?: UserSnapshot }).user = u;
  },
};

/** Generate a stable request id without external deps. */
export function newRequestId(): string {
  // Not crypto-strong; only used as a log correlator.
  return (
    Date.now().toString(36) +
    '-' +
    Math.random().toString(36).slice(2, 10)
  );
}
