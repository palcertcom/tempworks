import { IsString, IsIn, IsOptional, IsNumber, IsDateString, Min } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { FINANCIAL_RECORD_STATUSES } from '../constants';

export class UpdateStatusDto {
  @ApiProperty({ enum: FINANCIAL_RECORD_STATUSES })
  @IsString() @IsIn(FINANCIAL_RECORD_STATUSES as unknown as string[])
  status: string;

  @ApiPropertyOptional({ description: 'Amount actually deducted via payroll' })
  @IsOptional() @Type(() => Number) @IsNumber() @Min(0)
  deductionAmount?: number;

  @ApiPropertyOptional({ example: '2026-04-30' })
  @IsOptional() @IsDateString()
  deductionDate?: string;

  @ApiPropertyOptional({ description: 'Payroll batch reference for reconciliation' })
  @IsOptional() @IsString()
  payrollReference?: string;
}
