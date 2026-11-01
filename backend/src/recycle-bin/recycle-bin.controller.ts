import {
  Controller, Get, Post, Delete, Param, Query, Body, UseGuards,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { RequirePermission } from '../auth/decorators/require-permission.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { RecycleBinService } from './recycle-bin.service';
import { RestoreService } from './restore.service';
import { HardDeleteService } from './hard-delete.service';
import { DatabaseCleanupService } from './database-cleanup.service';
import { ListDeletedDto } from './dto/list-deleted.dto';
import { RestoreDto } from './dto/restore.dto';
import { HardDeleteDto } from './dto/hard-delete.dto';
import { ExecuteCleanupDto } from './dto/cleanup.dto';

@ApiTags('Recycle Bin')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('recycle-bin')
export class RecycleBinController {
  constructor(
    private readonly recycleBin: RecycleBinService,
    private readonly restore: RestoreService,
    private readonly hardDelete: HardDeleteService,
    private readonly cleanup: DatabaseCleanupService,
  ) {}

  // ── List & counts ─────────────────────────────────────────────────────────

  @Get()
  @Roles('System Admin', 'HR Manager', 'Compliance Officer')
  @RequirePermission('recycle-bin:read')
  @ApiOperation({ summary: 'List soft-deleted records across all (or a single) entity type' })
  findAll(@Query() filter: ListDeletedDto) {
    return this.recycleBin.findAll(filter);
  }

  @Get('counts')
  @Roles('System Admin', 'HR Manager', 'Compliance Officer')
  @RequirePermission('recycle-bin:read')
  @ApiOperation({ summary: 'Return count of deleted records per entity type' })
  getCounts() {
    return this.recycleBin.getEntityCounts();
  }

  // ── Record detail ─────────────────────────────────────────────────────────

  @Get(':entityType/:id/related')
  @Roles('System Admin', 'HR Manager', 'Compliance Officer')
  @RequirePermission('recycle-bin:read')
  @ApiOperation({ summary: 'Get related soft-deleted records for a deleted entity' })
  getRelated(@Param('entityType') entityType: string, @Param('id') id: string) {
    return this.recycleBin.getRelatedDeletedData(entityType.toUpperCase(), id);
  }

  @Get(':entityType/:id/preview-hard-delete')
  @Roles('System Admin', 'HR Manager', 'Compliance Officer')
  @RequirePermission('recycle-bin:read')
  @ApiOperation({ summary: 'Preview what will be permanently deleted' })
  previewHardDelete(@Param('entityType') entityType: string, @Param('id') id: string) {
    return this.recycleBin.previewHardDelete(entityType.toUpperCase(), id);
  }

  // ── Restore ───────────────────────────────────────────────────────────────

  @Post(':entityType/:id/restore')
  @Roles('System Admin', 'HR Manager', 'Compliance Officer')
  @RequirePermission('recycle-bin:create')
  @ApiOperation({ summary: 'Restore a soft-deleted record (optionally with related records)' })
  restoreRecord(
    @Param('entityType') entityType: string,
    @Param('id') id: string,
    @Body() dto: RestoreDto,
    @CurrentUser() user: any,
  ) {
    return this.restore.restore(entityType.toUpperCase(), id, user?.id, dto.withRelated ?? false, dto.reason);
  }

  // ── Hard Delete ───────────────────────────────────────────────────────────

  @Delete(':entityType/:id')
  @Roles('System Admin')
  @RequirePermission('recycle-bin:delete')
  @ApiOperation({ summary: 'Permanently hard-delete a record and its related data (System Admin only)' })
  hardDeleteRecord(
    @Param('entityType') entityType: string,
    @Param('id') id: string,
    @Body() dto: HardDeleteDto,
    @CurrentUser() user: any,
  ) {
    return this.hardDelete.execute(entityType.toUpperCase(), id, user?.id, dto.reason);
  }

  // ── Database Cleanup ──────────────────────────────────────────────────────

  @Get('cleanup/preview')
  @Roles('System Admin')
  @RequirePermission('recycle-bin:read')
  @ApiOperation({ summary: 'Preview the database cleanup — shows counts of records that will be removed' })
  cleanupPreview() {
    return this.cleanup.preview();
  }

  @Post('cleanup/execute')
  @Roles('System Admin')
  @RequirePermission('recycle-bin:create')
  @ApiOperation({
    summary: 'Execute database cleanup/reset — removes all business data while preserving admin users',
    description: 'Requires confirmPhrase === "CLEAN DATABASE". Extremely destructive and irreversible.',
  })
  cleanupExecute(@Body() dto: ExecuteCleanupDto, @CurrentUser() user: any) {
    return this.cleanup.execute(user?.id, dto);
  }
}
