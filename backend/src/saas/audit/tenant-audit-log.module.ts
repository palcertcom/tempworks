/**
 * Phase 2.30 — TenantAuditLogModule.
 *
 * Exports `TenantAuditLogService` so the five piloted feature modules
 * (finance, documents, vehicles, workflow, applicants) can import it
 * once and delegate every audit-log emission to the shared helper.
 */
import { Module } from '@nestjs/common';
import { PrismaModule } from '../../prisma/prisma.module';
import { FeatureFlagsModule } from '../feature-flags/feature-flags.module';
import { TenantAuditLogService } from './tenant-audit-log.service';

@Module({
  imports: [PrismaModule, FeatureFlagsModule],
  providers: [TenantAuditLogService],
  exports: [TenantAuditLogService],
})
export class TenantAuditLogModule {}
