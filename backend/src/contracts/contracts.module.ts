import { Module, forwardRef } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { FeatureFlagsModule } from '../saas/feature-flags/feature-flags.module';
import { TenantPrismaService } from '../saas/prisma/tenant-prisma.service';
import { PilotPrismaAccessor } from '../saas/prisma/pilot-prisma.accessor';
import { ContractsService } from './contracts.service';
import { ContractsController } from './contracts.controller';
import { ContractsAdminController } from './contracts-admin.controller';
import { ContractStatusCron } from './contract-status.cron';
import { DocumentsModule } from '../documents/documents.module';

@Module({
  // forwardRef: DocumentsModule imports ContractsModule (for auto-sync)
  // and ContractsService needs DocumentsService (to upload a contract
  // document from the contract form) — a deliberate two-way link.
  imports: [PrismaModule, FeatureFlagsModule, forwardRef(() => DocumentsModule)],
  providers: [ContractsService, ContractStatusCron, TenantPrismaService, PilotPrismaAccessor],
  controllers: [ContractsController, ContractsAdminController],
  exports: [ContractsService],
})
export class ContractsModule {}
