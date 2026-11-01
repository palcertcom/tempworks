import { IsObject, IsOptional, IsString } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class SaveDraftDto {
  @ApiProperty({ description: 'Raw ApplicantFormData blob — the shape that drives the multi-step form on the client.' })
  @IsObject()
  formData!: Record<string, any>;

  @ApiPropertyOptional({ description: 'Job Ad the application is in response to, if any.' })
  @IsOptional()
  @IsString()
  jobAdId?: string;
}
