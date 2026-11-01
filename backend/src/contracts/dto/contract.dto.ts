import { IsDateString, IsOptional, IsString, IsUUID, ValidateIf } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class CreateContractDto {
  @ApiProperty({ description: 'Contract effective start date (ISO)' })
  @IsDateString()
  startDate: string;

  @ApiPropertyOptional({ description: 'Contract end date (ISO); null/omitted = open-ended' })
  @IsOptional()
  @ValidateIf((_o, v) => v !== null && v !== '')
  @IsDateString()
  endDate?: string | null;

  @ApiPropertyOptional({ description: 'Contract type, e.g. Full-time, Fixed-term, Part-time' })
  @IsOptional()
  @IsString()
  contractType?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  notes?: string;

  @ApiPropertyOptional({ description: 'Link this contract to an existing document' })
  @IsOptional()
  @IsUUID()
  documentId?: string;
}

export class UpdateContractDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsDateString()
  startDate?: string;

  @ApiPropertyOptional({ description: 'Pass null to clear (open-ended)' })
  @IsOptional()
  @ValidateIf((_o, v) => v !== null && v !== '')
  @IsDateString()
  endDate?: string | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  contractType?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  notes?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  documentId?: string;
}
