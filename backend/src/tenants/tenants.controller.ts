import {
  Controller, Get, Post, Patch, Delete, Body, Param, Query, Req, UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { TenantsService } from './tenants.service';
import { CreateTenantDto } from './dto/create-tenant.dto';
import { UpdateTenantDto } from './dto/update-tenant.dto';
import { PlatformTenantGuard, RequireTenantLevel } from './platform-tenant.guard';

/**
 * Phase 3.15 — Tenant Management HTTP surface.
 *
 * All routes require an authenticated user AND a PlatformAdmin row
 * of at least the level declared on the handler. Non-platform users
 * receive 403 (TENANT.NOT_PLATFORM_ADMIN); under-level users receive
 * 403 (TENANT.LEVEL_TOO_LOW).
 *
 *   GET    /tenants               SUPPORT  list (paginated, search, status)
 *   GET    /tenants/:id           SUPPORT  details
 *   GET    /tenants/:id/stats     SUPPORT  counters
 *   POST   /tenants               SUPER    create
 *   PATCH  /tenants/:id           OPERATOR update (slug change still SUPER)
 *   POST   /tenants/:id/archive   OPERATOR archive (status=SUSPENDED)
 *   POST   /tenants/:id/activate  OPERATOR re-activate
 *   POST   /tenants/:id/restore   SUPER    restore from soft-delete
 *   DELETE /tenants/:id           SUPER    soft-delete (status=INACTIVE)
 *
 * @tenant-reviewed: phase315-tenant-management-module
 */
@ApiTags('Tenants')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, PlatformTenantGuard)
@Controller('tenants')
export class TenantsController {
  constructor(private readonly tenants: TenantsService) {}

  @Get()
  @RequireTenantLevel('SUPPORT')
  @ApiOperation({ summary: 'List tenants' })
  list(@Query() q: any) {
    return this.tenants.list({
      page: q.page, limit: q.limit, search: q.search,
      status: q.status, includeDeleted: q.includeDeleted === 'true' || q.includeDeleted === true,
    });
  }

  @Get(':id')
  @RequireTenantLevel('SUPPORT')
  @ApiOperation({ summary: 'Get tenant by ID' })
  get(@Param('id') id: string) { return this.tenants.findOne(id); }

  @Get(':id/stats')
  @RequireTenantLevel('SUPPORT')
  @ApiOperation({ summary: 'Get tenant statistics' })
  stats(@Param('id') id: string) { return this.tenants.stats(id); }

  @Post()
  @RequireTenantLevel('SUPER')
  @ApiOperation({ summary: 'Create tenant' })
  create(@Body() dto: CreateTenantDto, @CurrentUser('id') actorId: string) {
    return this.tenants.create(dto, actorId);
  }

  @Patch(':id')
  @RequireTenantLevel('OPERATOR')
  @ApiOperation({ summary: 'Update tenant' })
  update(@Param('id') id: string, @Body() dto: UpdateTenantDto, @CurrentUser('id') actorId: string, @Req() req: any) {
    const level = (req as any).platformAdminLevel as 'SUPPORT' | 'OPERATOR' | 'SUPER';
    return this.tenants.update(id, dto, actorId, level);
  }

  @Post(':id/archive')
  @RequireTenantLevel('OPERATOR')
  @ApiOperation({ summary: 'Archive (suspend) tenant' })
  archive(@Param('id') id: string, @CurrentUser('id') actorId: string) {
    return this.tenants.archive(id, actorId);
  }

  @Post(':id/activate')
  @RequireTenantLevel('OPERATOR')
  @ApiOperation({ summary: 'Activate (re-enable) tenant' })
  activate(@Param('id') id: string, @CurrentUser('id') actorId: string) {
    return this.tenants.activate(id, actorId);
  }

  @Post(':id/restore')
  @RequireTenantLevel('SUPER')
  @ApiOperation({ summary: 'Restore a soft-deleted tenant' })
  restore(@Param('id') id: string, @CurrentUser('id') actorId: string) {
    return this.tenants.restore(id, actorId);
  }

  @Delete(':id')
  @RequireTenantLevel('SUPER')
  @ApiOperation({ summary: 'Soft-delete tenant' })
  remove(@Param('id') id: string, @Query('force') force: string, @CurrentUser('id') actorId: string) {
    return this.tenants.softDelete(id, actorId, { force: force === 'true' || force === '1' });
  }

  // ── Phase 3.17 membership endpoints have moved to TenantMembersController
  // so a tenant's own System Admin can manage their tenant's memberships
  // without holding PlatformAdmin. @tenant-reviewed: phase317-multi-tenant-login
}
