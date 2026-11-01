import { Controller, Get, Post, Patch, Delete, Body, Param, Query, UseGuards, Request } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { WorkflowService } from './pipeline.service';
import {
  CreateWorkflowDto,
  CreateWorkflowStageDto,
  UpdateWorkflowStageProgressDto,
  CreateStageNoteDto,
  CreateStageApprovalDto,
  AssignCandidateToWorkflowDto,
  AssignEmployeeToWorkflowDto,
} from './dto/create-pipeline.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { RequirePermission } from '../auth/decorators/require-permission.decorator';

const ALL_ROLES = ['System Admin', 'HR Manager', 'Compliance Officer', 'Recruiter', 'Finance', 'Read Only'];
const WRITE_ROLES = ['System Admin', 'HR Manager', 'Recruiter'];
const ADMIN_ROLES = ['System Admin', 'HR Manager'];

@ApiTags('Workflows')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('workflows')
export class WorkflowController {
  constructor(private readonly workflowService: WorkflowService) {}

  // ─── Workflows ────────────────────────────────────────────────────────────

  @Get()
  @Roles(...ALL_ROLES)
  @RequirePermission('workflow:read')
  @ApiOperation({ summary: 'List all workflows' })
  listWorkflows(
    @Query('includeArchived') includeArchived?: string,
    @Query('tenantId') tenantIdQuery?: string,
    @Request() req?: any,
  ) {
    return this.workflowService.listWorkflows(includeArchived === 'true', req?.user, tenantIdQuery);
  }

  @Get(':id')
  @Roles(...ALL_ROLES)
  @RequirePermission('workflow:read')
  @ApiOperation({ summary: 'Get a workflow by ID' })
  getWorkflow(@Param('id') id: string) {
    return this.workflowService.getWorkflow(id);
  }

  @Get(':id/board')
  @Roles(...ALL_ROLES)
  @RequirePermission('workflow:read')
  @ApiOperation({ summary: 'Get workflow board view with candidates per stage' })
  getBoardView(@Param('id') id: string) {
    return this.workflowService.getWorkflowBoardView(id);
  }

  @Get(':id/candidates')
  @Roles(...ALL_ROLES)
  @RequirePermission('workflow:read')
  @ApiOperation({ summary: 'List candidates in a workflow' })
  getWorkflowCandidates(@Param('id') id: string) {
    return this.workflowService.getWorkflowCandidates(id);
  }

  @Get(':id/stats')
  @Roles(...ALL_ROLES)
  @RequirePermission('workflow:read')
  @ApiOperation({ summary: 'Get workflow statistics' })
  getWorkflowStats(@Param('id') id: string) {
    return this.workflowService.getWorkflowStats(id);
  }

  @Post()
  @Roles(...ADMIN_ROLES)
  @RequirePermission('workflow:create')
  @ApiOperation({ summary: 'Create a new workflow' })
  createWorkflow(@Body() dto: CreateWorkflowDto, @Request() req: any) {
    return this.workflowService.createWorkflow(dto, req.user?.id, req.user?.tenantId);
  }

  @Patch(':id')
  @Roles(...ADMIN_ROLES)
  @RequirePermission('workflow:update')
  @ApiOperation({ summary: 'Update workflow metadata' })
  updateWorkflow(@Param('id') id: string, @Body() dto: Partial<CreateWorkflowDto>, @Request() req: any) {
    return this.workflowService.updateWorkflow(id, dto, req.user?.id);
  }

  @Patch(':id/archive')
  @Roles(...ADMIN_ROLES)
  @RequirePermission('workflow:update')
  @ApiOperation({ summary: 'Archive a workflow' })
  archiveWorkflow(@Param('id') id: string, @Request() req: any) {
    return this.workflowService.archiveWorkflow(id, req.user?.id);
  }

  @Post(':id/copy')
  @Roles(...ADMIN_ROLES)
  @RequirePermission('workflow:create')
  @ApiOperation({ summary: 'Duplicate a workflow (stages, required docs, assigned users, access list)' })
  copyWorkflow(@Param('id') id: string, @Body() body: { name?: string } = {}, @Request() req: any) {
    return this.workflowService.copyWorkflow(id, { name: body?.name }, req.user?.id, req.user?.tenantId);
  }

  @Delete(':id')
  @Roles('System Admin')
  @RequirePermission('workflow:delete')
  @ApiOperation({ summary: 'Delete a workflow (soft delete)' })
  deleteWorkflow(@Param('id') id: string, @Request() req: any) {
    return this.workflowService.deleteWorkflow(id, req.user?.id);
  }

  // ─── Private access list ──────────────────────────────────────────────────

  @Get(':id/access-users')
  @Roles(...ALL_ROLES)
  @RequirePermission('workflow:read')
  @ApiOperation({ summary: 'List users granted access to a (private) workflow' })
  listAccessUsers(@Param('id') id: string) {
    return this.workflowService.listAccessUsers(id);
  }

  @Post(':id/access-users/:userId')
  @Roles(...ADMIN_ROLES)
  @RequirePermission('workflow:create')
  @ApiOperation({ summary: 'Grant a user access to a private workflow' })
  addAccessUser(@Param('id') id: string, @Param('userId') userId: string, @Request() req: any) {
    return this.workflowService.addAccessUser(id, userId, req.user?.id);
  }

  @Delete(':id/access-users/:userId')
  @Roles(...ADMIN_ROLES)
  @RequirePermission('workflow:delete')
  @ApiOperation({ summary: 'Revoke a user\'s access to a private workflow' })
  removeAccessUser(@Param('id') id: string, @Param('userId') userId: string, @Request() req: any) {
    return this.workflowService.removeAccessUser(id, userId, req.user?.id);
  }

  // ─── Stages ───────────────────────────────────────────────────────────────

  @Post(':id/stages')
  @Roles(...ADMIN_ROLES)
  @RequirePermission('workflow:create')
  @ApiOperation({ summary: 'Add a stage to a workflow' })
  addStage(@Param('id') workflowId: string, @Body() dto: CreateWorkflowStageDto, @Request() req: any) {
    return this.workflowService.addStage(workflowId, dto, req.user?.id);
  }

  @Patch(':id/stages/reorder')
  @Roles(...ADMIN_ROLES)
  @RequirePermission('workflow:update')
  @ApiOperation({ summary: 'Reorder stages in a workflow' })
  reorderStages(@Param('id') workflowId: string, @Body('orderedIds') orderedIds: string[]) {
    return this.workflowService.reorderStages(workflowId, orderedIds);
  }

  @Get('stages/:stageId/details')
  @Roles(...ALL_ROLES)
  @RequirePermission('workflow:read')
  @ApiOperation({ summary: 'Get WorkflowStage detail view: stage info, requirements, and active candidates' })
  getWorkflowStageDetails(@Param('stageId') stageId: string) {
    return this.workflowService.getWorkflowStageDetails(stageId);
  }

  @Patch('stages/:stageId')
  @Roles(...ADMIN_ROLES)
  @RequirePermission('workflow:update')
  @ApiOperation({ summary: 'Update a workflow stage' })
  updateStage(@Param('stageId') stageId: string, @Body() dto: Partial<CreateWorkflowStageDto>, @Request() req: any) {
    return this.workflowService.updateStage(stageId, dto, req.user?.id);
  }

  @Delete('stages/:stageId')
  @Roles(...ADMIN_ROLES)
  @RequirePermission('workflow:delete')
  @ApiOperation({ summary: 'Delete a workflow stage' })
  deleteStage(@Param('stageId') stageId: string, @Request() req: any) {
    return this.workflowService.deleteStage(stageId, req.user?.id);
  }

  // ─── Assignments ──────────────────────────────────────────────────────────

  @Post('assign')
  @Roles(...WRITE_ROLES)
  @RequirePermission('workflow:create')
  @ApiOperation({ summary: 'Assign a candidate to a workflow (reassignment to a different workflow requires System Admin)' })
  assignCandidate(@Body() dto: AssignCandidateToWorkflowDto, @Request() req: any) {
    return this.workflowService.assignCandidate(
      dto,
      req.user?.id,
      { role: req.user?.role },
    );
  }

  /** Phase 2B (#41) — candidates not yet on any ACTIVE workflow, scoped
   *  to the WORKFLOW's tenant when workflowId is supplied (correct
   *  source for the Assign Candidate dialog), otherwise to the caller's
   *  active tenant. Powers the searchable picker. */
  @Get('unassigned-candidates')
  @Roles(...WRITE_ROLES)
  @RequirePermission('workflow:create')
  @ApiOperation({ summary: 'List candidates not yet assigned to any active workflow' })
  listUnassignedCandidates(
    @Query('search') search: string | undefined,
    @Query('workflowId') workflowId: string | undefined,
    @Request() req: any,
  ) {
    return this.workflowService.listUnassignedCandidates(search, req.user, workflowId);
  }

  @Post('assign-bulk')
  @Roles(...WRITE_ROLES)
  @RequirePermission('workflow:create')
  @ApiOperation({ summary: 'Assign one workflow to many candidates in a single call (reassignment to a different workflow still requires System Admin per-candidate)' })
  assignCandidatesBulk(
    @Body() dto: { candidateIds: string[]; workflowId: string; notes?: string },
    @Request() req: any,
  ) {
    return this.workflowService.assignCandidatesBulk(
      dto,
      req.user?.id,
      { role: req.user?.role },
    );
  }

  @Get('candidate/:candidateId/assignments')
  @Roles(...ALL_ROLES)
  @RequirePermission('workflow:read')
  @ApiOperation({ summary: 'Get all workflow assignments for a candidate' })
  getCandidateAssignments(@Param('candidateId') candidateId: string) {
    return this.workflowService.getCandidateAssignments(candidateId);
  }

  @Delete('candidate/:candidateId/assignments/:assignmentId')
  @Roles(...WRITE_ROLES)
  @RequirePermission('workflow:delete')
  @ApiOperation({ summary: 'Remove a candidate from a workflow assignment' })
  removeCandidateAssignment(@Param('candidateId') candidateId: string, @Param('assignmentId') assignmentId: string) {
    return this.workflowService.removeCandidateAssignment(candidateId, assignmentId);
  }

  // ─── Employee Assignments ─────────────────────────────────────────────────

  @Post('assign-employee')
  @Roles(...WRITE_ROLES)
  @RequirePermission('workflow:create')
  @ApiOperation({ summary: 'Assign an employee to a workflow' })
  assignEmployee(@Body() dto: AssignEmployeeToWorkflowDto, @Request() req: any) {
    return this.workflowService.assignEmployee(dto, req.user?.id);
  }

  @Get('employee/:employeeId/assignments')
  @Roles(...ALL_ROLES)
  @RequirePermission('workflow:read')
  @ApiOperation({ summary: 'Get all workflow assignments for an employee' })
  getEmployeeWorkflows(@Param('employeeId') employeeId: string) {
    return this.workflowService.getEmployeeWorkflows(employeeId);
  }

  @Patch('employee/:employeeId/current-stage')
  @Roles(...WRITE_ROLES)
  @RequirePermission('workflow:update')
  @ApiOperation({ summary: 'Set the current stage for an employee workflow assignment' })
  setEmployeeCurrentStage(@Param('employeeId') employeeId: string, @Body('stageId') stageId: string, @Request() req: any) {
    return this.workflowService.setEmployeeCurrentStage(employeeId, stageId, req.user?.id);
  }

  @Post('employee/:employeeId/stages/:stageId/approve')
  @Roles(...WRITE_ROLES)
  @RequirePermission('workflow:create')
  @ApiOperation({ summary: 'Approve a stage for an employee' })
  approveEmployeeStage(@Param('employeeId') employeeId: string, @Param('stageId') stageId: string, @Body('notes') notes: string, @Request() req: any) {
    return this.workflowService.approveEmployeeStage(employeeId, stageId, req.user?.id, notes);
  }

  @Delete('employee/:employeeId/assignments/:workflowId')
  @Roles(...WRITE_ROLES)
  @RequirePermission('workflow:delete')
  @ApiOperation({ summary: 'Remove an employee from a workflow' })
  removeEmployeeWorkflow(@Param('employeeId') employeeId: string, @Param('workflowId') workflowId: string, @Request() req: any) {
    return this.workflowService.removeEmployeeWorkflow(employeeId, workflowId, req.user?.id);
  }

  // ─── Progress ─────────────────────────────────────────────────────────────

  @Post('assignments/:assignmentId/advance')
  @Roles(...WRITE_ROLES)
  @RequirePermission('workflow:create')
  @ApiOperation({ summary: 'Advance candidate to a stage in their workflow assignment' })
  advanceToStage(@Param('assignmentId') assignmentId: string, @Body('stageId') stageId: string, @Request() req: any) {
    return this.workflowService.advanceToStage(assignmentId, stageId, req.user?.id);
  }

  @Patch('progress/:progressId')
  @Roles(...WRITE_ROLES)
  @RequirePermission('workflow:update')
  @ApiOperation({ summary: 'Update candidate stage progress status / flag' })
  updateProgress(@Param('progressId') progressId: string, @Body() dto: UpdateWorkflowStageProgressDto, @Request() req: any) {
    return this.workflowService.updateProgress(progressId, dto, req.user?.id);
  }

  // ─── Notes ────────────────────────────────────────────────────────────────

  @Post('progress/:progressId/notes')
  @Roles(...WRITE_ROLES)
  @RequirePermission('workflow:create')
  @ApiOperation({ summary: 'Add a note to a candidate stage progress' })
  addNote(@Param('progressId') progressId: string, @Body() dto: CreateStageNoteDto, @Request() req: any) {
    return this.workflowService.addNote(progressId, dto, req.user?.id);
  }

  @Delete('notes/:noteId')
  @Roles(...WRITE_ROLES)
  @RequirePermission('workflow:delete')
  @ApiOperation({ summary: 'Delete a stage note' })
  deleteNote(@Param('noteId') noteId: string, @Request() req: any) {
    return this.workflowService.deleteNote(noteId, req.user?.id);
  }

  // ─── Flag ─────────────────────────────────────────────────────────────────

  @Patch('progress/:progressId/flag')
  @Roles(...WRITE_ROLES)
  @RequirePermission('workflow:update')
  @ApiOperation({ summary: 'Toggle flagged state on a candidate stage progress' })
  toggleFlag(
    @Param('progressId') progressId: string,
    @Body() body: { flagged: boolean; reason?: string | null },
    @Request() req: any,
  ) {
    return this.workflowService.toggleProgressFlag(progressId, !!body.flagged, body.reason ?? null, req.user?.id);
  }

  // ─── Approvals ────────────────────────────────────────────────────────────

  @Post('progress/:progressId/approve')
  @Roles(...WRITE_ROLES)
  @RequirePermission('workflow:create')
  @ApiOperation({ summary: 'Submit an approval decision for a stage' })
  submitApproval(@Param('progressId') progressId: string, @Body() dto: CreateStageApprovalDto, @Request() req: any) {
    return this.workflowService.submitApproval(progressId, dto, req.user?.id);
  }
}
