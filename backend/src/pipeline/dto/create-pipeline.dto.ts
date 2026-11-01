import { IsString, IsOptional, IsBoolean, IsHexColor, MaxLength, IsArray, IsUUID } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class CreateWorkflowDto {
  @ApiProperty() @IsString() @MaxLength(120) name: string;
  @ApiPropertyOptional() @IsOptional() @IsString() description?: string;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() isDefault?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() isPublic?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsString() color?: string;
}

export class CreateWorkflowStageDto {
  @ApiProperty() @IsString() @MaxLength(100) name: string;
  @ApiPropertyOptional() @IsOptional() @IsString() description?: string;
  @ApiPropertyOptional() @IsOptional() order?: number;
  @ApiPropertyOptional() @IsOptional() @IsString() color?: string;
  @ApiPropertyOptional() @IsOptional() slaHours?: number;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() requiresApproval?: boolean;
  @ApiPropertyOptional({ description: 'When true, any user can process the stage; when false, only users in responsibleUserIds can advance candidates.' })
  @IsOptional() @IsBoolean() responsibleAny?: boolean;
  @ApiPropertyOptional({ description: 'Minimum distinct approvers that must APPROVED before advance. Defaults to 1. Must not exceed approverUserIds.length.' })
  @IsOptional() minApprovals?: number;
  @ApiPropertyOptional({ enum: ['ANY'], description: 'How approvals are counted toward the minimum threshold. "ANY" — any distinct approver\'s APPROVED decision counts.' })
  @IsOptional() @IsString() approvalMode?: string;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() isFinal?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() isActive?: boolean;
  /** Legacy: treated as approvers. New callers should use
   *  approverUserIds / responsibleUserIds instead. */
  @ApiPropertyOptional() @IsOptional() @IsArray() @IsUUID('4', { each: true }) assignedUserIds?: string[];
  @ApiPropertyOptional({ description: 'Users who must approve the stage before advance.' })
  @IsOptional() @IsArray() @IsUUID('4', { each: true }) approverUserIds?: string[];
  @ApiPropertyOptional({ description: 'Users authorised to process candidates in this stage. Ignored when responsibleAny=true.' })
  @IsOptional() @IsArray() @IsUUID('4', { each: true }) responsibleUserIds?: string[];
  @ApiPropertyOptional() @IsOptional() @IsArray() @IsUUID('4', { each: true }) requiredDocTypeIds?: string[];
}

export class UpdateWorkflowStageProgressDto {
  @ApiProperty({ enum: ['ACTIVE', 'COMPLETED', 'SKIPPED', 'BLOCKED'] })
  @IsString() status: string;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() flagged?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsString() flagReason?: string;
}

export class CreateStageNoteDto {
  @ApiProperty() @IsString() content: string;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() isPrivate?: boolean;
}

export class CreateStageApprovalDto {
  @ApiProperty({ enum: ['APPROVED', 'REJECTED'] }) @IsString() decision: string;
  @ApiPropertyOptional() @IsOptional() @IsString() notes?: string;
}

export class AssignCandidateToWorkflowDto {
  @ApiProperty() @IsUUID() candidateId: string;
  @ApiProperty() @IsUUID() workflowId: string;
  @ApiPropertyOptional() @IsOptional() @IsString() notes?: string;
}

export class AssignEmployeeToWorkflowDto {
  @ApiProperty() @IsUUID() employeeId: string;
  @ApiProperty() @IsUUID() workflowId: string;
  @ApiPropertyOptional() @IsOptional() @IsString() notes?: string;
}
