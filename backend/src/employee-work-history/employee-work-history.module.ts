import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { EmployeeWorkHistoryService } from './employee-work-history.service';
import { EmployeeWorkHistoryController } from './employee-work-history.controller';
import { FeatureFlagsModule } from '../saas/feature-flags/feature-flags.module';
import { TenantPrismaService } from '../saas/prisma/tenant-prisma.service';
import { PilotPrismaAccessor } from '../saas/prisma/pilot-prisma.accessor';
import { ContractsModule } from '../contracts/contracts.module';

/**
 * Phase 2.7 — first tenant-scoped TenantPrisma pilot.
 *
 * Imports `FeatureFlagsModule` and provides `PilotPrismaAccessor` so
 * the service can route calls and apply tenant filters when
 * `TENANT_PRISMA_PILOT_ENABLED=true` AND env is SAFE_CLONE/SAFE_STAGING
 * AND a tenant is in the active request context. Otherwise behaviour
 * is byte-for-byte identical to before the refactor.
 */
@Module({
  imports: [PrismaModule, FeatureFlagsModule, ContractsModule],
  providers: [
    EmployeeWorkHistoryService,
    TenantPrismaService,
    PilotPrismaAccessor,
  ],
  controllers: [EmployeeWorkHistoryController],
  exports: [EmployeeWorkHistoryService],
})
export class EmployeeWorkHistoryModule {}
