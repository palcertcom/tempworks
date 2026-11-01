import { IsString, IsOptional, IsBoolean, IsArray, IsInt, Min } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';

export class CreateNotificationRuleDto {
  @ApiProperty() @IsString() name: string;
  @ApiProperty() @IsString() trigger: string;
  @ApiProperty() @IsString() entityType: string;
  @ApiPropertyOptional() @IsOptional() @Type(() => Number) @IsInt() @Min(1) daysBeforeExpiry?: number;
  @ApiProperty({ type: [String] }) @IsArray() @IsString({ each: true }) channels: string[];
  @ApiProperty({ type: [String] }) @IsArray() @IsString({ each: true }) recipientRoles: string[];
  @ApiPropertyOptional() @IsOptional() @IsBoolean() isActive?: boolean;
}
