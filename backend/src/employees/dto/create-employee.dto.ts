import { IsString, IsEmail, IsOptional, IsEnum, IsDateString, IsInt, Min } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type, Transform } from 'class-transformer';
import { normalizePhoneTransform } from '../../common/phone/normalize-phone';

export enum EmployeeStatusEnum {
  ACTIVE = 'ACTIVE',
  INACTIVE = 'INACTIVE',
  PENDING = 'PENDING',
  ONBOARDING = 'ONBOARDING',
  TERMINATED = 'TERMINATED',
  ON_LEAVE = 'ON_LEAVE',
}

export class CreateEmployeeDto {
  @ApiProperty() @IsString() firstName: string;
  @ApiProperty() @IsString() lastName: string;
  @ApiProperty() @IsEmail() email: string;
  @ApiProperty() @IsString() @Transform(normalizePhoneTransform) phone: string;
  @ApiProperty() @IsString() nationality: string;
  @ApiProperty() @IsDateString() dateOfBirth: string;
  @ApiPropertyOptional() @IsOptional() @IsString() licenseNumber?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() licenseCategory?: string;
  @ApiPropertyOptional() @IsOptional() @Type(() => Number) @IsInt() @Min(0) yearsExperience?: number;
  @ApiPropertyOptional({ description: 'JobType UUID' }) @IsOptional() @IsString() jobTypeId?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() agencyId?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() photoUrl?: string;
  @ApiProperty() @IsString() addressLine1: string;
  @ApiPropertyOptional() @IsOptional() @IsString() addressLine2?: string;
  @ApiProperty() @IsString() city: string;
  @ApiProperty() @IsString() country: string;
  @ApiProperty() @IsString() postalCode: string;
  @ApiPropertyOptional() @IsOptional() @IsString() emergencyContact?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @Transform(normalizePhoneTransform) emergencyPhone?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() notes?: string;
  @ApiPropertyOptional({ enum: EmployeeStatusEnum })
  @IsOptional() @IsEnum(EmployeeStatusEnum) status?: EmployeeStatusEnum;

  // §4.11 Notifications — contract lifecycle. Setting contractEndDate
  // arms the tiered EMPLOYEE_CONTRACT_EXPIRING reminders and the
  // EMPLOYEE_CONTRACT_ENDED close-out. Moving an existing end date
  // forward (or filling a null end date with status=ACTIVE) triggers
  // EMPLOYEE_CONTRACT_RENEWED in the update path.
  @ApiPropertyOptional({ description: 'Contract start date (ISO)' })
  @IsOptional() @IsDateString() contractStartDate?: string;

  @ApiPropertyOptional({ description: 'Contract end date (ISO); null/omitted for open-ended employment' })
  @IsOptional() @IsDateString() contractEndDate?: string;

  // SUPER USER only — reassign the record's tenant from the edit screen.
  // Ignored/stripped for every other caller; never trusted on create.
  @ApiPropertyOptional({ description: 'SUPER USER only — owning tenant id' })
  @IsOptional() @IsString() tenantId?: string;
}
