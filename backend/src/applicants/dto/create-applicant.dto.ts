import {
  IsString, IsEmail, IsOptional, IsEnum, IsDateString,
  IsBoolean, IsUUID, IsObject,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { normalizePhoneTransform } from '../../common/phone/normalize-phone';

export enum ApplicantStatusEnum {
  NEW = 'NEW', SCREENING = 'SCREENING', INTERVIEW = 'INTERVIEW',
  OFFER = 'OFFER', ACCEPTED = 'ACCEPTED', REJECTED = 'REJECTED',
  WITHDRAWN = 'WITHDRAWN', ONBOARDING = 'ONBOARDING',
}

export enum GenderEnum {
  MALE = 'MALE',
  FEMALE = 'FEMALE',
  OTHER = 'OTHER',
  PREFER_NOT_TO_SAY = 'PREFER_NOT_TO_SAY',
}

export class CreateApplicantDto {
  // ── Core identity ───────────────────────────────────────────────────────────
  @ApiProperty() @IsString() firstName: string;
  @ApiPropertyOptional() @IsOptional() @IsString() middleName?: string;
  @ApiProperty() @IsString() lastName: string;
  @ApiProperty() @IsEmail() email: string;
  @ApiProperty() @IsString() @Transform(normalizePhoneTransform) phone: string;

  /** @deprecated Use `citizenship` instead. Kept for backward compatibility. */
  @ApiPropertyOptional() @IsOptional() @IsString() nationality?: string;

  @ApiPropertyOptional({ description: 'Citizenship country (replaces nationality)' })
  @IsOptional() @IsString() citizenship?: string;

  @ApiPropertyOptional({ enum: GenderEnum }) @IsOptional() @IsEnum(GenderEnum) gender?: GenderEnum;
  @ApiPropertyOptional({ example: '1990-01-15' }) @IsOptional() @IsDateString() dateOfBirth?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() countryOfBirth?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() cityOfBirth?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() photoUrl?: string;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() hasDrivingLicense?: boolean;

  // ── Status & assignment ─────────────────────────────────────────────────────
  @ApiPropertyOptional({ enum: ApplicantStatusEnum }) @IsOptional() @IsEnum(ApplicantStatusEnum) status?: ApplicantStatusEnum;
  @ApiPropertyOptional() @IsOptional() @IsUUID() jobTypeId?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() agencyId?: string;
  @ApiPropertyOptional({ description: 'Job ad the applicant applied from (nullable FK to job_ads)' })
  @IsOptional() @IsString() jobAdId?: string;

  // ── Legacy fields (kept for backward compat with old form) ──────────────────
  @ApiPropertyOptional({ example: 'UK Citizen' }) @IsOptional() @IsString() residencyStatus?: string;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() hasNationalInsurance?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsString() nationalInsuranceNumber?: string;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() hasWorkAuthorization?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsString() workAuthorizationType?: string;
  @ApiPropertyOptional() @IsOptional() @IsDateString() workAuthorizationExpiry?: string;
  @ApiPropertyOptional() @IsOptional() @IsDateString() preferredStartDate?: string;
  @ApiPropertyOptional({ example: 'Immediate' }) @IsOptional() @IsString() availability?: string;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() willingToRelocate?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsString() preferredLocations?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() salaryExpectation?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() notes?: string;

  // ── Rich structured application data (JSON) ─────────────────────────────────
  // Stores: addresses, passport, ID card, visa, EU residence, work permit,
  // criminal records, driving license details, driving experience,
  // education[], workHistory[], skills, emergency contact,
  // additional info, declaration, etc.
  @ApiPropertyOptional({ description: 'Rich JSON payload from the v2 application form' })
  @IsOptional()
  @IsObject()
  applicationData?: Record<string, any>;

  // SUPER USER only — reassign the record's tenant from the edit screen.
  // Ignored/stripped for every other caller; never trusted on create.
  @ApiPropertyOptional({ description: 'SUPER USER only — owning tenant id' })
  @IsOptional()
  @IsString()
  tenantId?: string;
}
