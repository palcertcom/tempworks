/**
 * Every tenant-aware queue payload MUST satisfy this shape.
 *
 * Producers should use the typed helpers in `enqueue.ts` (Phase 1) to
 * avoid forgetting the field; this interface exists today so subclasses
 * of TenantAwareJobProcessor can be typed correctly.
 */
export interface TenantAwareJobPayload {
  /** UUID of the active tenant when the job was enqueued. */
  tenantId: string;
  /** Optional user UUID for audit-correlated jobs (downloads, exports). */
  userId?: string;
}

export type WithJob<T extends TenantAwareJobPayload> = { id?: string | number; data: T };
