import { IsObject, IsOptional } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

export class UpdatePreferencesDto {
  @ApiPropertyOptional({
    description: 'Notification preferences keyed by event type',
    example: {
      DOCUMENT_UPLOADED: { in_app: true, email: false, sms: false },
      DOCUMENT_EXPIRING_SOON: { in_app: true, email: true, sms: false },
    },
  })
  @IsOptional()
  @IsObject()
  preferences?: Record<string, { in_app: boolean; email: boolean; sms: boolean }>;
}
