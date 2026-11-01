import {
  Controller, Get, Post, Body, Patch, Param, Delete,
  Query, UseGuards, HttpCode, HttpStatus,
  UseInterceptors, UploadedFile, BadRequestException, Req,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiBearerAuth, ApiParam, ApiQuery, ApiConsumes } from '@nestjs/swagger';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Request } from 'express';
import { memoryUpload, LOGO_IMAGE_MIME } from '../common/storage/multer.config';
import { SettingsService } from './settings.service';
import { I18nService } from '../common/i18n/i18n.service';
import { BatchUpdateSettingsDto } from './dto/update-settings.dto';
import { CreateJobTypeDto } from './dto/create-job-type.dto';
import { CreateDocumentTypeDto } from './dto/create-document-type.dto';
import { CreateNotificationRuleDto } from './dto/create-notification-rule.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { RequirePermission } from '../auth/decorators/require-permission.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Public } from '../auth/decorators/public.decorator';

@ApiTags('Settings')
@ApiBearerAuth('access-token')
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('settings')
export class SettingsController {
  constructor(
    private readonly settingsService: SettingsService,
    private readonly i18n: I18nService,
  ) {}

  @Get()
  @ApiOperation({ summary: 'Get system settings (grouped by category)' })
  @ApiQuery({ name: 'includePrivate', required: false })
  findAll(@Query('includePrivate') includePrivate?: boolean, @CurrentUser() user?: any) {
    const isAdmin = user?.role === 'System Admin';
    return this.settingsService.findAll(isAdmin && !!includePrivate);
  }

  @Patch()
  @Roles('System Admin')
  @RequirePermission('settings:update')
  @ApiOperation({ summary: 'Batch update settings' })
  batchUpdate(@Body() dto: BatchUpdateSettingsDto, @CurrentUser() user: any) {
    // Phase 3.17 — branding.* keys are routed to the active tenant.
    return this.settingsService.batchUpdate(dto, user.id, user?.tenantId);
  }

  // Public form settings (no auth required)
  @Public()
  @Get('public/form')
  @ApiOperation({ summary: 'Get public form configuration (visa types, qualifications, etc.)' })
  getPublicFormSettings() { return this.settingsService.getPublicFormSettings(); }

  // ─── Vehicle Settings (centralised lookups) ─────────────────────────────
  // GET returns every vehicle lookup list keyed by short name (e.g.
  // statuses, fuelTypes, bodyTypes, …). PATCH accepts the same shape.
  @Get('vehicle')
  @ApiOperation({ summary: 'Get all centralised vehicle lookup lists' })
  getVehicleSettings() {
    return this.settingsService.getVehicleSettings();
  }

  @Patch('vehicle/:key')
  @Roles('System Admin')
  @RequirePermission('settings:update')
  @ApiOperation({ summary: 'Update one vehicle lookup list (e.g. statuses, fuelTypes, bodyTypes)' })
  @ApiParam({ name: 'key' })
  updateVehicleSetting(
    @Param('key') key: string,
    @Body() body: { values: string[] },
    @CurrentUser() user: any,
  ) {
    return this.settingsService.updateVehicleSetting(key, body.values ?? [], user.id);
  }

  // Job Types
  @Public()
  @Get('job-types')
  @ApiOperation({ summary: 'Get job types (active only by default; pass ?includeInactive=true for the settings page)' })
  @ApiQuery({ name: 'includeInactive', required: false })
  async findJobTypes(@Req() req: Request, @Query('includeInactive') includeInactive?: string) {
    const rows = await this.settingsService.findJobTypes({
      includeInactive: includeInactive === 'true' || includeInactive === '1',
    });
    const locale = this.i18n.resolve(req);
    return rows.map((r: any) => ({
      ...r,
      name: I18nService.localized(r, locale, 'name'),
      description: I18nService.localized(r, locale, 'description'),
    }));
  }

  @Post('job-types')
  @Roles('System Admin', 'HR Manager')
  @RequirePermission('settings:create')
  @ApiOperation({ summary: 'Create a job type' })
  createJobType(@Body() dto: CreateJobTypeDto, @CurrentUser() user: any) {
    return this.settingsService.createJobType(dto, user?.id);
  }

  @Patch('job-types/:id')
  @Roles('System Admin', 'HR Manager')
  @RequirePermission('settings:update')
  @ApiOperation({ summary: 'Update a job type' })
  @ApiParam({ name: 'id' })
  updateJobType(@Param('id') id: string, @Body() dto: Partial<CreateJobTypeDto>, @CurrentUser() user: any) {
    return this.settingsService.updateJobType(id, dto, user?.id);
  }

  @Delete('job-types/:id')
  @Roles('System Admin')
  @RequirePermission('settings:delete')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Deactivate a job type' })
  @ApiParam({ name: 'id' })
  deleteJobType(@Param('id') id: string, @CurrentUser() user: any) {
    return this.settingsService.deleteJobType(id, user?.id);
  }

  // ─── Finance Transaction Types ──────────────────────────────────────────────

  @Get('transaction-types')
  @ApiOperation({ summary: 'List configurable transaction types (active only by default)' })
  findTransactionTypes(@Query('includeInactive') includeInactive?: string) {
    return this.settingsService.findTransactionTypes({
      includeInactive: includeInactive === 'true',
    });
  }

  @Post('transaction-types')
  @Roles('System Admin', 'HR Manager', 'Finance')
  @RequirePermission('settings:create')
  @ApiOperation({ summary: 'Create a transaction type' })
  createTransactionType(
    @Body() dto: { name: string; sortOrder?: number; isActive?: boolean },
    @CurrentUser() user: any,
  ) {
    return this.settingsService.createTransactionType(dto, user?.id);
  }

  @Patch('transaction-types/:id')
  @Roles('System Admin', 'HR Manager', 'Finance')
  @RequirePermission('settings:update')
  @ApiOperation({ summary: 'Update a transaction type' })
  @ApiParam({ name: 'id' })
  updateTransactionType(
    @Param('id') id: string,
    @Body() dto: { name?: string; sortOrder?: number; isActive?: boolean },
    @CurrentUser() user: any,
  ) {
    return this.settingsService.updateTransactionType(id, dto, user?.id);
  }

  // ─── Work History Event Types ──────────────────────────────────────────────

  @Get('work-history-event-types')
  @ApiOperation({ summary: 'List configurable Work History event types (active only by default)' })
  findWorkHistoryEventTypes(@Query('includeInactive') includeInactive?: string) {
    return this.settingsService.findWorkHistoryEventTypes({
      includeInactive: includeInactive === 'true',
    });
  }

  @Post('work-history-event-types')
  @Roles('System Admin', 'HR Manager')
  @RequirePermission('settings:create')
  @ApiOperation({ summary: 'Create a Work History event type' })
  createWorkHistoryEventType(
    @Body() dto: { value: string; label: string; sortOrder?: number; isActive?: boolean },
    @CurrentUser() user: any,
  ) {
    return this.settingsService.createWorkHistoryEventType(dto, user?.id);
  }

  @Patch('work-history-event-types/:id')
  @Roles('System Admin', 'HR Manager')
  @RequirePermission('settings:update')
  @ApiOperation({ summary: 'Update a Work History event type' })
  @ApiParam({ name: 'id' })
  updateWorkHistoryEventType(
    @Param('id') id: string,
    @Body() dto: { value?: string; label?: string; sortOrder?: number; isActive?: boolean },
    @CurrentUser() user: any,
  ) {
    return this.settingsService.updateWorkHistoryEventType(id, dto, user?.id);
  }

  @Delete('work-history-event-types/:id')
  @Roles('System Admin')
  @RequirePermission('settings:delete')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Deactivate a Work History event type' })
  @ApiParam({ name: 'id' })
  deleteWorkHistoryEventType(@Param('id') id: string, @CurrentUser() user: any) {
    return this.settingsService.deleteWorkHistoryEventType(id, user?.id);
  }

  @Delete('transaction-types/:id')
  @Roles('System Admin', 'Finance')
  @RequirePermission('settings:delete')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Deactivate a transaction type' })
  @ApiParam({ name: 'id' })
  deleteTransactionType(@Param('id') id: string, @CurrentUser() user: any) {
    return this.settingsService.deleteTransactionType(id, user?.id);
  }

  // Document Types
  @Get('document-types')
  @ApiOperation({ summary: 'Get all active document types' })
  async findDocumentTypes(@Req() req: Request) {
    const rows = await this.settingsService.findDocumentTypes();
    const locale = this.i18n.resolve(req);
    return rows.map((r: any) => ({
      ...r,
      name: I18nService.localized(r, locale, 'name'),
      description: I18nService.localized(r, locale, 'description'),
    }));
  }

  @Get('document-types/:id')
  @ApiOperation({ summary: 'Get a document type by ID' })
  @ApiParam({ name: 'id' })
  findDocumentType(@Param('id') id: string) {
    return this.settingsService.findDocumentType(id);
  }

  @Post('document-types')
  @Roles('System Admin', 'HR Manager')
  @RequirePermission('settings:create')
  @ApiOperation({ summary: 'Create a document type' })
  createDocumentType(@Body() dto: CreateDocumentTypeDto, @CurrentUser() user: any) {
    return this.settingsService.createDocumentType(dto, user?.id);
  }

  @Patch('document-types/:id')
  @Roles('System Admin', 'HR Manager')
  @RequirePermission('settings:update')
  @ApiOperation({ summary: 'Update a document type' })
  @ApiParam({ name: 'id' })
  updateDocumentType(@Param('id') id: string, @Body() dto: Partial<CreateDocumentTypeDto>, @CurrentUser() user: any) {
    return this.settingsService.updateDocumentType(id, dto, user?.id);
  }

  @Delete('document-types/:id')
  @Roles('System Admin')
  @RequirePermission('settings:delete')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Deactivate a document type' })
  @ApiParam({ name: 'id' })
  deleteDocumentType(@Param('id') id: string, @CurrentUser() user: any) {
    return this.settingsService.deleteDocumentType(id, user?.id);
  }

  // Workflow Stages
  @Get('workflow-stages')
  @ApiOperation({ summary: 'Get all workflow stages' })
  findWorkflowStages() { return this.settingsService.findWorkflowStages(); }

  @Post('workflow-stages')
  @Roles('System Admin')
  @RequirePermission('settings:create')
  @ApiOperation({ summary: 'Create a workflow stage' })
  createWorkflowStage(@Body() dto: any, @CurrentUser() user: any) {
    return this.settingsService.createWorkflowStage(dto, user?.id);
  }

  @Patch('workflow-stages/reorder')
  @Roles('System Admin')
  @RequirePermission('settings:update')
  @ApiOperation({ summary: 'Bulk reorder workflow stages' })
  reorderWorkflowStages(@Body() body: { orders: { id: string; order: number }[] }, @CurrentUser() user: any) {
    return this.settingsService.reorderWorkflowStages(body.orders, user?.id);
  }

  @Patch('workflow-stages/:id')
  @Roles('System Admin')
  @RequirePermission('settings:update')
  @ApiOperation({ summary: 'Update a workflow stage' })
  @ApiParam({ name: 'id' })
  updateWorkflowStage(@Param('id') id: string, @Body() dto: any, @CurrentUser() user: any) {
    return this.settingsService.updateWorkflowStage(id, dto, user?.id);
  }

  @Delete('workflow-stages/:id')
  @Roles('System Admin')
  @RequirePermission('settings:delete')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Delete a workflow stage' })
  @ApiParam({ name: 'id' })
  deleteWorkflowStage(@Param('id') id: string, @CurrentUser() user: any) {
    return this.settingsService.deleteWorkflowStage(id, user?.id);
  }

  // Branding
  @Public()
  @Get('branding')
  @ApiOperation({ summary: 'Get company branding settings (public; overlays the active tenant\'s branding)' })
  @ApiQuery({ name: 'tenant', required: false, description: 'Tenant slug or customDomain — overrides whatever the JWT carries' })
  getBranding(@Req() req: Request, @Query('tenant') tenantHint?: string) {
    // Phase 3.17 — tenant-aware branding. Pulls the active tenantId from
    // the bearer JWT if present (best-effort decode, no signature
    // verification — this is a public endpoint). Falls back to the
    // optional ?tenant=<slug-or-domain> query hint, then to the global
    // system defaults.
    // @tenant-reviewed: phase317-multi-tenant-login
    let tenantIdFromJwt: string | null = null;
    const auth = (req.headers['authorization'] as string | undefined) ?? '';
    const m = /^Bearer\s+(.+)$/i.exec(auth);
    if (m) {
      try {
        const parts = m[1].split('.');
        if (parts.length === 3) {
          const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
          tenantIdFromJwt = typeof payload?.tenantId === 'string' ? payload.tenantId : null;
        }
      } catch { tenantIdFromJwt = null; }
    }
    return this.settingsService.getBranding({
      tenantId: tenantIdFromJwt ?? undefined,
      tenantHint: tenantHint ?? undefined,
    });
  }

  @Post('branding/logo')
  @Roles('System Admin')
  @RequirePermission('settings:create')
  @ApiOperation({ summary: 'Upload company logo' })
  @ApiConsumes('multipart/form-data')
  // SVG is excluded — see common/storage/multer.config.ts.
  @UseInterceptors(FileInterceptor('logo', memoryUpload({
    mimeTypes: LOGO_IMAGE_MIME,
    maxBytes: 2 * 1024 * 1024,
  })))
  uploadLogo(@UploadedFile() file: Express.Multer.File, @CurrentUser() user: any) {
    if (!file) throw new BadRequestException('No logo file provided');
    // Phase 3.17 — pass the active tenant so the upload lands on the
    // tenant's branding (the per-tenant overlay in /settings/branding)
    // instead of the global system setting that every tenant shares.
    // @tenant-reviewed: phase317-multi-tenant-login
    return this.settingsService.uploadLogo(file, user.id, user?.tenantId);
  }

  // System Information
  @Get('system-info')
  @ApiOperation({ summary: 'Get system information settings' })
  getSystemInfo() { return this.settingsService.getSystemInfo(); }

  @Get('system-stats')
  @ApiOperation({ summary: 'Get live system statistics' })
  getSystemStats() { return this.settingsService.getSystemStats(); }

  @Patch('system-info')
  @Roles('System Admin')
  @RequirePermission('settings:update')
  @ApiOperation({ summary: 'Update system information settings' })
  updateSystemInfo(@Body() data: Record<string, string>, @CurrentUser() user: any) {
    return this.settingsService.updateSystemInfo(data, user.id);
  }

  // Notification Rules
  @Get('notification-rules')
  @ApiOperation({ summary: 'Get all notification rules' })
  findNotificationRules() { return this.settingsService.findNotificationRules(); }

  @Post('notification-rules')
  @Roles('System Admin', 'HR Manager')
  @RequirePermission('settings:create')
  @ApiOperation({ summary: 'Create a notification rule' })
  createNotificationRule(@Body() dto: CreateNotificationRuleDto, @CurrentUser() user: any) {
    return this.settingsService.createNotificationRule(dto, user?.id);
  }

  @Patch('notification-rules/:id')
  @Roles('System Admin', 'HR Manager')
  @RequirePermission('settings:update')
  @ApiOperation({ summary: 'Update a notification rule' })
  @ApiParam({ name: 'id' })
  updateNotificationRule(@Param('id') id: string, @Body() dto: Partial<CreateNotificationRuleDto>, @CurrentUser() user: any) {
    return this.settingsService.updateNotificationRule(id, dto, user?.id);
  }

  @Delete('notification-rules/:id')
  @Roles('System Admin')
  @RequirePermission('settings:delete')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Delete a notification rule' })
  @ApiParam({ name: 'id' })
  deleteNotificationRule(@Param('id') id: string, @CurrentUser() user: any) {
    return this.settingsService.deleteNotificationRule(id, user?.id);
  }
}
