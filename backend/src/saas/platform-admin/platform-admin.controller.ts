import {
  Controller, Post, Delete, Get, Body, Param, Req, UseGuards, NotFoundException, ForbiddenException,
} from '@nestjs/common';
import { PlatformAdminService } from './platform-admin.service';
import { PlatformAdminGuard, RequirePlatformAdmin } from './platform-admin.guard';
import { GrantPlatformAdminDto, RevokePlatformAdminDto } from './dto/grant-platform-admin.dto';

/**
 * Phase 3.12 — PlatformAdmin HTTP surface.
 *
 * Three routes, all behind the existing `PlatformAdminGuard`:
 *   POST   /_platform/admin/grants            (SUPER) grant or change level
 *   DELETE /_platform/admin/grants/:userId    (SUPER) revoke
 *   GET    /_platform/admin/grants            (SUPPORT) list
 *
 * The guard requires the JWT claims `pa: true`, `paLevel`, and a
 * recent `paMfaAt` step-up. Service-level `assertSuperPlatformAdmin`
 * remains as defense-in-depth.
 *
 * `PLATFORM_ADMIN_HTTP_ENABLED` (default false) gates the entire
 * surface. When false, every handler throws NotFoundException so the
 * route is indistinguishable from "no such endpoint".
 *
 * @tenant-reviewed: phase312-platform-admin-controller
 */
@Controller('_platform/admin/grants')
@UseGuards(PlatformAdminGuard)
export class PlatformAdminController {
  constructor(private readonly platformAdmin: PlatformAdminService) {}

  private assertHttpEnabled(): void {
    if (process.env.PLATFORM_ADMIN_HTTP_ENABLED !== 'true') {
      // 404 instead of 403 so the surface is indistinguishable from
      // "no such route" when the operator has not opted in.
      throw new NotFoundException({ code: 'PLATFORM_ADMIN.HTTP_DISABLED' });
    }
  }

  private actorId(req: any): string {
    const id = req?.user?.id ?? req?.user?.sub;
    if (!id) throw new ForbiddenException({ code: 'PLATFORM_ADMIN.MISSING_ACTOR' });
    return id;
  }

  @Post()
  @RequirePlatformAdmin('SUPER')
  async grant(@Body() dto: GrantPlatformAdminDto, @Req() req: any) {
    this.assertHttpEnabled();
    return this.platformAdmin.grant({
      actorUserId: this.actorId(req),
      targetUserId: dto.userId,
      level: dto.level,
      reason: dto.reason,
      ip: req?.ip ?? null,
      userAgent: req?.headers?.['user-agent'] ?? null,
    });
  }

  @Delete(':userId')
  @RequirePlatformAdmin('SUPER')
  async revoke(@Param('userId') userId: string, @Body() dto: RevokePlatformAdminDto, @Req() req: any) {
    this.assertHttpEnabled();
    return this.platformAdmin.revoke({
      actorUserId: this.actorId(req),
      targetUserId: userId,
      reason: dto.reason,
      ip: req?.ip ?? null,
      userAgent: req?.headers?.['user-agent'] ?? dto.userAgent ?? null,
    });
  }

  @Get()
  @RequirePlatformAdmin('SUPPORT')
  async list(@Req() req: any) {
    this.assertHttpEnabled();
    return this.platformAdmin.list(this.actorId(req));
  }
}
