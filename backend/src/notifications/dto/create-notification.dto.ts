import { IsString, IsOptional, IsEnum, IsUUID } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class CreateNotificationDto {
  @ApiProperty({ description: 'User UUID to notify' }) @IsUUID() userId: string;
  @ApiProperty() @IsString() title: string;
  @ApiProperty() @IsString() message: string;
  @ApiPropertyOptional({ enum: ['INFO', 'WARNING', 'ERROR', 'SUCCESS', 'COMPLIANCE', 'DOCUMENT_EXPIRY', 'WORKFLOW', 'SYSTEM'] })
  @IsOptional() @IsEnum(['INFO', 'WARNING', 'ERROR', 'SUCCESS', 'COMPLIANCE', 'DOCUMENT_EXPIRY', 'WORKFLOW', 'SYSTEM'])
  type?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() relatedEntity?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() relatedEntityId?: string;
}
