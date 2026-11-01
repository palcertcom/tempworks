import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { FeatureFlagsService } from '../feature-flags/feature-flags.service';
import { TenantContext } from '../context/als';
import { isTenantScoped, classify } from './tenant-scoped-models';
import { setLocalTenantSql } from './rls';

/**
 * Phase 0 skeleton.
 *
 * BEHAVIOUR MATRIX:
 *
 *   TENANT_PRISMA_ENFORCEMENT = false  (Phase 0 default)
 *      `client` returns the underlying PrismaClient unchanged.
 *      `withTenant(...)` is still callable for opt-in code paths but
 *      the registry is empty — no models intercepted.
 *
 *   TENANT_PRISMA_ENFORCEMENT = true   (Phase 2+)
 *      `client` returns a Prisma `$extends`-wrapped client that, for
 *      every operation on a model in TENANT_SCOPED_MODELS:
 *        1. opens an interactive transaction;
 *        2. emits `SET LOCAL app.tenant_id = '<uuid>'` (RLS);
 *        3. injects `tenantId` into args.where / args.data;
 *        4. runs the operation, returns its result.
 *
 * THE WRAPPER IS DORMANT IN PHASE 0. Existing code paths that import
 * `PrismaService` directly continue to work byte-for-byte identically.
 *
 * Validated by SPIKE-001 (no leakage; +43% to -17% overhead depending
 * on queries-per-request).
 */
@Injectable()
export class TenantPrismaService {
  private readonly logger = new Logger('TenantPrismaService');

  constructor(
    private readonly prisma: PrismaService,
    private readonly flags: FeatureFlagsService,
  ) {}

  /**
   * The application-facing client.
   *
   * Phase 0: returns underlying Prisma. Phase 2: returns `$extends` proxy.
   */
  get client(): PrismaService {
    if (!this.flags.tenantPrismaEnforcement()) return this.prisma;
    return this.buildExtendedClient();
  }

  /**
   * Convenience for a hand-rolled tenant transaction. Use sparingly —
   * the `client` extension is the canonical surface.
   */
  async withTenant<T>(
    fn: (tx: any) => Promise<T>,
    tenantIdOverride?: string,
  ): Promise<T> {
    const tenantId = tenantIdOverride ?? TenantContext.current('withTenant').id;
    return this.prisma.$transaction(async (tx) => {
      // setLocalTenantSql validates UUID shape before interpolation.
      await tx.$executeRawUnsafe(setLocalTenantSql(tenantId));
      return fn(tx);
    });
  }

  // -- Phase 2 implementation (sketch; not active in Phase 0) ------------

  private buildExtendedClient(): PrismaService {
    // Returning a $extends proxy is intentionally NOT implemented here
    // until the model manifest is non-empty AND a corresponding
    // integration test ships. Throwing now prevents partial activation.
    if (TENANT_SCOPED_MODELS_NONEMPTY()) {
      // Implementation lands in TKT-04 (Phase 1).
      throw new Error(
        'TenantPrismaService.client extension activated without Phase 1 implementation',
      );
    }
    // Manifest empty: safe to behave as plain client.
    return this.prisma;
  }

  /** Diagnostic probe — useful in tests. */
  describeClassification(model: string): ReturnType<typeof classify> {
    return classify(model);
  }

  /** Indicates whether the wrapper is currently intercepting writes. */
  isEnforcing(): boolean {
    return this.flags.tenantPrismaEnforcement() && TENANT_SCOPED_MODELS_NONEMPTY();
  }

  /** True if the given model would be intercepted right now. */
  wouldIntercept(model: string): boolean {
    return this.flags.tenantPrismaEnforcement() && isTenantScoped(model);
  }
}

function TENANT_SCOPED_MODELS_NONEMPTY(): boolean {
  // Local helper to keep the registry import path in one place.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { TENANT_SCOPED_MODELS } = require('./tenant-scoped-models');
  return (TENANT_SCOPED_MODELS as Set<string>).size > 0;
}
