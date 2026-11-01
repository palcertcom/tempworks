import {
  Controller, Get, Post, Patch, Delete, Body, Param, Query,
  UseGuards, HttpCode, HttpStatus, Res, Request,
  UseInterceptors, UploadedFile, BadRequestException, Headers,
} from '@nestjs/common';
import { resolveAcceptLanguage } from '../common/i18n/server-translate';
import { FileInterceptor } from '@nestjs/platform-express';
import { memoryUpload, DOCUMENT_MIME } from '../common/storage/multer.config';
import { Response } from 'express';
import { ApiTags, ApiOperation, ApiBearerAuth, ApiConsumes } from '@nestjs/swagger';
import { VehiclesService } from './vehicles.service';
import {
  FilterVehiclesDto,
  CreateVehicleDto,
  UpdateVehicleDto,
  AssignDriverDto,
  CreateVehicleDocumentDto,
  UpdateVehicleDocumentDto,
  CreateMaintenanceTypeDto,
  UpdateMaintenanceTypeDto,
  CreateWorkshopDto,
  UpdateWorkshopDto,
  CreateMaintenanceRecordDto,
  UpdateMaintenanceRecordDto,
  FilterMaintenanceDto,
  ExportVehiclesDto,
} from './dto/vehicles.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { RequirePermission } from '../common/decorators/require-permission.decorator';

const READ_ROLES   = ['System Admin', 'HR Manager', 'Compliance Officer', 'Recruiter', 'Finance'];
const WRITE_ROLES  = ['System Admin', 'HR Manager'];
const EXPORT_ROLES = ['System Admin', 'HR Manager', 'Finance', 'Compliance Officer'];

/**
 * IMPORTANT — route ordering rule (Express/NestJS):
 * Static routes MUST be declared before parametric (:id) routes so they are
 * not swallowed. Order within this controller:
 *   1. Static collection routes (stats, export, maintenance/*, workshops/*)
 *   2. Parametric single-resource routes (:id, :vehicleId/*)
 */
@ApiTags('Vehicles')
@ApiBearerAuth('access-token')
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('vehicles')
export class VehiclesController {
  constructor(private readonly vehiclesService: VehiclesService) {}

  // ── 1. Static list / utility routes (must come before :id) ──────────────────

  @Get()
  @RequirePermission('vehicles:read')
  @Roles(...READ_ROLES)
  @RequirePermission('vehicles:read')
  @ApiOperation({ summary: 'List all vehicles with filters' })
  list(@Query() dto: FilterVehiclesDto, @Request() req: any) {
    return this.vehiclesService.listVehicles(dto, req.user);
  }

  @Get('stats')
  @RequirePermission('vehicles:read')
  @Roles(...READ_ROLES)
  @RequirePermission('vehicles:read')
  @ApiOperation({ summary: 'Get vehicle dashboard statistics' })
  getStats() {
    return this.vehiclesService.getDashboardStats();
  }

  @Get('export/excel')
  @RequirePermission('vehicles:export', 'vehicles:read')
  @Roles(...EXPORT_ROLES)
  @RequirePermission('vehicles:read')
  @ApiOperation({ summary: 'Export vehicle list as Excel' })
  async exportExcel(
    @Query() dto: ExportVehiclesDto,
    @Res() res: Response,
    @Headers('accept-language') acceptLanguage?: string,
  ) {
    const buffer = await this.vehiclesService.exportVehicles(dto, resolveAcceptLanguage(acceptLanguage));
    res.set({
      'Content-Type':        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename="vehicles-${new Date().toISOString().split('T')[0]}.xlsx"`,
      'Content-Length':      buffer.length,
    });
    res.end(buffer);
  }

  // ── 2. Static sub-resource routes — maintenance (before :id) ────────────────

  @Get('maintenance/types')
  @RequirePermission('vehicles:read')
  @Roles(...READ_ROLES)
  @RequirePermission('vehicles:read')
  @ApiOperation({ summary: 'List all maintenance types' })
  listMaintenanceTypes() {
    return this.vehiclesService.listMaintenanceTypes();
  }

  @Post('maintenance/types')
  @RequirePermission('vehicles:create')
  @Roles(...WRITE_ROLES)
  @RequirePermission('vehicles:create')
  @ApiOperation({ summary: 'Create a maintenance type' })
  createMaintenanceType(@Body() dto: CreateMaintenanceTypeDto) {
    return this.vehiclesService.createMaintenanceType(dto);
  }

  @Patch('maintenance/types/:id')
  @RequirePermission('vehicles:update')
  @Roles(...WRITE_ROLES)
  @RequirePermission('vehicles:update')
  @ApiOperation({ summary: 'Update a maintenance type' })
  updateMaintenanceType(@Param('id') id: string, @Body() dto: UpdateMaintenanceTypeDto) {
    return this.vehiclesService.updateMaintenanceType(id, dto);
  }

  @Delete('maintenance/types/:id')
  @RequirePermission('vehicles:delete')
  @Roles(...WRITE_ROLES)
  @RequirePermission('vehicles:delete')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Soft-delete a maintenance type' })
  deleteMaintenanceType(@Param('id') id: string, @Request() req: any) {
    return this.vehiclesService.deleteMaintenanceType(id, req.user?.id);
  }

  @Get('maintenance/records')
  @RequirePermission('vehicles:read')
  @Roles(...READ_ROLES)
  @RequirePermission('vehicles:read')
  @ApiOperation({ summary: 'List maintenance records with filters' })
  listMaintenance(@Query() dto: FilterMaintenanceDto, @Request() req: any) {
    return this.vehiclesService.listMaintenanceRecords(dto, req.user);
  }

  @Get('maintenance/records/export/excel')
  @RequirePermission('vehicles:export', 'vehicles:read')
  @Roles(...EXPORT_ROLES)
  @RequirePermission('vehicles:read')
  @ApiOperation({ summary: 'Export maintenance records as Excel' })
  async exportMaintenanceExcel(
    @Query() dto: FilterMaintenanceDto,
    @Query('recordIds') recordIds: string | string[] | undefined,
    @Res() res: Response,
    @Headers('accept-language') acceptLanguage?: string,
  ) {
    const ids = !recordIds ? undefined : Array.isArray(recordIds) ? recordIds : recordIds.split(',').filter(Boolean);
    const buffer = await this.vehiclesService.exportMaintenanceRecordsExcel(dto, ids, resolveAcceptLanguage(acceptLanguage));
    res.set({
      'Content-Type':        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename="maintenance-records-${new Date().toISOString().split('T')[0]}.xlsx"`,
      'Content-Length':      buffer.length,
    });
    res.end(buffer);
  }

  @Get('maintenance/records/export/pdf')
  @RequirePermission('vehicles:export', 'vehicles:read')
  @Roles(...EXPORT_ROLES)
  @RequirePermission('vehicles:read')
  @ApiOperation({ summary: 'Export maintenance records as PDF' })
  async exportMaintenancePdf(
    @Query() dto: FilterMaintenanceDto,
    @Query('recordIds') recordIds: string | string[] | undefined,
    @Res() res: Response,
    @Headers('accept-language') acceptLanguage?: string,
  ) {
    const ids = !recordIds ? undefined : Array.isArray(recordIds) ? recordIds : recordIds.split(',').filter(Boolean);
    const buffer = await this.vehiclesService.exportMaintenanceRecordsPdf(dto, ids, resolveAcceptLanguage(acceptLanguage));
    res.set({
      'Content-Type':        'application/pdf',
      'Content-Disposition': `attachment; filename="maintenance-records-${new Date().toISOString().split('T')[0]}.pdf"`,
      'Content-Length':      buffer.length,
    });
    res.end(buffer);
  }

  @Get('maintenance/records/:id')
  @RequirePermission('vehicles:read')
  @Roles(...READ_ROLES)
  @RequirePermission('vehicles:read')
  @ApiOperation({ summary: 'Get a single maintenance record' })
  getMaintenance(@Param('id') id: string) {
    return this.vehiclesService.getMaintenanceRecord(id);
  }

  @Post('maintenance/records')
  @RequirePermission('vehicles:create')
  @Roles(...WRITE_ROLES)
  @RequirePermission('vehicles:create')
  @ApiOperation({ summary: 'Create a maintenance record' })
  createMaintenance(@Body() dto: CreateMaintenanceRecordDto, @Request() req: any) {
    return this.vehiclesService.createMaintenanceRecord(dto, req.user?.id, req.user);
  }

  @Patch('maintenance/records/:id')
  @RequirePermission('vehicles:update')
  @Roles(...WRITE_ROLES)
  @RequirePermission('vehicles:update')
  @ApiOperation({ summary: 'Update a maintenance record' })
  updateMaintenance(@Param('id') id: string, @Body() dto: UpdateMaintenanceRecordDto, @Request() req: any) {
    return this.vehiclesService.updateMaintenanceRecord(id, dto, req.user?.id, req.user);
  }

  @Delete('maintenance/records/:id')
  @RequirePermission('vehicles:delete')
  @Roles(...WRITE_ROLES)
  @RequirePermission('vehicles:delete')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Soft-delete a maintenance record' })
  deleteMaintenance(@Param('id') id: string, @Request() req: any) {
    return this.vehiclesService.deleteMaintenanceRecord(id, req.user?.id, req.user);
  }

  @Post('maintenance/records/:id/attachments')
  @RequirePermission('vehicles:create')
  @Roles(...WRITE_ROLES)
  @RequirePermission('vehicles:create')
  // SECURITY-FIX: previously had no fileFilter and no limits.
  @UseInterceptors(FileInterceptor('file', memoryUpload({
    mimeTypes: DOCUMENT_MIME,
    maxBytes: 10 * 1024 * 1024,
  })))
  @ApiConsumes('multipart/form-data')
  @ApiOperation({ summary: 'Upload an attachment (invoice, receipt, etc.) to a maintenance record' })
  uploadMaintenanceAttachment(
    @Param('id') recordId: string,
    @UploadedFile() file: Express.Multer.File,
    @Request() req: any,
  ) {
    if (!file) throw new BadRequestException('No file uploaded');
    return this.vehiclesService.addMaintenanceAttachment(
      recordId,
      file,
      req.body.documentType,
      req.user?.id,
    );
  }

  @Get('maintenance/records/:id/attachments')
  @RequirePermission('vehicles:read')
  @Roles(...READ_ROLES)
  @RequirePermission('vehicles:read')
  @ApiOperation({ summary: 'List all attachments for a maintenance record' })
  getMaintenanceAttachments(@Param('id') recordId: string) {
    return this.vehiclesService.getMaintenanceAttachments(recordId);
  }

  @Delete('maintenance/attachments/:id')
  @RequirePermission('vehicles:delete')
  @Roles(...WRITE_ROLES)
  @RequirePermission('vehicles:delete')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Delete an attachment' })
  deleteMaintenanceAttachment(@Param('id') id: string) {
    return this.vehiclesService.deleteMaintenanceAttachment(id);
  }

  // ── 3. Static sub-resource routes — workshops (before :id) ──────────────────

  @Get('workshops')
  @RequirePermission('vehicles:read')
  @Roles(...READ_ROLES)
  @RequirePermission('vehicles:read')
  @ApiOperation({ summary: 'List all workshops' })
  listWorkshops(@Request() req: any, @Query('tenantId') tenantIdQuery?: string) {
    return this.vehiclesService.listWorkshops(req.user, tenantIdQuery);
  }

  @Post('workshops')
  @RequirePermission('vehicles:create')
  @Roles(...WRITE_ROLES)
  @RequirePermission('vehicles:create')
  @ApiOperation({ summary: 'Create a workshop' })
  createWorkshop(@Body() dto: CreateWorkshopDto, @Request() req: any) {
    return this.vehiclesService.createWorkshop(dto, req.user);
  }

  @Get('workshops/:id')
  @RequirePermission('vehicles:read')
  @Roles(...READ_ROLES)
  @RequirePermission('vehicles:read')
  @ApiOperation({ summary: 'Get a workshop' })
  getWorkshop(@Param('id') id: string, @Request() req: any) {
    return this.vehiclesService.getWorkshop(id, req.user);
  }

  @Patch('workshops/:id')
  @RequirePermission('vehicles:update')
  @Roles(...WRITE_ROLES)
  @RequirePermission('vehicles:update')
  @ApiOperation({ summary: 'Update a workshop' })
  updateWorkshop(@Param('id') id: string, @Body() dto: UpdateWorkshopDto, @Request() req: any) {
    return this.vehiclesService.updateWorkshop(id, dto, req.user);
  }

  @Delete('workshops/:id')
  @RequirePermission('vehicles:delete')
  @Roles(...WRITE_ROLES)
  @RequirePermission('vehicles:delete')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Soft-delete a workshop' })
  deleteWorkshop(@Param('id') id: string, @Request() req: any) {
    return this.vehiclesService.deleteWorkshop(id, req.user?.id, req.user);
  }

  // ── 4. Parametric single-vehicle routes (:id must come last) ────────────────

  @Get(':id')
  @RequirePermission('vehicles:read')
  @Roles(...READ_ROLES)
  @RequirePermission('vehicles:read')
  @ApiOperation({ summary: 'Get a single vehicle with full details' })
  getOne(@Param('id') id: string, @Request() req: any) {
    return this.vehiclesService.getVehicle(id, req.user);
  }

  @Post()
  @RequirePermission('vehicles:create')
  @Roles(...WRITE_ROLES)
  @RequirePermission('vehicles:create')
  @ApiOperation({ summary: 'Create a new vehicle' })
  create(@Body() dto: CreateVehicleDto, @Request() req: any) {
    return this.vehiclesService.createVehicle(dto, req.user?.id, req.user);
  }

  @Patch(':id')
  @RequirePermission('vehicles:update')
  @Roles(...WRITE_ROLES)
  @RequirePermission('vehicles:update')
  @ApiOperation({ summary: 'Update a vehicle' })
  update(@Param('id') id: string, @Body() dto: UpdateVehicleDto, @Request() req: any) {
    return this.vehiclesService.updateVehicle(id, dto, req.user?.id, req.user);
  }

  @Delete(':id')
  @RequirePermission('vehicles:delete')
  @Roles(...WRITE_ROLES)
  @RequirePermission('vehicles:delete')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Soft-delete a vehicle' })
  remove(@Param('id') id: string, @Request() req: any) {
    return this.vehiclesService.deleteVehicle(id, req.user?.id, req.user);
  }

  // ── 5. Parametric sub-resource routes (:vehicleId/*) ────────────────────────

  @Get(':vehicleId/drivers')
  @RequirePermission('vehicles:read')
  @Roles(...READ_ROLES)
  @RequirePermission('vehicles:read')
  @ApiOperation({ summary: 'Get driver assignment history for a vehicle' })
  getDriverHistory(@Param('vehicleId') vehicleId: string) {
    return this.vehiclesService.getDriverHistory(vehicleId);
  }

  @Post(':vehicleId/drivers')
  @RequirePermission('vehicles:create')
  @Roles(...WRITE_ROLES)
  @RequirePermission('vehicles:create')
  @ApiOperation({ summary: 'Assign a driver to a vehicle (replaces current active driver)' })
  assignDriver(@Param('vehicleId') vehicleId: string, @Body() dto: AssignDriverDto, @Request() req: any) {
    return this.vehiclesService.assignDriver(vehicleId, dto, req.user?.id);
  }

  @Delete(':vehicleId/drivers/:assignmentId')
  @RequirePermission('vehicles:delete')
  @Roles(...WRITE_ROLES)
  @RequirePermission('vehicles:delete')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'End a driver assignment' })
  unassignDriver(@Param('vehicleId') vehicleId: string, @Param('assignmentId') assignmentId: string) {
    return this.vehiclesService.unassignDriver(vehicleId, assignmentId);
  }

  @Post(':vehicleId/documents')
  @RequirePermission('vehicles:create')
  @Roles(...WRITE_ROLES)
  @RequirePermission('vehicles:create')
  @ApiConsumes('multipart/form-data')
  @ApiOperation({ summary: 'Add a document (with optional file upload) to a vehicle' })
  @UseInterceptors(FileInterceptor('file', memoryUpload({
    mimeTypes: DOCUMENT_MIME,
    maxBytes: 20 * 1024 * 1024,
  })))
  addDocument(
    @Param('vehicleId') vehicleId: string,
    @Body() dto: CreateVehicleDocumentDto,
    @UploadedFile() file: Express.Multer.File,
    @Request() req: any,
  ) {
    return this.vehiclesService.addDocument(vehicleId, dto, req.user?.id, file);
  }

  @Patch(':vehicleId/documents/:docId')
  @RequirePermission('vehicles:update')
  @Roles(...WRITE_ROLES)
  @RequirePermission('vehicles:update')
  @ApiOperation({ summary: 'Update a vehicle document' })
  updateDocument(
    @Param('vehicleId') vehicleId: string,
    @Param('docId') docId: string,
    @Body() dto: UpdateVehicleDocumentDto,
  ) {
    return this.vehiclesService.updateDocument(vehicleId, docId, dto);
  }

  @Delete(':vehicleId/documents/:docId')
  @RequirePermission('vehicles:delete')
  @Roles(...WRITE_ROLES)
  @RequirePermission('vehicles:delete')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Soft-delete a vehicle document' })
  deleteDocument(@Param('vehicleId') vehicleId: string, @Param('docId') docId: string, @Request() req: any) {
    return this.vehiclesService.deleteDocument(vehicleId, docId, req.user?.id);
  }
}
