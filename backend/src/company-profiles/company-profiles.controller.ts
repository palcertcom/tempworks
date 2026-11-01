import { Body, Controller, Delete, Get, Param, Patch, Post, Query, UseGuards, Request } from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { RequirePermission } from '../auth/decorators/require-permission.decorator';
import { CompanyProfilesService } from './company-profiles.service';

const READ_ROLES  = ['System Admin', 'HR Manager', 'Finance', 'Compliance Officer'];
const WRITE_ROLES = ['System Admin', 'HR Manager', 'Finance'];
// Roles allowed to read the profile list for use in export dialogs (timesheets,
// invoices, etc.). Broader than READ_ROLES — anyone who can export attendance
// needs to pick a header. The service tenant-scopes the result, so cross-tenant
// leakage is still impossible.
const LIST_FOR_EXPORT_ROLES = [...READ_ROLES, 'Recruiter', 'Officer'];

@ApiTags('Company Profiles')
@ApiBearerAuth('access-token')
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('company-profiles')
export class CompanyProfilesController {
  constructor(private readonly svc: CompanyProfilesService) {}

  @Get()
  @Roles(...LIST_FOR_EXPORT_ROLES)
  @RequirePermission('attendance:read')
  @ApiOperation({ summary: 'List company export profiles (tenant-scoped; SUPER may pass ?tenantId=… or omit for all)' })
  list(@Query('tenantId') tenantId: string | undefined, @Request() req: any) {
    return this.svc.list(req.user?.tenantId, tenantId, req.user?.id);
  }

  @Get(':id')
  @Roles(...READ_ROLES)
  @RequirePermission('settings:read')
  get(@Param('id') id: string) {
    return this.svc.get(id);
  }

  @Post()
  @Roles(...WRITE_ROLES)
  @RequirePermission('settings:create')
  create(@Body() body: any, @Request() req: any) {
    return this.svc.create(body, req.user?.tenantId, req.user?.id);
  }

  @Patch(':id')
  @Roles(...WRITE_ROLES)
  @RequirePermission('settings:update')
  update(@Param('id') id: string, @Body() body: any, @Request() req: any) {
    return this.svc.update(id, body, req.user?.id);
  }

  @Delete(':id')
  @Roles(...WRITE_ROLES)
  @RequirePermission('settings:delete')
  remove(@Param('id') id: string) {
    return this.svc.remove(id);
  }
}
