import { IsArray, IsString, IsNotEmpty, IsOptional, IsEnum } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export enum BulkActionType {
  STATUS_CHANGE = 'STATUS_CHANGE',
  TIER_CHANGE = 'TIER_CHANGE',
  ASSIGN_AGENCY = 'ASSIGN_AGENCY',
  CONVERT_TO_EMPLOYEE = 'CONVERT_TO_EMPLOYEE',
  DELETE = 'DELETE',
}

export class BulkActionDto {
  @ApiProperty({ description: 'Array of applicant IDs' })
  @IsArray()
  @IsString({ each: true })
  ids: string[];

  @ApiProperty({ enum: BulkActionType })
  @IsEnum(BulkActionType)
  action: BulkActionType;

  @ApiPropertyOptional({ description: 'Payload for the action (e.g., status value, tier)' })
  @IsOptional()
  @IsString()
  value?: string;

  /** Target agency for TIER_CHANGE→CANDIDATE and CONVERT_TO_EMPLOYEE —
   *  lets the operator assign the responsible agency in the same call. */
  @ApiPropertyOptional({ description: 'Target agency ID for Candidate promotions / Employee conversions' })
  @IsOptional()
  @IsString()
  agencyId?: string;
}

export class AssignAgencyDto {
  @ApiProperty({ description: 'Agency ID to assign' })
  @IsString()
  @IsNotEmpty()
  agencyId: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  reason?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  notes?: string;
}

export class ConvertLeadDto {
  @ApiPropertyOptional({ description: 'Agency ID to assign the candidate to' })
  @IsOptional()
  @IsString()
  agencyId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  notes?: string;
}
