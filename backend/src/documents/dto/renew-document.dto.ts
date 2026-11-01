import { IsOptional, IsString, IsDateString } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

/**
 * Payload for the document renewal endpoint.
 * Renewal creates a NEW Document record pointing to the superseded one
 * via renewedFromId. The original document is NOT modified.
 * The new document starts with PENDING status.
 */
export class RenewDocumentDto {
  /** Human-readable name for the renewed document */
  @ApiPropertyOptional()
  @IsOptional() @IsString()
  name?: string;

  /** New issue date (ISO date string) */
  @ApiPropertyOptional()
  @IsOptional() @IsDateString()
  issueDate?: string;

  /** New expiry date (ISO date string) */
  @ApiPropertyOptional()
  @IsOptional() @IsDateString()
  expiryDate?: string;

  /** Document number on the new physical document */
  @ApiPropertyOptional()
  @IsOptional() @IsString()
  documentNumber?: string;

  /** Country of issue for the renewed document */
  @ApiPropertyOptional()
  @IsOptional() @IsString()
  issueCountry?: string;

  /** Issuing authority */
  @ApiPropertyOptional()
  @IsOptional() @IsString()
  issuer?: string;

  /** Optional notes */
  @ApiPropertyOptional()
  @IsOptional() @IsString()
  notes?: string;
}
