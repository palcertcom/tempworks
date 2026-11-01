import {
  IsString, IsOptional, IsNumber, Min, IsIn, IsNotEmpty, IsArray,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { CONTRACT_TYPES, JOB_CATEGORIES, COMMON_CURRENCIES } from '../constants';

export class CreateJobAdDto {
  @ApiProperty({ example: 'Truck Driver – CE Licence Required' })
  @IsString() @IsNotEmpty()
  title: string;

  @ApiPropertyOptional({
    description: 'URL slug. Auto-generated from title if omitted.',
    example: 'truck-driver-ce-licence-required',
  })
  @IsOptional() @IsString()
  slug?: string;

  @ApiProperty({ enum: JOB_CATEGORIES, example: 'Truck Driver' })
  @IsString() @IsNotEmpty()
  category: string;

  @ApiProperty({ example: 'We are looking for an experienced CE truck driver…' })
  @IsString() @IsNotEmpty()
  description: string;

  @ApiProperty({ example: 'Warsaw' })
  @IsString() @IsNotEmpty()
  city: string;

  @ApiProperty({ example: 'Poland' })
  @IsString() @IsNotEmpty()
  country: string;

  @ApiPropertyOptional({ enum: CONTRACT_TYPES, default: 'Full-time' })
  @IsOptional() @IsString() @IsIn(CONTRACT_TYPES as unknown as string[])
  contractType?: string = 'Full-time';

  @ApiPropertyOptional({ example: 2500 })
  @IsOptional() @Type(() => Number) @IsNumber() @Min(0)
  salaryMin?: number;

  @ApiPropertyOptional({ example: 3500 })
  @IsOptional() @Type(() => Number) @IsNumber() @Min(0)
  salaryMax?: number;

  @ApiPropertyOptional({ enum: COMMON_CURRENCIES, default: 'GBP' })
  @IsOptional() @IsString()
  currency?: string = 'GBP';

  @ApiPropertyOptional({ enum: ['DRAFT', 'PUBLISHED', 'ARCHIVED'], default: 'DRAFT' })
  @IsOptional() @IsString() @IsIn(['DRAFT', 'PUBLISHED', 'ARCHIVED'])
  status?: string = 'DRAFT';

  @ApiPropertyOptional({ type: [String], description: 'Document type names that applicants must upload' })
  @IsOptional() @IsArray() @IsString({ each: true })
  requiredDocuments?: string[];

  // Phase 3.18 — only honoured when the caller is a PlatformAdmin
  // SUPER. Lets a SUPER user move a Job Ad between tenants from the
  // edit form. Ignored silently for every other caller (the service
  // strips it from the payload before the DB write).
  // @tenant-reviewed: phase318-tenant-public-jobs
  @ApiPropertyOptional({ description: 'Move the Job Ad to this tenant (SUPER PlatformAdmin only)' })
  @IsOptional() @IsString()
  tenantId?: string;
}
