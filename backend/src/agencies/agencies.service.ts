import { Injectable, NotFoundException, ConflictException, BadRequestException, ForbiddenException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { StorageService } from '../common/storage/storage.service';
import { PilotPrismaAccessor } from '../saas/prisma/pilot-prisma.accessor';
import { getPilotScope, PilotScope } from '../saas/prisma/tenant-pilot-scope';
import { TenantAuditLogService } from '../saas/audit/tenant-audit-log.service';
import { applySuperTenantReassignment } from '../saas/platform-admin/super-tenant-edit';
import { buildSuperUserTenantWhereDirect, assertRequestedTenantExists, isPlatformAuthority } from '../saas/prisma/super-user-tenant-filter';
import { CreateAgencyDto } from './dto/create-agency.dto';
import { UpdateAgencyDto } from './dto/update-agency.dto';
import { PaginationDto } from '../common/dto/pagination.dto';
import { PaginatedResponse } from '../common/dto/pagination-response.dto';

/**
 * Phase 2.35 — Agencies reads-first TenantPrisma pilot.
 *
 * READ paths route through `pilot.client()` and spread
 * `tenantWherePlusSystem()` (active tenant OR `isSystem=true`) when
 * the pilot scope is active. Production default (flag off) is
 * byte-identical to pre-2.35.
 *
 * `listPublic()` stays globally visible — it is the public agency
 * dropdown for the apply form.
 *
 * WRITE / mutation / storage paths (`create`, `update`, `remove`,
 * `uploadLogo`, `setPermissionOverride`, `removePermissionOverride`,
 * `setManager`) write through `legacyPrisma` but are gated by
 * Phase 2.35 tenant-scoped `findOne` and Phase 2.36 helpers.
 * `Agency.create` writes `tenantId` via `scope.tenantData()` when an
 * ALS frame is present. Audit emissions are routed through the
 * shared `TenantAuditLogService` (Phase 2.30).
 *
 * See `SAAS_PHASE2_AGENCIES_SYSTEM_AGENCY_DECISION.md` for the
 * `OR isSystem: true` rationale.
 */
@Injectable()
export class AgenciesService {
  constructor(
    private legacyPrisma: PrismaService,
    private storage: StorageService,
    private pilot: PilotPrismaAccessor,
    private tenantAuditLog: TenantAuditLogService,
  ) {}

  /** Pilot-aware Prisma surface used by READ paths only. Mutation
   *  paths use `legacyPrisma` directly. */
  private get prisma(): PrismaService {
    return this.pilot.client();
  }

  private scope(): PilotScope {
    return getPilotScope(this.pilot, 'agencies');
  }

  /**
   * Phase 2.35 — tenant-scope predicate that ALSO admits system
   * agencies. In legacy mode returns `{}` (byte-identical). In pilot
   * mode returns `{ OR: [{ tenantId: <active> }, { isSystem: true }] }`
   * which composes additively into the caller's `where` clause.
   */
  private tenantWhereOrSystem(): Record<string, unknown> {
    const s = this.scope();
    if (!s.active) return {};
    // Phase 3.9 — `Agency.isSystem` column dropped. The legacy
    // `OR isSystem: true` branch is removed; tenant scoping is now
    // the sole filter. Platform admins continue to bypass scoping
    // because the request user's `agencyIsSystem` flag is checked
    // by `isExternalActor`, which is sourced from PlatformAdmin.
    // @tenant-reviewed: phase390-agency-is-system-removed
    return { AND: [{ tenantId: s.tenantId }] };
  }

  private get include() {
    return { _count: { select: { users: true, employees: true } } };
  }

  async listPublic(): Promise<{ id: string; name: string }[]> {
    // @tenant-reviewed: phase235-global (public apply-form dropdown — every tenant must be enumerable)
    return this.legacyPrisma.agency.findMany({
      where: { deletedAt: null },
      select: { id: true, name: true },
      orderBy: { name: 'asc' },
    });
  }

  /**
   * External tenant = user attached to any agency that is not the
   * Tempworks root (`isSystem=true`). All such users are scoped to
   * their own agency regardless of role name, so HR Managers and
   * Agency Managers in external agencies are treated identically.
   */
  private isExternalActor(actor?: { agencyId?: string; agencyIsSystem?: boolean }) {
    return !!actor && !!actor.agencyId && actor.agencyIsSystem !== true;
  }

  /**
   * Roles that are bound to a single recruitment agency and must only
   * ever see that one agency in the listing. Tenant-level roles (HR
   * Manager, Recruiter, Compliance Officer, Finance, Read Only) are
   * NOT bound — they see every agency in their own tenant so they can
   * reassign an employee's recruitment agency within the tenant.
   */
  private isAgencyBoundRole(actor?: { role?: string }) {
    const role = (actor?.role ?? '').toString().trim().toLowerCase();
    return role === 'agency manager' || role === 'agency user';
  }

  /** Throws when an external tenant tries to reach an agency other than their own. */
  private assertAgencyAccess(agencyId: string, actor?: { role?: string; agencyId?: string; agencyIsSystem?: boolean }) {
    if (this.isExternalActor(actor) && actor?.agencyId !== agencyId) {
      throw new ForbiddenException('You can only view your own agency');
    }
  }

  async findAll(pagination: PaginationDto, actor?: { role?: string; agencyId?: string; agencyIsSystem?: boolean; tenantId?: string | null }, tenantIdQuery?: string) {
    const { page = 1, limit = 10, search, sortBy = 'createdAt', sortOrder = 'desc' } = pagination;
    const skip = (Number(page) - 1) * Number(limit);
    // Phase F2 (SPIKE-010): SUPER USER may override the session tenant
    // by passing ?tenantId=. The helper validates SUPER and rejects
    // spoofs from every other caller before any prisma call.
    await assertRequestedTenantExists(actor, tenantIdQuery, this.legacyPrisma.tenant);
    // Agency is the model itself — no self-relation; use direct variant.
    const superTenantPredicate = buildSuperUserTenantWhereDirect(actor, tenantIdQuery);
    const where: any = { deletedAt: null, ...this.tenantWhereOrSystem() }; // @tenant-reviewed: phase235-pilot-scope
    if (superTenantPredicate) where.AND = [...(where.AND ?? []), superTenantPredicate];

    // Visibility tiers (backend-enforced regardless of the pilot flag):
    //   • Platform authority (SUPER / System Admin) — no extra scoping;
    //     they use the ?tenantId override above to pick a tenant.
    //   • Genuinely agency-bound roles (Agency Manager / Agency User)
    //     only ever see their own agency — that lock is unchanged.
    //   • Every other tenant-level role (HR Manager, Recruiter, …) sees
    //     EVERY agency in their own tenant, so they can pick a
    //     recruitment agency for an employee. Strictly same-tenant — no
    //     cross-tenant rows ever leak.
    if (!isPlatformAuthority(actor)) {
      if (this.isAgencyBoundRole(actor)) {
        if (!actor?.agencyId) return PaginatedResponse.create([], 0, page, limit);
        where.id = actor.agencyId;
      } else if (actor?.tenantId) {
        where.AND = [...(where.AND ?? []), { tenantId: actor.tenantId }];
      } else if (actor?.agencyId) {
        // No tenant on the token — fall back to own-agency-only so we
        // never widen visibility past what we can prove is in-tenant.
        where.id = actor.agencyId;
      }
    }
    if (search) {
      where.OR = [
        { name: { contains: search, mode: 'insensitive' } },
        { country: { contains: search, mode: 'insensitive' } },
        { contactPerson: { contains: search, mode: 'insensitive' } },
      ];
    }
    const validSort = ['name', 'country', 'status', 'createdAt'];
    const [items, total] = await Promise.all([
      this.prisma.agency.findMany({ where, skip, take: Number(limit), orderBy: { [validSort.includes(sortBy) ? sortBy : 'name']: sortOrder }, include: this.include }), // @tenant-reviewed: phase235-pilot-scope
      this.prisma.agency.count({ where }), // @tenant-reviewed: phase235-pilot-scope
    ]);
    return PaginatedResponse.create(items, total, page, limit);
  }

  async findOne(id: string, actor?: { role?: string; agencyId?: string; agencyIsSystem?: boolean }) {
    this.assertAgencyAccess(id, actor);
    const agency = await this.prisma.agency.findFirst({ // @tenant-reviewed: phase235-pilot-scope (was findUnique; migrated to findFirst to compose tenant predicate)
      where: { id, deletedAt: null, ...this.tenantWhereOrSystem() },
      include: {
        ...this.include,
        manager: { select: { id: true, firstName: true, lastName: true, email: true } },
      },
    });
    if (!agency) throw new NotFoundException(`Agency ${id} not found`);
    return agency;
  }

  /** Derive the legacy `contactPerson` column from the structured name pieces
   *  when the client sends first/middle/last but omits the combined value.
   *  Keeps backwards compatibility for listing/search code that still reads
   *  the single column. */
  private deriveContactPerson(dto: Partial<CreateAgencyDto>): string | undefined {
    if (dto.contactPerson && dto.contactPerson.trim()) return dto.contactPerson.trim();
    const pieces = [dto.contactFirstName, dto.contactMiddleName, dto.contactLastName]
      .map(p => (p ?? '').trim())
      .filter(Boolean);
    return pieces.length ? pieces.join(' ') : undefined;
  }

  async create(dto: CreateAgencyDto, createdById?: string, actorRole?: string, callerTenantId?: string | null) {
    const contactPerson = this.deriveContactPerson(dto);
    if (!contactPerson) throw new BadRequestException('Contact person name is required');
    // Phase 3.9 — `Agency.isSystem` column dropped. Any legacy payload
    // still carrying the field is silently ignored. Platform authority
    // is granted exclusively through PlatformAdmin rows.
    // @tenant-reviewed: phase390-agency-is-system-removed
    if ('isSystem' in (dto as any)) delete (dto as any).isSystem;
    void actorRole;
    // Phase 1B (#11 #23) — tenant policy:
    //   • SUPER may pin the agency to a specific tenant via dto.tenantId
    //     (validated against the tenants table).
    //   • Everyone else: tenantId in the body is silently stripped
    //     (spoof guard).
    //   • In every case we default to the caller's active tenant when
    //     the pilot scope didn't supply one — stops SUPER-created
    //     agencies from landing tenant-less.
    const requestedTenantId = (dto as any).tenantId;
    if ('tenantId' in (dto as any)) delete (dto as any).tenantId;
    let superTenantId: string | null | undefined;
    if (requestedTenantId !== undefined && createdById) {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { isSuperPlatformAdmin } = require('../saas/platform-admin/super-tenant-edit');
      if (await isSuperPlatformAdmin(this.legacyPrisma, createdById)) {
        const trimmed = String(requestedTenantId ?? '').trim();
        if (trimmed) {
          const exists = await this.legacyPrisma.tenant.findUnique({ where: { id: trimmed }, select: { id: true } });
          if (!exists) {
            throw new BadRequestException({
              code: 'TENANT.NOT_FOUND',
              message: 'Selected tenant does not exist.',
              params: { tenantId: trimmed },
            });
          }
          superTenantId = trimmed;
        }
      }
    }
    const tdata = this.scope().tenantData();
    const agency = await this.legacyPrisma.agency.create({ // @tenant-reviewed: phase236-pilot-scope (writes tenantId via scope.tenantData when ALS frame present)
      data: {
        ...dto,
        contactPerson,
        status: (dto.status as any) || 'ACTIVE',
        ...tdata,
        ...(!(tdata as any).tenantId && callerTenantId ? { tenantId: callerTenantId } : {}),
        // SUPER explicit override wins over both above.
        ...(superTenantId ? { tenantId: superTenantId } : {}),
      },
      include: this.include,
    });
    if (createdById) {
      // @tenant-reviewed: phase236-audit-log-pilot
      await this.tenantAuditLog.write({
        userId: createdById, action: 'CREATE', entity: 'Agency', entityId: agency.id,
      });
    }
    return agency;
  }

  /**
   * Agency fields that an Agency Manager is NEVER allowed to touch. The
   * list is the single source of truth — adding a future protected field
   * is a one-line change here.
   */
  static readonly PROTECTED_FIELDS_FOR_MANAGER: string[] = [
    // Business-identity fields Agency Manager must never change.
    'name', 'country', 'status',
    // Admin-only fields.
    'managerId', 'maxUsersPerAgency',
    'deletedAt', 'deletedBy', 'deletionReason',
  ];

  async update(
    id: string,
    dto: UpdateAgencyDto,
    updatedById?: string,
    actor?: { role?: string; agencyId?: string; agencyIsSystem?: boolean },
  ) {
    const existing = await this.findOne(id);

    // Agency Manager scoping: can only edit their own agency, and protected
    // fields (name, managerId, status, maxUsersPerAgency, …) are stripped.
    if (actor?.role === 'Agency Manager') {
      if (actor.agencyId !== id) throw new ForbiddenException('You can only edit your own agency');
      for (const field of AgenciesService.PROTECTED_FIELDS_FOR_MANAGER) {
        delete (dto as any)[field];
      }
    }

    // Phase 3.9 — `Agency.isSystem` column dropped. Strip any legacy
    // payload still carrying it. @tenant-reviewed: phase390-agency-is-system-removed
    if ('isSystem' in (dto as any)) delete (dto as any).isSystem;

    const data: any = { ...dto };
    const derived = this.deriveContactPerson(dto);
    if (derived !== undefined) data.contactPerson = derived;

    // Phase 3 (#27) — SUPER-only tenant reassignment. Non-SUPER callers
    // can't write `tenantId` (the helper strips it before any prisma
    // call). SUPER may move the agency to another tenant; the target
    // tenant is validated against `tenant.findUnique`. Agencies have
    // no `agencyId` of their own, so the helper's agency-drop branch
    // is a no-op here — we just pin the new tenantId.
    await applySuperTenantReassignment(this.legacyPrisma, updatedById, data);

    const agency = await this.legacyPrisma.agency.update({ // @tenant-reviewed: phase236-pilot-scope-precheck (findOne above is tenant-scoped)
      where: { id },
      data,
      include: this.include,
    });
    if (updatedById) {
      // @tenant-reviewed: phase236-audit-log-pilot
      await this.tenantAuditLog.write({
        userId: updatedById, action: 'UPDATE', entity: 'Agency', entityId: id,
      });
    }
    return agency;
  }

  async uploadLogo(id: string, file: Express.Multer.File, actorId?: string) {
    // Phase 2.36 — storage guard. The Phase 2.35 tenant-scoped
    // `findOne` runs BEFORE `storage.uploadFile`, so a cross-tenant
    // id raises 404 with no byte write. Tag the storage-write site
    // accordingly.
    const existing = await this.findOne(id);
    if (!file) throw new BadRequestException('No logo file provided');

    const upload = await this.storage.uploadFile(file.buffer, {
      keyPrefix: `agencies/${id}/logos`,
      contentType: file.mimetype,
      originalName: file.originalname,
      inline: true,
    });

    const agency = await this.legacyPrisma.agency.update({ // @tenant-reviewed: phase236-storage-guard (parent gate above is tenant-scoped)
      where: { id },
      data: { logoUrl: upload.url },
      include: this.include,
    });

    if ((existing as any)?.logoUrl && (existing as any).logoUrl !== upload.url) {
      await this.storage.deleteFileByUrlOrKey((existing as any).logoUrl);
    }

    if (actorId) {
      // @tenant-reviewed: phase236-audit-log-pilot
      await this.tenantAuditLog.write({
        userId: actorId, action: 'UPDATE_LOGO', entity: 'Agency', entityId: id,
        changes: { logoUrl: upload.url },
      });
    }
    return agency;
  }

  /**
   * SUPER-only bulk reassignment: stamp every agency with tenantId=null
   * to the given tenantId. Idempotent — agencies that already have a
   * tenant are left untouched.
   *
   * Caller authority is verified by the controller (Roles + permission +
   * the same isSuperPlatformAdmin check used by single-agency tenant
   * reassignment). The given tenantId must reference an existing tenant.
   *
   * Returns the count of rows updated so the frontend can show "Updated N
   * agencies" feedback.
   */
  async bulkAssignUnassignedToTenant(
    tenantId: string,
    actorId?: string,
  ): Promise<{ updated: number; tenantId: string }> {
    // SUPER-only action — verify before any write. The single-agency
    // tenant-reassignment path in `create` and `update` uses the same
    // helper to gate dto.tenantId; reusing it keeps authority logic
    // consistent across both call sites.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { isSuperPlatformAdmin } = require('../saas/platform-admin/super-tenant-edit');
    if (!actorId || !(await isSuperPlatformAdmin(this.legacyPrisma, actorId))) {
      throw new ForbiddenException({
        code: 'AGENCY.BULK_ASSIGN_TENANT_FORBIDDEN',
        message: 'Only platform SUPER admins can bulk-assign agencies to a tenant.',
      });
    }
    const trimmed = (tenantId ?? '').toString().trim();
    if (!trimmed) {
      throw new BadRequestException({
        code: 'AGENCY.BULK_ASSIGN_TENANT_MISSING',
        message: 'tenantId is required',
      });
    }
    const tenant = await this.legacyPrisma.tenant.findUnique({
      where: { id: trimmed },
      select: { id: true },
    });
    if (!tenant) {
      throw new BadRequestException({
        code: 'TENANT.NOT_FOUND',
        message: 'Selected tenant does not exist.',
        params: { tenantId: trimmed },
      });
    }
    const result = await this.legacyPrisma.agency.updateMany({
      where: { tenantId: null, deletedAt: null },
      data: { tenantId: trimmed },
    });
    if (actorId && result.count > 0) {
      try {
        await this.tenantAuditLog.write({
          userId: actorId,
          action: 'BULK_ASSIGN_TENANT',
          entity: 'Agency',
          entityId: 'ALL_UNASSIGNED',
          changes: { tenantId: trimmed, updated: result.count, source: 'agencies-list' },
        });
      } catch { /* best-effort audit */ }
    }
    return { updated: result.count, tenantId: trimmed };
  }

  async remove(id: string, deletedById?: string) {
    await this.findOne(id);
    await this.legacyPrisma.agency.update({ where: { id }, data: { deletedAt: new Date(), deletedBy: deletedById ?? null } }); // @tenant-reviewed: phase236-pilot-scope-precheck
    if (deletedById) {
      // @tenant-reviewed: phase236-audit-log-pilot
      await this.tenantAuditLog.write({
        userId: deletedById, action: 'DELETE', entity: 'Agency', entityId: id,
      });
    }
    return { message: 'Agency deleted' };
  }

  async getUsers(id: string, pagination: PaginationDto, actor?: { role?: string; agencyId?: string; agencyIsSystem?: boolean }) {
    this.assertAgencyAccess(id, actor);
    await this.findOne(id, actor);
    const { page = 1, limit = 10 } = pagination;
    const where = { agencyId: id, deletedAt: null };
    const [items, total] = await Promise.all([
      this.prisma.user.findMany({ // @tenant-reviewed: phase235-pilot-scope-precheck (parent agency gated by findOne above)
        where,
        skip: (Number(page) - 1) * Number(limit),
        take: Number(limit),
        select: {
          id: true, email: true, firstName: true, lastName: true, status: true,
          // Include the approval state + per-user manager override flags so
          // the frontend can gate Edit/Delete/Approve buttons the same way
          // the standalone Users list does.
          agencyId: true,
          approvalStatus: true,
          approvedAt: true,
          allowManagerEdit: true,
          allowManagerDelete: true,
          role: { select: { id: true, name: true } },
        },
      }),
      this.prisma.user.count({ where }), // @tenant-reviewed: phase235-pilot-scope-precheck
    ]);
    return PaginatedResponse.create(items, total, page, limit);
  }

  async getEmployees(id: string, pagination: PaginationDto, actor?: { role?: string; agencyId?: string; agencyIsSystem?: boolean }) {
    this.assertAgencyAccess(id, actor);
    await this.findOne(id, actor);
    const { page = 1, limit = 10 } = pagination;
    const where: any = { agencyId: id, deletedAt: null };

    // Any external tenant — regardless of role — must have an explicit
    // per-employee grant with canView=true; origin agency alone never
    // grants access, and a read-access-only-revoked grant still blocks.
    if (this.isExternalActor(actor)) {
      const grants = await this.prisma.employeeAgencyAccess.findMany({ // @tenant-reviewed: phase235-pilot-scope-precheck
        where: { agencyId: actor!.agencyId!, canView: true },
        select: { employeeId: true },
      });
      const allowedIds = grants.map(g => g.employeeId);
      if (allowedIds.length === 0) return PaginatedResponse.create([], 0, page, limit);
      where.id = { in: allowedIds };
    }

    const [items, total] = await Promise.all([
      this.prisma.employee.findMany({ // @tenant-reviewed: phase235-pilot-scope-precheck
        where,
        skip: (Number(page) - 1) * Number(limit),
        take: Number(limit),
        select: { id: true, firstName: true, lastName: true, email: true, status: true, licenseCategory: true },
      }),
      this.prisma.employee.count({ where }), // @tenant-reviewed: phase235-pilot-scope-precheck
    ]);
    return PaginatedResponse.create(items, total, page, limit);
  }

  async getStats(id: string, actor?: { role?: string; agencyId?: string; agencyIsSystem?: boolean }) {
    this.assertAgencyAccess(id, actor);
    await this.findOne(id, actor);

    // Build the employee-scope the same way getEmployees does so stats
    // don't leak a count larger than the external tenant can open.
    const employeeWhere: any = { agencyId: id, deletedAt: null };
    if (this.isExternalActor(actor)) {
      const grants = await this.prisma.employeeAgencyAccess.findMany({ // @tenant-reviewed: phase235-pilot-scope-precheck
        where: { agencyId: actor!.agencyId!, canView: true },
        select: { employeeId: true },
      });
      const allowedIds = grants.map(g => g.employeeId);
      if (allowedIds.length === 0) {
        const users = await this.prisma.user.count({ where: { agencyId: id, deletedAt: null } }); // @tenant-reviewed: phase235-pilot-scope-precheck
        return { users, employees: 0, activeEmployees: 0, pendingEmployees: 0 };
      }
      employeeWhere.id = { in: allowedIds };
    }
    const [users, employees, activeEmployees, pendingEmployees] = await Promise.all([
      this.prisma.user.count({ where: { agencyId: id, deletedAt: null } }),                                       // @tenant-reviewed: phase235-pilot-scope-precheck
      this.prisma.employee.count({ where: employeeWhere }),                                                       // @tenant-reviewed: phase235-pilot-scope-precheck
      this.prisma.employee.count({ where: { ...employeeWhere, status: 'ACTIVE' } }),                              // @tenant-reviewed: phase235-pilot-scope-precheck
      this.prisma.employee.count({ where: { ...employeeWhere, status: 'PENDING' } }),                             // @tenant-reviewed: phase235-pilot-scope-precheck
    ]);
    return { users, employees, activeEmployees, pendingEmployees };
  }

  // ── Agency-wide permission overrides (admin only) ───────────────────────────

  async listPermissionOverrides(agencyId: string) {
    await this.findOne(agencyId);
    return this.prisma.agencyPermissionOverride.findMany({ // @tenant-reviewed: phase235-pilot-scope-precheck
      where: { agencyId },
      orderBy: { permission: 'asc' },
    });
  }

  async setPermissionOverride(
    agencyId: string,
    permission: string,
    allow: boolean,
    actorId?: string,
  ) {
    await this.findOne(agencyId);
    const record = await this.legacyPrisma.agencyPermissionOverride.upsert({ // @tenant-reviewed: phase236-permission-gate (parent agency gated above)
      where:  { agencyId_permission: { agencyId, permission } },
      create: { agencyId, permission, allow },
      update: { allow },
    });
    // @tenant-reviewed: phase236-audit-log-pilot
    await this.tenantAuditLog.write({
      userId: actorId, action: allow ? 'AGENCY_PERMISSION_GRANT' : 'AGENCY_PERMISSION_REVOKE',
      entity: 'Agency', entityId: agencyId, changes: { permission, allow },
    });
    return record;
  }

  async removePermissionOverride(agencyId: string, permission: string, actorId?: string) {
    await this.findOne(agencyId);
    try {
      await this.legacyPrisma.agencyPermissionOverride.delete({ // @tenant-reviewed: phase236-permission-gate
        where: { agencyId_permission: { agencyId, permission } },
      });
    } catch {
      throw new NotFoundException('Permission override not found');
    }
    // @tenant-reviewed: phase236-audit-log-pilot
    await this.tenantAuditLog.write({
      userId: actorId, action: 'AGENCY_PERMISSION_OVERRIDE_REMOVED',
      entity: 'Agency', entityId: agencyId, changes: { permission },
    });
    return { message: 'Permission override removed' };
  }

  async setManager(agencyId: string, userId: string, actorId?: string) {
    // Phase 2.36 — manager gate. Tenant-scoped parent gate runs
    // BEFORE the user lookup so a cross-tenant agencyId raises 404
    // before any update.
    await this.findOne(agencyId);

    // Verify user belongs to this agency. The tenant-scoped findOne
    // above guarantees the agency is within the active tenant; the
    // user-belongs-to-agency check then rules out tenant-bypass via
    // a known agencyId.
    const user = await this.legacyPrisma.user.findFirst({ where: { id: userId, agencyId, deletedAt: null } }); // @tenant-reviewed: phase236-manager-gate (parent gated above)
    if (!user) throw new BadRequestException('User does not belong to this agency');

    await this.legacyPrisma.agency.update({ // @tenant-reviewed: phase236-manager-gate
      where: { id: agencyId },
      data: { managerId: userId },
    });

    // @tenant-reviewed: phase236-audit-log-pilot
    await this.tenantAuditLog.write({
      userId: actorId,
      action: 'SET_AGENCY_MANAGER',
      entity: 'Agency',
      entityId: agencyId,
      changes: { managerId: userId },
    });

    return this.findOne(agencyId);
  }
}
