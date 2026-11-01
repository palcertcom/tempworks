import { IsOptional, IsBoolean, IsString, IsDateString } from 'class-validator';
import { Transform } from 'class-transformer';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { PaginationDto } from '../../common/dto/pagination.dto';

export class NotificationFilterDto extends PaginationDto {
  @ApiPropertyOptional({ description: 'Filter by read state' })
  @IsOptional()
  @Transform(({ value }) => value === 'true' || value === true)
  @IsBoolean()
  isRead?: boolean;

  @ApiPropertyOptional({ description: 'Filter by NotificationType (INFO, WARNING, FINANCIAL, DOCUMENT_EXPIRY, ...)' })
  @IsOptional()
  @IsString()
  type?: string;

  @ApiPropertyOptional({ description: 'Filter by event key (DOCUMENT_UPLOADED, FINANCIAL_RECORD_CREATED, ...)' })
  @IsOptional()
  @IsString()
  eventType?: string;

  @ApiPropertyOptional({ description: 'Created-at range start (ISO date)' })
  @IsOptional()
  @IsDateString()
  dateFrom?: string;

  @ApiPropertyOptional({ description: 'Created-at range end (ISO date)' })
  @IsOptional()
  @IsDateString()
  dateTo?: string;
}
