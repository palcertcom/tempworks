import { Module } from '@nestjs/common';
import { ComplianceService } from './compliance.service';
import { ComplianceController } from './compliance.controller';
import { ComplianceScheduler } from './compliance.scheduler';
import { ComplianceCron } from './compliance.cron';
import { FeatureFlagsModule } from '../saas/feature-flags/feature-flags.module';
import { TenantPrismaService } from '../saas/prisma/tenant-prisma.service';
import { PilotPrismaAccessor } from '../saas/prisma/pilot-prisma.accessor';
import { TenantAuditLogModule } from '../saas/audit/tenant-audit-log.module';
import { NotificationsModule } from '../notifications/notifications.module';

/**
 * Phase 2.8 — second tenant-scoped TenantPrisma pilot.
 *
 * Imports the pilot dependencies so `ComplianceService` can route reads
 * through the accessor and apply tenant filters via `getPilotScope()`.
 * Defaults are off; production behaviour is unchanged.
 */
@Module({
  imports: [FeatureFlagsModule, TenantAuditLogModule, NotificationsModule],
  controllers: [ComplianceController],
  providers: [ComplianceService, ComplianceScheduler, ComplianceCron, TenantPrismaService, PilotPrismaAccessor],
  exports: [ComplianceService, ComplianceScheduler],
})
export class ComplianceModule {}
