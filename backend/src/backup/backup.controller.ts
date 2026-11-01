import {
  Controller,
  Get,
  Post,
  Delete,
  Param,
  Body,
  Query,
  UseGuards,
  Request,
  Res,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { Response } from 'express';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard }   from '../auth/guards/roles.guard';
import { Roles }        from '../auth/decorators/roles.decorator';
import { BackupService } from './backup.service';
import { BackupScheduleService } from './backup-schedule.service';
import { StoragePurgeService } from '../common/storage/storage-purge.service';
import { CreateBackupDto, ListBackupsDto, RestoreBackupDto } from './dto/backup.dto';

@ApiTags('Backup')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('System Admin')
@Controller('backup')
export class BackupController {
  constructor(
    private readonly backupService: BackupService,
    private readonly schedule: BackupScheduleService,
    private readonly purge: StoragePurgeService,
  ) {}

  // ── Create backup ─────────────────────────────────────────────────────────

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Create a full database backup (System Admin only)' })
  async createBackup(@Body() dto: CreateBackupDto, @Request() req: any) {
    return this.backupService.createBackup(dto, req.user?.id, req.user?.email);
  }

  // ── List backups ──────────────────────────────────────────────────────────

  @Get()
  @ApiOperation({ summary: 'List all database backups' })
  async findAll(@Query() dto: ListBackupsDto) {
    return this.backupService.findAll(dto);
  }

  // ── Active operation status ───────────────────────────────────────────────

  @Get('status')
  @ApiOperation({ summary: 'Check if a backup or restore is currently in progress' })
  getStatus() {
    return this.backupService.getActiveOperation();
  }

  // ── Schedule / staleness status ─────────────────────────────────────────────

  @Get('schedule')
  @ApiOperation({ summary: 'Scheduled-backup configuration, next run, last run and staleness' })
  scheduleStatus() {
    return this.schedule.status();
  }

  // ── Deferred object deletion ────────────────────────────────────────────────

  @Post('storage-purge')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Run the deferred-deletion purge now (skips while a backup runs; never deletes referenced objects)' })
  runStoragePurge(@Body() body: { graceHours?: number }) {
    const g = body?.graceHours;
    return this.purge.runPurge({ graceHours: typeof g === 'number' && g >= 0 ? g : undefined });
  }

  // ── Preflight ───────────────────────────────────────────────────────────────

  @Get('preflight')
  @ApiOperation({ summary: 'Run backup preflight checks (toolchain, connectivity, permissions, capacity, destination)' })
  preflight() {
    return this.backupService.preflight();
  }

  // ── Reconcile catalog vs disk/offsite ─────────────────────────────────────────

  @Get('legacy-inventory')
  @ApiOperation({ summary: 'List the legacy /uploads inventories recorded per instance (System Admin only)' })
  listLegacyInventories() {
    return this.backupService.legacyInventories();
  }

  @Post('legacy-inventory')
  @ApiOperation({ summary: 'Record the legacy /uploads files held by the instance serving this request (System Admin only)' })
  legacyInventory(@Request() req: any) {
    return this.backupService.legacyInventory(req.user?.id, req.user?.email);
  }

  @Post('reconcile')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Reconcile the backup catalog against stored artifacts (flags missing files)' })
  reconcile(@Request() req: any) {
    return this.backupService.reconcile(req.user?.id, req.user?.email);
  }

  // ── Get single backup ─────────────────────────────────────────────────────

  @Get(':id')
  @ApiOperation({ summary: 'Get backup metadata by ID' })
  async findOne(@Param('id') id: string) {
    return this.backupService.findOne(id);
  }

  // ── Preview / validate restore ────────────────────────────────────────────

  @Get(':id/preview')
  @ApiOperation({ summary: 'Preview and validate backup before restore' })
  async previewRestore(@Param('id') id: string) {
    return this.backupService.previewRestore(id);
  }

  // ── Verify integrity (distinct state from "created") ───────────────────────

  @Post(':id/verify')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Verify a backup package integrity (checksums + dump readability)' })
  async verify(@Param('id') id: string, @Request() req: any) {
    return this.backupService.verifyBackup(id, req.user?.id, req.user?.email);
  }

  // ── Download backup ───────────────────────────────────────────────────────

  @Get(':id/download')
  @ApiOperation({ summary: 'Download backup file (System Admin only)' })
  async download(
    @Param('id') id: string,
    @Request() req:  any,
    @Res()    res:  Response,
  ) {
    const { stream, fileName, fileSize, cancel } = await this.backupService.getDownloadStream(
      id,
      req.user?.id,
      req.user?.email,
    );

    res.set({
      'Content-Type':        fileName.endsWith('.tar') ? 'application/x-tar' : 'application/octet-stream',
      'Content-Disposition': `attachment; filename="${fileName}"`,
      // Streamed snapshots have no precomputed length (chunked transfer); a
      // failed export then ends the response abnormally instead of silently.
      ...(fileSize != null ? { 'Content-Length': fileSize.toString() } : {}),
    });

    stream.on('error', () => res.destroy());
    res.on('close', () => { if (!res.writableFinished) cancel(); });
    stream.pipe(res);
  }

  // ── Restore from backup ───────────────────────────────────────────────────

  @Post(':id/restore')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Restore database from a backup (System Admin only, EXTREMELY DANGEROUS)' })
  async restore(
    @Param('id') id:   string,
    @Body()     dto:  RestoreBackupDto,
    @Request()  req:  any,
  ) {
    return this.backupService.restoreBackup(id, dto, req.user?.id, req.user?.email);
  }

  // ── Delete backup ─────────────────────────────────────────────────────────

  @Delete(':id')
  @ApiOperation({ summary: 'Delete a backup file and its metadata record' })
  async deleteBackup(@Param('id') id: string, @Request() req: any) {
    return this.backupService.deleteBackup(id, req.user?.id, req.user?.email);
  }
}
