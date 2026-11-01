import {
  Controller, Get, Post, Put, Patch, Delete, Body, Param, Query,
  UseGuards, HttpCode, HttpStatus, Res, Headers,
} from '@nestjs/common';
import { Response } from 'express';
import { resolveAcceptLanguage } from '../common/i18n/server-translate';
import {
  ApiTags, ApiOperation, ApiBearerAuth, ApiParam, ApiBody,
} from '@nestjs/swagger';
import { ReportsService } from './reports.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { RequirePermission } from '../auth/decorators/require-permission.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import {
  CreateReportDto, UpdateReportDto, RunReportDto, ExportReportDto, PreviewReportDto,
  ShareReportDto, SetReportVisibilityDto,
} from './dto/report.dto';
import { isPlatformAuthority } from '../saas/prisma/super-user-tenant-filter';

const ALL_REPORT_ROLES = ['System Admin', 'HR Manager', 'Compliance Officer', 'Recruiter', 'Finance', 'Read Only'];
const EDIT_ROLES       = ['System Admin', 'HR Manager', 'Finance'];

@ApiTags('Reports')
@ApiBearerAuth('access-token')
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('reports')
export class ReportsController {
  constructor(private readonly reportsService: ReportsService) {}

  // ── Meta ────────────────────────────────────────────────────────────────

  @Get('dashboard')
  @Roles(...ALL_REPORT_ROLES)
  @RequirePermission('reports:read')
  @ApiOperation({ summary: 'Live dashboard KPIs (employee/applicant/compliance counts)' })
  getDashboard(
    @Query('tenantId') tenantIdQuery: string | undefined,
    @CurrentUser() user: any,
  ) {
    // SUPER USERs may override the session tenant via ?tenantId= so the
    // dashboard KPIs match what the per-page Tenant filter shows on
    // list pages (Documents/Applicants/Employees/...). Non-SUPER
    // callers' override is silently dropped — agencyIsSystem is the
    // sole gate, matching every other report endpoint.
    const isSuper = isPlatformAuthority({ agencyIsSystem: user?.agencyIsSystem, role: user?.role });
    const effectiveTenantId = (isSuper && tenantIdQuery?.trim()) ? tenantIdQuery.trim() : user?.tenantId;
    return this.reportsService.getDashboard({
      role: user?.role,
      agencyId: user?.agencyId,
      agencyIsSystem: user?.agencyIsSystem,
      tenantId: effectiveTenantId,
    });
  }

  @Get('data-sources')
  @Roles(...ALL_REPORT_ROLES)
  @RequirePermission('reports:read')
  @ApiOperation({ summary: 'List data sources the caller is entitled to build reports on' })
  getDataSources(@CurrentUser() user: any) {
    return this.reportsService.getDataSources({ id: user?.id, agencyId: user?.agencyId });
  }

  // ── Saved report CRUD ────────────────────────────────────────────────────

  @Get()
  @Roles(...ALL_REPORT_ROLES)
  @RequirePermission('reports:read')
  @ApiOperation({ summary: 'List saved reports the caller can see (owned + shared + public-in-tenant)' })
  findAll(
    @Query('tenantId') tenantIdQuery: string | undefined,
    @CurrentUser() user: any,
  ) {
    return this.reportsService.findAll(
      { id: user?.id, agencyId: user?.agencyId, agencyIsSystem: user?.agencyIsSystem, tenantId: user?.tenantId },
      tenantIdQuery,
    );
  }

  @Post()
  @Roles(...EDIT_ROLES)
  @RequirePermission('reports:create')
  @ApiOperation({ summary: 'Save a new report configuration (visibility defaults to PRIVATE)' })
  create(@Body() dto: CreateReportDto, @CurrentUser() user: any) {
    return this.reportsService.create(dto, user?.id, { agencyId: user?.agencyId, tenantId: user?.tenantId });
  }

  // ── Preview (Phase 3 hardening: does NOT save) ───────────────────────────

  @Post('preview')
  @Roles(...ALL_REPORT_ROLES)
  @RequirePermission('reports:read')
  @ApiOperation({ summary: 'Preview an UNSAVED report definition (returns up to 50 rows; does not persist)' })
  preview(@Body() dto: PreviewReportDto, @CurrentUser() user: any) {
    return this.reportsService.previewInline(dto, { id: user?.id, agencyId: user?.agencyId });
  }

  @Get(':id')
  @Roles(...ALL_REPORT_ROLES)
  @RequirePermission('reports:read')
  @ApiOperation({ summary: 'Get a saved report by ID (access-gated)' })
  @ApiParam({ name: 'id', description: 'Report UUID' })
  findOne(@Param('id') id: string, @CurrentUser() user: any) {
    return this.reportsService.findOne(id, { id: user?.id, agencyId: user?.agencyId, tenantId: user?.tenantId });
  }

  @Put(':id')
  @Roles(...EDIT_ROLES)
  @RequirePermission('reports:create')
  @ApiOperation({ summary: 'Update a saved report (owner or EDIT/SHARE grantee only)' })
  @ApiParam({ name: 'id', description: 'Report UUID' })
  update(@Param('id') id: string, @Body() dto: UpdateReportDto, @CurrentUser() user: any) {
    return this.reportsService.update(id, dto, { id: user?.id, agencyId: user?.agencyId, tenantId: user?.tenantId });
  }

  @Delete(':id')
  @Roles(...EDIT_ROLES)
  @RequirePermission('reports:delete')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Soft-delete a saved report (owner only)' })
  @ApiParam({ name: 'id', description: 'Report UUID' })
  remove(@Param('id') id: string, @CurrentUser() user: any) {
    return this.reportsService.remove(id, { id: user?.id, agencyId: user?.agencyId, tenantId: user?.tenantId });
  }

  // ── Sharing & visibility (Phase B, backend-only) ─────────────────────────

  @Patch(':id/visibility')
  @Roles(...ALL_REPORT_ROLES)
  @RequirePermission('reports:read')
  @ApiOperation({ summary: 'Change report visibility (owner only)' })
  @ApiParam({ name: 'id', description: 'Report UUID' })
  setVisibility(@Param('id') id: string, @Body() dto: SetReportVisibilityDto, @CurrentUser() user: any) {
    return this.reportsService.setVisibility(id, dto.visibility, { id: user?.id, agencyId: user?.agencyId, tenantId: user?.tenantId });
  }

  @Post(':id/share')
  @Roles(...ALL_REPORT_ROLES)
  @RequirePermission('reports:read')
  @ApiOperation({ summary: 'Grant a user access to this report (owner or SHARE grantee only)' })
  @ApiParam({ name: 'id', description: 'Report UUID' })
  share(@Param('id') id: string, @Body() dto: ShareReportDto, @CurrentUser() user: any) {
    return this.reportsService.shareWithUser(id, dto, { id: user?.id, agencyId: user?.agencyId, tenantId: user?.tenantId });
  }

  @Delete(':id/share/:userId')
  @Roles(...ALL_REPORT_ROLES)
  @RequirePermission('reports:read')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Revoke a user\'s access to this report' })
  @ApiParam({ name: 'id', description: 'Report UUID' })
  @ApiParam({ name: 'userId', description: 'Grantee user UUID' })
  revoke(@Param('id') id: string, @Param('userId') userId: string, @CurrentUser() user: any) {
    return this.reportsService.revokeShare(id, userId, { id: user?.id, agencyId: user?.agencyId, tenantId: user?.tenantId });
  }

  // ── Run ──────────────────────────────────────────────────────────────────

  @Post(':id/run')
  @Roles(...ALL_REPORT_ROLES)
  @RequirePermission('reports:read')
  @ApiOperation({ summary: 'Execute a saved report and return paginated rows + column metadata' })
  @ApiParam({ name: 'id', description: 'Report UUID' })
  run(@Param('id') id: string, @Body() dto: RunReportDto, @CurrentUser() user: any) {
    // tenantId is required by resolveReportAccess to evaluate the
    // 'same tenant' fence on explicit shares and PUBLIC_IN_TENANT
    // visibility. Without it a sharee on the same tenant gets 404'd —
    // every other report endpoint in this controller passes it through.
    return this.reportsService.run(id, dto, { id: user?.id, agencyId: user?.agencyId, tenantId: user?.tenantId });
  }

  // ── Export ────────────────────────────────────────────────────────────────

  @Post(':id/export')
  @Roles(...EDIT_ROLES, 'Compliance Officer')
  @RequirePermission('reports:create')
  @ApiOperation({ summary: 'Export a report as Excel, PDF, or Word' })
  @ApiParam({ name: 'id', description: 'Report UUID' })
  @ApiBody({ type: ExportReportDto })
  async exportReport(
    @Param('id') id: string,
    @Body() dto: ExportReportDto,
    @Res() res: Response,
    @Headers('accept-language') acceptLanguage?: string,
  ) {
    const { buffer, mimeType, filename } = await this.reportsService.export(
      id, dto.format, resolveAcceptLanguage(acceptLanguage),
      { id: (res.req as any)?.user?.id, agencyId: (res.req as any)?.user?.agencyId, tenantId: (res.req as any)?.user?.tenantId },
    );
    res.setHeader('Content-Type', mimeType);
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Length', buffer.length);
    res.end(buffer);
  }
}
