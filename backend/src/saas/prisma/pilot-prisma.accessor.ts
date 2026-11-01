/**
 * Phase 2.6 — Pilot Prisma Accessor.
 *
 * Single, narrow injectable that lets one pilot module opt into routing
 * all Prisma calls through `TenantPrismaService.client` instead of the
 * raw `PrismaService`, but ONLY when:
 *
 *   1. `TENANT_PRISMA_PILOT_ENABLED=true` (default false), AND
 *   2. The runtime environment classifies as SAFE_CLONE / SAFE_STAGING.
 *
 * Otherwise, the accessor returns `PrismaService` directly — exactly as
 * legacy code does today. Behavior is therefore byte-for-byte identical
 * with the flag OFF or in production.
 *
 * Why a separate accessor (vs. consuming `TenantPrismaService` directly)?
 *   - It centralises the "pilot OR legacy" decision so individual call
 *     sites stay clean.
 *   - It contains the env-safety check inside one place, so production
 *     can never accidentally route through TenantPrisma.
 *   - It logs the chosen path once at startup, so operators can see
 *     which client a given module is using.
 *
 * When `TENANT_PRISMA_ENFORCEMENT=true` is also on (Phase 3+), the
 * underlying `TenantPrismaService.client` will start intercepting calls
 * for tenant-scoped models. Roles / Permissions / RolePermission are in
 * `GLOBAL_MODELS`, so the wrapper will pass them through unchanged —
 * proving the global-table path of the larger refactor.
 */
import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { TenantPrismaService } from './tenant-prisma.service';
import { FeatureFlagsService } from '../feature-flags/feature-flags.service';
import { classifyRuntimeEnv, isStagingClassification } from '../tenancy/env-safety';

@Injectable()
export class PilotPrismaAccessor {
  private readonly logger = new Logger('PilotPrismaAccessor');
  private logged = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantPrisma: TenantPrismaService,
    private readonly flags: FeatureFlagsService,
  ) {}

  /**
   * The Prisma surface a pilot module should use for ALL reads/writes.
   * Always returns a usable client; never throws.
   */
  client(): PrismaService {
    const usePilot = this.shouldUsePilotPath();
    if (!this.logged) {
      this.logged = true;
      this.logger.log(
        usePilot
          ? '[pilot] routing through TenantPrismaService.client (pilot flag ON, env staging)'
          : '[pilot] routing through PrismaService directly (legacy path; default)',
      );
    }
    return usePilot ? this.tenantPrisma.client : this.prisma;
  }

  /**
   * Diagnostic for tests/harnesses. Returns the same boolean used to
   * choose the client; cheap, no side effects.
   */
  isPilotActive(): boolean {
    return this.shouldUsePilotPath();
  }

  /**
   * Reason exposed for diagnostics — harnesses use this to assert why
   * the pilot did or did not engage in a given environment.
   */
  pilotReason(): { active: boolean; reason: string } {
    if (!this.flags.tenantPrismaPilotEnabled()) {
      return { active: false, reason: 'TENANT_PRISMA_PILOT_ENABLED=false' };
    }
    const env = classifyRuntimeEnv();
    if (!isStagingClassification(env.classification)) {
      return {
        active: false,
        reason: `env=${env.classification} is not SAFE_CLONE/SAFE_STAGING`,
      };
    }
    return { active: true, reason: `pilot ON, env=${env.classification}` };
  }

  private shouldUsePilotPath(): boolean {
    if (!this.flags.tenantPrismaPilotEnabled()) return false;
    const env = classifyRuntimeEnv();
    return isStagingClassification(env.classification);
  }
}
