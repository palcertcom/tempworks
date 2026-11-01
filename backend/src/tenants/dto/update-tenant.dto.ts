import { PartialType } from '@nestjs/swagger';
import { CreateTenantDto } from './create-tenant.dto';

// Phase 3.15 — slug update is enforced as SUPER-only at the service layer.
// @tenant-reviewed: phase315-tenant-management-module
export class UpdateTenantDto extends PartialType(CreateTenantDto) {}
