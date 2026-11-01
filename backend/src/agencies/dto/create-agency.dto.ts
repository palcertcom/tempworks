import { IsString, IsEmail, IsOptional, IsEnum, IsInt, Min, IsUrl } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';

export class CreateAgencyDto {
  @ApiProperty() @IsString() name: string;
  @ApiProperty() @IsString() country: string;

  // Legacy single-line contact-person name is kept for backwards compatibility.
  // New submissions typically send the structured trio below; the service
  // combines them into `contactPerson` when only the pieces are provided.
  @ApiPropertyOptional() @IsOptional() @IsString() contactPerson?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() contactFirstName?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() contactMiddleName?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() contactLastName?: string;

  @ApiProperty() @IsEmail() email: string;
  @ApiProperty() @IsString() phone: string;
  @ApiPropertyOptional() @IsOptional() @IsString() whatsapp?: string;

  @ApiPropertyOptional() @IsOptional() @IsUrl({ require_protocol: false }) website?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() logoUrl?: string;

  // Headquarters address pieces — all optional so existing rows migrate cleanly.
  @ApiPropertyOptional() @IsOptional() @IsString() addressLine1?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() addressLine2?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() city?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() stateRegion?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() postalCode?: string;

  @ApiPropertyOptional() @IsOptional() @IsString() notes?: string;

  @ApiPropertyOptional({ enum: ['ACTIVE', 'INACTIVE', 'SUSPENDED'] })
  @IsOptional() @IsEnum(['ACTIVE', 'INACTIVE', 'SUSPENDED']) status?: string;

  @ApiPropertyOptional({ description: 'Maximum number of users allowed for this agency', default: 10 })
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) maxUsersPerAgency?: number;

  // Phase 3.9 — `isSystem` field removed. Platform authority is now
  // sourced exclusively from PlatformAdmin rows. Any legacy payload
  // still carrying the field is silently dropped by the service.

  // Phase 3 (#27) — SUPER-only tenant pin.
  // Whitelisted here so the property survives ValidationPipe stripping.
  // The service re-checks SUPER and silently drops it for everyone else
  // (spoof guard) — the backend remains the final authority.
  @ApiPropertyOptional({ description: 'SUPER-only: pin agency to this tenant' })
  @IsOptional() @IsString() tenantId?: string;
}
