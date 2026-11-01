import { CanActivate, ExecutionContext, Injectable, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PrismaService } from '../prisma/prisma.service';

export const PLATFORM_TENANT_LEVEL_KEY = 'PLATFORM_TENANT_LEVEL';
export type RequiredLevel = 'SUPPORT' | 'OPERATOR' | 'SUPER';
const RANK: Record<RequiredLevel, number> = { SUPPORT: 1, OPERATOR: 2, SUPER: 3 };

/**
 * Phase 3.15 — Tenant Management RBAC guard.
 *
 * The route handler declares the minimum PlatformAdmin level it
 * requires via `@RequireTenantLevel('SUPER')`. The guard looks up
 * the caller's PlatformAdmin row and rejects with a Forbidden when
 * the level is missing or below the requirement.
 *
 * Non-platform users (no row in `platform_admins`) are always
 * rejected. Tenant routes never leak to ordinary tenant users.
 *
 * @tenant-reviewed: phase315-tenant-management-module
 */
@Injectable()
export class PlatformTenantGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly prisma: PrismaService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const required: RequiredLevel =
      this.reflector.get<RequiredLevel>(PLATFORM_TENANT_LEVEL_KEY, context.getHandler()) ?? 'SUPPORT';

    const req = context.switchToHttp().getRequest();
    const userId: string | undefined = req?.user?.id ?? req?.user?.sub;
    if (!userId) throw new ForbiddenException({ code: 'TENANT.MISSING_ACTOR' });

    const pa = await (this.prisma as any).platformAdmin.findUnique({
      where: { userId }, select: { level: true },
    });
    if (!pa) throw new ForbiddenException({ code: 'TENANT.NOT_PLATFORM_ADMIN' });
    if (RANK[pa.level as RequiredLevel] < RANK[required]) {
      throw new ForbiddenException({ code: 'TENANT.LEVEL_TOO_LOW', required, have: pa.level });
    }
    (req as any).platformAdminLevel = pa.level;
    return true;
  }
}

export function RequireTenantLevel(level: RequiredLevel) {
  return (target: any, key?: string | symbol, descriptor?: PropertyDescriptor) => {
    Reflect.defineMetadata(PLATFORM_TENANT_LEVEL_KEY, level, (descriptor?.value ?? target));
  };
}
