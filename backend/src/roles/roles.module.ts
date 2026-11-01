import { Module } from '@nestjs/common';
import { RolesService } from './roles.service';
import { RolesController } from './roles.controller';
import { FeatureFlagsModule } from '../saas/feature-flags/feature-flags.module';
import { TenantPrismaService } from '../saas/prisma/tenant-prisma.service';
import { PilotPrismaAccessor } from '../saas/prisma/pilot-prisma.accessor';

/**
 * Phase 2.6 — pilot module.
 *
 * Imports `FeatureFlagsModule` and provides `PilotPrismaAccessor` so
 * `RolesService` can route Prisma calls through TenantPrismaService when
 * `TENANT_PRISMA_PILOT_ENABLED=true` AND env classifies as
 * SAFE_CLONE / SAFE_STAGING. With the flag OFF (production default),
 * the accessor returns `PrismaService` directly — legacy behaviour.
 */
@Module({
  imports: [FeatureFlagsModule],
  controllers: [RolesController],
  providers: [RolesService, TenantPrismaService, PilotPrismaAccessor],
  exports: [RolesService],
})
export class RolesModule {}
