import { Global, Module } from '@nestjs/common';
import { LogsService } from './logs.service';
import { LogsController } from './logs.controller';
import { TenantAuditController } from './tenant-audit.controller';
import { AuditLogService } from './audit-log.service';
import { AuditLogRateLimiter } from './audit-log-rate-limiter.service';
import { FeatureFlagsModule } from '../saas/feature-flags/feature-flags.module';
import { TenantPrismaService } from '../saas/prisma/tenant-prisma.service';
import { PilotPrismaAccessor } from '../saas/prisma/pilot-prisma.accessor';
import { TenantAuditLogModule } from '../saas/audit/tenant-audit-log.module';

@Global()
@Module({
  imports: [FeatureFlagsModule, TenantAuditLogModule],
  controllers: [LogsController, TenantAuditController],
  providers: [LogsService, AuditLogService, TenantPrismaService, PilotPrismaAccessor, AuditLogRateLimiter],
  exports: [AuditLogService],
})
export class LogsModule {}
