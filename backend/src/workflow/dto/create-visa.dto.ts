import { IsString, IsOptional, IsEnum, IsDateString } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export enum VisaStatusEnum {
  PENDING = 'PENDING', APPLIED = 'APPLIED', APPOINTMENT_SCHEDULED = 'APPOINTMENT_SCHEDULED',
  APPROVED = 'APPROVED', REJECTED = 'REJECTED', EXPIRED = 'EXPIRED', CANCELLED = 'CANCELLED',
}

export class CreateVisaDto {
  @ApiProperty({ enum: ['EMPLOYEE', 'APPLICANT'] }) @IsString() entityType: string;
  @ApiProperty({ description: 'Entity UUID' }) @IsString() entityId: string;
  @ApiProperty({ example: 'Work Visa' }) @IsString() visaType: string;
  @ApiPropertyOptional({ enum: VisaStatusEnum }) @IsOptional() @IsEnum(VisaStatusEnum) status?: VisaStatusEnum;
  @ApiPropertyOptional() @IsOptional() @IsString() visaNumber?: string;
  @ApiProperty({ example: '2024-01-10' }) @IsDateString() applicationDate: string;
  @ApiPropertyOptional() @IsOptional() @IsDateString() appointmentDate?: string;
  @ApiPropertyOptional() @IsOptional() @IsDateString() approvalDate?: string;
  @ApiPropertyOptional() @IsOptional() @IsDateString() expiryDate?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() embassy?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() notes?: string;
}
