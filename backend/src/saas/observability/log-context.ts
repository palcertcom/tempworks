import { currentRequestContext } from '../context/als';

/**
 * Structured log-context provider.
 *
 * Read by the Pino mixin (Phase 5) to stamp every log line with:
 *   { requestId, tenantId?, userId? }
 *
 * Phase 0: a function that returns an object — caller uses or ignores.
 * No active integration with the existing `Logger` yet.
 */
export interface LogContext {
  requestId?: string;
  tenantId?: string;
  userId?: string;
  /** True when the actor is operating via the platform-admin bypass. */
  platformAdmin?: boolean;
}

export function getLogContext(): LogContext {
  const ctx = currentRequestContext();
  if (!ctx) return {};
  return {
    requestId:     ctx.requestId,
    tenantId:      ctx.tenant?.id,
    userId:        ctx.user?.id,
    platformAdmin: ctx.user?.platformAdmin ?? false,
  };
}

/**
 * Audit-event base type.
 *
 * Phase 0: type only, no writer. Phase 3 ships an `@Audit('module.action')`
 * interceptor that builds these and writes to `audit_logs`.
 */
export interface AuditEventBase {
  /** Module-prefixed action key, e.g. 'candidates.delete'. */
  action: string;
  /** Target entity reference. */
  target?: { type: string; id: string };
  /** Free-form metadata (must NOT contain raw PII). */
  meta?: Record<string, unknown>;
  /** When the event occurred. */
  occurredAt: string; // ISO 8601
}
