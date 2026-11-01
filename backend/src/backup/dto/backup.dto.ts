import { IsOptional, IsString, IsIn, IsBoolean } from 'class-validator';
import { ApiPropertyOptional, ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { PaginationDto } from '../../common/dto/pagination.dto';

// ── Restore modes ─────────────────────────────────────────────────────────────

export enum RestoreMode {
  /** Drop all DB objects, recreate from backup — pg_restore --clean --if-exists */
  FULL = 'FULL',
  /** Restore data only; current schema must match backup schema */
  DATA_ONLY = 'DATA_ONLY',
  /** TRUNCATE all tables (cascade), then restore data — safest for data refresh */
  CLEAN = 'CLEAN',
}

// ── Backup kinds ────────────────────────────────────────────────────────────────

export enum BackupKind {
  /** Database only: pg_dumpall globals + custom-format dump (owners/ACLs/RLS). */
  DATABASE = 'DATABASE',
  /** Full system: database + uploaded files + config/manifest DR package. */
  FULL_SYSTEM = 'FULL_SYSTEM',
}

// ── DTOs ──────────────────────────────────────────────────────────────────────

export class CreateBackupDto {
  @ApiPropertyOptional({ description: 'Optional label / notes for this backup' })
  @IsOptional()
  @IsString()
  notes?: string;

  @ApiPropertyOptional({
    enum: BackupKind,
    description: 'DATABASE = database only (default); FULL_SYSTEM = database + uploaded files + config DR package.',
    default: BackupKind.DATABASE,
  })
  @IsOptional()
  @IsIn([BackupKind.DATABASE, BackupKind.FULL_SYSTEM])
  kind?: BackupKind;
}

export class ListBackupsDto extends PaginationDto {
  @ApiPropertyOptional({ description: 'Filter by status (PENDING|RUNNING|COMPLETED|FAILED)' })
  @IsOptional()
  @IsString()
  status?: string;

  @ApiPropertyOptional({ enum: BackupKind, description: 'Filter by backup kind' })
  @IsOptional()
  @IsIn([BackupKind.DATABASE, BackupKind.FULL_SYSTEM])
  kind?: BackupKind;
}

export class RestoreBackupDto {
  @ApiProperty({
    enum: RestoreMode,
    description:
      'FULL = drop + recreate all objects from backup; ' +
      'DATA_ONLY = restore row data only (schema must match); ' +
      'CLEAN = truncate all tables, then restore data',
  })
  @IsIn([RestoreMode.FULL, RestoreMode.DATA_ONLY, RestoreMode.CLEAN])
  restoreMode: RestoreMode;

  @ApiProperty({ description: 'Must equal "RESTORE DATABASE" to confirm destructive operation' })
  @IsString()
  confirmPhrase: string;

  @ApiPropertyOptional({ description: 'Optional reason / notes for the restore operation' })
  @IsOptional()
  @IsString()
  notes?: string;

  @ApiPropertyOptional({
    description:
      'Required (true) to restore the database from a DEGRADED backup — a consistent ' +
      'backup whose referenced files are missing everywhere. Never allowed for INCOMPLETE.',
  })
  @IsOptional()
  @IsBoolean()
  acceptDegraded?: boolean;

  @ApiPropertyOptional({
    description:
      'When true, skip creating an automatic pre-restore safety backup. ' +
      'Default false — a safety backup is always created before restoring.',
  })
  @IsOptional()
  @IsBoolean()
  @Type(() => Boolean)
  skipSafetyBackup?: boolean;
}
