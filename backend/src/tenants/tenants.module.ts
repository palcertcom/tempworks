import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { TenantsController } from './tenants.controller';
import { TenantMembersController } from './tenant-members.controller';
import { TenantsService } from './tenants.service';
import { PlatformTenantGuard } from './platform-tenant.guard';

// Phase 3.15 — Tenant Management Module
// Phase 3.17 — TenantMembersController carries the membership endpoints
// with a relaxed PlatformAdmin-OR-tenant-System-Admin RBAC.
// @tenant-reviewed: phase317-multi-tenant-login
@Module({
  imports: [PrismaModule],
  controllers: [TenantsController, TenantMembersController],
  providers: [TenantsService, PlatformTenantGuard],
  exports: [TenantsService],
})
export class TenantsModule {}
