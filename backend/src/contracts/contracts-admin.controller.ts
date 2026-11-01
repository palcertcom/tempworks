import { Body, Controller, Get, Post, Put, Request, UseGuards } from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { RequirePermission } from '../auth/decorators/require-permission.decorator';
import { ContractsService } from './contracts.service';

/**
 * Admin config for the Documents ↔ Contracts integration: which
 * document type(s) auto-create/update a contract when uploaded.
 */
@ApiTags('Employment Contracts')
@ApiBearerAuth('access-token')
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('contracts/settings')
export class ContractsAdminController {
  constructor(private readonly service: ContractsService) {}

  @Get('document-types')
  @Roles('System Admin', 'HR Manager')
  @RequirePermission('settings:read')
  @ApiOperation({ summary: 'Get the document types that map to contracts + the full picker list' })
  getDocumentTypes() {
    return this.service.getSettings();
  }

  @Put('document-types')
  @Roles('System Admin', 'HR Manager')
  @RequirePermission('settings:update')
  @ApiOperation({ summary: 'Set which document type ids auto-create/update contracts on upload' })
  setDocumentTypes(@Body() body: { documentTypeIds: string[] }, @Request() req: any) {
    return this.service.setDocumentTypeIds(body?.documentTypeIds ?? [], req.user?.id);
  }

  /**
   * Run the contract-end status sweep on demand (same logic the daily
   * cron runs): terminate every employee whose last contract's end day
   * has fully passed. Handy for testing/ops without waiting for
   * midnight. Returns { scanned, terminated }.
   */
  @Post('run-status-sweep')
  @Roles('System Admin')
  @RequirePermission('employees:update')
  @ApiOperation({ summary: 'Run the auto-terminate-on-contract-end sweep now' })
  runStatusSweep() {
    return this.service.runStatusSweep();
  }
}
