import { Module } from '@nestjs/common';
import { FinanceService } from './finance.service';
import { FinanceController } from './finance.controller';
import { NotificationsModule } from '../notifications/notifications.module';
import { FeatureFlagsModule } from '../saas/feature-flags/feature-flags.module';
import { TenantPrismaService } from '../saas/prisma/tenant-prisma.service';
import { PilotPrismaAccessor } from '../saas/prisma/pilot-prisma.accessor';
import { TenantAuditLogModule } from '../saas/audit/tenant-audit-log.module';

/**
 * Phase 2.16 — Finance reads-first TenantPrisma pilot.
 *
 * Wires the pilot dependencies. Read paths in `FinanceService` use
 * `getPilotScope(this.pilot, 'finance')` which respects the
 * `TENANT_PRISMA_PILOT_MODULES` allow-list. Mutation paths remain on
 * `legacyPrisma` and are byte-identical to pre-2.16.
 */
// Multer config now lives per-route (memoryStorage) — see
// common/storage/multer.config.ts.
@Module({
  imports: [NotificationsModule, FeatureFlagsModule, TenantAuditLogModule],
  controllers: [FinanceController],
  providers: [FinanceService, TenantPrismaService, PilotPrismaAccessor],
  exports: [FinanceService],
})
export class FinanceModule {}
