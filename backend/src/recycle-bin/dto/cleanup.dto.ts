import { IsString, IsOptional, IsBoolean } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class ExecuteCleanupDto {
  @ApiProperty({
    description: 'Must equal the literal string "CLEAN DATABASE" to confirm the action',
    example: 'CLEAN DATABASE',
  })
  @IsString()
  confirmPhrase: string;

  @ApiPropertyOptional({ description: 'Optional reason for cleanup (stored in audit log)' })
  @IsOptional()
  @IsString()
  reason?: string;

  @ApiPropertyOptional({
    description: 'If true, also remove audit logs (default: false — audit logs are preserved)',
    default: false,
  })
  @IsOptional()
  @IsBoolean()
  clearAuditLogs?: boolean = false;
}
