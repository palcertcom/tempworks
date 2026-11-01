import { IsOptional, IsString, IsInt, Min, Max, IsIn, IsDateString } from 'class-validator';
import { Type } from 'class-transformer';
import { ApiPropertyOptional } from '@nestjs/swagger';

export const SUPPORTED_ENTITY_TYPES = [
  'APPLICANT', 'EMPLOYEE', 'USER', 'AGENCY', 'DOCUMENT',
  'JOB_AD', 'FINANCIAL_RECORD', 'ROLE', 'NOTIFICATION', 'REPORT',
  'DOCUMENT_TYPE', 'VEHICLE', 'VEHICLE_DOCUMENT', 'MAINTENANCE_RECORD',
  'MAINTENANCE_TYPE', 'WORKSHOP',
] as const;

export type SupportedEntityType = typeof SUPPORTED_ENTITY_TYPES[number];

export class ListDeletedDto {
  @ApiPropertyOptional({ enum: SUPPORTED_ENTITY_TYPES })
  @IsOptional()
  @IsIn(SUPPORTED_ENTITY_TYPES)
  entityType?: SupportedEntityType;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  search?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsDateString()
  deletedFrom?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsDateString()
  deletedTo?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  deletedById?: string;

  @ApiPropertyOptional({ default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  @ApiPropertyOptional({ default: 20 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number = 20;

  @ApiPropertyOptional({ default: 'desc', enum: ['asc', 'desc'] })
  @IsOptional()
  @IsIn(['asc', 'desc'])
  sortOrder?: 'asc' | 'desc' = 'desc';
}
