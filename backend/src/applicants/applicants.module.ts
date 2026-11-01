import { Module } from '@nestjs/common';
import { ApplicantsService } from './applicants.service';
import { ApplicantsController } from './applicants.controller';
import { EmailModule } from '../email/email.module';
import { FeatureFlagsModule } from '../saas/feature-flags/feature-flags.module';
import { TenantPrismaService } from '../saas/prisma/tenant-prisma.service';
import { PilotPrismaAccessor } from '../saas/prisma/pilot-prisma.accessor';
import { TenantAuditLogModule } from '../saas/audit/tenant-audit-log.module';
import { NotificationsModule } from '../notifications/notifications.module';

/**
 * Phase 2.28 — Applicants reads-first TenantPrisma pilot.
 *
 * Wires the pilot dependencies. Read paths in `ApplicantsService`
 * use `getPilotScope(this.pilot, 'applicants')`. Mutation /
 * lifecycle / conversion paths remain on `legacyPrisma` until
 * Phase 2.29+.
 */
@Module({
  imports: [EmailModule, FeatureFlagsModule, TenantAuditLogModule, NotificationsModule],
  controllers: [ApplicantsController],
  providers: [ApplicantsService, TenantPrismaService, PilotPrismaAccessor],
  exports: [ApplicantsService],
})
export class ApplicantsModule {}
