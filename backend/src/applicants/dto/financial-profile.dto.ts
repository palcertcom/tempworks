import { IsOptional, IsString, IsNumber, Min } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';

export class UpsertFinancialProfileDto {
  @ApiPropertyOptional() @IsOptional() @IsString() bankName?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() accountHolder?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() accountNumber?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() sortCode?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() iban?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() bankAddress?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() taxCode?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() niNumber?: string;
  @ApiPropertyOptional({ example: 'BACS' }) @IsOptional() @IsString() paymentMethod?: string;
  @ApiPropertyOptional({ type: Number }) @IsOptional() @Type(() => Number) @IsNumber() @Min(0) salaryAgreed?: number;
  @ApiPropertyOptional({ example: 'GBP', default: 'GBP' }) @IsOptional() @IsString() currency?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() notes?: string;
}
