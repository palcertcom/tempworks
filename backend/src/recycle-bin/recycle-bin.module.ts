import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { LogsModule } from '../logs/logs.module';
import { RecycleBinService } from './recycle-bin.service';
import { RestoreService } from './restore.service';
import { HardDeleteService } from './hard-delete.service';
import { DatabaseCleanupService } from './database-cleanup.service';
import { RecycleBinController } from './recycle-bin.controller';
import { FeatureFlagsModule } from '../saas/feature-flags/feature-flags.module';
import { TenantPrismaService } from '../saas/prisma/tenant-prisma.service';
import { PilotPrismaAccessor } from '../saas/prisma/pilot-prisma.accessor';

/**
 * Phase 2.11 — fifth tenant-scoped TenantPrisma pilot.
 *
 * All four services (RecycleBinService, RestoreService,
 * HardDeleteService, DatabaseCleanupService) are wired with the pilot
 * accessor. Tenant-scoped entities (APPLICANT, EMPLOYEE, AGENCY,
 * DOCUMENT, FINANCIAL_RECORD, JOB_AD, NOTIFICATION, VEHICLE,
 * VEHICLE_DOCUMENT, MAINTENANCE_RECORD) are filtered by tenant when
 * the pilot scope is active. Global / catalog entities (USER, ROLE,
 * DOCUMENT_TYPE, MAINTENANCE_TYPE, WORKSHOP, REPORT) keep their
 * existing global semantics — see SAAS_PHASE2_RECYCLE_BIN_SCOPE_MAP.md.
 *
 * `DatabaseCleanupService` is a System Admin-only platform operation
 * that intentionally crosses tenant boundaries. It remains on
 * `legacyPrisma` and is annotated `phase211-excluded-platform`.
 */
@Module({
  imports: [PrismaModule, LogsModule, FeatureFlagsModule],
  controllers: [RecycleBinController],
  providers: [
    RecycleBinService, RestoreService, HardDeleteService, DatabaseCleanupService,
    TenantPrismaService, PilotPrismaAccessor,
  ],
  exports: [RecycleBinService, RestoreService, HardDeleteService, DatabaseCleanupService],
})
export class RecycleBinModule {}
