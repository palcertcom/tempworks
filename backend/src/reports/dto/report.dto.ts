import {
  IsString, IsOptional, IsBoolean, IsInt, IsIn, IsArray,
  ValidateNested, Min, IsEnum,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

// ─── Filter ──────────────────────────────────────────────────────────────────

export class ReportFilterDto {
  @ApiProperty() @IsString() fieldName: string;

  @ApiProperty({
    enum: ['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'like', 'between', 'in', 'is_null', 'is_not_null'],
  })
  @IsIn(['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'like', 'between', 'in', 'is_null', 'is_not_null'])
  operator: string;

  @ApiPropertyOptional() @IsOptional() @IsString() value?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() value2?: string;

  @ApiPropertyOptional({ enum: ['string', 'number', 'date', 'boolean'] })
  @IsOptional()
  @IsIn(['string', 'number', 'date', 'boolean'])
  valueType?: string;
}

// ─── Column ──────────────────────────────────────────────────────────────────

export class ReportColumnDto {
  @ApiProperty() @IsString() columnName: string;
  @ApiProperty() @IsString() displayName: string;

  @ApiPropertyOptional({ enum: ['string', 'number', 'date', 'boolean', 'enum'] })
  @IsOptional()
  @IsIn(['string', 'number', 'date', 'boolean', 'enum'])
  dataType?: string;

  @ApiPropertyOptional() @IsOptional() @IsBoolean() isGrouped?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() isAggregated?: boolean;

  @ApiPropertyOptional({ enum: ['COUNT', 'SUM', 'AVG', 'MIN', 'MAX'] })
  @IsOptional()
  @IsIn(['COUNT', 'SUM', 'AVG', 'MIN', 'MAX'])
  aggregationType?: string;

  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(0) position?: number;
}

// ─── Sorting ─────────────────────────────────────────────────────────────────

export class ReportSortingDto {
  @ApiProperty() @IsString() columnName: string;

  @ApiPropertyOptional({ enum: ['ASC', 'DESC'] })
  @IsOptional()
  @IsIn(['ASC', 'DESC'])
  direction?: string;

  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(0) position?: number;
}

// Whitelisted dataSource values for Create / Update / Preview DTOs.
// Phase 3 Reports Hardening — Phase E Batch 1 added the Vehicles
// fleet trio (vehicles / workshops / maintenance_records).
export const REPORT_DATA_SOURCE_VALUES = [
  'employees', 'applicants', 'documents', 'compliance_alerts', 'agencies', 'work_permits',
  'document_types', 'visas',
  'employees_documents', 'employees_work_permits', 'employees_compliance',
  'applicants_documents', 'employees_agencies', 'applicants_compliance',
  'documents_with_type', 'employees_visas', 'applicants_visas',
  'employees_documents_type',
  // Phase E Batch 1.
  'vehicles', 'workshops', 'maintenance_records',
  // Phase E Batch 2 (Operations).
  'attendance', 'finance', 'job_ads',
  // Phase E Batch 3 (Workflows).
  'workflows',
] as const;

// ─── Create / Update Report ───────────────────────────────────────────────────

export class CreateReportDto {
  @ApiProperty() @IsString() name: string;
  @ApiPropertyOptional() @IsOptional() @IsString() description?: string;

  @ApiProperty({ enum: REPORT_DATA_SOURCE_VALUES })
  @IsIn(REPORT_DATA_SOURCE_VALUES as unknown as string[])
  dataSource: string;

  @ApiPropertyOptional({ type: [ReportFilterDto] })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ReportFilterDto)
  filters?: ReportFilterDto[];

  @ApiPropertyOptional({ type: [ReportColumnDto] })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ReportColumnDto)
  columns?: ReportColumnDto[];

  @ApiPropertyOptional({ type: [ReportSortingDto] })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ReportSortingDto)
  sorting?: ReportSortingDto[];
}

export class UpdateReportDto extends CreateReportDto {}

// ─── Preview (Phase 3 Reports Hardening — Phase A) ──────────────────────────
// Same shape as CreateReportDto minus the `name` requirement. Used by
// POST /reports/preview to run an unsaved definition without persisting.

export class PreviewReportDto {
  @ApiProperty({ enum: REPORT_DATA_SOURCE_VALUES })
  @IsIn(REPORT_DATA_SOURCE_VALUES as unknown as string[])
  dataSource: string;

  @ApiPropertyOptional({ type: [ReportFilterDto] })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ReportFilterDto)
  filters?: ReportFilterDto[];

  @ApiPropertyOptional({ type: [ReportColumnDto] })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ReportColumnDto)
  columns?: ReportColumnDto[];

  @ApiPropertyOptional({ type: [ReportSortingDto] })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ReportSortingDto)
  sorting?: ReportSortingDto[];
}

// ─── Run / Export ─────────────────────────────────────────────────────────────

export class RunReportDto {
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(1) page?: number;
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(1) limit?: number;
}

export enum ExportFormat {
  EXCEL = 'excel',
  PDF = 'pdf',
  WORD = 'word',
}

export class ExportReportDto {
  @ApiProperty({ enum: ExportFormat })
  @IsEnum(ExportFormat)
  format: ExportFormat;
}

// ─── Sharing & Visibility (Phase 3 Reports Hardening — Phase B) ───────────

export const REPORT_VISIBILITY_VALUES = ['PRIVATE', 'SHARED', 'PUBLIC_IN_TENANT'] as const;
export const REPORT_SHARE_PERMISSION_VALUES = ['VIEW', 'RUN', 'EDIT', 'SHARE'] as const;

export class SetReportVisibilityDto {
  @ApiProperty({ enum: REPORT_VISIBILITY_VALUES })
  @IsIn(REPORT_VISIBILITY_VALUES as unknown as string[])
  visibility: 'PRIVATE' | 'SHARED' | 'PUBLIC_IN_TENANT';
}

export class ShareReportDto {
  @ApiProperty() @IsString() userId: string;

  @ApiPropertyOptional({ enum: REPORT_SHARE_PERMISSION_VALUES })
  @IsOptional()
  @IsIn(REPORT_SHARE_PERMISSION_VALUES as unknown as string[])
  permission?: 'VIEW' | 'RUN' | 'EDIT' | 'SHARE';
}
