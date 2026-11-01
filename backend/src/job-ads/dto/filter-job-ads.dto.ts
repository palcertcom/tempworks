import { IsOptional, IsString } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { PaginationDto } from '../../common/dto/pagination.dto';

export class FilterJobAdsDto extends PaginationDto {
  @ApiPropertyOptional({ enum: ['DRAFT', 'PUBLISHED', 'ARCHIVED'] })
  @IsOptional() @IsString()
  status?: string;

  @ApiPropertyOptional() @IsOptional() @IsString()
  category?: string;

  @ApiPropertyOptional() @IsOptional() @IsString()
  country?: string;

  @ApiPropertyOptional() @IsOptional() @IsString()
  contractType?: string;

  /** Phase F2 (SPIKE-010 Batch 2) — SUPER USER tenant override. */
  @ApiPropertyOptional() @IsOptional() @IsString()
  tenantId?: string;
}
