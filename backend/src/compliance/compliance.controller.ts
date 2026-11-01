import {
  Controller, Get, Patch, Param, Body, Query, UseGuards,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiBearerAuth, ApiParam, ApiQuery } from '@nestjs/swagger';
import { ComplianceService } from './compliance.service';
import { UpdateAlertDto } from './dto/update-alert.dto';
import { PaginationDto } from '../common/dto/pagination.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { RequirePermission } from '../auth/decorators/require-permission.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';

@ApiTags('Compliance')
@ApiBearerAuth('access-token')
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('compliance')
export class ComplianceController {
  constructor(private readonly complianceService: ComplianceService) {}

  @Get('dashboard')
  @Roles('System Admin', 'HR Manager', 'Compliance Officer', 'Recruiter', 'Finance', 'Read Only')
  @RequirePermission('compliance:read')
  @ApiOperation({ summary: 'Get compliance dashboard summary' })
  getDashboard() {
    return this.complianceService.getDashboard();
  }

  @Get('alerts')
  @Roles('System Admin', 'HR Manager', 'Compliance Officer', 'Recruiter', 'Read Only')
  @RequirePermission('compliance:read')
  @ApiOperation({ summary: 'Get compliance alerts with filtering' })
  @ApiQuery({ name: 'status', required: false })
  @ApiQuery({ name: 'severity', required: false })
  getAlerts(
    @Query() pagination: PaginationDto,
    @Query('status') status?: string,
    @Query('severity') severity?: string,
  ) {
    return this.complianceService.getAlerts(pagination, status, severity);
  }

  @Get('expiring-documents')
  @Roles('System Admin', 'HR Manager', 'Compliance Officer', 'Recruiter', 'Read Only')
  @RequirePermission('compliance:read')
  @ApiOperation({ summary: 'Get documents expiring within N days' })
  @ApiQuery({ name: 'days', required: false, description: 'Days threshold (default 30)' })
  getExpiringDocuments(@Query('days') days?: number) {
    return this.complianceService.getExpiringDocuments(days || 30);
  }

  @Get('employees/:id')
  @Roles('System Admin', 'HR Manager', 'Compliance Officer', 'Recruiter', 'Read Only')
  @RequirePermission('compliance:read')
  @ApiOperation({ summary: 'Get compliance status for a specific employee' })
  @ApiParam({ name: 'id', description: 'Employee UUID' })
  getEmployeeCompliance(@Param('id') id: string) {
    return this.complianceService.getEmployeeCompliance(id);
  }

  @Get('generate-alerts')
  @Roles('System Admin', 'HR Manager', 'Compliance Officer')
  @RequirePermission('compliance:read')
  @ApiOperation({ summary: 'Scan and generate new compliance alerts (admin)' })
  generateAlerts() {
    return this.complianceService.generateAlerts();
  }

  @Patch('alerts/:id')
  @Roles('System Admin', 'HR Manager', 'Compliance Officer')
  @RequirePermission('compliance:update')
  @ApiOperation({ summary: 'Update a compliance alert (acknowledge/resolve/dismiss)' })
  @ApiParam({ name: 'id', description: 'ComplianceAlert UUID' })
  updateAlert(@Param('id') id: string, @Body() dto: UpdateAlertDto, @CurrentUser() user: any) {
    return this.complianceService.updateAlert(id, dto, user?.id);
  }
}
