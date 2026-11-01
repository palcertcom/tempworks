import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { PilotPrismaAccessor } from '../saas/prisma/pilot-prisma.accessor';
import { getPilotScope, PilotScope } from '../saas/prisma/tenant-pilot-scope';
import { buildSuperUserTenantWhereDirect, assertRequestedTenantExists } from '../saas/prisma/super-user-tenant-filter';
import { CreateJobAdDto } from './dto/create-job-ad.dto';
import { UpdateJobAdDto } from './dto/update-job-ad.dto';
import { FilterJobAdsDto } from './dto/filter-job-ads.dto';
import { PaginatedResponse } from '../common/dto/pagination-response.dto';
import { JOB_AD_STATUSES, CONTRACT_TYPES, JOB_CATEGORIES, COMMON_CURRENCIES } from './constants';

/**
 * Phase 2.9 — third tenant-scoped TenantPrisma pilot.
 *
 * Reads/writes route through `PilotPrismaAccessor.client()` and apply
 * a tenant filter when `getPilotScope(this.pilot, 'job-ads')` reports
 * `active=true` (pilot flag on, env staging-classified, ALS has a
 * tenant, allow-list includes `job-ads`). Otherwise — including every
 * production request — the spreads are no-ops and behaviour is
 * byte-identical to before this PR.
 *
 * Public endpoints (`findPublished`, `findBySlug`) typically run
 * without a tenant in ALS. The pilot scope is naturally inactive
 * there, so public URLs continue to surface every PUBLISHED ad
 * regardless of tenant — preserving public-link semantics. A future
 * Phase 3 may add a tenant-from-host resolver that attaches a tenant
 * to public traffic; the service contract does NOT change today.
 *
 * Slug uniqueness: the schema's global `slug @unique` constraint is
 * preserved (Phase 2.9 only added a nullable `tenantId` and two
 * tenant-leading indexes). The service's `uniqueSlug` lookup stays
 * global so the suffix-loop never hands out a slug that would later
 * collide on insert. Phase 3 will swap to a composite `(tenantId, slug)`
 * unique once every existing public URL is reconciled.
 */
@Injectable()
export class JobAdsService {
  constructor(
    private legacyPrisma: PrismaService,
    private pilot: PilotPrismaAccessor,
  ) {}

  private get prisma(): PrismaService {
    return this.pilot.client();
  }

  private scope(): PilotScope {
    return getPilotScope(this.pilot, 'job-ads');
  }

  // ── Slug generation ──────────────────────────────────────────────────────────

  private toSlug(title: string): string {
    return title
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, '')
      .trim()
      .replace(/\s+/g, '-')
      .replace(/-+/g, '-')
      .slice(0, 100);
  }

  /**
   * Phase 3.18 — dashboard scoping helper. PlatformAdmin SUPER and
   * platform admins generally bypass the tenant filter (they manage
   * every tenant); all other callers see only their own tenant. The
   * tenantId comes from the JWT (Phase 3.17) and falls back to the
   * caller's agency.tenantId for legacy tokens (set on req.user in
   * jwt.strategy.ts).
   *
   * Returns either `{}` (no filter, super admin) or `{ tenantId: <id> }`.
   * @tenant-reviewed: phase318-tenant-public-jobs
   */
  private callerTenantWhere(caller: any): Record<string, any> {
    if (!caller) return {};
    if (caller.agencyIsSystem) return {}; // PlatformAdmin sees everything
    // Phase 3.22 — pilot-off rows have tenantId=null; applying the
    // strict filter would exclude them and make the listing report
    // zero. Rely on scope().tenantWhere() (which is a no-op when
    // inactive) for the legacy single-tenant deployment path.
    if (!this.scope().active) return {};
    const t = caller.tenantId;
    if (!t) return {}; // no scope info → behave like legacy until login-v2
    return { tenantId: t };
  }

  /**
   * Phase 3.18 — check whether the caller is a SUPER PlatformAdmin.
   * Used to gate the tenantId reassignment on create + update. Falls
   * back to the JWT-side hint (caller.agencyIsSystem) when the
   * platform_admins lookup fails so legacy admins are not locked out.
   * @tenant-reviewed: phase318-tenant-public-jobs
   */
  private async isCallerSuperPlatformAdmin(caller: any): Promise<boolean> {
    if (!caller?.id) return false;
    try {
      const row = await (this.prisma as any).platformAdmin.findUnique({
        where: { userId: caller.id }, select: { level: true },
      });
      if (row?.level === 'SUPER') return true;
    } catch { /* table missing on fresh envs */ }
    return false;
  }

  /** Slug uniqueness probe — INTENTIONALLY tenant-agnostic. The DB's
   *  `slug @unique` constraint is global until Phase 3 swaps it to a
   *  composite `(tenantId, slug)`. Tenant-filtering this lookup would
   *  mean the suffix-loop hands out a slug that the unique index then
   *  rejects on insert. Keeping it global keeps inserts predictable. */
  private async uniqueSlug(base: string, excludeId?: string): Promise<string> {
    let slug = base;
    let attempt = 0;
    while (true) {
      const existing = await this.legacyPrisma.jobAd.findFirst({ // @tenant-reviewed: phase29-pilot-scope (slug uniqueness is GLOBAL until Phase 3 composite)
        where: {
          slug,
          deletedAt: null,
          ...(excludeId ? { id: { not: excludeId } } : {}),
        },
      });
      if (!existing) return slug;
      attempt++;
      slug = `${base}-${attempt}`;
    }
  }

  // ── Dashboard: list (paginated + filtered) ───────────────────────────────────

  async findAll(filter: FilterJobAdsDto, caller?: any) {
    const scope = this.scope();
    const {
      page = 1, limit = 20, search, status, category, country, contractType,
      sortBy = 'createdAt', sortOrder = 'desc',
    } = filter as any;
    const skip = (Number(page) - 1) * Number(limit);

    // Phase F2 (SPIKE-010 Batch 2) — SUPER USER tenant override.
    await assertRequestedTenantExists(caller, (filter as any).tenantId, this.legacyPrisma.tenant);
    const superTenantPredicate = buildSuperUserTenantWhereDirect(caller, (filter as any).tenantId);

    const where: any = { deletedAt: null, ...scope.tenantWhere(), ...this.callerTenantWhere(caller) };
    // Strict tenant filter: picking a specific tenant returns only that
    // tenant's ads. Legacy null-tenant rows surface only under SUPER's
    // 'All Tenants' selection (where superTenantPredicate is null and the
    // outer filters don't constrain tenantId). Earlier OR-with-null
    // passthrough made every per-tenant view return the same legacy
    // rows, defeating the toolbar.
    if (superTenantPredicate) {
      where.AND = [...(where.AND ?? []), superTenantPredicate];
    }
    if (status)       where.status       = status;
    if (category)     where.category     = category;
    if (country)      where.country      = country;
    if (contractType) where.contractType = contractType;
    if (search) {
      where.OR = [
        { title:       { contains: search, mode: 'insensitive' } },
        { category:    { contains: search, mode: 'insensitive' } },
        { city:        { contains: search, mode: 'insensitive' } },
        { country:     { contains: search, mode: 'insensitive' } },
        { description: { contains: search, mode: 'insensitive' } },
      ];
    }

    const validSort = ['createdAt', 'publishedAt', 'title', 'status', 'country', 'category'];
    const orderField = validSort.includes(sortBy) ? sortBy : 'createdAt';

    const [items, total] = await Promise.all([
      this.prisma.jobAd.findMany({ // @tenant-reviewed: phase29-pilot-scope
        where, skip, take: Number(limit),
        orderBy: { [orderField]: sortOrder },
        include: {
          createdBy: { select: { id: true, firstName: true, lastName: true } },
          _count: { select: { applicants: true } },
        },
      }),
      this.prisma.jobAd.count({ where }), // @tenant-reviewed: phase29-pilot-scope
    ]);

    // Phase 3.18 — when the caller is a PlatformAdmin (sees every
    // tenant's ads), attach a `tenant: { id, name, slug }` object to
    // each row so the dashboard list can render a tenant column.
    // Other callers are already scoped to a single tenant; surfacing
    // the same name is harmless but unnecessary.
    // @tenant-reviewed: phase318-tenant-public-jobs
    let enriched = items as any[];
    if (caller?.agencyIsSystem) {
      const ids = Array.from(new Set(items.map((r: any) => r.tenantId).filter(Boolean)));
      if (ids.length) {
        const tenants = await this.prisma.tenant.findMany({
          where: { id: { in: ids as string[] } },
          select: { id: true, name: true, slug: true },
        }).catch(() => []);
        const byId = new Map<string, any>(tenants.map((t: any): [string, any] => [t.id, t]));
        enriched = items.map((r: any) => ({
          ...r,
          tenant: r.tenantId ? byId.get(r.tenantId) ?? null : null,
        }));
      }
    }

    return PaginatedResponse.create(enriched, total, Number(page), Number(limit));
  }

  // ── Public listing (only PUBLISHED, no auth required) ────────────────────────
  //
  // This endpoint is reached without auth and (typically) without a
  // tenant in ALS, so `scope.tenantWhere()` returns `{}` and the
  // listing behaves byte-identically to legacy: every PUBLISHED ad
  // across all tenants is visible. If a future Phase 3 host-based
  // resolver attaches a tenant to public traffic, the same code path
  // will automatically narrow the listing to that tenant — no code
  // change required.
  async findPublished(filter: FilterJobAdsDto, tenantHint?: string) {
    const scope = this.scope();
    const {
      page = 1, limit = 20, search, category, country, contractType,
      sortBy = 'publishedAt', sortOrder = 'desc',
    } = filter as any;
    const skip = (Number(page) - 1) * Number(limit);

    // Phase 3.18 — public tenant scoping.
    //  - WITH hint:      resolve slug/customDomain → only that tenant's ads.
    //  - WITHOUT hint:   the legacy global /jobs URL aggregates ads from
    //                    every tenant (and any tenant-less / global ads).
    //                    Each row carries `tenant: { id, name, slug }` so
    //                    the public listing card can label the owner.
    // @tenant-reviewed: phase318-tenant-public-jobs
    let publicTenantWhere: any;
    if (tenantHint) {
      const hint = tenantHint.trim().toLowerCase();
      const tenant = await this.prisma.tenant.findFirst({
        where: { OR: [{ slug: hint }, { customDomain: hint }] },
        select: { id: true },
      }).catch(() => null);
      publicTenantWhere = tenant
        ? { tenantId: tenant.id }
        : { tenantId: '__no_such_tenant__' }; // unresolved → empty result
    } else {
      publicTenantWhere = {}; // global aggregator
    }

    const where: any = { deletedAt: null, status: 'PUBLISHED', ...scope.tenantWhere(), ...publicTenantWhere };
    if (category)     where.category     = category;
    if (country)      where.country      = country;
    if (contractType) where.contractType = contractType;
    if (search) {
      where.OR = [
        { title:       { contains: search, mode: 'insensitive' } },
        { category:    { contains: search, mode: 'insensitive' } },
        { city:        { contains: search, mode: 'insensitive' } },
        { country:     { contains: search, mode: 'insensitive' } },
        { description: { contains: search, mode: 'insensitive' } },
      ];
    }

    const validSort = ['publishedAt', 'title', 'country', 'category'];
    const orderField = validSort.includes(sortBy) ? sortBy : 'publishedAt';

    const [items, total] = await Promise.all([
      this.prisma.jobAd.findMany({ // @tenant-reviewed: phase29-pilot-scope
        where, skip, take: Number(limit),
        orderBy: { [orderField]: sortOrder },
        select: {
          id: true, title: true, slug: true, category: true,
          city: true, country: true, contractType: true,
          salaryMin: true, salaryMax: true, currency: true,
          publishedAt: true,
          requiredDocuments: true,
          tenantId: true,
        },
      }),
      this.prisma.jobAd.count({ where }), // @tenant-reviewed: phase29-pilot-scope
    ]);

    // Phase 3.18 — batch-load the owning tenants so each listing card
    // can display "from <Tenant>" on the global aggregator at /jobs.
    // @tenant-reviewed: phase318-tenant-public-jobs
    const tenantIds = Array.from(new Set(items.map((r: any) => r.tenantId).filter(Boolean)));
    const tenants = tenantIds.length
      ? await this.prisma.tenant.findMany({
          where: { id: { in: tenantIds as string[] } },
          select: { id: true, name: true, slug: true },
        }).catch(() => [])
      : [];
    const tenantById = new Map<string, any>(tenants.map((t: any): [string, any] => [t.id, t]));

    const mapped = items.map((ad: any) => ({
      ...ad,
      requiredDocuments: this.parseRequiredDocuments(ad.requiredDocuments),
      tenant: ad.tenantId ? tenantById.get(ad.tenantId) ?? null : null,
    }));
    return PaginatedResponse.create(mapped, total, Number(page), Number(limit));
  }

  // ── Helper: parse requiredDocuments JSON string to string[] ──────────────────

  private parseRequiredDocuments(raw: string | null | undefined): string[] {
    if (!raw) return [];
    try { return JSON.parse(raw) as string[]; } catch { return []; }
  }

  // ── Public detail by slug ─────────────────────────────────────────────────────
  //
  // Same public-traffic semantics as `findPublished`. With no tenant in
  // ALS, the slug lookup is global — preserving today's public URLs.
  async findBySlug(slug: string, tenantHint?: string) {
    const scope = this.scope();
    // Phase 3.18 — slug lookup: scope to the named tenant when a hint
    // is provided; otherwise allow the slug to resolve against any
    // tenant (the global /jobs/:slug page should still work for ads
    // owned by a tenant, since the public list links to them).
    // @tenant-reviewed: phase318-tenant-public-jobs
    let publicTenantWhere: any;
    if (tenantHint) {
      const hint = tenantHint.trim().toLowerCase();
      const tenant = await this.prisma.tenant.findFirst({
        where: { OR: [{ slug: hint }, { customDomain: hint }] },
        select: { id: true },
      }).catch(() => null);
      publicTenantWhere = tenant
        ? { tenantId: tenant.id }
        : { tenantId: '__no_such_tenant__' };
    } else {
      publicTenantWhere = {};
    }
    const ad = await this.prisma.jobAd.findFirst({ // @tenant-reviewed: phase29-pilot-scope
      where: { slug, deletedAt: null, status: 'PUBLISHED', ...scope.tenantWhere(), ...publicTenantWhere },
    });
    if (!ad) throw new NotFoundException(`Job ad '${slug}' not found`);
    // Phase 3.18 — attach the owning tenant so the public detail page
    // can show which tenant the ad belongs to.
    let owningTenant: any = null;
    if ((ad as any).tenantId) {
      owningTenant = await this.prisma.tenant.findUnique({
        where: { id: (ad as any).tenantId },
        select: { id: true, name: true, slug: true },
      }).catch(() => null);
    }
    return { ...ad, tenant: owningTenant, requiredDocuments: this.parseRequiredDocuments(ad.requiredDocuments) };
  }

  // ── Dashboard detail by ID ────────────────────────────────────────────────────

  async findOne(id: string, caller?: any) {
    const scope = this.scope();
    const ad = await this.prisma.jobAd.findFirst({ // @tenant-reviewed: phase29-pilot-scope
      where: { id, deletedAt: null, ...scope.tenantWhere(), ...this.callerTenantWhere(caller) },
      include: {
        createdBy: { select: { id: true, firstName: true, lastName: true } },
        _count: { select: { applicants: true } },
      },
    });
    if (!ad) throw new NotFoundException(`Job ad ${id} not found`);
    // Phase 3.18 — attach the owning tenant for PlatformAdmin viewers so
    // the detail page can show which tenant a Job Ad belongs to.
    let tenant: any = null;
    if (caller?.agencyIsSystem && (ad as any).tenantId) {
      tenant = await this.prisma.tenant.findUnique({
        where: { id: (ad as any).tenantId },
        select: { id: true, name: true, slug: true },
      }).catch(() => null);
    }
    return { ...ad, tenant, requiredDocuments: this.parseRequiredDocuments(ad.requiredDocuments) };
  }

  // ── Create ────────────────────────────────────────────────────────────────────

  async create(dto: CreateJobAdDto, userId?: string, caller?: any) {
    const scope = this.scope();
    const baseSlug = dto.slug ? dto.slug.toLowerCase().replace(/\s+/g, '-') : this.toSlug(dto.title);
    const slug = await this.uniqueSlug(baseSlug);

    const publishedAt = dto.status === 'PUBLISHED' ? new Date() : null;

    // Stamp the new ad's owning tenant so findAll's tenant filter finds
    // it AND any applicant who applies inherits a real tenant. A SUPER
    // PlatformAdmin may explicitly target a different tenant via
    // dto.tenantId; otherwise EVERY caller (including platform admins)
    // falls back to their active tenant. Previously platform admins were
    // excluded from the implicit value, so SUPER-created ads landed with
    // a NULL tenant — orphaning every applicant who applied through them.
    // @tenant-reviewed: phase318-tenant-public-jobs
    const isSuper = await this.isCallerSuperPlatformAdmin(caller);
    const explicitTenantId =
      isSuper && typeof (dto as any).tenantId === 'string' && (dto as any).tenantId.trim()
        ? (dto as any).tenantId.trim()
        : undefined;
    const callerTenantId = explicitTenantId ?? caller?.tenantId ?? undefined;

    return this.prisma.jobAd.create({ // @tenant-reviewed: phase29-pilot-scope
      data: {
        title:             dto.title,
        slug,
        category:          dto.category,
        description:       dto.description,
        city:              dto.city,
        country:           dto.country,
        contractType:      dto.contractType ?? 'Full-time',
        salaryMin:         dto.salaryMin  ?? null,
        salaryMax:         dto.salaryMax  ?? null,
        currency:          dto.currency   ?? 'GBP',
        status:            dto.status ?? 'DRAFT',
        publishedAt,
        createdById:       userId ?? null,
        requiredDocuments: dto.requiredDocuments ? JSON.stringify(dto.requiredDocuments) : null,
        ...scope.tenantData(),
        ...(callerTenantId ? { tenantId: callerTenantId } : {}),
      },
    });
  }

  // ── Update ────────────────────────────────────────────────────────────────────

  async update(id: string, dto: UpdateJobAdDto, userId?: string, caller?: any) {
    // findOne is tenant-scoped, so cross-tenant id presents as 404
    // before any update SQL runs.
    const existing = await this.findOne(id, caller);

    // Regenerate slug if title changed and no explicit slug provided
    let slug = existing.slug;
    if (dto.slug) {
      slug = await this.uniqueSlug(dto.slug.toLowerCase().replace(/\s+/g, '-'), id);
    } else if (dto.title && dto.title !== existing.title && !dto.slug) {
      slug = await this.uniqueSlug(this.toSlug(dto.title), id);
    }

    // Auto-set publishedAt when transitioning to PUBLISHED
    let publishedAt = existing.publishedAt;
    if (dto.status === 'PUBLISHED' && existing.status !== 'PUBLISHED') {
      publishedAt = new Date();
    }

    // Phase 3.18 — SUPER PlatformAdmin may reassign tenantId. Validate
    // the target tenant exists before writing; reject non-SUPER attempts
    // silently by dropping the field from the payload.
    // @tenant-reviewed: phase318-tenant-public-jobs
    let nextTenantId: string | undefined;
    if ((dto as any).tenantId !== undefined) {
      const isSuper = await this.isCallerSuperPlatformAdmin(caller);
      if (isSuper) {
        const incoming = String((dto as any).tenantId ?? '').trim();
        if (incoming) {
          const t = await this.prisma.tenant.findUnique({
            where: { id: incoming }, select: { id: true },
          }).catch(() => null);
          if (!t) throw new NotFoundException(`Tenant ${incoming} not found`);
          nextTenantId = incoming;
        }
      }
    }

    return this.prisma.jobAd.update({ // @tenant-reviewed: phase29-pilot-scope
      where: { id },
      data: {
        ...(dto.title        !== undefined ? { title:        dto.title }        : {}),
        ...(dto.category     !== undefined ? { category:     dto.category }     : {}),
        ...(dto.description  !== undefined ? { description:  dto.description }  : {}),
        ...(dto.city         !== undefined ? { city:         dto.city }         : {}),
        ...(dto.country      !== undefined ? { country:      dto.country }      : {}),
        ...(dto.contractType !== undefined ? { contractType: dto.contractType } : {}),
        ...(dto.salaryMin    !== undefined ? { salaryMin:    dto.salaryMin }    : {}),
        ...(dto.salaryMax    !== undefined ? { salaryMax:    dto.salaryMax }    : {}),
        ...(dto.currency          !== undefined ? { currency:          dto.currency }                                           : {}),
        ...(dto.status            !== undefined ? { status:            dto.status }                                             : {}),
        ...(dto.requiredDocuments !== undefined ? { requiredDocuments: dto.requiredDocuments ? JSON.stringify(dto.requiredDocuments) : null } : {}),
        ...(nextTenantId          !== undefined ? { tenantId:          nextTenantId } : {}),
        slug,
        publishedAt,
      },
    });
  }

  // ── Soft-delete ───────────────────────────────────────────────────────────────

  async remove(id: string, caller?: any) {
    // findOne is tenant-scoped, so cross-tenant id presents as 404.
    await this.findOne(id, caller);
    return this.prisma.jobAd.update({ // @tenant-reviewed: phase29-pilot-scope
      where: { id },
      data: { deletedAt: new Date(), deletedBy: caller?.id ?? null },
    });
  }

  // ── Constants ─────────────────────────────────────────────────────────────────

  getConstants() {
    return { statuses: JOB_AD_STATUSES, contractTypes: CONTRACT_TYPES, categories: JOB_CATEGORIES, currencies: COMMON_CURRENCIES };
  }
}
