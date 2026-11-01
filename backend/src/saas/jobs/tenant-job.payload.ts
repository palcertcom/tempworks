/**
 * Phase 2.13 — Tenant job payload contracts.
 *
 * Every queued job that runs inside a tenant context MUST carry this
 * envelope. The contract is intentionally tiny — the framework
 * doesn't impose any business shape; it only guarantees the
 * tenant-routing fields are present and well-formed.
 *
 * Defining this here (as opposed to inside each future queue
 * processor) is the same pattern Phase 2.4 used for `StructuredJoinOn`:
 * structure beats free-form strings when tenant safety depends on it.
 */

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Stable identity used to detect duplicate work across retries / cron
 * ticks. The framework does NOT enforce uniqueness — it only validates
 * the shape and exposes a helper to compute one.
 */
export type IdempotencyKey = string;

export interface TenantJobActor {
  /** Either 'system' (cron / fanout) or 'user'. */
  readonly kind: 'system' | 'user';
  /** Present only when kind === 'user'. */
  readonly userId?: string;
  /** Free-form label for the system actor (e.g. 'cron:notifications-checks'). */
  readonly label: string;
}

export interface TenantJobRetryMeta {
  /** Zero on the first attempt; incremented by the queue runner. */
  readonly attempt: number;
  /** Maximum attempts the queue should make (0 = no retry). */
  readonly maxAttempts: number;
  /** Backoff strategy hint for the queue. The framework records but does
   *  not enforce — your queue runner picks one. */
  readonly backoff?: 'fixed' | 'exponential' | 'none';
}

export interface TenantJobPayload<TBody = Record<string, unknown>> {
  /** Tenant the job runs against. UUID, validated. */
  readonly tenantId: string;
  /** What/who scheduled the job. */
  readonly actor: TenantJobActor;
  /** Stable across retries; the queue runner uses this to dedupe. */
  readonly idempotencyKey: IdempotencyKey;
  /** Originating job name (e.g. 'notifications.runAllChecks'). */
  readonly sourceJobName: string;
  /** ISO8601 timestamp of when the job was enqueued. */
  readonly scheduledAt: string;
  /** Retry telemetry. */
  readonly retry: TenantJobRetryMeta;
  /** Domain-specific payload body. Opaque to the framework. */
  readonly body: TBody;
}

export class TenantJobPayloadError extends Error {
  constructor(public readonly field: string, message: string) {
    super(`tenant-job-payload: ${field}: ${message}`);
    this.name = 'TenantJobPayloadError';
  }
}

/**
 * Validate a payload at the queue boundary. Throws
 * `TenantJobPayloadError` on the FIRST violation; never logs or
 * mutates. Cheap: O(small fixed work).
 */
export function assertTenantJobPayload<T = Record<string, unknown>>(
  raw: unknown,
): asserts raw is TenantJobPayload<T> {
  if (raw === null || typeof raw !== 'object') {
    throw new TenantJobPayloadError('root', 'payload must be an object');
  }
  const p = raw as Record<string, unknown>;

  if (typeof p.tenantId !== 'string' || !UUID_RE.test(p.tenantId)) {
    throw new TenantJobPayloadError('tenantId', 'must be a UUID');
  }

  if (typeof p.actor !== 'object' || p.actor === null) {
    throw new TenantJobPayloadError('actor', 'must be an object');
  }
  const actor = p.actor as Record<string, unknown>;
  if (actor.kind !== 'system' && actor.kind !== 'user') {
    throw new TenantJobPayloadError('actor.kind', 'must be "system" or "user"');
  }
  if (typeof actor.label !== 'string' || actor.label.length === 0) {
    throw new TenantJobPayloadError('actor.label', 'must be a non-empty string');
  }
  if (actor.kind === 'user') {
    if (typeof actor.userId !== 'string' || !UUID_RE.test(actor.userId)) {
      throw new TenantJobPayloadError('actor.userId', 'must be a UUID for user actors');
    }
  }

  if (typeof p.idempotencyKey !== 'string' || p.idempotencyKey.length < 4) {
    throw new TenantJobPayloadError('idempotencyKey', 'must be a non-empty string');
  }
  if (typeof p.sourceJobName !== 'string' || p.sourceJobName.length === 0) {
    throw new TenantJobPayloadError('sourceJobName', 'must be non-empty');
  }
  if (typeof p.scheduledAt !== 'string' || Number.isNaN(Date.parse(p.scheduledAt))) {
    throw new TenantJobPayloadError('scheduledAt', 'must be ISO8601');
  }

  if (typeof p.retry !== 'object' || p.retry === null) {
    throw new TenantJobPayloadError('retry', 'must be an object');
  }
  const retry = p.retry as Record<string, unknown>;
  if (typeof retry.attempt !== 'number' || retry.attempt < 0) {
    throw new TenantJobPayloadError('retry.attempt', 'must be >= 0');
  }
  if (typeof retry.maxAttempts !== 'number' || retry.maxAttempts < 0) {
    throw new TenantJobPayloadError('retry.maxAttempts', 'must be >= 0');
  }

  if (p.body === undefined || p.body === null) {
    throw new TenantJobPayloadError('body', 'must be present (use {} for empty)');
  }
}

/**
 * Compose a stable idempotency key from `(sourceJobName, tenantId,
 * scheduledAt-bucket, body-fingerprint)`. The bucket truncates to the
 * minute so two cron ticks that fire within the same minute agree on
 * the same key — letting the queue dedupe naturally.
 *
 * Body fingerprint is a deterministic JSON stringify (sorted keys).
 * The framework does NOT include random/time-of-day fields.
 */
export function makeIdempotencyKey(args: {
  sourceJobName: string;
  tenantId: string;
  scheduledAt: Date | string;
  body?: Record<string, unknown>;
}): IdempotencyKey {
  const dt = typeof args.scheduledAt === 'string'
    ? new Date(args.scheduledAt)
    : args.scheduledAt;
  const minuteBucket = new Date(dt);
  minuteBucket.setSeconds(0, 0);
  const ts = minuteBucket.toISOString();
  const fp = stableStringify(args.body ?? {});
  // Cheap djb2-style hash — enough to keep the key short. The framework
  // only needs uniqueness within `(sourceJobName, tenantId, ts)`; the
  // body fingerprint is a tie-breaker for jobs that legitimately enqueue
  // different bodies in the same minute.
  let h = 5381;
  for (let i = 0; i < fp.length; i++) h = ((h << 5) + h + fp.charCodeAt(i)) | 0;
  const hash = (h >>> 0).toString(36);
  return `${args.sourceJobName}|${args.tenantId}|${ts}|${hash}`;
}

function stableStringify(o: unknown): string {
  if (o === null || typeof o !== 'object') return JSON.stringify(o);
  if (Array.isArray(o)) return '[' + o.map(stableStringify).join(',') + ']';
  const keys = Object.keys(o as object).sort();
  return '{' + keys.map((k) =>
    JSON.stringify(k) + ':' + stableStringify((o as Record<string, unknown>)[k])).join(',') + '}';
}

/**
 * Construct a payload from minimal arguments — useful in tests and
 * when a producer doesn't yet have a queue runner attached.
 */
export function buildTenantJobPayload<T extends Record<string, unknown>>(args: {
  tenantId: string;
  sourceJobName: string;
  body?: T;
  actor?: Partial<TenantJobActor>;
  scheduledAt?: Date;
  maxAttempts?: number;
  backoff?: TenantJobRetryMeta['backoff'];
}): TenantJobPayload<T> {
  const scheduledAt = args.scheduledAt ?? new Date();
  const actor: TenantJobActor = {
    kind: args.actor?.kind ?? 'system',
    userId: args.actor?.userId,
    label: args.actor?.label ?? 'system:default',
  };
  const body = (args.body ?? {} as T);
  const payload: TenantJobPayload<T> = {
    tenantId: args.tenantId,
    actor,
    idempotencyKey: makeIdempotencyKey({
      sourceJobName: args.sourceJobName,
      tenantId: args.tenantId,
      scheduledAt,
      body,
    }),
    sourceJobName: args.sourceJobName,
    scheduledAt: scheduledAt.toISOString(),
    retry: {
      attempt: 0,
      maxAttempts: args.maxAttempts ?? 3,
      backoff: args.backoff ?? 'exponential',
    },
    body,
  };
  assertTenantJobPayload<T>(payload);
  return payload;
}

/**
 * Make a retry payload. Clones everything but bumps `attempt`. The
 * idempotency key stays stable across retries — that's the whole
 * point of dedupe.
 */
export function buildRetryPayload<T = Record<string, unknown>>(
  source: TenantJobPayload<T>,
): TenantJobPayload<T> {
  const next: TenantJobPayload<T> = {
    ...source,
    retry: {
      attempt: source.retry.attempt + 1,
      maxAttempts: source.retry.maxAttempts,
      backoff: source.retry.backoff,
    },
  };
  assertTenantJobPayload<T>(next);
  return next;
}
