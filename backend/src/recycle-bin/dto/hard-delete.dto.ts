import { IsOptional, IsString } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

export class HardDeleteDto {
  @ApiPropertyOptional({ description: 'Reason for permanent deletion (required for audit log)' })
  @IsOptional()
  @IsString()
  reason?: string;
}
