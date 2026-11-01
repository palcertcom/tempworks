import { Logger } from '@nestjs/common';
import { tenantALS, newRequestId, TenantContext } from '../context/als';
import { TenantSnapshot, UserSnapshot } from '../context/types';
import { TenantAwareJobPayload } from './payload';

/**
 * Base class for any background-job processor that reads tenant data.
 *
 * Validated by SPIKE-006: re-entering ALS with `tenant` from `job.data`
 * isolates concurrent multi-tenant fan-out, retries, and cron triggers.
 *
 * NOT YET CONSUMED in Phase 0 — existing schedulers continue unchanged.
 * Phase 3 retires the legacy `setInterval` in
 * `notifications-scheduler.service.ts` and migrates to per-tenant BullMQ
 * jobs whose processors extend this class.
 */
export abstract class TenantAwareJobProcessor<T extends TenantAwareJobPayload> {
  protected readonly logger = new Logger(this.constructor.name);

  /**
   * Hook the producer/queue entry through this method, or override
   * `process(job)` directly.
   *
   * The wrapper:
   *   - validates the payload carries `tenantId`,
   *   - resolves the tenant snapshot via {@link resolveTenant},
   *   - resolves the optional user snapshot via {@link resolveUser},
   *   - runs `handle(job)` inside a fresh ALS frame.
   */
  async process(job: { id?: string | number; data: T }): Promise<unknown> {
    const data = job.data;
    if (!data || typeof data.tenantId !== 'string' || data.tenantId.length === 0) {
      throw new Error(
        `${this.constructor.name}: job ${job.id} missing tenantId in payload`,
      );
    }
    const tenant = await this.resolveTenant(data.tenantId);
    const user = data.userId ? await this.resolveUser(data.userId) : undefined;
    const requestId = `job:${job.id ?? newRequestId()}`;

    return tenantALS.run({ requestId, tenant, user }, async () => {
      // Defensive sanity check inside the frame.
      const inCtx = TenantContext.current(`${this.constructor.name}.process`);
      if (inCtx.id !== data.tenantId) {
        throw new Error('ALS tenant mismatch — internal error');
      }
      return this.handle(job);
    });
  }

  /** Override in subclasses with the actual job logic. */
  protected abstract handle(job: { id?: string | number; data: T }): Promise<unknown>;

  /**
   * Default implementation throws — subclasses or DI must provide.
   * In Phase 3 we'll inject a `TenantSnapshotResolver`.
   */
  protected async resolveTenant(tenantId: string): Promise<TenantSnapshot> {
    throw new Error(
      `${this.constructor.name}.resolveTenant not provided (override or inject in Phase 3)`,
    );
  }

  protected async resolveUser(_userId: string): Promise<UserSnapshot | undefined> {
    return undefined;
  }
}
