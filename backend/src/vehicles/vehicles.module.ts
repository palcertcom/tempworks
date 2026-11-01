import { Module } from '@nestjs/common';
import { VehiclesController } from './vehicles.controller';
import { VehiclesService } from './vehicles.service';
import { PrismaModule } from '../prisma/prisma.module';
import { FeatureFlagsModule } from '../saas/feature-flags/feature-flags.module';
import { TenantPrismaService } from '../saas/prisma/tenant-prisma.service';
import { PilotPrismaAccessor } from '../saas/prisma/pilot-prisma.accessor';

/**
 * Phase 2.23 — Vehicles reads-first TenantPrisma pilot.
 *
 * Wires the pilot dependencies. Read paths in `VehiclesService` use
 * `getPilotScope(this.pilot, 'vehicles')` which respects the
 * `TENANT_PRISMA_PILOT_MODULES` allow-list. Mutation, assignment,
 * document upload/download, maintenance, and storage paths remain on
 * `legacyPrisma` and are byte-identical to pre-2.23.
 */
@Module({
  imports:     [PrismaModule, FeatureFlagsModule],
  controllers: [VehiclesController],
  providers:   [VehiclesService, TenantPrismaService, PilotPrismaAccessor],
})
export class VehiclesModule {}
