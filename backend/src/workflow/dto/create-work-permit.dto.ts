import { IsString, IsOptional, IsEnum, IsDateString, IsUUID } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export enum WorkPermitStatusEnum {
  PENDING = 'PENDING', APPLIED = 'APPLIED', APPROVED = 'APPROVED',
  REJECTED = 'REJECTED', EXPIRED = 'EXPIRED', CANCELLED = 'CANCELLED',
}

export class CreateWorkPermitDto {
  @ApiProperty({ description: 'Employee UUID' }) @IsUUID() employeeId: string;
  @ApiProperty({ example: 'Tier 2 General' }) @IsString() permitType: string;
  @ApiPropertyOptional({ enum: WorkPermitStatusEnum }) @IsOptional() @IsEnum(WorkPermitStatusEnum) status?: WorkPermitStatusEnum;
  @ApiPropertyOptional() @IsOptional() @IsString() permitNumber?: string;
  @ApiProperty({ example: '2024-01-15' }) @IsDateString() applicationDate: string;
  @ApiPropertyOptional() @IsOptional() @IsDateString() approvalDate?: string;
  @ApiProperty({ example: '2026-01-14' }) @IsDateString() expiryDate: string;
  @ApiPropertyOptional() @IsOptional() @IsString() issuingAuthority?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() notes?: string;
}
