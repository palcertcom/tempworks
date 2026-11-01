import { IsString, IsOptional } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

export class UpdatePreferencesDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  preferredLanguage?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  timeZone?: string;

  @ApiPropertyOptional()
  @IsOptional()
  notificationPrefs?: Record<string, any>;
}
