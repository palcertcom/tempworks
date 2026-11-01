import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { isSuperPlatformAdmin } from '../saas/platform-admin/super-tenant-edit';

interface CompanyProfileInput {
  name: string;
  legalName?: string;
  addressLine1?: string;
  addressLine2?: string;
  city?: string;
  postalCode?: string;
  country?: string;
  phone?: string;
  email?: string;
  vatNumber?: string;
  registrationNumber?: string;
  logoUrl?: string;
  footer?: string;
  isDefault?: boolean;
  /** SUPER-only — reassign profile to a specific tenant. Ignored for everyone else. */
  tenantId?: string | null;
}

/**
 * Company Export Profile = the company-details block printed on the
 * Excel timesheet header. Tenants may keep several profiles (own
 * holding co. + client cos.) and pick one at export time.
 */
@Injectable()
export class CompanyProfilesService {
  constructor(private readonly prisma: PrismaService) {}

  async list(callerTenantId?: string | null, requestedTenantId?: string | null, actorId?: string) {
    // SUPER may scope to any tenant via ?tenantId=… (and also see globals via
    // tenantId=__none__). Every other caller is locked to their own tenant.
    const where: any = { deletedAt: null };
    if (await isSuperPlatformAdmin(this.prisma, actorId)) {
      if (requestedTenantId === '__none__') where.tenantId = null;
      else if (requestedTenantId) where.tenantId = requestedTenantId;
      // omitted → all tenants (SUPER global view)
    } else if (callerTenantId) {
      where.tenantId = callerTenantId;
    }
    return (this.prisma as any).companyExportProfile.findMany({
      where,
      orderBy: [{ isDefault: 'desc' }, { name: 'asc' }],
    });
  }

  async get(id: string) {
    const profile = await (this.prisma as any).companyExportProfile.findUnique({ where: { id } });
    if (!profile || profile.deletedAt) {
      throw new NotFoundException('Company profile not found');
    }
    return profile;
  }

  async create(dto: CompanyProfileInput, callerTenantId?: string | null, actorId?: string) {
    // Tenant policy:
    //   • SUPER may pick any existing tenant via dto.tenantId; absent →
    //     the caller's active tenant.
    //   • Everyone else: the row is pinned to the caller's active tenant.
    //     Any tenantId in the body is silently stripped (spoof guard).
    const { tenantId: requestedTenantId, ...rest } = dto;
    const isSuper = await isSuperPlatformAdmin(this.prisma, actorId);
    let tenantId: string | null = callerTenantId ?? null;
    if (isSuper && requestedTenantId !== undefined) {
      const trimmed = (requestedTenantId ?? '').toString().trim();
      if (trimmed) {
        const exists = await (this.prisma as any).tenant.findUnique({ where: { id: trimmed }, select: { id: true } });
        if (!exists) {
          throw new BadRequestException({ code: 'TENANT.NOT_FOUND', message: 'Selected tenant does not exist.', params: { tenantId: trimmed } });
        }
        tenantId = trimmed;
      } else {
        tenantId = null; // SUPER explicitly chose "no tenant"
      }
    }
    if (rest.isDefault) await this.clearDefault(tenantId);
    return (this.prisma as any).companyExportProfile.create({
      data: { ...rest, tenantId },
    });
  }

  async update(id: string, dto: Partial<CompanyProfileInput>, actorId?: string) {
    const existing = await this.get(id);
    const { tenantId: requestedTenantId, ...rest } = dto;
    // SUPER-only tenant reassignment; non-SUPER attempts are stripped.
    let nextTenantId: string | null | undefined;
    if (requestedTenantId !== undefined && await isSuperPlatformAdmin(this.prisma, actorId)) {
      const trimmed = (requestedTenantId ?? '').toString().trim();
      if (trimmed) {
        const exists = await (this.prisma as any).tenant.findUnique({ where: { id: trimmed }, select: { id: true } });
        if (!exists) {
          throw new BadRequestException({ code: 'TENANT.NOT_FOUND', message: 'Selected tenant does not exist.', params: { tenantId: trimmed } });
        }
        nextTenantId = trimmed;
      } else {
        nextTenantId = null;
      }
    }
    const effectiveTenantId = nextTenantId !== undefined ? nextTenantId : existing.tenantId;
    if (rest.isDefault) await this.clearDefault(effectiveTenantId);
    return (this.prisma as any).companyExportProfile.update({
      where: { id },
      data: { ...rest, ...(nextTenantId !== undefined ? { tenantId: nextTenantId } : {}) },
    });
  }

  async remove(id: string) {
    await this.get(id);
    return (this.prisma as any).companyExportProfile.update({
      where: { id },
      data: { deletedAt: new Date() },
    });
  }

  private async clearDefault(tenantId?: string | null) {
    await (this.prisma as any).companyExportProfile.updateMany({
      where: { tenantId: tenantId ?? null, isDefault: true, deletedAt: null },
      data: { isDefault: false },
    });
  }
}
