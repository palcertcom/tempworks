import {
  Controller, Get, Post, Delete, Body, Param, Req, UseGuards, ForbiddenException,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { PrismaService } from '../prisma/prisma.service';
import { TenantsService } from './tenants.service';

/**
 * Phase 3.17 — Tenant membership management with a relaxed RBAC model.
 *
 * Membership endpoints are now reachable by either:
 *   - a PlatformAdmin SUPER (manage any tenant), or
 *   - the tenant's own System Admin (manage only their own tenant).
 *
 * The TenantsController still owns the rest of the tenant surface and
 * keeps its PlatformAdmin-only gate; only the three membership routes
 * are split out here so a tenant manager can grant/revoke access to
 * their own tenant without needing PlatformAdmin.
 *
 * @tenant-reviewed: phase317-multi-tenant-login
 */
@ApiTags('Tenant Members')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('tenants/:id/memberships')
export class TenantMembersController {
  constructor(
    private readonly tenants: TenantsService,
    private readonly prisma: PrismaService,
  ) {}

  /**
   * Authorize the caller for membership operations on tenant `tenantId`.
   * Either PlatformAdmin SUPER OR a tenant System Admin who already has
   * an ACTIVE membership in the target tenant.
   */
  private async assertCanManage(req: any, tenantId: string): Promise<'SUPER' | 'TENANT_ADMIN'> {
    const callerId: string | undefined = req?.user?.id ?? req?.user?.sub;
    if (!callerId) throw new ForbiddenException({ code: 'TENANT.MISSING_ACTOR' });

    // SUPER PlatformAdmin: green light for every tenant.
    const pa = await (this.prisma as any).platformAdmin.findUnique({
      where: { userId: callerId }, select: { level: true },
    }).catch(() => null);
    if (pa?.level === 'SUPER') return 'SUPER';

    // Tenant System Admin path: caller must hold the "System Admin" role
    // AND already be an ACTIVE member of the target tenant. The tenant
    // role today is global (User.roleId) — once we move roles into
    // MembershipRole this check becomes "role within this tenant".
    const callerRole = req?.user?.role;
    if (callerRole !== 'System Admin') {
      throw new ForbiddenException({ code: 'TENANT.NOT_PLATFORM_ADMIN_OR_TENANT_ADMIN' });
    }
    const membership = await (this.prisma as any).tenantMembership.findUnique({
      where: { userId_tenantId: { userId: callerId, tenantId } },
      select: { status: true },
    }).catch(() => null);
    // Fallback for first-time System Admin in their primary tenant:
    // accept the legacy agency.tenantId pin so a tenant admin who has
    // not yet logged in via /auth/login-v2 once (the auto-backfill path)
    // can still manage their tenant.
    let allowed = membership?.status === 'ACTIVE';
    if (!allowed) {
      const user = await (this.prisma as any).user.findUnique({
        where: { id: callerId },
        select: { agency: { select: { tenantId: true } } },
      }).catch(() => null);
      allowed = user?.agency?.tenantId === tenantId;
    }
    if (!allowed) {
      throw new ForbiddenException({ code: 'TENANT.NOT_A_MEMBER' });
    }
    return 'TENANT_ADMIN';
  }

  @Get()
  @ApiOperation({ summary: 'List tenant memberships (SUPER or in-tenant System Admin)' })
  async list(@Param('id') id: string, @Req() req: any) {
    await this.assertCanManage(req, id);
    return this.tenants.listMemberships(id);
  }

  @Post()
  @ApiOperation({ summary: 'Grant tenant membership to a user (SUPER or in-tenant System Admin)' })
  async grant(
    @Param('id') id: string,
    @Body() body: { userId: string },
    @CurrentUser('id') actorId: string,
    @Req() req: any,
  ) {
    await this.assertCanManage(req, id);
    return this.tenants.grantMembership(id, body.userId, actorId);
  }

  @Delete(':userId')
  @ApiOperation({ summary: 'Revoke tenant membership from a user (SUPER or in-tenant System Admin)' })
  async revoke(
    @Param('id') id: string,
    @Param('userId') userId: string,
    @CurrentUser('id') actorId: string,
    @Req() req: any,
  ) {
    await this.assertCanManage(req, id);
    return this.tenants.revokeMembership(id, userId, actorId);
  }
}
