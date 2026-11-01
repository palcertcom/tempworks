import { Controller, Get, Post, Body, Patch, Param, Delete, UseGuards } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { RolesService } from './roles.service';
import { CreateRoleDto } from './dto/create-role.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { RequirePermission } from '../auth/decorators/require-permission.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';

@ApiTags('Roles')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('roles')
export class RolesController {
  constructor(private rolesService: RolesService) {}

  @Get()
  @Roles('System Admin', 'HR Manager', 'Read Only')
  @RequirePermission('roles:read')
  @ApiOperation({ summary: 'List all roles' })
  findAll(@CurrentUser() user: any) { return this.rolesService.findAll(user?.role); }

  @Get('permissions')
  @Roles('System Admin')
  @RequirePermission('roles:read')
  @ApiOperation({ summary: 'Get all permissions' })
  getPermissions() { return this.rolesService.getPermissions(); }

  @Get('permissions-matrix')
  @Roles('System Admin', 'HR Manager')
  @RequirePermission('roles:read')
  @ApiOperation({ summary: 'Get permissions matrix for all roles' })
  getPermissionsMatrix() { return this.rolesService.getPermissionsMatrix(); }

  @Get(':id')
  @Roles('System Admin', 'HR Manager')
  @RequirePermission('roles:read')
  @ApiOperation({ summary: 'Get role by ID' })
  findOne(@Param('id') id: string) { return this.rolesService.findOne(id); }

  @Post()
  @Roles('System Admin')
  @RequirePermission('roles:create')
  @ApiOperation({ summary: 'Create new role' })
  create(@Body() dto: CreateRoleDto, @CurrentUser() caller: any) {
    return this.rolesService.create(dto, caller?.id);
  }

  @Patch(':id')
  @Roles('System Admin')
  @RequirePermission('roles:update')
  @ApiOperation({ summary: 'Update role' })
  update(@Param('id') id: string, @Body() dto: Partial<CreateRoleDto>, @CurrentUser() caller: any) {
    return this.rolesService.update(id, dto, caller?.id);
  }

  @Delete(':id')
  @Roles('System Admin')
  @RequirePermission('roles:delete')
  @ApiOperation({ summary: 'Delete role' })
  remove(@Param('id') id: string, @CurrentUser() caller: any) {
    return this.rolesService.remove(id, caller?.id);
  }
}
