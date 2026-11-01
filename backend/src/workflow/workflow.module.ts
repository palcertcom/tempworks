import { Module } from '@nestjs/common';
import { WorkflowService } from './workflow.service';
import { WorkflowController } from './workflow.controller';
import { FeatureFlagsModule } from '../saas/feature-flags/feature-flags.module';
import { TenantPrismaService } from '../saas/prisma/tenant-prisma.service';
import { PilotPrismaAccessor } from '../saas/prisma/pilot-prisma.accessor';
import { TenantAuditLogModule } from '../saas/audit/tenant-audit-log.module';

/**
 * Phase 2.26 — Workflow reads-first TenantPrisma pilot.
 *
 * Wires the pilot dependencies. Read paths in `WorkflowService` use
 * `getPilotScope(this.pilot, 'workflow')`. StageTemplate is treated
 * as a global catalog. EmployeeStage aggregates are narrowed via
 * `employee.tenantId` relation filter. WorkPermit and Visa reads
 * narrow on the direct `tenantId` column. Mutation paths remain on
 * `legacyPrisma` until Phase 2.27+.
 */
@Module({
  imports: [FeatureFlagsModule, TenantAuditLogModule],
  controllers: [WorkflowController],
  providers: [WorkflowService, TenantPrismaService, PilotPrismaAccessor],
  exports: [WorkflowService],
})
export class WorkflowModule {}
