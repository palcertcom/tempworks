import { Module } from '@nestjs/common';
import { AgenciesService } from './agencies.service';
import { AgenciesController } from './agencies.controller';
import { FeatureFlagsModule } from '../saas/feature-flags/feature-flags.module';
import { TenantPrismaService } from '../saas/prisma/tenant-prisma.service';
import { PilotPrismaAccessor } from '../saas/prisma/pilot-prisma.accessor';
import { TenantAuditLogModule } from '../saas/audit/tenant-audit-log.module';

/**
 * Phase 2.35 — Agencies reads-first TenantPrisma pilot.
 *
 * Wires the pilot dependencies. Read paths in `AgenciesService` use
 * `getPilotScope(this.pilot, 'agencies')` plus an `OR isSystem: true`
 * predicate. Mutation, permission-override, manager-set, and storage
 * paths remain on `legacyPrisma` and are byte-identical to pre-2.35.
 */
@Module({
  imports: [FeatureFlagsModule, TenantAuditLogModule],
  controllers: [AgenciesController],
  providers: [AgenciesService, TenantPrismaService, PilotPrismaAccessor],
  exports: [AgenciesService],
})
export class AgenciesModule {}
