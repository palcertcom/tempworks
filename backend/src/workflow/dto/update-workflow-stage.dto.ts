import { IsEnum, IsOptional, IsString, IsUUID } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export enum WorkflowStageStatusEnum {
  PENDING = 'PENDING', IN_PROGRESS = 'IN_PROGRESS',
  COMPLETED = 'COMPLETED', SKIPPED = 'SKIPPED', BLOCKED = 'BLOCKED',
}

export class UpdateWorkflowStageDto {
  @ApiProperty({ enum: WorkflowStageStatusEnum })
  @IsEnum(WorkflowStageStatusEnum)
  status: WorkflowStageStatusEnum;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  notes?: string;

  @ApiPropertyOptional({ description: 'User UUID to assign to this stage' })
  @IsOptional()
  @IsUUID()
  assignedToId?: string;
}
