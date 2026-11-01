import {
  IsString, IsOptional, IsEnum, IsDateString, IsInt, IsUUID, Min,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';

export enum EntityTypeEnum {
  EMPLOYEE = 'EMPLOYEE', APPLICANT = 'APPLICANT',
  APPLICATION = 'APPLICATION', AGENCY = 'AGENCY', USER = 'USER',
  // Phase 2C (#32) — entityId is the AttendanceRecord.id; the document
  // inherits the usual tenant/agency scoping and document permissions.
  ATTENDANCE = 'ATTENDANCE',
}

export class CreateDocumentDto {
  @ApiProperty() @IsString() name: string;
  @ApiProperty({ description: 'DocumentType UUID' }) @IsUUID() documentTypeId: string;
  @ApiProperty({ enum: EntityTypeEnum }) @IsEnum(EntityTypeEnum) entityType: EntityTypeEnum;
  @ApiProperty({ description: 'ID of the related entity' }) @IsString() entityId: string;
  @ApiPropertyOptional() @IsOptional() @IsDateString() issueDate?: string;
  @ApiPropertyOptional() @IsOptional() @IsDateString() expiryDate?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() issuer?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() documentNumber?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() notes?: string;
}
