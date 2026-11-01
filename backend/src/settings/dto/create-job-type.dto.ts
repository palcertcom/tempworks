import { IsString, IsOptional, IsBoolean, IsArray } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class CreateJobTypeDto {
  @ApiProperty() @IsString() name: string;
  @ApiPropertyOptional() @IsOptional() @IsString() description?: string;
  @ApiPropertyOptional() @IsOptional() @IsArray() @IsString({ each: true }) requiredDocuments?: string[];
  @ApiPropertyOptional() @IsOptional() @IsBoolean() isActive?: boolean;
}
