import { IsEmail, IsString, IsOptional, MinLength, IsEnum, IsDateString, IsNotEmpty } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export enum UserStatusEnum {
  ACTIVE = 'ACTIVE',
  INACTIVE = 'INACTIVE',
  SUSPENDED = 'SUSPENDED',
  PENDING = 'PENDING',
  TERMINATED = 'TERMINATED',
}

export enum GenderEnum {
  MALE = 'MALE',
  FEMALE = 'FEMALE',
  OTHER = 'OTHER',
  PREFER_NOT_TO_SAY = 'PREFER_NOT_TO_SAY',
}

export class CreateUserDto {
  @ApiProperty()
  @IsEmail()
  email: string;

  @ApiPropertyOptional({ minLength: 8, description: 'If not provided, an activation email will be sent' })
  @IsOptional()
  @IsString()
  @MinLength(8)
  password?: string;

  @ApiProperty()
  @IsString()
  firstName: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  middleName?: string;

  @ApiProperty()
  @IsString()
  lastName: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  phone?: string;

  @ApiProperty({ description: 'Role ID' })
  @IsString()
  @IsNotEmpty()
  roleId: string;

  @ApiPropertyOptional({ description: 'Agency ID' })
  @IsOptional()
  @IsString()
  agencyId?: string;

  @ApiPropertyOptional({ enum: UserStatusEnum })
  @IsOptional()
  @IsEnum(UserStatusEnum)
  status?: string;

  // Profile fields
  @ApiPropertyOptional()
  @IsOptional()
  @IsDateString()
  dateOfBirth?: string;

  @ApiPropertyOptional({ enum: GenderEnum })
  @IsOptional()
  @IsEnum(GenderEnum)
  gender?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  citizenship?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  addressLine1?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  addressLine2?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  city?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  country?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  postalCode?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  jobTitle?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  department?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsDateString()
  startDate?: string;

  // Preferences
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  preferredLanguage?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  timeZone?: string;
}
