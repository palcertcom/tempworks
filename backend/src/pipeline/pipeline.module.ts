import { Module } from '@nestjs/common';
import { WorkflowService } from './pipeline.service';
import { WorkflowController } from './pipeline.controller';
import { PrismaModule } from '../prisma/prisma.module';
import { FeatureFlagsModule } from '../saas/feature-flags/feature-flags.module';
import { TenantPrismaService } from '../saas/prisma/tenant-prisma.service';
import { PilotPrismaAccessor } from '../saas/prisma/pilot-prisma.accessor';
import { TenantAuditLogModule } from '../saas/audit/tenant-audit-log.module';
import { NotificationsModule } from '../notifications/notifications.module';

/**
 * Phase 2.61/2.62 — Pipeline pilot.
 *
 * - 2.61 wired `TenantPrismaService` + `PilotPrismaAccessor` so
 *   assignment-driven reads can apply `scope.tenantWhere()`.
 * - 2.62 imports `TenantAuditLogModule` so `WorkflowService` can
 *   route audit emission through `TenantAuditLogService.write`.
 *
 * Workflow / WorkflowStage configuration remains GLOBAL by design.
 */
@Module({
  imports: [PrismaModule, FeatureFlagsModule, TenantAuditLogModule, NotificationsModule],
  controllers: [WorkflowController],
  providers: [WorkflowService, TenantPrismaService, PilotPrismaAccessor],
  exports: [WorkflowService],
})
export class WorkflowPipelineModule {}
