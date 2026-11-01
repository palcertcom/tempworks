import {
  Controller, Get, Post, Body, Patch, Param, Delete,
  Query, UseGuards, HttpCode, HttpStatus, UseInterceptors,
  UploadedFile, BadRequestException, Res,
} from '@nestjs/common';
import { Response } from 'express';
import { FileInterceptor } from '@nestjs/platform-express';
import { memoryUpload, DOCUMENT_MIME } from '../common/storage/multer.config';
import {
  ApiTags, ApiOperation, ApiResponse, ApiBearerAuth,
  ApiParam, ApiConsumes, ApiBody,
} from '@nestjs/swagger';
import { DocumentsService } from './documents.service';
import { CreateDocumentDto } from './dto/create-document.dto';
import { VerifyDocumentDto } from './dto/verify-document.dto';
import { FilterDocumentsDto } from './dto/filter-documents.dto';
import { RenewDocumentDto } from './dto/renew-document.dto';
import { PaginationDto } from '../common/dto/pagination.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { RequirePermission } from '../auth/decorators/require-permission.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Public } from '../auth/decorators/public.decorator';

const fileInterceptor = (_optional = false) =>
  FileInterceptor('file', memoryUpload({
    mimeTypes: DOCUMENT_MIME,
    maxBytes: parseInt(process.env.MAX_FILE_SIZE || '10485760'),
  }));

@ApiTags('Documents')
@ApiBearerAuth('access-token')
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('documents')
export class DocumentsController {
  constructor(private readonly documentsService: DocumentsService) {}

  // ── List ───────────────────────────────────────────────────────────────────

  @Get()
  @Roles('System Admin', 'HR Manager', 'Compliance Officer', 'Recruiter', 'Finance', 'Read Only')
  @RequirePermission('documents:read')
  @ApiOperation({ summary: 'Get all documents (filterable, sortable, paginated)' })
  findAll(@Query() filter: FilterDocumentsDto, @CurrentUser() user: any) {
    return this.documentsService.findAll(filter, user);
  }

  @Get('expiring')
  @Roles('System Admin', 'HR Manager', 'Compliance Officer', 'Recruiter', 'Read Only')
  @RequirePermission('documents:read')
  @ApiOperation({ summary: 'Get documents expiring within N days' })
  getExpiring(@Query('days') days?: number) {
    return this.documentsService.getExpiringDocuments(days || 30);
  }

  @Get('kpis')
  @Roles('System Admin', 'HR Manager', 'Compliance Officer', 'Recruiter', 'Finance', 'Read Only')
  @RequirePermission('documents:read')
  @ApiOperation({ summary: 'KPI counters (valid / expiringSoon / expired / pending) for the same scope as findAll' })
  getKpis(@Query() filter: FilterDocumentsDto, @CurrentUser() user: any) {
    return this.documentsService.getKpis(filter, user);
  }

  @Get('entity/:entityType/:entityId')
  @Roles('System Admin', 'HR Manager', 'Compliance Officer', 'Recruiter', 'Finance', 'Read Only')
  @RequirePermission('documents:read')
  @ApiOperation({ summary: 'Get all documents for a specific entity (Candidate / Employee)' })
  @ApiParam({ name: 'entityType', description: 'EMPLOYEE | APPLICANT | AGENCY | USER' })
  @ApiParam({ name: 'entityId', description: 'Entity UUID' })
  findByEntity(
    @Param('entityType') entityType: string,
    @Param('entityId') entityId: string,
    @Query() pagination: PaginationDto,
    @Query('archived') archived: string | undefined,
    @CurrentUser() user: any,
  ) {
    return this.documentsService.findByEntity(entityType, entityId, { ...pagination, archived } as any, user);
  }

  @Get(':id')
  @Roles('System Admin', 'HR Manager', 'Compliance Officer', 'Recruiter', 'Finance', 'Read Only')
  // attendance:read lets an attendance manager open a day's proof file;
  // the service restricts such callers to ATTENDANCE-linked documents.
  @RequirePermission('documents:read', 'attendance:read')
  @ApiOperation({ summary: 'Get document by internal UUID' })
  findOne(@Param('id') id: string, @CurrentUser() user: any) {
    return this.documentsService.findOne(id, user);
  }

  // ── File proxy ─────────────────────────────────────────────────────────────
  // Streams the document bytes from storage (Spaces / disk) through the API
  // origin. The browser cannot fetch Spaces URLs directly because the bucket
  // has no CORS headers; this same-origin proxy unblocks the front-end PDF
  // bundler and any other client that needs to read raw bytes.

  @Get(':id/file')
  @Roles('System Admin', 'HR Manager', 'Compliance Officer', 'Recruiter', 'Finance', 'Read Only')
  // attendance:read lets an attendance manager stream a day's proof
  // file; the service restricts such callers to ATTENDANCE-linked docs.
  @RequirePermission('documents:read', 'attendance:read')
  @ApiOperation({ summary: 'Stream the document file bytes (CORS-safe proxy)' })
  async streamFile(@Param('id') id: string, @Res() res: Response, @CurrentUser() user: any) {
    const { buffer, mimeType, name } = await this.documentsService.readDocumentBytes(id, user);
    res.setHeader('Content-Type', mimeType || 'application/octet-stream');
    res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(name)}"`);
    res.setHeader('Content-Length', buffer.length);
    res.end(buffer);
  }

  // ── Bulk download ──────────────────────────────────────────────────────────

  @Post('bulk-download')
  @Roles('System Admin', 'HR Manager', 'Compliance Officer', 'Recruiter', 'Finance', 'Read Only')
  @RequirePermission('documents:create')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Download multiple documents as a structured ZIP archive' })
  async bulkDownload(@Body() dto: { ids: string[] }, @Res() res: Response, @CurrentUser() user: any) {
    if (!dto.ids?.length) { res.status(400).json({ message: 'No document IDs provided' }); return; }
    const buffer = await this.documentsService.createBulkDownloadArchive(dto.ids, user);
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="documents_${Date.now()}.zip"`);
    res.setHeader('Content-Length', buffer.length);
    res.end(buffer);
  }

  // ── Public upload (no auth) ────────────────────────────────────────────────
  // SECURITY: This endpoint is unauthenticated by design — it backs the public
  // /apply form. The shared `fileInterceptor` enforces the document MIME
  // allow-list and the MAX_FILE_SIZE cap, but the route is still abusable as
  // a free file host. TODO(security): rate-limit per IP, add a short-lived
  // upload token issued by /apply form load, or front it behind a CAPTCHA.

  @Public()
  @Post('public/upload')
  @UseInterceptors(fileInterceptor())
  @ApiConsumes('multipart/form-data')
  @ApiOperation({ summary: 'Public document upload for applicant form submissions (no auth)' })
  @ApiBody({
    schema: {
      type: 'object', required: ['file', 'entityId', 'name'],
      properties: {
        file:             { type: 'string', format: 'binary' },
        entityId:         { type: 'string' },
        name:             { type: 'string' },
        documentTypeName: { type: 'string' },
      },
    },
  })
  async publicUpload(
    @UploadedFile() file: Express.Multer.File,
    @Body('entityId') entityId: string,
    @Body('name') name: string,
    @Body('documentTypeName') documentTypeName: string,
    @Body('sectionKey') sectionKey: string | undefined,
  ) {
    if (!file)     throw new BadRequestException({ code: 'GENERIC.FILE_REQUIRED', message: 'File is required' });
    if (!entityId) throw new BadRequestException({ code: 'DOCUMENT.ENTITY_ID_REQUIRED', message: 'entityId is required' });
    return this.documentsService.publicCreate(file, entityId, name || file.originalname, documentTypeName || 'Other', sectionKey);
  }

  // ── Authenticated upload ───────────────────────────────────────────────────

  @Post('upload')
  @Roles('System Admin', 'HR Manager', 'Compliance Officer', 'Recruiter')
  @RequirePermission('documents:create')
  @UseInterceptors(fileInterceptor())
  @ApiConsumes('multipart/form-data')
  @ApiOperation({ summary: 'Upload a document with file (authenticated)' })
  @ApiBody({
    schema: {
      type: 'object', required: ['file', 'name', 'documentTypeId', 'entityType', 'entityId'],
      properties: {
        file:           { type: 'string', format: 'binary' },
        name:           { type: 'string' },
        documentTypeId: { type: 'string' },
        entityType:     { type: 'string' },
        entityId:       { type: 'string' },
        issueDate:      { type: 'string', format: 'date' },
        expiryDate:     { type: 'string', format: 'date' },
        issueCountry:   { type: 'string' },
        issuer:         { type: 'string' },
        documentNumber: { type: 'string' },
        notes:          { type: 'string' },
      },
    },
  })
  async upload(
    @UploadedFile() file: Express.Multer.File,
    @Body() dto: CreateDocumentDto,
    @CurrentUser() user: any,
  ) {
    if (!file) throw new BadRequestException({ code: 'GENERIC.FILE_REQUIRED', message: 'File is required' });
    return this.documentsService.create(dto, file, user.id, user?.tenantId);
  }

  // ── Renew ──────────────────────────────────────────────────────────────────

  @Post(':id/renew')
  @Roles('System Admin', 'HR Manager', 'Compliance Officer', 'Recruiter')
  @RequirePermission('documents:create')
  @UseInterceptors(fileInterceptor(true))
  @ApiConsumes('multipart/form-data')
  @ApiOperation({
    summary: 'Renew a document — upload the new file; the original is auto-archived',
    description: 'A new document file is REQUIRED. Creates a new PENDING document linked to the original, then archives the original (kept in history, removed from the active set).',
  })
  async renew(
    @Param('id') id: string,
    @UploadedFile() file: Express.Multer.File | undefined,
    @Body() dto: RenewDocumentDto,
    @CurrentUser() user: any,
  ) {
    return this.documentsService.renew(id, dto, file, user.id);
  }

  // ── Verify / reject ────────────────────────────────────────────────────────

  @Post(':id/verify')
  @Roles('System Admin', 'HR Manager', 'Compliance Officer')
  // Approve/reject changes the document's status — an edit action — so
  // it is governed by documents:update, which is the "Documents → Edit"
  // toggle in the Roles UI (the UI exposes only View/Create/Edit/Delete;
  // there is no Verify column). The on-screen buttons gate on the same
  // key, so visibility == capability and admins control who can approve
  // via Documents → Edit. OR-semantics with @Roles keep built-in roles.
  @RequirePermission('documents:update')
  @ApiOperation({ summary: 'Verify (approve) or reject a document' })
  verify(@Param('id') id: string, @Body() dto: VerifyDocumentDto, @CurrentUser() user: any) {
    return this.documentsService.verify(id, dto, user.id);
  }

  // ── Update metadata ────────────────────────────────────────────────────────

  @Patch(':id')
  @Roles('System Admin', 'HR Manager', 'Compliance Officer')
  @RequirePermission('documents:update')
  @ApiOperation({ summary: 'Update document metadata' })
  update(@Param('id') id: string, @Body() dto: Partial<CreateDocumentDto>, @CurrentUser() user: any) {
    return this.documentsService.update(id, dto, user?.id);
  }

  // ── Archive (manual "No longer valid") ─────────────────────────────────────

  @Post(':id/archive')
  @Roles('System Admin', 'HR Manager', 'Compliance Officer')
  @RequirePermission('documents:update')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Archive a document ("No longer valid") — keeps it in history, hides it from active views' })
  archive(@Param('id') id: string, @CurrentUser() user: any) {
    return this.documentsService.archive(id, user?.id);
  }

  @Post(':id/unarchive')
  @Roles('System Admin', 'HR Manager', 'Compliance Officer')
  @RequirePermission('documents:update')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Restore an archived document to the active set' })
  unarchive(@Param('id') id: string, @CurrentUser() user: any) {
    return this.documentsService.unarchive(id, user?.id);
  }

  // ── Delete ─────────────────────────────────────────────────────────────────

  @Delete(':id')
  @Roles('System Admin')
  @RequirePermission('documents:delete')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Soft-delete a document (System Admin only)' })
  remove(@Param('id') id: string, @CurrentUser() user: any) {
    return this.documentsService.remove(id, user?.id);
  }

  // ── Document-type permission matrix ───────────────────────────────────────

  @Get('type-permissions/:documentTypeId')
  @Roles('System Admin', 'HR Manager')
  @RequirePermission('documents:read')
  @ApiOperation({ summary: 'Get per-role permissions for a document type' })
  getDocTypePermissions(@Param('documentTypeId') documentTypeId: string) {
    return this.documentsService.getDocTypePermissions(documentTypeId);
  }

  @Post('type-permissions/:documentTypeId/:roleId')
  @Roles('System Admin', 'HR Manager')
  @RequirePermission('documents:create')
  @ApiOperation({ summary: 'Set permissions for a role on a specific document type' })
  upsertDocTypePermission(
    @Param('documentTypeId') documentTypeId: string,
    @Param('roleId') roleId: string,
    @Body() body: { canUpload?: boolean; canView?: boolean; canEdit?: boolean; canDelete?: boolean; canRenew?: boolean },
  ) {
    return this.documentsService.upsertDocTypePermission(documentTypeId, roleId, body);
  }
}
