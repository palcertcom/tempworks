import {
  Controller, Get, Post, Body, Patch, Param, Delete,
  Query, UseGuards, HttpCode, HttpStatus, UseInterceptors,
  UploadedFile, BadRequestException, Res, Headers,
} from '@nestjs/common';
import { resolveAcceptLanguage } from '../common/i18n/server-translate';
import { Response } from 'express';
import { FileInterceptor } from '@nestjs/platform-express';
import { memoryUpload, DOCUMENT_MIME } from '../common/storage/multer.config';
import {
  ApiTags, ApiOperation, ApiResponse, ApiBearerAuth,
  ApiParam, ApiConsumes, ApiBody,
} from '@nestjs/swagger';
import { FinanceService } from './finance.service';
import { CreateFinancialRecordDto } from './dto/create-financial-record.dto';
import { UpdateFinancialRecordDto } from './dto/update-financial-record.dto';
import { UpdateStatusDto } from './dto/update-status.dto';
import { FilterFinancialRecordsDto } from './dto/filter-financial-records.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { RequirePermission } from '../auth/decorators/require-permission.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import {
  FINANCE_READ_ROLES, FINANCE_WRITE_ROLES,
  FINANCE_STATUS_ROLES, FINANCE_EXPORT_ROLES,
  TRANSACTION_TYPES, PAYMENT_METHODS,
  FINANCIAL_RECORD_STATUSES, COMMON_CURRENCIES,
} from './constants';

@ApiTags('Finance')
@ApiBearerAuth('access-token')
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('finance')
export class FinanceController {
  constructor(private readonly financeService: FinanceService) {}

  // ── Constants endpoint (used by frontend dropdowns) ──────────────────────────

  @Get('constants')
  @Roles(...FINANCE_READ_ROLES)
  @RequirePermission('finance:read')
  @ApiOperation({ summary: 'Get finance module constants (transaction types, payment methods, etc.)' })
  async getConstants() {
    // Transaction types are configurable in Settings → Finance →
    // Transaction Types. Fall back to the hardcoded defaults if the
    // table is empty (fresh install before the startup seed runs).
    const configured = await this.financeService.listTransactionTypes();
    return {
      transactionTypes: configured.length > 0 ? configured.map(t => t.name) : TRANSACTION_TYPES,
      paymentMethods: PAYMENT_METHODS,
      statuses: FINANCIAL_RECORD_STATUSES,
      currencies: COMMON_CURRENCIES,
    };
  }

  // ── List / Global ─────────────────────────────────────────────────────────────

  @Get()
  @Roles(...FINANCE_READ_ROLES)
  @RequirePermission('finance:read')
  @ApiOperation({ summary: 'List financial records (paginated + filtered)' })
  findAll(@Query() filter: FilterFinancialRecordsDto, @CurrentUser() user: any) {
    return this.financeService.findAll(filter, user);
  }

  // ── Export ────────────────────────────────────────────────────────────────────

  @Get('export')
  @Roles(...FINANCE_EXPORT_ROLES)
  @RequirePermission('finance:export')
  @ApiOperation({ summary: 'Export financial records as Excel (.xlsx)' })
  async exportExcel(
    @Query() filter: FilterFinancialRecordsDto,
    @Res() res: Response,
    @Headers('accept-language') acceptLanguage?: string,
  ) {
    const buffer = await this.financeService.exportExcel(filter, resolveAcceptLanguage(acceptLanguage));
    const filename = `financial-records-${new Date().toISOString().slice(0, 10)}.xlsx`;
    res.set({
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Content-Length': buffer.length,
    });
    res.end(buffer);
  }

  // ── Totals for an entity ──────────────────────────────────────────────────────

  @Get('totals/:entityType/:entityId')
  @Roles(...FINANCE_READ_ROLES)
  @RequirePermission('finance:read')
  @ApiOperation({ summary: 'Get financial totals and current balance for a person' })
  @ApiParam({ name: 'entityType', description: "'APPLICANT' or 'EMPLOYEE'" })
  @ApiParam({ name: 'entityId', description: 'Entity UUID' })
  getTotals(
    @Param('entityType') entityType: string,
    @Param('entityId') entityId: string,
  ) {
    return this.financeService.getTotals(entityType, entityId);
  }

  // ── Cross-lifecycle person view ───────────────────────────────────────────────

  @Get('person/:applicantId')
  @Roles(...FINANCE_READ_ROLES)
  @RequirePermission('finance:read')
  @ApiOperation({
    summary: 'Get all financial records for a person across ALL lifecycle stages',
    description:
      'Uses the stable applicantId to retrieve all records whether the person ' +
      'is still a Lead/Candidate or has been converted to an Employee. ' +
      'Also returns the ApplicantFinancialProfile (banking/salary details) ' +
      'and aggregated totals across all stages.',
  })
  @ApiParam({ name: 'applicantId', description: 'Applicant UUID (stable person reference)' })
  getPersonRecords(@Param('applicantId') applicantId: string) {
    return this.financeService.getPersonRecords(applicantId);
  }

  // ── Single record ─────────────────────────────────────────────────────────────

  @Get(':id')
  @Roles(...FINANCE_READ_ROLES)
  @RequirePermission('finance:read')
  @ApiOperation({ summary: 'Get a single financial record by ID' })
  @ApiParam({ name: 'id', description: 'Financial record UUID' })
  findOne(@Param('id') id: string, @CurrentUser() user: any) {
    return this.financeService.findOne(id, user);
  }

  @Get(':id/history')
  @Roles(...FINANCE_READ_ROLES)
  @RequirePermission('finance:read')
  @ApiOperation({ summary: 'Get the audit trail (who did what + when) for a financial record' })
  @ApiParam({ name: 'id', description: 'Financial record UUID' })
  getHistory(@Param('id') id: string) {
    return this.financeService.getHistory(id);
  }

  // ── Create ────────────────────────────────────────────────────────────────────

  @Post()
  @Roles(...FINANCE_WRITE_ROLES)
  @RequirePermission('finance:create')
  @ApiOperation({ summary: 'Create a financial record' })
  @ApiResponse({ status: 201, description: 'Record created' })
  create(
    @Body() dto: CreateFinancialRecordDto,
    @CurrentUser() user: any,
  ) {
    return this.financeService.create(dto, user?.id, user?.tenantId);
  }

  // ── Update ────────────────────────────────────────────────────────────────────

  @Patch(':id')
  @Roles(...FINANCE_WRITE_ROLES)
  @RequirePermission('finance:update')
  @ApiOperation({ summary: 'Update a financial record (partial)' })
  @ApiParam({ name: 'id', description: 'Financial record UUID' })
  update(
    @Param('id') id: string,
    @Body() dto: UpdateFinancialRecordDto,
    @CurrentUser() user: any,
  ) {
    return this.financeService.update(id, dto, user?.id);
  }

  // ── Status / Deduction ────────────────────────────────────────────────────────

  @Patch(':id/status')
  @Roles(...FINANCE_STATUS_ROLES)
  @RequirePermission('finance:status')
  @ApiOperation({ summary: 'Update status and deduction details of a financial record' })
  @ApiParam({ name: 'id', description: 'Financial record UUID' })
  updateStatus(
    @Param('id') id: string,
    @Body() dto: UpdateStatusDto,
    @CurrentUser() user: any,
  ) {
    return this.financeService.updateStatus(id, dto, user?.id);
  }

  // ── Soft-delete ───────────────────────────────────────────────────────────────

  @Delete(':id')
  @Roles(...FINANCE_WRITE_ROLES)
  @RequirePermission('finance:delete')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Soft-delete a financial record' })
  @ApiParam({ name: 'id', description: 'Financial record UUID' })
  remove(@Param('id') id: string, @CurrentUser() user: any) {
    return this.financeService.remove(id, user?.id);
  }

  // ── Deductions (multi-partial) ────────────────────────────────────────────────

  @Post(':id/deductions')
  @Roles(...FINANCE_STATUS_ROLES)
  @RequirePermission('finance:status')
  @ApiOperation({ summary: 'Append a partial deduction to a financial record' })
  @ApiParam({ name: 'id', description: 'Financial record UUID' })
  addDeduction(
    @Param('id') id: string,
    @Body() dto: { amount: number; deductionDate: string; payrollReference?: string; notes?: string },
    @CurrentUser() user: any,
  ) {
    return this.financeService.addDeduction(id, dto, user?.id);
  }

  @Delete('deductions/:deductionId')
  @Roles(...FINANCE_STATUS_ROLES)
  @RequirePermission('finance:status')
  @ApiOperation({ summary: 'Remove a single partial deduction from a financial record' })
  @ApiParam({ name: 'deductionId', description: 'Deduction row UUID' })
  removeDeduction(@Param('deductionId') deductionId: string, @CurrentUser() user: any) {
    return this.financeService.removeDeduction(deductionId, user?.id);
  }

  // ── Attachments ───────────────────────────────────────────────────────────────

  @Post(':id/attachments')
  @Roles(...FINANCE_WRITE_ROLES)
  @RequirePermission('finance:update')
  @ApiOperation({ summary: 'Upload an attachment to a financial record' })
  @ApiParam({ name: 'id', description: 'Financial record UUID' })
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      properties: { file: { type: 'string', format: 'binary' } },
    },
  })
  @UseInterceptors(FileInterceptor('file', memoryUpload({
    mimeTypes: DOCUMENT_MIME,
    maxBytes: 10 * 1024 * 1024,
  })))
  addAttachment(
    @Param('id') id: string,
    @UploadedFile() file: Express.Multer.File,
    @CurrentUser() user: any,
  ) {
    if (!file) throw new BadRequestException('No file uploaded');
    return this.financeService.addAttachment(id, file, user?.id);
  }

  @Delete(':id/attachments/:attachmentId')
  @Roles(...FINANCE_WRITE_ROLES)
  @RequirePermission('finance:update')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Soft-delete an attachment from a financial record' })
  @ApiParam({ name: 'id', description: 'Financial record UUID' })
  @ApiParam({ name: 'attachmentId', description: 'Attachment UUID' })
  removeAttachment(
    @Param('id') id: string,
    @Param('attachmentId') attachmentId: string,
    @CurrentUser() user: any,
  ) {
    return this.financeService.removeAttachment(id, attachmentId, user?.id);
  }
}
