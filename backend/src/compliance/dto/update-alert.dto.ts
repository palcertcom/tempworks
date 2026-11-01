import { IsOptional, IsString, IsEnum } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

export class UpdateAlertDto {
  @ApiPropertyOptional({ enum: ['OPEN', 'ACKNOWLEDGED', 'RESOLVED', 'DISMISSED'] })
  @IsOptional()
  @IsEnum(['OPEN', 'ACKNOWLEDGED', 'RESOLVED', 'DISMISSED'])
  status?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  notes?: string;
}
