import {
  Controller, Get, Post, Body, Patch, Param, Query, UseGuards,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiBearerAuth, ApiParam, ApiQuery, ApiBody } from '@nestjs/swagger';
import { WorkflowService } from './workflow.service';
import { CreateWorkPermitDto } from './dto/create-work-permit.dto';
import { CreateVisaDto } from './dto/create-visa.dto';
import { UpdateWorkflowStageDto } from './dto/update-workflow-stage.dto';
import { PaginationDto } from '../common/dto/pagination.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { RequirePermission } from '../auth/decorators/require-permission.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';

@ApiTags('Workflow')
@ApiBearerAuth('access-token')
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('workflow')
export class WorkflowController {
  constructor(private readonly workflowService: WorkflowService) {}

  @Get('stages')
  @Roles('System Admin', 'HR Manager', 'Compliance Officer', 'Recruiter', 'Read Only')
  @RequirePermission('workflow:read')
  @ApiOperation({ summary: 'Get all workflow stages' })
  getStages() {
    return this.workflowService.getStages();
  }

  @Get('overview')
  @Roles('System Admin', 'HR Manager', 'Compliance Officer', 'Recruiter', 'Read Only')
  @RequirePermission('workflow:read')
  @ApiOperation({ summary: 'Get workflow overview with stage counts' })
  getOverview() {
    return this.workflowService.getOverview();
  }

  @Get('stages/:stageId/people')
  @Roles('System Admin', 'HR Manager', 'Compliance Officer', 'Recruiter', 'Read Only')
  @RequirePermission('workflow:read')
  @ApiOperation({ summary: 'Get applicants and employees currently at a specific stage' })
  @ApiParam({ name: 'stageId', description: 'WorkflowStage UUID' })
  getStageDetails(@Param('stageId') stageId: string) {
    return this.workflowService.getStageDetails(stageId);
  }

  @Get('analytics')
  @Roles('System Admin', 'HR Manager', 'Compliance Officer', 'Recruiter', 'Read Only')
  @RequirePermission('workflow:read')
  @ApiOperation({ summary: 'Get workflow analytics and recent activity' })
  getAnalytics() {
    return this.workflowService.getAnalytics();
  }

  @Get('timeline/:employeeId')
  @Roles('System Admin', 'HR Manager', 'Compliance Officer', 'Recruiter', 'Read Only')
  @RequirePermission('workflow:read')
  @ApiOperation({ summary: 'Get workflow timeline for an employee' })
  @ApiParam({ name: 'employeeId', description: 'Employee UUID' })
  getTimeline(@Param('employeeId') employeeId: string) {
    return this.workflowService.getTimeline(employeeId);
  }

  @Patch('employees/:id/workflow-stage/:stageId')
  @Roles('System Admin', 'HR Manager', 'Compliance Officer')
  @RequirePermission('workflow:update')
  @ApiOperation({ summary: 'Update a workflow stage for an employee' })
  @ApiParam({ name: 'id', description: 'Employee UUID' })
  @ApiParam({ name: 'stageId', description: 'WorkflowStage UUID' })
  updateEmployeeWorkflowStage(
    @Param('id') employeeId: string,
    @Param('stageId') stageId: string,
    @Body() dto: UpdateWorkflowStageDto,
    @CurrentUser() user: any,
  ) {
    return this.workflowService.updateEmployeeWorkflowStage(employeeId, stageId, dto, user?.id);
  }

  @Patch('employees/:id/current-stage')
  @Roles('System Admin', 'HR Manager', 'Compliance Officer', 'Recruiter')
  @RequirePermission('workflow:update')
  @ApiOperation({ summary: 'Set the current (IN_PROGRESS) workflow stage for an employee' })
  @ApiParam({ name: 'id', description: 'Employee UUID' })
  @ApiBody({ schema: { type: 'object', properties: { stageId: { type: 'string' } }, required: ['stageId'] } })
  setEmployeeCurrentStage(
    @Param('id') employeeId: string,
    @Body('stageId') stageId: string,
    @CurrentUser() user: any,
  ) {
    return this.workflowService.setEmployeeCurrentStage(employeeId, stageId, user?.id);
  }

  // Work Permits
  @Get('work-permits')
  @Roles('System Admin', 'HR Manager', 'Compliance Officer', 'Recruiter', 'Read Only')
  @RequirePermission('workflow:read')
  @ApiOperation({ summary: 'Get all work permits' })
  @ApiQuery({ name: 'employeeId', required: false })
  getWorkPermits(@Query() pagination: PaginationDto, @Query('employeeId') employeeId?: string) {
    return this.workflowService.findWorkPermits(pagination, employeeId);
  }

  @Post('work-permits')
  @Roles('System Admin', 'HR Manager', 'Compliance Officer')
  @RequirePermission('workflow:create')
  @ApiOperation({ summary: 'Create a work permit' })
  createWorkPermit(@Body() dto: CreateWorkPermitDto, @CurrentUser() user: any) {
    return this.workflowService.createWorkPermit(dto, user?.id, user?.tenantId);
  }

  @Patch('work-permits/:id')
  @Roles('System Admin', 'HR Manager', 'Compliance Officer')
  @RequirePermission('workflow:update')
  @ApiOperation({ summary: 'Update work permit' })
  @ApiParam({ name: 'id', description: 'WorkPermit UUID' })
  updateWorkPermit(
    @Param('id') id: string,
    @Body() dto: Partial<CreateWorkPermitDto>,
    @CurrentUser() user: any,
  ) {
    return this.workflowService.updateWorkPermit(id, dto, user?.id);
  }

  // Visas
  @Get('visas')
  @Roles('System Admin', 'HR Manager', 'Compliance Officer', 'Recruiter', 'Read Only')
  @RequirePermission('workflow:read')
  @ApiOperation({ summary: 'Get all visas' })
  @ApiQuery({ name: 'entityId', required: false })
  getVisas(@Query() pagination: PaginationDto, @Query('entityId') entityId?: string) {
    return this.workflowService.findVisas(pagination, entityId);
  }

  @Post('visas')
  @Roles('System Admin', 'HR Manager', 'Compliance Officer')
  @RequirePermission('workflow:create')
  @ApiOperation({ summary: 'Create a visa record' })
  createVisa(@Body() dto: CreateVisaDto, @CurrentUser() user: any) {
    return this.workflowService.createVisa(dto, user?.id, user?.tenantId);
  }

  @Patch('visas/:id')
  @Roles('System Admin', 'HR Manager', 'Compliance Officer')
  @RequirePermission('workflow:update')
  @ApiOperation({ summary: 'Update visa record' })
  @ApiParam({ name: 'id', description: 'Visa UUID' })
  updateVisa(@Param('id') id: string, @Body() dto: Partial<CreateVisaDto>, @CurrentUser() user: any) {
    return this.workflowService.updateVisa(id, dto, user?.id);
  }
}
