import { IsOptional, IsString, IsIn } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { PaginationDto } from '../../common/dto/pagination.dto';
import { FINANCIAL_RECORD_STATUSES, TRANSACTION_TYPES } from '../constants';

export class FilterFinancialRecordsDto extends PaginationDto {
  @ApiPropertyOptional() @IsOptional() @IsString() entityType?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() entityId?: string;

  @ApiPropertyOptional({ description: 'Search by person name, payroll ref, description' })
  @IsOptional() @IsString() search?: string;

  @ApiPropertyOptional({ enum: FINANCIAL_RECORD_STATUSES })
  @IsOptional() @IsString() @IsIn(FINANCIAL_RECORD_STATUSES as unknown as string[])
  status?: string;

  @ApiPropertyOptional({ enum: TRANSACTION_TYPES })
  @IsOptional() @IsString() transactionType?: string;

  @ApiPropertyOptional() @IsOptional() @IsString() currency?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() agencyId?: string;

  @ApiPropertyOptional({ description: 'ISO date, start of range' })
  @IsOptional() @IsString() dateFrom?: string;

  @ApiPropertyOptional({ description: 'ISO date, end of range' })
  @IsOptional() @IsString() dateTo?: string;

  @ApiPropertyOptional({ default: 'transactionDate' })
  @IsOptional() @IsString() sortBy?: string;

  /** Phase F2 (SPIKE-010) — SUPER USER tenant override (silently ignored
   *  for non-SUPER callers by buildSuperUserTenantWhere). */
  @ApiPropertyOptional()
  @IsOptional() @IsString() tenantId?: string;
}
