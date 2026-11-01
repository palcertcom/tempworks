import { IsOptional, IsBoolean, IsString } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

export class RestoreDto {
  @ApiPropertyOptional({
    description: 'If true, also restore eligible soft-deleted related records',
    default: false,
  })
  @IsOptional()
  @IsBoolean()
  withRelated?: boolean = false;

  @ApiPropertyOptional({ description: 'Optional reason for restore action (for audit log)' })
  @IsOptional()
  @IsString()
  reason?: string;
}
