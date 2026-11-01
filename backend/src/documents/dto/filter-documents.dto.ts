import { IsOptional, IsString, IsEnum } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { PaginationDto } from '../../common/dto/pagination.dto';

export class FilterDocumentsDto extends PaginationDto {
  /** Filter by document status */
  @ApiPropertyOptional({ enum: ['PENDING', 'VERIFIED', 'REJECTED', 'EXPIRED', 'EXPIRING_SOON'] })
  @IsOptional() @IsString()
  status?: string;

  /** Filter by document type UUID */
  @ApiPropertyOptional()
  @IsOptional() @IsString()
  documentTypeId?: string;

  /** Filter by entity type (APPLICANT | EMPLOYEE | AGENCY | USER) */
  @ApiPropertyOptional()
  @IsOptional() @IsString()
  entityType?: string;

  /** Filter by specific entity UUID — use with entityType for owner-based filtering */
  @ApiPropertyOptional()
  @IsOptional() @IsString()
  entityId?: string;

  /** Filter by business document ID (partial match) */
  @ApiPropertyOptional()
  @IsOptional() @IsString()
  docId?: string;

  /** Filter by physical document number printed on the document */
  @ApiPropertyOptional()
  @IsOptional() @IsString()
  documentNumber?: string;

  /** ISO date string — only return documents with issueDate >= this */
  @ApiPropertyOptional()
  @IsOptional() @IsString()
  issueDateFrom?: string;

  /** ISO date string — only return documents with issueDate <= this */
  @ApiPropertyOptional()
  @IsOptional() @IsString()
  issueDateTo?: string;

  /** ISO date string — only return documents with expiryDate >= this */
  @ApiPropertyOptional()
  @IsOptional() @IsString()
  expiryDateFrom?: string;

  /** ISO date string — only return documents with expiryDate <= this */
  @ApiPropertyOptional()
  @IsOptional() @IsString()
  expiryDateTo?: string;

  /** Filter by uploading user UUID */
  @ApiPropertyOptional()
  @IsOptional() @IsString()
  uploadedById?: string;

  /** Filter by verifying/rejecting user UUID */
  @ApiPropertyOptional()
  @IsOptional() @IsString()
  verifiedById?: string;

  /** Phase F2 (SPIKE-010) — SUPER USER tenant override. Non-SUPER
   *  callers' value is silently ignored by `buildSuperUserTenantWhere`. */
  @ApiPropertyOptional()
  @IsOptional() @IsString()
  tenantId?: string;

  /** Archive view: 'active' (default) hides archived documents,
   *  'archived' shows only archived, 'all' shows both. */
  @ApiPropertyOptional({ enum: ['active', 'archived', 'all'] })
  @IsOptional() @IsString()
  archived?: string;
}
