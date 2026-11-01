import { Module } from '@nestjs/common';
import { EmployeesService } from './employees.service';
import { EmployeesController } from './employees.controller';
import { FeatureFlagsModule } from '../saas/feature-flags/feature-flags.module';
import { TenantPrismaService } from '../saas/prisma/tenant-prisma.service';
import { PilotPrismaAccessor } from '../saas/prisma/pilot-prisma.accessor';
import { NotificationsModule } from '../notifications/notifications.module';

/**
 * Phase 2.33 — Employees reads-first TenantPrisma pilot.
 *
 * Wires the pilot dependencies. Read paths in `EmployeesService` use
 * `getPilotScope(this.pilot, 'employees')` which respects the
 * `TENANT_PRISMA_PILOT_MODULES` allow-list. Mutation, agency-access,
 * and storage paths remain on `legacyPrisma` and are byte-identical
 * to pre-2.33.
 */
@Module({
  imports: [FeatureFlagsModule, NotificationsModule],
  controllers: [EmployeesController],
  providers: [EmployeesService, TenantPrismaService, PilotPrismaAccessor],
  exports: [EmployeesService],
})
export class EmployeesModule {}
