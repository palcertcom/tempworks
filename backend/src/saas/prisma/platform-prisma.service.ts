import { Injectable, Logger } from '@nestjs/common';
import { FeatureFlagsService } from '../feature-flags/feature-flags.service';

/**
 * Audited platform-admin DB access — SKELETON ONLY in Phase 0.
 *
 * Per ADR-005, this service binds to a separate Postgres role
 * (`platform_admin`) that has explicit RLS-bypass policies. Every
 * public method requires a `reason: string` and writes a row to
 * `PlatformAuditLog` BEFORE returning data.
 *
 * Phase 0 ships:
 *   - the class signature
 *   - the audit-write contract
 *   - a hard guard against use when `PLATFORM_ADMIN_ENABLED=false`
 *
 * Phase 0 does NOT ship:
 *   - a separate `PrismaClient` connection
 *   - the bypass policies (those land in Phase 3 RLS rollout)
 *   - any consumers (no module imports this yet)
 */
@Injectable()
export class PlatformPrismaService {
  private readonly logger = new Logger('PlatformPrismaService');

  constructor(private readonly flags: FeatureFlagsService) {}

  /** Throws unless the feature flag is on. Lets us fail loudly before any I/O. */
  protected ensureEnabled(method: string): void {
    if (!this.flags.platformAdminEnabled()) {
      throw new Error(
        `PlatformPrismaService.${method} called but PLATFORM_ADMIN_ENABLED=false`,
      );
    }
  }

  /**
   * Read across all tenants (Phase 3+).
   *
   * @param model    the Prisma model name
   * @param args     Prisma findMany args
   * @param reason   human-readable justification (audit-required)
   */
  async findAcrossTenants<T = unknown>(
    model: string,
    args: unknown,
    reason: string,
  ): Promise<T[]> {
    this.ensureEnabled('findAcrossTenants');
    if (!reason || reason.trim().length < 10) {
      throw new Error('PlatformPrismaService requires a >=10 char `reason` audit string');
    }
    // Phase 3 implementation. Refusing for now is the safe default.
    throw new Error('PlatformPrismaService.findAcrossTenants not implemented in Phase 0');
  }

  /** Mutate against the bypass role. Same contract as above. */
  async mutateAcrossTenants<T = unknown>(
    _model: string,
    _operation: string,
    _args: unknown,
    reason: string,
  ): Promise<T> {
    this.ensureEnabled('mutateAcrossTenants');
    if (!reason || reason.trim().length < 10) {
      throw new Error('PlatformPrismaService requires a >=10 char `reason` audit string');
    }
    throw new Error('PlatformPrismaService.mutateAcrossTenants not implemented in Phase 0');
  }
}
