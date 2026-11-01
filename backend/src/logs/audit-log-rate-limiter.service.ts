import { HttpException, HttpStatus, Injectable } from '@nestjs/common';

/**
 * Phase 2.59 — In-memory per-tenant rate limiter for the
 * `/admin/tenant-audit/*` HTTP routes. Default-OFF; activates only
 * when `AUDIT_LOG_HTTP_RATE_LIMIT_ENABLED=true` AND
 * `AUDIT_LOG_HTTP_RATE_LIMIT_RPM > 0`.
 *
 * Sliding-window-by-bucket implementation:
 *   - One bucket per `(key)` per `(window)` of N seconds.
 *   - Each bucket holds a counter and the bucket's start timestamp.
 *   - On consume, current bucket counter is incremented; if it
 *     exceeds the configured RPM, the call rejects with 429.
 *   - Buckets older than the window are recycled when their key is
 *     touched again.
 *
 * Tag chain: phase259-audit-log-http-rate-limit,
 * phase259-audit-log-rate-limit-keying,
 * phase259-audit-log-rate-limit-disabled-default.
 */
export interface AuditRateLimitDecision {
  allowed: boolean;
  enabled: boolean;
  key: string;
  limit: number;
  windowSeconds: number;
  retryAfterSeconds: number;
  remaining: number;
}

@Injectable()
export class AuditLogRateLimiter {
  // key → { count, windowStartMs }
  private buckets = new Map<string, { count: number; windowStartMs: number }>();

  /** Read env flags. Pure; called per consume() so harnesses can
   *  mutate flags between calls. */
  private resolveConfig(): { enabled: boolean; limit: number; windowSeconds: number } {
    const enabled = String(process.env.AUDIT_LOG_HTTP_RATE_LIMIT_ENABLED ?? '').toLowerCase() === 'true';
    const rawLimit = Number(process.env.AUDIT_LOG_HTTP_RATE_LIMIT_RPM);
    const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.floor(rawLimit) : 0;
    const rawWindow = Number(process.env.AUDIT_LOG_HTTP_RATE_LIMIT_WINDOW_SECONDS);
    const windowSeconds = Number.isFinite(rawWindow) && rawWindow > 0 ? Math.floor(rawWindow) : 60;
    // The limiter is only ACTIVE when both gates are set; an invalid /
    // zero RPM falls back to disabled (documented).
    return { enabled: enabled && limit > 0, limit, windowSeconds };
  }

  /** Consume one quota unit. Throws HttpException(429) when the
   *  limit is exceeded; returns silently otherwise. */
  consumeOrThrow(key: string): AuditRateLimitDecision {
    const cfg = this.resolveConfig();
    const decision = this.peek(key, cfg);
    if (!cfg.enabled) return decision;
    if (!decision.allowed) {
      // tag: phase259-audit-log-http-rate-limit (HTTP 429 with Retry-After hint)
      throw new HttpException(
        { statusCode: 429, message: 'Too Many Requests', error: 'Too Many Requests' },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    return decision;
  }

  /** Phase 2.60 — non-throwing variant. Returns the decision so the
   *  controller can build a structured 429 envelope and set the
   *  `Retry-After` header before throwing.
   *  Tag: phase260-audit-log-rate-limit-envelope. */
  tryConsume(key: string): AuditRateLimitDecision {
    return this.peek(key, this.resolveConfig());
  }

  /** Pure peek without throwing. Updates internal state when the
   *  limiter is enabled. */
  private peek(
    key: string,
    cfg: { enabled: boolean; limit: number; windowSeconds: number },
  ): AuditRateLimitDecision {
    const baseDecision = (allowed: boolean, retryAfter: number, remaining: number): AuditRateLimitDecision => ({
      allowed, enabled: cfg.enabled, key,
      limit: cfg.limit, windowSeconds: cfg.windowSeconds,
      retryAfterSeconds: retryAfter, remaining,
    });
    if (!cfg.enabled) return baseDecision(true, 0, Number.POSITIVE_INFINITY);
    const now = Date.now();
    const windowMs = cfg.windowSeconds * 1000;
    const existing = this.buckets.get(key);
    if (!existing || now - existing.windowStartMs >= windowMs) {
      // Open a fresh bucket and consume one slot.
      this.buckets.set(key, { count: 1, windowStartMs: now });
      return baseDecision(true, 0, cfg.limit - 1);
    }
    if (existing.count >= cfg.limit) {
      const retryAfter = Math.max(1, Math.ceil((existing.windowStartMs + windowMs - now) / 1000));
      return baseDecision(false, retryAfter, 0);
    }
    existing.count += 1;
    return baseDecision(true, 0, cfg.limit - existing.count);
  }

  /** Test/runbook helper. Not called by runtime code paths. */
  reset(): void {
    this.buckets.clear();
  }

  /** Pure introspection (no state change) — used by harnesses to
   *  check the resolved config. */
  config(): { enabled: boolean; limit: number; windowSeconds: number } {
    return this.resolveConfig();
  }
}
