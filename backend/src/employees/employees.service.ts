import { Injectable, NotFoundException, ConflictException, ForbiddenException, Logger, Optional } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { StorageService } from '../common/storage/storage.service';
import { PilotPrismaAccessor } from '../saas/prisma/pilot-prisma.accessor';
import { NotificationsService } from '../notifications/notifications.service';
import { NOTIF_EVENTS } from '../notifications/notification-events';
import { getPilotScope, PilotScope } from '../saas/prisma/tenant-pilot-scope';
import { buildSuperUserTenantWhere, assertRequestedTenantExists, isPlatformAuthority } from '../saas/prisma/super-user-tenant-filter';
import { applySuperTenantReassignment } from '../saas/platform-admin/super-tenant-edit';
import { CreateEmployeeDto } from './dto/create-employee.dto';
import { PaginationDto } from '../common/dto/pagination.dto';
import { PaginatedResponse } from '../common/dto/pagination-response.dto';
import * as ExcelJS from 'exceljs';
import { tServer, ServerLocale } from '../common/i18n/server-translate';

/**
 * Phase 2.33 — Employees reads-first TenantPrisma pilot.
 *
 * READ paths route through `pilot.client()` and spread
 * `scope.tenantWhere()` when the pilot scope is active. Production
 * default (flag off) is byte-identical to pre-2.33.
 *
 * WRITE / mutation / storage paths (`create`, `update`, `remove`,
 * `updateStatus`, `uploadPhoto`, `grant/update/revokeAgencyAccess`)
 * stay on `legacyPrisma` and are tagged `phase234-pilot-scope`,
 * `phase234-pilot-scope-precheck`, `phase234-storage-guard`, or
 * `phase234-agency-gate` (Phase 2.34) — except the intentionally
 * global identifier sequence and email-uniqueness sites which keep
 * `phase233-global`.
 *
 * `Employee.email`, `Employee.employeeNumber` stay globally unique
 * (Phase 3 product). Identifier raw SQL stays global.
 */
@Injectable()
export class EmployeesService {
  constructor(
    private legacyPrisma: PrismaService,
    private storage: StorageService,
    private pilot: PilotPrismaAccessor,
    @Optional() private notifications?: NotificationsService,
  ) {}

  /** Same staff group used by the applicants module — HR Manager runs
   *  status transitions; Recruiter wants to know their hires went on
   *  leave / terminated; System Admin is always in. */
  private static readonly EMPLOYEE_NOTIFY_ROLES = ['System Admin', 'HR Manager', 'Recruiter'];

  private readonly logger = new Logger('EmployeesService');

  /** Pilot-aware Prisma surface used by READ paths only. Mutation
   *  paths use `legacyPrisma` directly. */
  private get prisma(): PrismaService {
    return this.pilot.client();
  }

  private scope(): PilotScope {
    return getPilotScope(this.pilot, 'employees');
  }

  /**
   * Phase 2.34 — parent gate. Loads the employee through the pilot
   * client with `tenantWhere()`. Cross-tenant ids raise 404.
   * Legacy mode reduces to plain by-id lookup (`tenantWhere()` ⇒ {}).
   */
  private async findEmployeeOrFail(id: string) {
    const t = this.scope().tenantWhere();
    const e = await this.prisma.employee.findFirst({ where: { id, deletedAt: null, ...t } }); // @tenant-reviewed: phase234-pilot-scope (parent gate)
    if (!e) throw new NotFoundException('Employee not found');
    return e;
  }

  /**
   * Phase 2.34 — agency tenant gate. Loads the agency through the
   * pilot client with `tenantWhere()`. Cross-tenant agency ids
   * raise 404 BEFORE any agency-access mutation.
   */
  private async findAgencyOrFail(id: string) {
    const t = this.scope().tenantWhere();
    const a = await this.prisma.agency.findFirst({ where: { id, deletedAt: null, ...t } }); // @tenant-reviewed: phase234-agency-gate
    if (!a) throw new NotFoundException('Agency not found');
    return a;
  }

  /**
   * External tenant = user attached to any agency that is not the
   * Tempworks root (`isSystem=true`). Such users are scoped to their
   * own agency regardless of their role name, so an HR Manager in an
   * external agency is treated the same as an Agency Manager.
   */
  private isExternalActor(actor?: { agencyId?: string; agencyIsSystem?: boolean }): boolean {
    return !!actor && !!actor.agencyId && actor.agencyIsSystem !== true;
  }

  async findAll(
    query: PaginationDto & { agencyId?: string; status?: string; nationality?: string; driversOnly?: boolean; tenantId?: string },
    actor?: { role?: string; agencyId?: string; agencyIsSystem?: boolean },
  ) {
    const { page = 1, limit = 20, search, sortBy = 'createdAt', sortOrder = 'desc', agencyId, status, nationality, driversOnly } = query;
    const skip = (Number(page) - 1) * Number(limit);

    const where: any = { deletedAt: null, ...this.scope().tenantWhere() }; // @tenant-reviewed: phase233-pilot-scope

    // External tenants — every role inside a non-system agency — can
    // only see employees granted via EmployeeAgencyAccess with
    // canView=true. Employee.agencyId (origin) is intentionally
    // ignored. Tempworks-root users (isSystem=true) and System Admin
    // keep the global view. The pilot tenant predicate above is
    // additive: `tenantId AND id IN (granted)`.
    if (this.isExternalActor(actor)) {
      // Phase 2B (#35) — an external agency user (e.g. Agency Manager)
      // sees employees they were explicitly granted via
      // EmployeeAgencyAccess, PLUS every employee assigned to their own
      // agency (same-tenant + same-agency = automatic view). Cross-tenant
      // / cross-agency access still requires an explicit grant.
      const grants = await this.prisma.employeeAgencyAccess.findMany({ // @tenant-reviewed: phase233-pilot-scope-precheck (relation by employeeId; gated parents are tenant-scoped)
        where: { agencyId: actor!.agencyId!, canView: true },
        select: { employeeId: true },
      });
      const allowedIds = grants.map(g => g.employeeId);
      where.OR = [
        { agencyId: actor!.agencyId! },
        ...(allowedIds.length > 0 ? [{ id: { in: allowedIds } }] : []),
      ];
    }
    if (search) {
      where.OR = [
        { firstName: { contains: search, mode: 'insensitive' } },
        { lastName: { contains: search, mode: 'insensitive' } },
        { email: { contains: search, mode: 'insensitive' } },
        { licenseNumber: { contains: search, mode: 'insensitive' } },
      ];
    }
    if (agencyId) where.agencyId = agencyId;
    if (status) where.status = status;
    if (nationality) where.nationality = { contains: nationality, mode: 'insensitive' };

    // SUPER USER tenant filter — platform admins only. Ignored otherwise.
    await assertRequestedTenantExists(actor, query.tenantId, this.legacyPrisma.tenant);
    const tenantPredicate = buildSuperUserTenantWhere(actor, query.tenantId);
    if (tenantPredicate) where.AND = [...(where.AND ?? []), tenantPredicate];

    if (driversOnly) {
      // Include employees who have a licence field OR any job type assigned
      // (job type covers cases like "Flatbed Driver" with no licence yet entered)
      where.OR = [
        ...(where.OR ?? []),
        { licenseNumber:  { not: null } },
        { licenseCategory: { not: null } },
        { jobTypeId:      { not: null } },
      ];
    }

    const [data, total] = await Promise.all([
      this.prisma.employee.findMany({ // @tenant-reviewed: phase233-pilot-scope
        where, skip, take: Number(limit),
        orderBy: { [sortBy]: sortOrder },
        include: {
          agency:   { select: { id: true, name: true, tenantId: true } },
          jobType:  { select: { id: true, name: true } },
        },
      }),
      this.prisma.employee.count({ where }), // @tenant-reviewed: phase233-pilot-scope
    ]);

    return PaginatedResponse.create(data, total, page, limit);
  }

  async findOne(
    id: string,
    actor?: { role?: string; agencyId?: string; agencyIsSystem?: boolean },
    opts?: { require?: 'view' | 'edit' },
  ) {
    const t = this.scope().tenantWhere();
    const employee = await this.prisma.employee.findFirst({ // @tenant-reviewed: phase233-pilot-scope
      where: { id, deletedAt: null, ...t },
      // Cast to any because the `createdBy` relation was added to the
      // Prisma schema in the same change that introduced it; a running
      // tsc --watch won't see the regenerated client until the process
      // is restarted. The relation resolves fine at runtime.
      include: {
        agency:   true,
        jobType:  { select: { id: true, name: true } },
        createdBy: { select: { id: true, firstName: true, lastName: true, email: true } },
        employeeStages: { include: { stage: true, assignedTo: { select: { id: true, firstName: true, lastName: true } } }, orderBy: { stage: { order: 'asc' } } },
      } as any,
    });
    if (!employee) throw new NotFoundException('Employee not found');

    if (this.isExternalActor(actor)) {
      // Phase 2B (#35) — same-agency auto-grant: an external agency
      // user automatically sees employees whose agencyId matches their
      // own (same-tenant via the findFirst tenant predicate above).
      // For view-only we short-circuit; for edit we still require an
      // explicit grant (canEdit) so agencies can't unilaterally mutate
      // shared records without being told they can.
      const isSameAgency = !!actor!.agencyId && (employee as any).agencyId === actor!.agencyId;
      const need = opts?.require ?? 'view';
      if (isSameAgency && need === 'view') {
        return employee;
      }
      const grant = await this.prisma.employeeAgencyAccess.findUnique({ // @tenant-reviewed: phase233-pilot-scope-precheck (parent gated above)
        where: { employeeId_agencyId: { employeeId: id, agencyId: actor!.agencyId! } },
      });
      if (!grant && !isSameAgency) throw new ForbiddenException('Access to this employee has not been granted to your agency');
      if (need === 'view' && grant && !grant.canView) {
        throw new ForbiddenException('View access to this employee has not been granted to your agency');
      }
      // Edit still requires an explicit grant (same-agency does NOT auto-grant edit).
      if (need === 'edit' && !grant?.canEdit) {
        throw new ForbiddenException('Edit access to this employee has not been granted to your agency');
      }
    }

    return employee;
  }

  // ── Per-employee agency access grants (admin-only) ──────────────────────────

  async listAgencyAccess(employeeId: string) {
    const t = this.scope().tenantWhere();
    const employee = await this.prisma.employee.findFirst({ // @tenant-reviewed: phase233-pilot-scope (parent gate)
      where: { id: employeeId, deletedAt: null, ...t },
    });
    if (!employee) throw new NotFoundException('Employee not found');
    return this.prisma.employeeAgencyAccess.findMany({ // @tenant-reviewed: phase233-pilot-scope-precheck
      where: { employeeId },
      include: { agency: { select: { id: true, name: true } } },
      orderBy: { grantedAt: 'desc' },
    });
  }

  async grantAgencyAccess(
    employeeId: string,
    agencyId: string,
    dto: { notes?: string; canView?: boolean; canEdit?: boolean } = {},
    actorId?: string,
  ) {
    // Phase 2.34 — both target sides are tenant-gated in pilot mode.
    // In legacy mode the gates collapse to plain by-id lookups
    // (`tenantWhere()` → `{}`) — byte-equivalent to pre-2.34 behaviour
    // since the prior code already required `deletedAt: null` on both.
    await this.findEmployeeOrFail(employeeId);
    await this.findAgencyOrFail(agencyId);
    const canView = dto.canView ?? true;
    const canEdit = dto.canEdit ?? true;
    // If the caller sets both flags to false we delete the row instead
    // of persisting a useless "no access" grant — keeps the table tidy
    // and makes revoke from the UI symmetric with delete.
    if (!canView && !canEdit) {
      await this.legacyPrisma.employeeAgencyAccess.deleteMany({ // @tenant-reviewed: phase234-agency-gate (gates above)
        where: { employeeId, agencyId },
      });
      return { employeeId, agencyId, canView: false, canEdit: false, deleted: true };
    }
    const grant = await this.legacyPrisma.employeeAgencyAccess.upsert({ // @tenant-reviewed: phase234-agency-gate (gates above)
      where:  { employeeId_agencyId: { employeeId, agencyId } },
      create: { employeeId, agencyId, notes: dto.notes, grantedById: actorId, canView, canEdit },
      update: { notes: dto.notes, grantedById: actorId, grantedAt: new Date(), canView, canEdit },
    });
    return grant;
  }

  async updateAgencyAccess(
    employeeId: string,
    agencyId: string,
    dto: { canView?: boolean; canEdit?: boolean; notes?: string },
    actorId?: string,
  ) {
    // Phase 2.34 — gate both sides BEFORE the access-row lookup so a
    // foreign-tenant employee or agency cannot drive any update.
    await this.findEmployeeOrFail(employeeId);
    await this.findAgencyOrFail(agencyId);
    const existing = await this.legacyPrisma.employeeAgencyAccess.findUnique({ // @tenant-reviewed: phase234-agency-gate (gates above)
      where: { employeeId_agencyId: { employeeId, agencyId } },
    });
    if (!existing) throw new NotFoundException('No grant for that employee/agency pair');
    const canView = dto.canView ?? existing.canView;
    const canEdit = dto.canEdit ?? existing.canEdit;
    if (!canView && !canEdit) {
      await this.legacyPrisma.employeeAgencyAccess.delete({ // @tenant-reviewed: phase234-agency-gate
        where: { employeeId_agencyId: { employeeId, agencyId } },
      });
      return { employeeId, agencyId, canView: false, canEdit: false, deleted: true };
    }
    return this.legacyPrisma.employeeAgencyAccess.update({ // @tenant-reviewed: phase234-agency-gate
      where: { employeeId_agencyId: { employeeId, agencyId } },
      data: {
        canView, canEdit,
        ...(dto.notes !== undefined ? { notes: dto.notes } : {}),
        grantedById: actorId,
      },
    });
  }

  async revokeAgencyAccess(employeeId: string, agencyId: string) {
    // Phase 2.34 — gate both sides BEFORE delete.
    await this.findEmployeeOrFail(employeeId);
    await this.findAgencyOrFail(agencyId);
    try {
      await this.legacyPrisma.employeeAgencyAccess.delete({ // @tenant-reviewed: phase234-agency-gate
        where: { employeeId_agencyId: { employeeId, agencyId } },
      });
    } catch {
      throw new NotFoundException('No grant for that employee/agency pair');
    }
    return { message: 'Access revoked' };
  }

  async create(
    dto: CreateEmployeeDto,
    actorId?: string,
    actor?: { role: string; agencyId?: string; agencyIsSystem?: boolean; tenantId?: string | null },
  ) {
    const existing = await this.legacyPrisma.employee.findFirst({ where: { email: dto.email, deletedAt: null } }); // @tenant-reviewed: phase233-global (Employee.email globally unique — Phase 3)
    if (existing) throw new ConflictException('Employee with this email already exists');

    // Get all workflow stages to initialize
    const stages = await this.legacyPrisma.stageTemplate.findMany({ where: { isActive: true }, orderBy: { order: 'asc' } }); // @tenant-reviewed: phase233-global (StageTemplate is a global catalog)

    const employeeNumber = await this.generateEmployeeNumber();
    // Drop agencyId (resolved server-side) and tenantId (never trusted on
    // create — tenant comes from scope().tenantData()).
    const { agencyId: dtoAgencyId, tenantId: _ignoredTenantId, ...rest } = dto as any;

    // Server-authoritative agency assignment.
    //   • External actor (Agency User/Manager): pin to caller's agency,
    //     ignoring any value submitted in the body.
    //   • Internal actor (System Admin / HR Manager / etc.): may pick
    //     any agency, but it MUST belong to the active tenant —
    //     findAgencyOrFail() raises 404 for cross-tenant ids and so
    //     the bad assignment never reaches the database.
    let resolvedAgencyId: string | undefined = dtoAgencyId ?? undefined;
    if (actor && this.isExternalActor(actor) && actor.agencyId) {
      resolvedAgencyId = actor.agencyId;
    } else if (resolvedAgencyId) {
      await this.findAgencyOrFail(resolvedAgencyId);
      // Belt-and-braces tenant guard (findAgencyOrFail only scopes by
      // tenant when the pilot is active): a non-platform caller cannot
      // attach an agency from a different tenant.
      await this.assertAgencyInTenant(resolvedAgencyId, actor);
    }

    const tdata = this.scope().tenantData();
    const employee = await this.legacyPrisma.employee.create({ // @tenant-reviewed: phase234-pilot-scope (writes tenantId via scope.tenantData)
      data: {
        ...rest,
        employeeNumber,
        dateOfBirth: new Date(dto.dateOfBirth),
        status: (dto.status as any) || 'PENDING',
        ...(resolvedAgencyId ? { agencyId: resolvedAgencyId } : {}),
        // Employees created directly from the dashboard are always
        // staff-initiated — the public /apply flow produces an
        // applicant, not an employee.
        createdById: actorId ?? null,
        source: 'STAFF_CREATED',
        employeeStages: {
          create: stages.map((stage) => ({
            stageId: stage.id,
            status: 'PENDING',
          })),
        },
        ...tdata,
        // Phase 1B (#23) — default the new employee's tenant to the
        // caller's active tenant when the pilot scope didn't supply one
        // (e.g. pilot off). Prevents SUPER-created employees from
        // landing with a NULL tenant and orphaning their attendance /
        // financial / document records.
        ...(!(tdata as any).tenantId && actor?.tenantId ? { tenantId: actor.tenantId } : {}),
      } as any,
      include: { agency: { select: { id: true, name: true } } },
    });

    // Auto-grant the owning agency view + edit access on the new
    // employee. Without this row the agency's users wouldn't see the
    // record they just created (the per-employee Agency Access list
    // would render empty), even though the Employee.agencyId column
    // points at them. Mirrors the convertToEmployee path so the two
    // creation routes behave identically.
    if (resolvedAgencyId) {
      await this.grantAgencyAccess(
        employee.id,
        resolvedAgencyId,
        { canView: true, canEdit: true, notes: 'Auto-granted on employee creation' },
        actorId,
      );
    }

    return employee;
  }

  private async generateEmployeeNumber(): Promise<string> {
    const now = new Date();
    const yyyy = now.getFullYear().toString();
    const mm = String(now.getMonth() + 1).padStart(2, '0');
    const prefix = `E${yyyy}${mm}`;

    // @tenant-reviewed: phase233-global (Employee.employeeNumber globally unique — Phase 3 product)
    const result: any[] = await this.legacyPrisma.$queryRaw`
      SELECT COALESCE(MAX(
        CAST(SUBSTRING("employeeNumber" FROM 8) AS INTEGER)
      ), 0) + 1 AS next_serial
      FROM employees
      WHERE "employeeNumber" IS NOT NULL
        AND "employeeNumber" LIKE ${prefix + '%'}
    `;

    const serial = result[0]?.next_serial ?? 1;
    return `${prefix}${String(serial).padStart(5, '0')}`;
  }

  async update(
    id: string,
    dto: Partial<CreateEmployeeDto>,
    _actorId?: string,
    actor?: { role?: string; agencyId?: string; agencyIsSystem?: boolean; tenantId?: string | null },
  ) {
    // Edit path: external tenants need a grant with canEdit=true.
    const existing = await this.findOne(id, actor, { require: 'edit' });
    const data: any = { ...dto };
    if (dto.dateOfBirth) data.dateOfBirth = new Date(dto.dateOfBirth);
    // §4.11 — contract date columns. Capture the pre-update end-date
    // BEFORE the write so the EMPLOYEE_CONTRACT_RENEWED detection below
    // has a clean comparison point.
    if ('contractStartDate' in dto) {
      data.contractStartDate = dto.contractStartDate ? new Date(dto.contractStartDate) : null;
    }
    if ('contractEndDate' in dto) {
      data.contractEndDate = dto.contractEndDate ? new Date(dto.contractEndDate) : null;
    }
    const prevContractEnd: Date | null = (existing as any).contractEndDate ?? null;
    // Tenant guard: a non-platform caller may only assign a recruitment
    // agency that belongs to their own tenant. The picker is already
    // tenant-scoped, but this rejects a spoofed cross-tenant agencyId
    // sent straight to the API. Platform admins bypass (they reassign
    // tenants explicitly via applySuperTenantReassignment).
    await this.assertAgencyInTenant((dto as any).agencyId, actor);
    // SUPER-only tenant reassignment (strips tenantId for everyone else).
    // On a tenant change, a foreign agency is dropped to stay consistent.
    await applySuperTenantReassignment(this.legacyPrisma, _actorId, data, (existing as any).agencyId);
    const updated = await this.legacyPrisma.employee.update({
      where: { id }, data,
      include: { agency: { select: { id: true, name: true } } },
    }); // @tenant-reviewed: phase234-pilot-scope-precheck

    // §4.11 EMPLOYEE_CONTRACT_RENEWED — fires when the contract end
    // date moves forward (or fills a null end with status=ACTIVE).
    // Same-or-earlier dates are silent (corrections / typo fixes).
    // The expiring + ended events are handled by the cron so a single
    // edit doesn't fire three notifications for the same change.
    const nextContractEnd: Date | null = (updated as any).contractEndDate ?? null;
    const renewed =
      (nextContractEnd && (!prevContractEnd || nextContractEnd.getTime() > prevContractEnd.getTime())) ||
      (nextContractEnd === null && (updated as any).status === 'ACTIVE' && prevContractEnd !== null);
    if (renewed && nextContractEnd) {
      const displayName = [(updated as any).firstName, (updated as any).lastName].filter(Boolean).join(' ');
      this.notifications?.notifyUsersByRoles(
        EmployeesService.EMPLOYEE_NOTIFY_ROLES,
        NOTIF_EVENTS.EMPLOYEE_CONTRACT_RENEWED,
        'Contract renewed',
        `${displayName || 'An employee'} has a new contract end date: ${nextContractEnd.toISOString().slice(0, 10)}.`,
        'EMPLOYEE',
        id,
        {
          titleKey: 'events.employeeContractRenewed.title',
          messageKey: 'events.employeeContractRenewed.body',
          params: {
            fullName: displayName,
            previousEnd: prevContractEnd ? prevContractEnd.toISOString().slice(0, 10) : null,
            newEnd: nextContractEnd.toISOString().slice(0, 10),
          },
        },
      ).catch(e => this.logger.error('Employee contract-renewed notification error:', e));
    }

    return updated;
  }

  // ── Profile lock ────────────────────────────────────────────────────────────
  //
  // §4.11 EMPLOYEE_PROFILE_LOCKED. Admins flip the lock to prevent the
  // employee from editing their own profile. Both the affected
  // employee (when they hold a user account) and HR managers hear the
  // toggle. Idempotent — re-applying the same state is silent.

  async setProfileLock(
    employeeId: string,
    locked: boolean,
    actorId?: string,
    actor?: { role?: string; agencyId?: string; agencyIsSystem?: boolean },
  ) {
    const existing = await this.findOne(employeeId, actor, { require: 'edit' });
    const wasLocked = !!(existing as any).profileLocked;
    if (wasLocked === locked) {
      return existing;
    }
    const updated = await this.legacyPrisma.employee.update({
      where: { id: employeeId },
      data: ({
        profileLocked: locked,
        profileLockedAt: locked ? new Date() : null,
        profileLockedBy: locked ? (actorId ?? null) : null,
      } as any),
      include: { agency: { select: { id: true, name: true } } },
    });

    // Notify the affected employee's user account (if any) + HR. Look
    // up the user account by matching email — Employees and Users are
    // linked by email today.
    const employeeUser = (updated as any).email
      ? await this.legacyPrisma.user.findFirst({
          where: { email: (updated as any).email, deletedAt: null },
          select: { id: true },
        })
      : null;
    const displayName = [(updated as any).firstName, (updated as any).lastName].filter(Boolean).join(' ');
    const title = locked ? 'Profile locked' : 'Profile unlocked';
    const message = locked
      ? `${displayName || 'Your profile'} has been locked by an administrator. You cannot edit it until it is unlocked.`
      : `${displayName || 'Your profile'} has been unlocked. You can resume editing.`;

    if (employeeUser?.id) {
      this.notifications?.notifyUsers(
        [employeeUser.id],
        NOTIF_EVENTS.EMPLOYEE_PROFILE_LOCKED,
        title,
        message,
        'EMPLOYEE',
        employeeId,
        {
          titleKey: locked ? 'events.employeeProfileLocked.title' : 'events.employeeProfileUnlocked.title',
          messageKey: locked ? 'events.employeeProfileLocked.body' : 'events.employeeProfileUnlocked.body',
          params: { fullName: displayName, locked },
        },
      ).catch(e => this.logger.error('Employee profile-lock notification (employee) error:', e));
    }

    // HR cohort — same event, different recipient set.
    this.notifications?.notifyUsersByRoles(
      EmployeesService.EMPLOYEE_NOTIFY_ROLES,
      NOTIF_EVENTS.EMPLOYEE_PROFILE_LOCKED,
      title,
      `${displayName || 'An employee'} profile was ${locked ? 'locked' : 'unlocked'}.`,
      'EMPLOYEE',
      employeeId,
      {
        titleKey: locked ? 'events.employeeProfileLocked.title' : 'events.employeeProfileUnlocked.title',
        messageKey: locked ? 'events.employeeProfileLocked.body' : 'events.employeeProfileUnlocked.body',
        params: { fullName: displayName, locked },
      },
    ).catch(e => this.logger.error('Employee profile-lock notification (HR) error:', e));

    return updated;
  }

  /**
   * Reject any attempt by a non-platform caller to attach a recruitment
   * agency that lives in a different tenant. No-op when no agency is
   * being set, for platform authorities, or when the caller's token
   * carries no tenantId (nothing to compare against).
   */
  private async assertAgencyInTenant(
    agencyId: string | undefined | null,
    actor?: { role?: string; agencyIsSystem?: boolean; tenantId?: string | null },
  ): Promise<void> {
    if (!agencyId) return;
    if (isPlatformAuthority(actor)) return;
    const callerTenantId = (actor?.tenantId ?? '').toString().trim();
    if (!callerTenantId) return;
    const agency = await this.legacyPrisma.agency.findFirst({
      where: { id: agencyId, deletedAt: null },
      select: { tenantId: true },
    });
    if (!agency || (agency.tenantId && agency.tenantId !== callerTenantId)) {
      throw new ForbiddenException({
        code: 'AGENCY.CROSS_TENANT',
        message: 'You can only assign a recruitment agency that belongs to your own tenant.',
      });
    }
  }

  async uploadPhoto(id: string, file: Express.Multer.File) {
    // Phase 2.34 — storage guard. Resolve through the pilot-aware
    // tenant gate BEFORE writing bytes to storage. Cross-tenant ids
    // raise 404 BEFORE `storage.uploadFile` is called. Legacy mode
    // collapses `tenantWhere()` to {} ⇒ tenant-agnostic by-id lookup.
    const t = this.scope().tenantWhere();
    const employee = await this.prisma.employee.findFirst({ // @tenant-reviewed: phase234-storage-guard
      where: { id, deletedAt: null, ...t },
      select: { firstName: true, lastName: true, photoUrl: true },
    });
    if (!employee) throw new NotFoundException('Employee not found');

    const upload = await this.storage.uploadFile(file.buffer, {
      keyPrefix: `employees/${id}/photos`,
      contentType: file.mimetype,
      originalName: file.originalname,
      inline: true,
    });

    const updated = await this.legacyPrisma.employee.update({ // @tenant-reviewed: phase234-pilot-scope-precheck (storage guard above is tenant-scoped)
      where: { id },
      data: { photoUrl: upload.url },
      include: { agency: { select: { id: true, name: true } } },
    });

    if (employee.photoUrl && employee.photoUrl !== upload.url) {
      await this.storage.deleteFileByUrlOrKey(employee.photoUrl);
    }

    return updated;
  }

  /**
   * Get the banking/salary profile for a converted employee.
   * Looks up the ApplicantFinancialProfile via the employeeId link
   * that is set during Candidate→Employee conversion.
   * Returns null if the employee was not converted from an applicant
   * or if no financial profile was created at the candidate stage.
   */
  async getFinancialProfile(id: string) {
    await this.findOne(id);
    const profile = await (this.prisma as any).applicantFinancialProfile.findUnique({ // @tenant-reviewed: phase233-pilot-scope-precheck (parent gated; employeeId is unique)
      where: { employeeId: id },
    });
    return profile ?? null;
  }

  async remove(id: string, actorId?: string, actor?: { role?: string; agencyId?: string; agencyIsSystem?: boolean }) {
    await this.findOne(id, actor, { require: 'edit' });
    // Stamp deletedBy so the Recycle Bin / Deleted Records page can show
    // who removed the row. Without this the column was always "—".
    await this.legacyPrisma.employee.update({ where: { id }, data: { deletedAt: new Date(), deletedBy: actorId ?? null } }); // @tenant-reviewed: phase234-pilot-scope-precheck
    return { message: 'Employee deleted successfully' };
  }

  async updateStatus(id: string, status: string, _actorId?: string, actor?: { role?: string; agencyId?: string; agencyIsSystem?: boolean }) {
    const existing = await this.findOne(id, actor, { require: 'edit' });
    const previousStatus = (existing as any).status as string | undefined;
    const updated = await this.legacyPrisma.employee.update({ where: { id }, data: { status: status as any } }); // @tenant-reviewed: phase234-pilot-scope-precheck

    // Spec §4.11 — Employees: emit STATUS_CHANGED on real transitions
    // only (a no-op set to the same status doesn't spam the bell).
    if (previousStatus !== status) {
      const displayName = [(updated as any).firstName, (updated as any).lastName].filter(Boolean).join(' ');
      this.notifications?.notifyUsersByRoles(
        EmployeesService.EMPLOYEE_NOTIFY_ROLES,
        NOTIF_EVENTS.EMPLOYEE_STATUS_CHANGED,
        'Employee status changed',
        `${displayName || 'An employee'} is now ${status}.`,
        'EMPLOYEE',
        id,
        {
          titleKey: 'events.employeeStatusChanged.title',
          messageKey: 'events.employeeStatusChanged.body',
          params: {
            fullName: displayName,
            previousStatus: previousStatus ?? '',
            newStatus: status,
          },
        },
      ).catch(e => this.logger.error('Employee status-change notification error:', e));
    }
    return updated;
  }

  async getDocuments(id: string, archived?: string) {
    await this.findOne(id);
    // Archive view: default hides archived ("No longer valid") docs so
    // the profile Documents tab shows only the active set. 'archived'
    // shows only archived; 'all' shows both.
    const archivedPredicate: any =
      archived === 'archived' ? { archivedAt: { not: null } } :
      archived === 'all'      ? {} :
                                { archivedAt: null };
    // Include documents the employee owns directly (entityType=EMPLOYEE)
    // AND documents uploaded as proof against any of the employee's
    // attendance days (entityType=ATTENDANCE, entityId IN their records),
    // so the Documents tab is the single place where every file linked
    // to the employee is visible.
    const attRecords = await (this.prisma as any).attendanceRecord.findMany({ // @tenant-reviewed: phase233-pilot-scope-precheck (parent employee gated above)
      where: { employeeId: id },
      select: { id: true },
    });
    const attendanceIds = attRecords.map((r: any) => r.id);
    return this.prisma.document.findMany({ // @tenant-reviewed: phase233-pilot-scope-precheck (parent gated; entityId-keyed)
      where: {
        deletedAt: null,
        ...archivedPredicate,
        OR: [
          { entityType: 'EMPLOYEE', entityId: id },
          ...(attendanceIds.length
            ? [{ entityType: 'ATTENDANCE' as any, entityId: { in: attendanceIds } }]
            : []),
        ],
      },
      include: { documentType: true, uploadedBy: { select: { firstName: true, lastName: true } }, verifiedBy: { select: { firstName: true, lastName: true } } },
      orderBy: { createdAt: 'desc' },
    });
  }

  async getWorkflow(id: string) {
    await this.findOne(id);
    return this.prisma.employeeStage.findMany({ // @tenant-reviewed: phase233-pilot-scope-precheck
      where: { employeeId: id },
      include: { stage: true, assignedTo: { select: { id: true, firstName: true, lastName: true } } },
      orderBy: { stage: { order: 'asc' } },
    });
  }

  async getCompliance(id: string) {
    await this.findOne(id);
    const [docs, alerts] = await Promise.all([
      this.prisma.document.findMany({ where: { entityType: 'EMPLOYEE', entityId: id, deletedAt: null }, include: { documentType: true } }), // @tenant-reviewed: phase233-pilot-scope-precheck
      this.prisma.complianceAlert.findMany({ where: { entityType: 'EMPLOYEE', entityId: id }, orderBy: { severity: 'desc' } }),               // @tenant-reviewed: phase233-pilot-scope-precheck
    ]);
    return { documents: docs, alerts };
  }

  async getCertifications(id: string) {
    await this.findOne(id);
    return this.prisma.document.findMany({ // @tenant-reviewed: phase233-pilot-scope-precheck
      where: { entityType: 'EMPLOYEE', entityId: id, deletedAt: null, documentType: { category: 'certification' } },
      include: { documentType: true },
      orderBy: { createdAt: 'desc' },
    });
  }

  async getTraining(id: string) {
    await this.findOne(id);
    const stages = await this.prisma.employeeStage.findMany({ // @tenant-reviewed: phase233-pilot-scope-precheck
      where: { employeeId: id, stage: { category: 'TRAINING' } },
      include: { stage: true },
    });
    return stages;
  }

  async getPerformance(id: string) {
    const employee = await this.findOne(id);
    const completedStages = await this.prisma.employeeStage.count({ // @tenant-reviewed: phase233-pilot-scope-precheck
      where: { employeeId: id, status: 'COMPLETED' },
    });
    const totalStages = await this.prisma.employeeStage.count({ where: { employeeId: id } }); // @tenant-reviewed: phase233-pilot-scope-precheck
    const validDocs = await this.prisma.document.count({ where: { entityType: 'EMPLOYEE', entityId: id, status: 'VERIFIED', deletedAt: null } }); // @tenant-reviewed: phase233-pilot-scope-precheck
    const totalDocs = await this.prisma.document.count({ where: { entityType: 'EMPLOYEE', entityId: id, deletedAt: null } });                       // @tenant-reviewed: phase233-pilot-scope-precheck

    return {
      employee: { id: employee.id, firstName: employee.firstName, lastName: employee.lastName },
      workflowCompletion: totalStages > 0 ? Math.round((completedStages / totalStages) * 100) : 0,
      documentCompliance: totalDocs > 0 ? Math.round((validDocs / totalDocs) * 100) : 0,
      completedStages,
      totalStages,
      validDocuments: validDocs,
      totalDocuments: totalDocs,
    };
  }

  // ── XLSX Export ─────────────────────────────────────────────────────────────
  //
  // Same scoping rules as findAll — external tenants only see employees
  // granted via EmployeeAgencyAccess.canView; passing `ids` restricts to
  // those specific rows (for the "Export to Excel" button which always
  // runs on the selected set). Returns a workbook Buffer ready to stream.
  async exportExcel(
    query: PaginationDto & { agencyId?: string; status?: string; nationality?: string },
    actor?: { role?: string; agencyId?: string; agencyIsSystem?: boolean },
    ids?: string[],
    locale: ServerLocale = 'en',
  ): Promise<Buffer> {
    let items: any[];

    if (ids && ids.length > 0) {
      const where: any = { id: { in: ids }, deletedAt: null, ...this.scope().tenantWhere() }; // @tenant-reviewed: phase233-pilot-scope
      if (this.isExternalActor(actor)) {
        const grants = await this.prisma.employeeAgencyAccess.findMany({ // @tenant-reviewed: phase233-pilot-scope-precheck
          where: { agencyId: actor!.agencyId!, canView: true },
          select: { employeeId: true },
        });
        const allowedIds = new Set(grants.map(g => g.employeeId));
        where.id = { in: ids.filter(i => allowedIds.has(i)) };
      }
      items = await this.prisma.employee.findMany({ // @tenant-reviewed: phase233-pilot-scope
        where,
        include: {
          agency:  { select: { id: true, name: true } },
          jobType: { select: { id: true, name: true } },
        },
        orderBy: { createdAt: 'desc' },
      });
    } else {
      const big = { ...query, limit: 10000, page: 1 } as any;
      const result = await this.findAll(big, actor);
      items = (result as any).data;
    }

    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'TempWorks';
    workbook.created = new Date();

    // Resolve column headers via the export catalog so AR/DE/RU/SK/TR
    // exports match the requester's UI locale. EN fallback is automatic
    // when a translation is missing.
    const col = (key: string) => tServer(`employees.columns.${key}`, {}, locale, 'exports');
    const sheet = workbook.addWorksheet(
      tServer('employees.sheetName', {}, locale, 'exports'),
      { views: [{ state: 'frozen', ySplit: 1 }] },
    );

    sheet.columns = [
      { header: col('employeeNumber'),  key: 'employeeNumber',  width: 18 },
      { header: col('firstName'),       key: 'firstName',       width: 16 },
      { header: col('lastName'),        key: 'lastName',        width: 16 },
      { header: col('email'),           key: 'email',           width: 28 },
      { header: col('phone'),           key: 'phone',           width: 18 },
      { header: col('nationality'),     key: 'nationality',     width: 16 },
      { header: col('licenseNumber'),   key: 'licenseNumber',   width: 20 },
      { header: col('licenseCategory'), key: 'licenseCategory', width: 14 },
      { header: col('yearsExperience'), key: 'yearsExperience', width: 14 },
      { header: col('jobType'),         key: 'jobType',         width: 22 },
      { header: col('agency'),          key: 'agency',          width: 22 },
      { header: col('address'),         key: 'address',         width: 30 },
      { header: col('city'),            key: 'city',            width: 16 },
      { header: col('country'),         key: 'country',         width: 16 },
      { header: col('postalCode'),      key: 'postalCode',      width: 12 },
      { header: col('status'),          key: 'status',          width: 14 },
      { header: col('createdAt'),       key: 'createdAt',       width: 16, style: { numFmt: 'yyyy-mm-dd' } },
    ];

    sheet.getRow(1).eachCell((cell) => {
      cell.font      = { bold: true, color: { argb: 'FFFFFFFF' } };
      cell.fill      = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF2563EB' } };
      cell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
      cell.border    = { bottom: { style: 'thin', color: { argb: 'FF1D4ED8' } } };
    });
    sheet.getRow(1).height = 28;

    for (const e of items) {
      sheet.addRow({
        employeeNumber:  e.employeeNumber ?? '',
        firstName:       e.firstName ?? '',
        lastName:        e.lastName ?? '',
        email:           e.email ?? '',
        phone:           e.phone ?? '',
        nationality:     e.nationality ?? '',
        licenseNumber:   e.licenseNumber ?? '',
        licenseCategory: e.licenseCategory ?? '',
        yearsExperience: e.yearsExperience ?? '',
        jobType:         e.jobType?.name ?? '',
        agency:          e.agency?.name ?? '',
        address:         [e.addressLine1, e.addressLine2].filter(Boolean).join(', '),
        city:            e.city ?? '',
        country:         e.country ?? '',
        postalCode:      e.postalCode ?? '',
        status:          e.status ?? '',
        createdAt:       e.createdAt ? new Date(e.createdAt) : null,
      });
    }

    return Buffer.from(await workbook.xlsx.writeBuffer() as ArrayBuffer);
  }
}
