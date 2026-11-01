import { Module } from '@nestjs/common';
import { JobAdsService } from './job-ads.service';
import { JobAdsController, PublicJobAdsController, PublicTenantJobAdsController } from './job-ads.controller';
import { FeatureFlagsModule } from '../saas/feature-flags/feature-flags.module';
import { TenantPrismaService } from '../saas/prisma/tenant-prisma.service';
import { PilotPrismaAccessor } from '../saas/prisma/pilot-prisma.accessor';

/**
 * Phase 2.9 — third tenant-scoped TenantPrisma pilot.
 *
 * Imports the pilot dependencies. The service uses
 * `getPilotScope(this.pilot, 'job-ads')` which respects the
 * `TENANT_PRISMA_PILOT_MODULES` allow-list. Public endpoints
 * (`findPublished`, `findBySlug`) typically run without a tenant
 * context attached and naturally see an inactive pilot scope, so the
 * public listing semantics stay byte-identical to legacy.
 */
@Module({
  imports: [FeatureFlagsModule],
  controllers: [JobAdsController, PublicJobAdsController, PublicTenantJobAdsController],
  providers: [JobAdsService, TenantPrismaService, PilotPrismaAccessor],
  exports: [JobAdsService],
})
export class JobAdsModule {}
