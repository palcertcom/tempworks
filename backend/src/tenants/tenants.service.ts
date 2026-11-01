import {
  Injectable, BadRequestException, ConflictException, ForbiddenException, NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateTenantDto } from './dto/create-tenant.dto';
import { UpdateTenantDto } from './dto/update-tenant.dto';

// Phase 3.15 — Tenant Management Module.
// Branding-scoped operational metadata is stored on the existing Tenant
// `branding Json?` column to avoid a schema migration. Soft-delete is
// represented by status=INACTIVE with branding.deletedAt set; archive
// is status=SUSPENDED with branding.archivedAt set.
// @tenant-reviewed: phase315-tenant-management-module

type BrandingBlob = {
  logoUrl?: string;
  primaryColor?: string;
  timezone?: string;
  locale?: string;
  contactEmail?: string;
  contactPhone?: string;
  address?: string;
  notes?: string;
  planId?: string;
  featureFlags?: Record<string, boolean>;
  onboardingStatus?: string;
  archivedAt?: string | null;
  deletedAt?: string | null;
};

const BRANDING_KEYS: (keyof BrandingBlob)[] = [
  'logoUrl', 'primaryColor', 'timezone', 'locale',
  'contactEmail', 'contactPhone', 'address', 'notes',
  'planId', 'featureFlags', 'onboardingStatus',
  'archivedAt', 'deletedAt',
];

function pickBrandingFromDto(dto: Partial<CreateTenantDto>): BrandingBlob {
  const out: BrandingBlob = {};
  for (const k of BRANDING_KEYS) {
    const v = (dto as any)[k];
    if (v !== undefined) (out as any)[k] = v;
  }
  return out;
}

@Injectable()
export class TenantsService {
  constructor(private readonly prisma: PrismaService) {}

  // ─── Audit helper ──────────────────────────────────────────────────────────
  private async emitAudit(args: {
    actorId: string;
    action: string;
    reason?: string;
    tenantId: string;
    previous?: Record<string, unknown>;
    next?: Record<string, unknown>;
  }): Promise<void> {
    try {
      await (this.prisma as any).platformAuditLog.create({
        data: {
          actorId: args.actorId,
          action: args.action,
          reason: args.reason ?? 'tenant-mgmt-ui',
          tenantId: args.tenantId,
          target: {
            tenantId: args.tenantId,
            previous: args.previous ?? null,
            next: args.next ?? null,
          } as any,
        },
      });
    } catch { /* platform_audit_logs may not exist in some envs */ }
  }

  // ─── Mapping ───────────────────────────────────────────────────────────────
  private shape(t: any) {
    const b = (t.branding ?? {}) as BrandingBlob;
    return {
      id: t.id,
      name: t.name,
      slug: t.slug,
      customDomain: t.customDomain ?? null,
      status: t.status,
      region: t.region,
      planId: t.planId ?? b.planId ?? null,
      createdAt: t.createdAt,
      updatedAt: t.updatedAt,
      logoUrl: b.logoUrl ?? null,
      primaryColor: b.primaryColor ?? null,
      timezone: b.timezone ?? null,
      locale: b.locale ?? null,
      contactEmail: b.contactEmail ?? null,
      contactPhone: b.contactPhone ?? null,
      address: b.address ?? null,
      notes: b.notes ?? null,
      featureFlags: b.featureFlags ?? {},
      onboardingStatus: b.onboardingStatus ?? null,
      archivedAt: b.archivedAt ?? null,
      deletedAt: b.deletedAt ?? null,
    };
  }

  // ─── Reads ─────────────────────────────────────────────────────────────────
  async list(query: {
    page?: number; limit?: number;
    search?: string; status?: string;
    includeDeleted?: boolean;
  }) {
    const page = Math.max(1, Number(query.page ?? 1));
    const limit = Math.min(200, Math.max(1, Number(query.limit ?? 20)));
    const skip = (page - 1) * limit;

    const where: any = {};
    if (query.search) {
      where.OR = [
        { name: { contains: query.search, mode: 'insensitive' } },
        { slug: { contains: query.search, mode: 'insensitive' } },
        { customDomain: { contains: query.search, mode: 'insensitive' } },
      ];
    }
    if (query.status) where.status = query.status;

    const [rows, total] = await Promise.all([
      (this.prisma as any).tenant.findMany({ where, skip, take: limit, orderBy: { createdAt: 'desc' } }),
      (this.prisma as any).tenant.count({ where }),
    ]);

    const includeDeleted = !!query.includeDeleted;
    const filtered = includeDeleted
      ? rows
      : rows.filter((r: any) => !((r.branding as any)?.deletedAt));

    return {
      data: filtered.map((r: any) => this.shape(r)),
      meta: {
        total,
        page,
        limit,
        totalPages: Math.max(1, Math.ceil(total / limit)),
      },
    };
  }

  async findOne(id: string) {
    const t = await (this.prisma as any).tenant.findUnique({ where: { id } });
    if (!t) throw new NotFoundException({ code: 'TENANT.NOT_FOUND' });
    return this.shape(t);
  }

  async stats(id: string) {
    const t = await (this.prisma as any).tenant.findUnique({ where: { id }, select: { id: true } });
    if (!t) throw new NotFoundException({ code: 'TENANT.NOT_FOUND' });

    // Count operational entities scoped to the tenant. Each query is
    // wrapped in a try/catch because a couple of pilot tables may not
    // exist in every environment.
    const counters: Record<string, number> = {};
    const safeCount = async (key: string, fn: () => Promise<number>) => {
      try { counters[key] = await fn(); } catch { counters[key] = 0; }
    };
    await Promise.all([
      safeCount('agencies', () => (this.prisma as any).agency.count({ where: { tenantId: id } })),
      safeCount('users', () => (this.prisma as any).user.count({
        where: { agency: { tenantId: id }, deletedAt: null },
      })),
      safeCount('employees', () => (this.prisma as any).employee.count({
        where: { tenantId: id },
      })),
      safeCount('applicants', () => (this.prisma as any).applicant.count({
        where: { tenantId: id },
      })),
      safeCount('documents', () => (this.prisma as any).document.count({
        where: { tenantId: id },
      })),
      safeCount('memberships', () => (this.prisma as any).tenantMembership.count({
        where: { tenantId: id, status: 'ACTIVE' },
      })),
    ]);
    return { tenantId: id, ...counters };
  }

  // ─── Mutations ─────────────────────────────────────────────────────────────
  async create(dto: CreateTenantDto, actorId: string) {
    const slug = dto.slug.trim().toLowerCase();
    if (!/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(slug)) {
      throw new BadRequestException({ code: 'TENANT.SLUG_INVALID' });
    }
    const existing = await (this.prisma as any).tenant.findUnique({ where: { slug } });
    if (existing) throw new ConflictException({ code: 'TENANT.SLUG_TAKEN' });

    if (dto.customDomain) {
      const dom = dto.customDomain.trim().toLowerCase();
      const existsDom = await (this.prisma as any).tenant.findUnique({ where: { customDomain: dom } });
      if (existsDom) throw new ConflictException({ code: 'TENANT.DOMAIN_TAKEN' });
    }

    const branding = pickBrandingFromDto(dto);
    const created = await (this.prisma as any).tenant.create({
      data: {
        slug,
        name: dto.name,
        customDomain: dto.customDomain ? dto.customDomain.trim().toLowerCase() : null,
        status: dto.status ?? 'ACTIVE',
        region: dto.region ?? 'eu',
        planId: dto.planId ?? null,
        branding: branding as any,
      },
    });
    await this.emitAudit({
      actorId, action: 'TENANT_CREATED', tenantId: created.id,
      next: { slug: created.slug, name: created.name, status: created.status },
    });
    return this.shape(created);
  }

  async update(
    id: string,
    dto: UpdateTenantDto,
    actorId: string,
    actorLevel: 'SUPPORT' | 'OPERATOR' | 'SUPER',
  ) {
    const t = await (this.prisma as any).tenant.findUnique({ where: { id } });
    if (!t) throw new NotFoundException({ code: 'TENANT.NOT_FOUND' });

    if (actorLevel === 'SUPPORT') {
      throw new ForbiddenException({ code: 'TENANT.READ_ONLY' });
    }

    const prevBranding = (t.branding ?? {}) as BrandingBlob;
    const data: any = {};
    let domainChanged = false;

    if (dto.name !== undefined) data.name = dto.name;
    if (dto.region !== undefined) data.region = dto.region;
    if (dto.planId !== undefined) data.planId = dto.planId || null;

    if (dto.status !== undefined) data.status = dto.status;

    if (dto.slug !== undefined && dto.slug.toLowerCase() !== t.slug) {
      if (actorLevel !== 'SUPER') {
        throw new ForbiddenException({ code: 'TENANT.SLUG_IMMUTABLE_BELOW_SUPER' });
      }
      const slug = dto.slug.trim().toLowerCase();
      if (!/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(slug)) {
        throw new BadRequestException({ code: 'TENANT.SLUG_INVALID' });
      }
      const exists = await (this.prisma as any).tenant.findFirst({
        where: { slug, NOT: { id } }, select: { id: true },
      });
      if (exists) throw new ConflictException({ code: 'TENANT.SLUG_TAKEN' });
      data.slug = slug;
    }

    if (dto.customDomain !== undefined) {
      const dom = dto.customDomain ? dto.customDomain.trim().toLowerCase() : null;
      if (dom !== t.customDomain) {
        if (dom) {
          const exists = await (this.prisma as any).tenant.findFirst({
            where: { customDomain: dom, NOT: { id } }, select: { id: true },
          });
          if (exists) throw new ConflictException({ code: 'TENANT.DOMAIN_TAKEN' });
        }
        data.customDomain = dom;
        domainChanged = true;
      }
    }

    // Merge branding-scoped fields onto the existing blob.
    const newBranding: BrandingBlob = { ...prevBranding };
    let brandingChanged = false;
    for (const k of BRANDING_KEYS) {
      if ((dto as any)[k] !== undefined) {
        (newBranding as any)[k] = (dto as any)[k];
        brandingChanged = true;
      }
    }
    if (brandingChanged) data.branding = newBranding as any;

    const updated = await (this.prisma as any).tenant.update({ where: { id }, data });

    await this.emitAudit({
      actorId, action: 'TENANT_UPDATED', tenantId: id,
      previous: { name: t.name, slug: t.slug, status: t.status, customDomain: t.customDomain },
      next:     { name: updated.name, slug: updated.slug, status: updated.status, customDomain: updated.customDomain },
    });
    if (data.status !== undefined && data.status !== t.status) {
      await this.emitAudit({ actorId, action: 'TENANT_STATUS_CHANGED', tenantId: id, previous: { status: t.status }, next: { status: data.status } });
    }
    if (domainChanged) {
      await this.emitAudit({ actorId, action: 'TENANT_DOMAIN_UPDATED', tenantId: id, previous: { customDomain: t.customDomain }, next: { customDomain: data.customDomain } });
    }

    return this.shape(updated);
  }

  async archive(id: string, actorId: string) {
    const t = await (this.prisma as any).tenant.findUnique({ where: { id } });
    if (!t) throw new NotFoundException({ code: 'TENANT.NOT_FOUND' });
    const branding = { ...(t.branding ?? {}), archivedAt: new Date().toISOString() };
    const updated = await (this.prisma as any).tenant.update({
      where: { id }, data: { status: 'SUSPENDED', branding: branding as any },
    });
    await this.emitAudit({ actorId, action: 'TENANT_ARCHIVED', tenantId: id, previous: { status: t.status }, next: { status: 'SUSPENDED' } });
    return this.shape(updated);
  }

  async activate(id: string, actorId: string) {
    const t = await (this.prisma as any).tenant.findUnique({ where: { id } });
    if (!t) throw new NotFoundException({ code: 'TENANT.NOT_FOUND' });
    const branding = { ...(t.branding ?? {}), archivedAt: null, deletedAt: null };
    const updated = await (this.prisma as any).tenant.update({
      where: { id }, data: { status: 'ACTIVE', branding: branding as any },
    });
    await this.emitAudit({ actorId, action: 'TENANT_STATUS_CHANGED', tenantId: id, previous: { status: t.status }, next: { status: 'ACTIVE' } });
    return this.shape(updated);
  }

  async softDelete(id: string, actorId: string, opts: { force?: boolean }) {
    const t = await (this.prisma as any).tenant.findUnique({ where: { id } });
    if (!t) throw new NotFoundException({ code: 'TENANT.NOT_FOUND' });

    // Block delete if tenant still has active membership unless explicit force.
    if (!opts.force) {
      const activeMembers = await (this.prisma as any).tenantMembership.count({
        where: { tenantId: id, status: 'ACTIVE' },
      }).catch(() => 0);
      if (activeMembers > 0) {
        throw new ConflictException({ code: 'TENANT.HAS_ACTIVE_MEMBERS', count: activeMembers });
      }
    }

    const branding = { ...(t.branding ?? {}), deletedAt: new Date().toISOString() };
    const updated = await (this.prisma as any).tenant.update({
      where: { id }, data: { status: 'INACTIVE', branding: branding as any },
    });
    await this.emitAudit({ actorId, action: 'TENANT_DELETED', tenantId: id, previous: { status: t.status }, next: { status: 'INACTIVE', deletedAt: branding.deletedAt } });
    return this.shape(updated);
  }

  async restore(id: string, actorId: string) {
    const t = await (this.prisma as any).tenant.findUnique({ where: { id } });
    if (!t) throw new NotFoundException({ code: 'TENANT.NOT_FOUND' });
    const branding = { ...(t.branding ?? {}), deletedAt: null, archivedAt: null };
    const updated = await (this.prisma as any).tenant.update({
      where: { id }, data: { status: 'ACTIVE', branding: branding as any },
    });
    await this.emitAudit({ actorId, action: 'TENANT_RESTORED', tenantId: id, previous: { status: t.status }, next: { status: 'ACTIVE' } });
    return this.shape(updated);
  }

  // ─── Phase 3.17 — TenantMembership management ─────────────────────────────
  // One User can belong to many Tenants. The membership row is what
  // gates /auth/login-v2 + /auth/switch-tenant.
  // @tenant-reviewed: phase317-multi-tenant-login

  async listMemberships(tenantId: string) {
    const t = await (this.prisma as any).tenant.findUnique({ where: { id: tenantId }, select: { id: true } });
    if (!t) throw new NotFoundException({ code: 'TENANT.NOT_FOUND' });
    const rows = await (this.prisma as any).tenantMembership.findMany({
      where: { tenantId },
      select: {
        id: true, status: true, joinedAt: true, invitedAt: true,
        userId: true,
      },
      orderBy: { joinedAt: 'desc' },
    });
    const userIds = rows.map((r: any) => r.userId);
    const [users, platformAdmins] = await Promise.all([
      userIds.length
        ? (this.prisma as any).user.findMany({
            where: { id: { in: userIds } },
            select: { id: true, email: true, firstName: true, lastName: true, status: true },
          })
        : [],
      userIds.length
        ? (this.prisma as any).platformAdmin.findMany({
            where: { userId: { in: userIds } },
            select: { userId: true, level: true },
          }).catch(() => [])
        : [],
    ]);
    const userById = new Map<string, any>(users.map((u: any) => [u.id, u]));
    const paById   = new Map<string, string>(platformAdmins.map((p: any) => [p.userId, p.level]));
    return rows.map((r: any) => ({
      ...r,
      user: userById.get(r.userId) ?? null,
      // Phase 3.17 — surface the row's PlatformAdmin level so the UI
      // can hide the revoke action for SUPER users (only another SUPER
      // can remove them; the backend re-checks this on revoke).
      platformAdminLevel: paById.get(r.userId) ?? null,
    }));
  }

  async grantMembership(tenantId: string, userId: string, actorId: string) {
    const t = await (this.prisma as any).tenant.findUnique({ where: { id: tenantId }, select: { id: true } });
    if (!t) throw new NotFoundException({ code: 'TENANT.NOT_FOUND' });
    const u = await (this.prisma as any).user.findUnique({ where: { id: userId }, select: { id: true, email: true } });
    if (!u) throw new NotFoundException({ code: 'USER.NOT_FOUND' });

    const existing = await (this.prisma as any).tenantMembership.findUnique({
      where: { userId_tenantId: { userId, tenantId } },
      select: { id: true, status: true },
    }).catch(() => null);

    let row: any;
    let action = 'TENANT_MEMBERSHIP_GRANT_IDEMPOTENT';
    if (existing && existing.status === 'ACTIVE') {
      row = existing;
    } else if (existing) {
      row = await (this.prisma as any).tenantMembership.update({
        where: { id: existing.id },
        data: { status: 'ACTIVE', joinedAt: new Date() },
      });
      action = 'TENANT_MEMBERSHIP_REACTIVATED';
    } else {
      row = await (this.prisma as any).tenantMembership.create({
        data: { userId, tenantId, status: 'ACTIVE', invitedBy: actorId, joinedAt: new Date() },
      });
      action = 'TENANT_MEMBERSHIP_GRANTED';
    }

    await this.emitAudit({
      actorId, action, tenantId,
      next: { userId, email: u.email, membershipId: row.id, status: 'ACTIVE' },
    });
    return row;
  }

  async revokeMembership(tenantId: string, userId: string, actorId: string) {
    const existing = await (this.prisma as any).tenantMembership.findUnique({
      where: { userId_tenantId: { userId, tenantId } },
      select: { id: true, status: true },
    }).catch(() => null);
    if (!existing) throw new NotFoundException({ code: 'TENANT.MEMBERSHIP_NOT_FOUND' });

    // Refuse to remove the last platform-admin tether to a tenant — if
    // the membership being revoked is the actor's own and they hold
    // SUPER, they'd lock themselves out. Cheap guard:
    if (userId === actorId) {
      throw new ForbiddenException({ code: 'TENANT.SELF_REVOKE_FORBIDDEN' });
    }

    // Phase 3.17 — protect SUPER PlatformAdmins. Only another SUPER can
    // revoke a SUPER user's tenant membership; a tenant System Admin
    // (or even an OPERATOR/SUPPORT PlatformAdmin) cannot.
    // @tenant-reviewed: phase317-multi-tenant-login
    const [targetPa, actorPa] = await Promise.all([
      (this.prisma as any).platformAdmin.findUnique({
        where: { userId }, select: { level: true },
      }).catch(() => null),
      (this.prisma as any).platformAdmin.findUnique({
        where: { userId: actorId }, select: { level: true },
      }).catch(() => null),
    ]);
    if (targetPa?.level === 'SUPER' && actorPa?.level !== 'SUPER') {
      throw new ForbiddenException({ code: 'TENANT.SUPER_REVOKE_REQUIRES_SUPER' });
    }

    const updated = await (this.prisma as any).tenantMembership.update({
      where: { id: existing.id },
      data: { status: 'REMOVED' },
    });
    await this.emitAudit({
      actorId, action: 'TENANT_MEMBERSHIP_REVOKED', tenantId,
      previous: { status: existing.status }, next: { userId, status: 'REMOVED' },
    });
    return updated;
  }
}
