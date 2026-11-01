import { CanActivate, ExecutionContext, Injectable, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { FeatureFlagsService } from '../feature-flags/feature-flags.service';

export const PLATFORM_ADMIN_LEVEL_KEY = 'PLATFORM_ADMIN_LEVEL';
export type PlatformAdminLevel = 'SUPPORT' | 'OPERATOR' | 'SUPER';
const LEVEL_RANK: Record<PlatformAdminLevel, number> = { SUPPORT: 1, OPERATOR: 2, SUPER: 3 };

/**
 * Phase 0 SKELETON.
 *
 * - When `PLATFORM_ADMIN_ENABLED=false`: any route protected by this guard
 *   responds 403 deterministically. There is no quiet bypass.
 * - When `PLATFORM_ADMIN_ENABLED=true`: the guard expects a JWT claim
 *   `pa: true` plus a recent `pa_mfa_at` step-up timestamp. The full
 *   implementation lands in Phase 3 (`PlatformPrismaService` consumers).
 *
 * NOT YET CONSUMED by any route.
 */
@Injectable()
export class PlatformAdminGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly flags: FeatureFlagsService,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    if (!this.flags.platformAdminEnabled()) {
      throw new ForbiddenException('Platform admin surface is disabled');
    }
    const required = this.reflector.get<PlatformAdminLevel>(
      PLATFORM_ADMIN_LEVEL_KEY,
      context.getHandler(),
    ) ?? 'SUPPORT';

    const req = context.switchToHttp().getRequest();
    const claims = req.user as { pa?: boolean; paLevel?: PlatformAdminLevel; paMfaAt?: number } | undefined;

    if (!claims?.pa) throw new ForbiddenException('Platform admin claim missing');
    const haveLevel = claims.paLevel ?? 'SUPPORT';
    if (LEVEL_RANK[haveLevel] < LEVEL_RANK[required]) {
      throw new ForbiddenException(`Requires ${required}; have ${haveLevel}`);
    }

    // Step-up MFA freshness: 30 minutes
    const fresh = (Date.now() - (claims.paMfaAt ?? 0)) <= 30 * 60 * 1000;
    if (!fresh) throw new ForbiddenException('Step-up MFA required');

    return true;
  }
}

/** Decorator usage: `@RequirePlatformAdmin('OPERATOR')`. */
export function RequirePlatformAdmin(level: PlatformAdminLevel = 'SUPPORT') {
  // Avoid coupling to @nestjs/common SetMetadata import path here so the file
  // can be imported by tests without bringing the Nest decorator runtime.
  return (target: any, key?: string, descriptor?: PropertyDescriptor) => {
    const meta = descriptor?.value ?? target;
    Reflect.defineMetadata(PLATFORM_ADMIN_LEVEL_KEY, level, meta);
  };
}
