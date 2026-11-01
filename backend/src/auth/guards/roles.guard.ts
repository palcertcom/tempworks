import { Injectable, CanActivate, ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ROLES_KEY } from '../../common/decorators/roles.decorator';
import { PERMISSIONS_KEY } from '../../common/decorators/require-permission.decorator';
import { PrismaService } from '../../prisma/prisma.service';

/**
 * Access is granted when any of the following is true:
 *   - the endpoint declares no @Roles and no @RequirePermission (public within auth)
 *   - user.role matches one of @Roles(...)
 *   - user.role is 'System Admin' (universal bypass)
 *   - user holds one of @RequirePermission(...) keys, looked up live
 *     against the role-permission + agency-override merge
 *
 * Permissions are resolved per-request so grants made via the Roles UI
 * take effect without forcing users to log out and back in.
 */
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(
    private reflector: Reflector,
    private prisma: PrismaService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const requiredRoles = this.reflector.getAllAndOverride<string[]>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    const requiredPermissions = this.reflector.getAllAndOverride<string[]>(PERMISSIONS_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (
      (!requiredRoles || requiredRoles.length === 0) &&
      (!requiredPermissions || requiredPermissions.length === 0)
    ) {
      return true;
    }

    const { user } = context.switchToHttp().getRequest();
    if (!user) return false;

    if (user.role === 'System Admin') return true;

    if (requiredRoles?.some((role) => user.role === role)) return true;

    if (requiredPermissions && requiredPermissions.length > 0) {
      const effective = await this.resolvePermissions(user.id, user.agencyId);
      if (requiredPermissions.some((p) => effective.has(p))) return true;
    }

    return false;
  }

  /** Resolve the caller's effective permission set (role + agency overrides). */
  private async resolvePermissions(userId: string, agencyId?: string): Promise<Set<string>> {
    if (!userId) return new Set();

    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        role: {
          select: {
            permissions: { select: { permission: { select: { name: true } } } },
          },
        },
      },
    });
    const effective = new Set<string>(
      (user?.role?.permissions ?? []).map((rp) => rp.permission.name),
    );

    if (agencyId) {
      const overrides = await this.prisma.agencyPermissionOverride.findMany({
        where: { agencyId },
        select: { permission: true, allow: true },
      });
      for (const o of overrides) {
        if (o.allow) effective.add(o.permission);
        else effective.delete(o.permission);
      }
    }

    return effective;
  }
}
