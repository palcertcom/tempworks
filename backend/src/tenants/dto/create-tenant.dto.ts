import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsEmail, IsHexColor, IsIn, IsObject, IsOptional, IsString, Matches, MaxLength, MinLength } from 'class-validator';

// Phase 3.15 — Tenant Management Module
// @tenant-reviewed: phase315-tenant-management-module
export class CreateTenantDto {
  @ApiProperty()
  @IsString() @MinLength(2) @MaxLength(80)
  name!: string;

  @ApiProperty({ description: 'lowercase URL-safe slug, immutable after create unless SUPER' })
  @IsString() @MinLength(2) @MaxLength(63)
  @Matches(/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/, { message: 'slug must be lowercase URL-safe' })
  slug!: string;

  @ApiPropertyOptional()
  @IsOptional() @IsString() @MaxLength(253)
  @Matches(/^(?!:\/\/)([a-zA-Z0-9-_]+\.)+[a-zA-Z0-9]{2,}$/, { message: 'invalid customDomain' })
  customDomain?: string;

  @ApiPropertyOptional()
  @IsOptional() @IsIn(['ACTIVE', 'SUSPENDED', 'INACTIVE'])
  status?: 'ACTIVE' | 'SUSPENDED' | 'INACTIVE';

  @ApiPropertyOptional() @IsOptional() @IsString() region?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() logoUrl?: string;
  @ApiPropertyOptional() @IsOptional() @IsHexColor() primaryColor?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() timezone?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() locale?: string;
  @ApiPropertyOptional() @IsOptional() @IsEmail() contactEmail?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() contactPhone?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() address?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() notes?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() planId?: string;
  @ApiPropertyOptional() @IsOptional() @IsObject() featureFlags?: Record<string, boolean>;
  @ApiPropertyOptional() @IsOptional() @IsString() onboardingStatus?: string;
}
