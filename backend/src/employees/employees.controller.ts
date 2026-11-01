import { Controller, Get, Post, Body, Patch, Param, Delete, Query, UseGuards, UseInterceptors, UploadedFile, BadRequestException, Res, Headers } from '@nestjs/common';
import { Response } from 'express';
import { resolveAcceptLanguage } from '../common/i18n/server-translate';
import { ApiTags, ApiOperation, ApiBearerAuth, ApiConsumes } from '@nestjs/swagger';
import { FileInterceptor } from '@nestjs/platform-express';
import { memoryUpload, IMAGE_MIME } from '../common/storage/multer.config';
import { EmployeesService } from './employees.service';
import { CreateEmployeeDto } from './dto/create-employee.dto';
import { PaginationDto } from '../common/dto/pagination.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { RequirePermission } from '../auth/decorators/require-permission.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';

const ALL_ROLES = ['System Admin', 'HR Manager', 'Compliance Officer', 'Recruiter', 'Finance', 'Read Only'];
const WRITE_ROLES = ['System Admin', 'HR Manager'];
const ADMIN_ROLES = ['System Admin', 'HR Manager'];

@ApiTags('Employees')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('employees')
export class EmployeesController {
  constructor(private employeesService: EmployeesService) {}

  @Get()
  @Roles(...ALL_ROLES)
  @RequirePermission('employees:read')
  @ApiOperation({ summary: 'List employees with pagination and filters' })
  findAll(
    @Query() query: PaginationDto & { agencyId?: string; status?: string; nationality?: string; tenantId?: string },
    @CurrentUser() user: any,
  ) {
    return this.employeesService.findAll(query, { role: user?.role, agencyId: user?.agencyId, agencyIsSystem: user?.agencyIsSystem });
  }

  // ── XLSX Export ─────────────────────────────────────────────────────────────
  // Declared above the `:id` route so Nest doesn't treat "export" as an id.
  @Get('export/xlsx')
  @Roles(...ALL_ROLES)
  @RequirePermission('employees:read')
  @ApiOperation({ summary: 'Export employees as an Excel (.xlsx) file. Pass ids=a,b,c to export the selected rows only; otherwise the filter set is used. External tenants are scoped to grants with canView=true.' })
  async exportExcel(
    @Query() query: PaginationDto & { agencyId?: string; status?: string; nationality?: string; ids?: string },
    @CurrentUser() user: any,
    @Res() res: Response,
    @Headers('accept-language') acceptLanguage?: string,
  ) {
    const rawIds = (query as any).ids;
    const idList: string[] | undefined = Array.isArray(rawIds)
      ? rawIds
      : typeof rawIds === 'string' && rawIds.length > 0
        ? rawIds.split(',').map(s => s.trim()).filter(Boolean)
        : undefined;

    const { ids: _omit, ...cleanQuery } = (query ?? {}) as any;
    const buffer = await this.employeesService.exportExcel(
      cleanQuery,
      { role: user?.role, agencyId: user?.agencyId, agencyIsSystem: user?.agencyIsSystem },
      idList,
      resolveAcceptLanguage(acceptLanguage),
    );
    res.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
    res.setHeader('Content-Disposition', `attachment; filename="employees-${Date.now()}.xlsx"`);
    res.send(buffer);
  }

  @Get(':id')
  @Roles(...ALL_ROLES)
  @RequirePermission('employees:read')
  @ApiOperation({ summary: 'Get employee by ID' })
  findOne(@Param('id') id: string, @CurrentUser() user: any) {
    return this.employeesService.findOne(id, { role: user?.role, agencyId: user?.agencyId, agencyIsSystem: user?.agencyIsSystem });
  }

  // ── Per-employee agency access grants (admin only) ──────────────────────────

  @Get(':id/agency-access')
  @Roles(...ADMIN_ROLES)
  @RequirePermission('employees:manage-agency-access')
  @ApiOperation({ summary: 'List agencies that have been granted access to this employee' })
  listAgencyAccess(@Param('id') id: string) {
    return this.employeesService.listAgencyAccess(id);
  }

  @Post(':id/agency-access')
  @Roles(...ADMIN_ROLES)
  @RequirePermission('employees:manage-agency-access')
  @ApiOperation({ summary: 'Grant or update an agency\'s access to this employee. Body: { agencyId, notes?, canView?, canEdit? }. Defaults: canView=true, canEdit=true.' })
  grantAgencyAccess(
    @Param('id') id: string,
    @Body() dto: { agencyId: string; notes?: string; canView?: boolean; canEdit?: boolean },
    @CurrentUser('id') actorId: string,
  ) {
    return this.employeesService.grantAgencyAccess(
      id,
      dto.agencyId,
      { notes: dto.notes, canView: dto.canView, canEdit: dto.canEdit },
      actorId,
    );
  }

  @Patch(':id/agency-access/:agencyId')
  @Roles(...ADMIN_ROLES)
  @RequirePermission('employees:manage-agency-access')
  @ApiOperation({ summary: 'Update an existing agency-access grant. Body: { canView?, canEdit?, notes? }. If both flags end up false the grant row is deleted.' })
  updateAgencyAccess(
    @Param('id') id: string,
    @Param('agencyId') agencyId: string,
    @Body() dto: { canView?: boolean; canEdit?: boolean; notes?: string },
    @CurrentUser('id') actorId: string,
  ) {
    return this.employeesService.updateAgencyAccess(id, agencyId, dto, actorId);
  }

  @Delete(':id/agency-access/:agencyId')
  @Roles(...ADMIN_ROLES)
  @RequirePermission('employees:manage-agency-access')
  @ApiOperation({ summary: 'Revoke a specific agency\'s access to this employee (deletes the grant row).' })
  revokeAgencyAccess(
    @Param('id') id: string,
    @Param('agencyId') agencyId: string,
  ) {
    return this.employeesService.revokeAgencyAccess(id, agencyId);
  }

  @Get(':id/documents')
  @Roles(...ALL_ROLES)
  @RequirePermission('employees:read')
  @ApiOperation({ summary: 'Get employee documents (active by default; ?archived=archived|all for history)' })
  getDocuments(@Param('id') id: string, @Query('archived') archived?: string) {
    return this.employeesService.getDocuments(id, archived);
  }

  @Get(':id/workflow')
  @Roles(...ALL_ROLES)
  @RequirePermission('employees:read')
  @ApiOperation({ summary: 'Get employee workflow stages' })
  getWorkflow(@Param('id') id: string) { return this.employeesService.getWorkflow(id); }

  @Get(':id/compliance')
  @Roles(...ALL_ROLES)
  @RequirePermission('employees:read')
  @ApiOperation({ summary: 'Get employee compliance status' })
  getCompliance(@Param('id') id: string) { return this.employeesService.getCompliance(id); }

  @Get(':id/certifications')
  @Roles(...ALL_ROLES)
  @RequirePermission('employees:read')
  @ApiOperation({ summary: 'Get employee certifications' })
  getCertifications(@Param('id') id: string) { return this.employeesService.getCertifications(id); }

  @Get(':id/training')
  @Roles(...ALL_ROLES)
  @RequirePermission('employees:read')
  @ApiOperation({ summary: 'Get employee training history' })
  getTraining(@Param('id') id: string) { return this.employeesService.getTraining(id); }

  @Get(':id/performance')
  @Roles('System Admin', 'HR Manager', 'Compliance Officer', 'Read Only')
  @RequirePermission('employees:read')
  @ApiOperation({ summary: 'Get employee performance metrics' })
  getPerformance(@Param('id') id: string) { return this.employeesService.getPerformance(id); }

  @Get(':id/financial-profile')
  @Roles('System Admin', 'HR Manager', 'Finance', 'Compliance Officer', 'Read Only')
  @RequirePermission('finance:read')
  @ApiOperation({ summary: 'Get the banking/salary profile for an employee (from applicant financial profile via employeeId link)' })
  getFinancialProfile(@Param('id') id: string) { return this.employeesService.getFinancialProfile(id); }

  @Post()
  @Roles(...WRITE_ROLES)
  @RequirePermission('employees:create')
  @ApiOperation({ summary: 'Create new employee' })
  create(@Body() dto: CreateEmployeeDto, @CurrentUser() user: any) {
    return this.employeesService.create(dto, user?.id, {
      role: user?.role,
      agencyId: user?.agencyId,
      agencyIsSystem: user?.agencyIsSystem,
      tenantId: user?.tenantId,
    });
  }

  @Patch(':id')
  @Roles(...WRITE_ROLES)
  @RequirePermission('employees:update')
  @ApiOperation({ summary: 'Update employee' })
  update(@Param('id') id: string, @Body() dto: Partial<CreateEmployeeDto>, @CurrentUser() user: any) {
    return this.employeesService.update(id, dto, user?.id, { role: user?.role, agencyId: user?.agencyId, agencyIsSystem: user?.agencyIsSystem, tenantId: user?.tenantId });
  }

  @Patch(':id/photo')
  @Roles(...WRITE_ROLES)
  @RequirePermission('employees:update')
  @ApiOperation({ summary: 'Upload or replace employee photo' })
  @ApiConsumes('multipart/form-data')
  @UseInterceptors(FileInterceptor('photo', memoryUpload({
    mimeTypes: IMAGE_MIME,
    maxBytes: 5 * 1024 * 1024,
  })))
  uploadPhoto(@Param('id') id: string, @UploadedFile() file: Express.Multer.File) {
    if (!file) throw new BadRequestException('No photo file provided');
    return this.employeesService.uploadPhoto(id, file);
  }

  @Patch(':id/status')
  @Roles(...WRITE_ROLES)
  @RequirePermission('employees:update')
  @ApiOperation({ summary: 'Update employee status' })
  updateStatus(@Param('id') id: string, @Body('status') status: string, @CurrentUser() user: any) {
    return this.employeesService.updateStatus(id, status, user?.id, { role: user?.role, agencyId: user?.agencyId, agencyIsSystem: user?.agencyIsSystem });
  }

  // §4.11 EMPLOYEE_PROFILE_LOCKED trigger. Body: { locked: boolean }.
  // Toggling the lock notifies the affected employee user account + HR.
  @Patch(':id/profile-lock')
  @Roles(...WRITE_ROLES)
  @RequirePermission('employees:update')
  @ApiOperation({ summary: 'Lock or unlock an employee\'s self-edit access' })
  setProfileLock(
    @Param('id') id: string,
    @Body() body: { locked: boolean },
    @CurrentUser() user: any,
  ) {
    return this.employeesService.setProfileLock(id, !!body?.locked, user?.id, {
      role: user?.role, agencyId: user?.agencyId, agencyIsSystem: user?.agencyIsSystem,
    });
  }

  @Delete(':id')
  @Roles('System Admin')
  @RequirePermission('employees:delete')
  @ApiOperation({ summary: 'Delete employee (soft delete)' })
  remove(@Param('id') id: string, @CurrentUser() user: any) {
    return this.employeesService.remove(id, user?.id, { role: user?.role, agencyId: user?.agencyId, agencyIsSystem: user?.agencyIsSystem });
  }
}
