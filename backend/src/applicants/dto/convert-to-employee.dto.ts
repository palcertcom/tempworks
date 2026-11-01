import { IsString, IsOptional, IsInt, Min } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type, Transform } from 'class-transformer';
import { normalizePhoneTransform } from '../../common/phone/normalize-phone';

export class ConvertToEmployeeDto {
  @ApiProperty() @IsString() addressLine1: string;
  @ApiPropertyOptional() @IsOptional() @IsString() addressLine2?: string;
  @ApiProperty() @IsString() city: string;
  @ApiProperty() @IsString() country: string;
  @ApiProperty() @IsString() postalCode: string;
  @ApiPropertyOptional() @IsOptional() @IsString() licenseNumber?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() licenseCategory?: string;
  @ApiPropertyOptional() @IsOptional() @Type(() => Number) @IsInt() @Min(0) yearsExperience?: number;
  @ApiPropertyOptional() @IsOptional() @IsString() emergencyContact?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @Transform(normalizePhoneTransform) emergencyPhone?: string;
}
