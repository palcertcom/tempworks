import { Module } from '@nestjs/common';
import { AttendanceController } from './attendance.controller';
import { AttendanceService } from './attendance.service';
import { PrismaModule } from '../prisma/prisma.module';
import { FeatureFlagsModule } from '../saas/feature-flags/feature-flags.module';
import { TenantPrismaService } from '../saas/prisma/tenant-prisma.service';
import { PilotPrismaAccessor } from '../saas/prisma/pilot-prisma.accessor';
import { TenantAuditLogModule } from '../saas/audit/tenant-audit-log.module';

/**
 * Phase 2.47 — Attendance reads-first TenantPrisma pilot.
 *
 * Wires the pilot dependencies. Read paths in `AttendanceService`
 * (`listEmployeesWithStats`, `getEmployeeAttendance`) use
 * `getPilotScope(this.pilot, 'attendance')` and apply `tenantWhere()`
 * to both the parent `Employee` lookup and the child `AttendanceRecord`
 * query. Mutation, bulk, lock, and export paths remain on
 * `legacyPrisma` and are byte-identical to pre-2.47.
 */
@Module({
  imports:     [PrismaModule, FeatureFlagsModule, TenantAuditLogModule],
  controllers: [AttendanceController],
  providers:   [AttendanceService, TenantPrismaService, PilotPrismaAccessor],
  exports:     [AttendanceService],
})
export class AttendanceModule {}
