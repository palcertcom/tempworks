import {
  Injectable, NotFoundException, ConflictException, ForbiddenException, BadRequestException, Logger, Optional,
} from '@nestjs/common';
import { randomUUID } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { PilotPrismaAccessor } from '../saas/prisma/pilot-prisma.accessor';
import { getPilotScope, PilotScope, isModuleAllowed } from '../saas/prisma/tenant-pilot-scope';
import { buildSuperUserTenantWhere, assertRequestedTenantExists } from '../saas/prisma/super-user-tenant-filter';
import { applySuperTenantReassignment } from '../saas/platform-admin/super-tenant-edit';
import { TenantAuditLogService } from '../saas/audit/tenant-audit-log.service';
import { TenantContext } from '../saas/context/als';
import { EmailService } from '../email/email.service';
import { NotificationsService } from '../notifications/notifications.service';
import { NOTIF_EVENTS } from '../notifications/notification-events';
import { tServer, ServerLocale } from '../common/i18n/server-translate';
import { CreateApplicantDto } from './dto/create-applicant.dto';
import { UpdateApplicantDto } from './dto/update-applicant.dto';
import { ConvertToEmployeeDto } from './dto/convert-to-employee.dto';
import { FilterApplicantsDto } from './dto/filter-applicants.dto';
import { UpsertFinancialProfileDto } from './dto/financial-profile.dto';
import { BulkActionDto, BulkActionType, AssignAgencyDto, ConvertLeadDto } from './dto/bulk-action.dto';
import { PaginatedResponse } from '../common/dto/pagination-response.dto';
import { StorageService } from '../common/storage/storage.service';
import * as ExcelJS from 'exceljs';

/**
 * Phase 2.28 — Applicants reads-first pilot.
 *
 * READ paths route through `pilot.client()` and spread
 * `scope.tenantWhere()` when the pilot scope is active. Production
 * default (flag off) is byte-identical to pre-2.28.
 *
 * WRITE / mutation paths (every CRUD / lifecycle / conversion
 * method) explicitly use `legacyPrisma`. Phase 2.29 retags by-id
 * mutation sites as `phase229-pilot-scope-precheck` (gated by the
 * tenant-scoped `findOne` from Phase 2.28); creates +
 * `convertToEmployee.employee.create` get `phase229-pilot-scope`
 * (write `tenantId` via `scope.tenantData()`); `bulkAction` uses
 * `phase229-bulk-filter`. `publicSubmit` and `uploadPhoto` stay
 * `phase228-excluded-mutation` (DEFERRED).
 *
 * `Applicant.email @unique` stays globally unique; the duplicate-
 * check inside `update` is intentionally global (`phase228-global`).
 *
 * Audit-log writes use `legacyPrisma` always (`phase228-audit-log`).
 */

/**
 * Phase 3 (#26) — Single source of truth for "what address does the
 * candidate already have on file?". Both the bulk converter and the
 * single-candidate converter need to read addresses out of the
 * applicant's `applicationData` JSON blob, since Applicants don't
 * store address as flat columns. Previously this logic lived inline
 * in bulkAction only — the individual flow ignored it entirely and
 * defaulted the dialog form to empty strings, so the bulk error
 * "convert this one individually" was a dead end.
 *
 * Preference: `homeAddress` is used when it has any identifying
 * field; otherwise we fall back to `currentAddress`. Same rule as
 * the legacy inline extraction.
 */
export function extractApplicantAddressForConversion(applicationData: any): {
  addressLine1: string;
  addressLine2: string;
  city: string;
  country: string;
  postalCode: string;
} {
  const ad = applicationData ?? {};
  const pick = (v: any) => (typeof v === 'string' ? v.trim() : '');
  const hasAny = (a: any) => !!a && typeof a === 'object'
    && (pick(a.line1) || pick(a.addressLine1) || pick(a.street)
        || pick(a.city) || pick(a.country) || pick(a.postalCode));

  // Try, in order, the address shapes the various intake paths produce:
  //   1. applicationData.homeAddress    (public application form)
  //   2. applicationData.currentAddress (same form, when "different from home")
  //   3. applicationData.permanentAddress / address (legacy + a few imports)
  //   4. flat keys on applicationData root (manual API create)
  const candidates = [
    ad.homeAddress,
    ad.currentAddress,
    ad.permanentAddress,
    ad.address,
    ad,
  ];
  const src: any = candidates.find(hasAny) ?? {};

  return {
    // 'street' is the legacy alias; 'addressLine1' is the dialog/import alias.
    addressLine1: pick(src.line1) || pick(src.addressLine1) || pick(src.street),
    addressLine2: pick(src.line2) || pick(src.addressLine2),
    city:         pick(src.city),
    country:      pick(src.country),
    postalCode:   pick(src.postalCode) || pick(src.postal) || pick(src.zip),
  };
}

/** Returns the list of required address keys that are missing/empty. */
export function missingAddressFields(addr: {
  addressLine1: string;
  city: string;
  country: string;
  postalCode: string;
}): string[] {
  const missing: string[] = [];
  if (!addr.addressLine1) missing.push('addressLine1');
  if (!addr.city)         missing.push('city');
  if (!addr.country)      missing.push('country');
  if (!addr.postalCode)   missing.push('postalCode');
  return missing;
}

@Injectable()
export class ApplicantsService {
  constructor(
    private legacyPrisma: PrismaService,
    private email: EmailService,
    private storage: StorageService,
    private pilot: PilotPrismaAccessor,
    private tenantAuditLog: TenantAuditLogService,
    @Optional() private notifications?: NotificationsService,
  ) {}

  /** Spec §4.11 applicants emissions go to the staff group that
   *  reviews applicants — same set the documents module already uses
   *  for similar visibility. Recruiter / HR Manager / System Admin
   *  is the smallest superset that covers public-form submissions
   *  (Recruiters triage), approval decisions (HR Managers approve),
   *  and conversions (any of them might run them). The receiving end
   *  still gates by the `applicants:read` permission so this is the
   *  ceiling, not the floor. */
  private static readonly APPLICANT_NOTIFY_ROLES = ['System Admin', 'HR Manager', 'Recruiter'];

  private readonly logger = new Logger('ApplicantsService');

  private get prisma(): PrismaService {
    return this.pilot.client();
  }

  private scope(): PilotScope {
    return getPilotScope(this.pilot, 'applicants');
  }

  /**
   * Phase 2.28 — parent gate for child-of-applicant reads. Loads
   * the applicant through the pilot client with `tenantWhere()`.
   * Cross-tenant ids raise 404. Legacy mode reduces to plain by-id
   * lookup.
   */
  private async findApplicantOrFail(id: string) {
    const t = this.scope().tenantWhere();
    const a = await this.prisma.applicant.findFirst({ where: { id, deletedAt: null, ...t } }); // @tenant-reviewed: phase228-pilot-scope (parent gate)
    if (!a) throw new NotFoundException({ code: 'APPLICANT.NOT_FOUND', message: `Applicant ${id} not found`, params: { id } });
    return a;
  }

  /**
   * Phase 2.29 — agency tenant gate. Loads the agency through the
   * pilot client with `tenantWhere()`. Cross-tenant agency ids
   * raise 404 BEFORE any mutation that links applicant to agency
   * (convertLeadToCandidate, reassignAgency).
   */
  private async findAgencyOrFail(id: string) {
    const t = this.scope().tenantWhere();
    const a = await this.prisma.agency.findFirst({ where: { id, ...t } }); // @tenant-reviewed: phase229-pilot-scope (agency gate)
    if (!a) throw new NotFoundException({ code: 'AGENCY.NOT_FOUND', message: `Agency ${id} not found`, params: { id } });
    return a;
  }

  /**
   * Phase 2.31 — public-submit tenant attribution.
   *
   * Resolves the tenant id used to stamp a self-applied lead, in the
   * order documented in
   * `SAAS_PHASE231_APPLICANTS_PUBLIC_SUBMIT_ATTRIBUTION_DECISION.md`:
   *
   *   1. ALS frame from the request (host / subdomain resolved).
   *   2. Agency-derived: `agencyId` in the body resolves to an agency,
   *      and the agency carries `tenantId`.
   *   3. Otherwise rejected in pilot mode; legacy null in flag-off.
   *
   * If both (1) and (2) yield a tenant, they MUST agree.
   *
   * Returns `{ tenantId: null, source: 'legacy' }` when the pilot is
   * inactive, so the caller writes a row with no `tenantId` (today's
   * behaviour).
   */
  private async resolvePublicSubmitTenantId(
    payloadAgencyId: string | undefined,
  ): Promise<{ tenantId: string | null; source: 'als' | 'agency' | 'legacy' }> {
    // Pilot mode for public-submit attribution is gated on
    // `isPilotActive()` (flag + SAFE_CLONE/SAFE_STAGING) — NOT on
    // `scope().active`, because the public form often arrives
    // without an ALS frame, in which case `scope().active` is
    // false but we still want to derive the tenant from the
    // submitted agency.
    if (!this.pilot.isPilotActive() || !isModuleAllowed('applicants')) {
      // Legacy / non-pilot path. Public submissions land NULL-tenant
      // exactly as pre-2.31. The pilot-only error codes are
      // unreachable here.
      return { tenantId: null, source: 'legacy' };
    }
    // Pilot mode. ALS frame wins when present.
    const ctx = TenantContext.optional?.();
    const alsTenantId = ctx?.id ?? null;
    let agencyTenantId: string | null = null;
    if (payloadAgencyId) {
      // Agency resolution in pilot mode bypasses the per-tenant
      // filter when there is no ALS frame, because we are deriving
      // the tenant FROM the agency. When an ALS frame exists, we
      // still resolve through the (tenantWhere)-narrowed pilot
      // client so cross-tenant ids fall out as 404 cleanly.
      // Resolve the agency unfiltered so we can distinguish
      // "agency missing" from "agency belongs to a different
      // tenant". The tenancy decision is made explicitly below
      // by comparing `agency.tenantId` to the active ALS tenant.
      const agency = await this.legacyPrisma.agency.findFirst({ where: { id: payloadAgencyId } }); // @tenant-reviewed: phase231-public-submit-attribution
      if (!agency) {
        throw new NotFoundException({
          code: 'APPLICANT.PUBLIC_SUBMIT_AGENCY_NOT_FOUND',
          message: 'Agency not found for public submission',
        });
      }
      agencyTenantId = (agency as any).tenantId ?? null;
    }
    if (alsTenantId && agencyTenantId && alsTenantId !== agencyTenantId) {
      throw new BadRequestException({
        code: 'APPLICANT.PUBLIC_SUBMIT_TENANT_MISMATCH',
        message: 'Submitted agency belongs to a different tenant than the request host',
      });
    }
    const resolved = alsTenantId ?? agencyTenantId;
    if (!resolved) {
      throw new BadRequestException({
        code: 'APPLICANT.PUBLIC_SUBMIT_NO_TENANT',
        message: 'Public submission requires either a tenant host or a known agency',
      });
    }
    return { tenantId: resolved, source: alsTenantId ? 'als' : 'agency' };
  }

  /**
   * Resolve + validate the Job Ad an applicant is applying through.
   *
   * The Job Ad is the authoritative source of tenant ownership for any
   * applicant created from it — its `tenantId` is copied onto the new
   * Applicant/Lead (never taken from the request body). Loaded globally
   * (no tenant filter) precisely because the public flow has no tenant
   * context of its own; the ad itself supplies the tenant.
   *
   * @param requirePublished  true for public applications — you can only
   *   apply to a PUBLISHED, non-deleted ad. Staff (authenticated) flows
   *   may attach to any non-deleted ad in their own tenant.
   */
  private async resolveJobAdForApplication(
    jobAdId: string,
    opts?: { requirePublished?: boolean },
  ): Promise<{ id: string; tenantId: string | null; status: string }> {
    const jobAd = await this.legacyPrisma.jobAd.findFirst({ // @tenant-reviewed: phase231-jobad-tenant-source (ad is the tenant source for public apply)
      where: { id: jobAdId, deletedAt: null },
      select: { id: true, tenantId: true, status: true },
    });
    if (!jobAd) {
      throw new NotFoundException({
        code: 'JOB_AD.NOT_FOUND',
        message: 'This job posting is no longer available.',
      });
    }
    if (opts?.requirePublished !== false && jobAd.status !== 'PUBLISHED') {
      throw new BadRequestException({
        code: 'JOB_AD.NOT_OPEN',
        message: 'This job posting is not open for applications.',
      });
    }
    return jobAd as any;
  }


  private get include() {
    return {
      jobType: { select: { id: true, name: true } },
      agency: { select: { id: true, name: true, tenantId: true } },
      currentWorkflowStage: { select: { id: true, name: true, color: true, order: true } },
      jobAd: { select: { id: true, title: true, slug: true, city: true, country: true, status: true } },
      // Creator of the record — null for public (self-applied) submissions.
      createdBy: { select: { id: true, firstName: true, lastName: true, email: true } },
    };
  }

  /**
   * Compute the human-readable application source indicator for a row.
   *
   *   - jobAd  set                       → JOB_AD       — "Apply from Job Ad: <id> - <title>"
   *   - source === 'SELF_APPLIED'        → PUBLIC       — "Public Application"
   *   - source === 'STAFF_CREATED' / etc → INTERNAL     — "Internal Application"
   *
   * Returns both a machine-readable kind and a pre-formatted label so the
   * frontend can render the indicator without re-implementing the rule.
   */
  private buildApplicationSource(row: any): {
    kind: 'JOB_AD' | 'PUBLIC' | 'INTERNAL';
    label: string;
    jobAdId?: string;
    jobAdTitle?: string;
  } {
    if (row?.jobAd?.id) {
      return {
        kind: 'JOB_AD',
        label: `Apply from Job Ad: ${row.jobAd.id} - ${row.jobAd.title ?? ''}`.trim(),
        jobAdId: row.jobAd.id,
        jobAdTitle: row.jobAd.title ?? undefined,
      };
    }
    if (row?.source === 'SELF_APPLIED') {
      return { kind: 'PUBLIC', label: 'Public Application' };
    }
    return { kind: 'INTERNAL', label: 'Internal Application' };
  }

  private withApplicationSource<T>(row: T): T {
    if (!row) return row;
    (row as any).applicationSource = this.buildApplicationSource(row);
    return row;
  }

  private get includeWithRelations() {
    return {
      ...this.include,
      financialProfile: true,
      agencyHistory: { orderBy: { assignedAt: 'desc' as const }, take: 50 },
    };
  }

  // ── List ──────────────────────────────────────────────────────────────────────

  async findAll(filter: FilterApplicantsDto, actor?: { role: string; agencyId?: string; agencyIsSystem?: boolean }) {
    const { page = 1, limit = 20, search, sortBy = 'createdAt', sortOrder = 'desc',
            tier, status, agencyId, nationality, jobTypeId } = filter;
    const skip = (Number(page) - 1) * Number(limit);

    const t = this.scope().tenantWhere();
    const where: any = { deletedAt: null, ...t };

    // External tenants are scoped to their own agency across every
    // tier. The client-supplied tier filter flows through unchanged,
    // so Applicants (LEAD) and Candidates (CANDIDATE) both work for
    // tenant roles that hold applicants:read — Agency Manager and
    // other external roles alike.
    if (actor && this.isExternalActor(actor) && actor.agencyId) {
      where.agencyId = actor.agencyId;
    }
    if (tier) where.tier = tier;

    if (search) {
      where.OR = [
        { firstName: { contains: search, mode: 'insensitive' } },
        { lastName: { contains: search, mode: 'insensitive' } },
        { email: { contains: search, mode: 'insensitive' } },
        // Allow searching by lifecycle identifiers (e.g. "A20260400001", "C20260400001")
        { leadNumber: { contains: search, mode: 'insensitive' } },
        { candidateNumber: { contains: search, mode: 'insensitive' } },
      ];
    }
    if (status) where.status = status;
    if (agencyId && !this.isExternalActor(actor)) where.agencyId = agencyId;
    if (nationality) where.nationality = { contains: nationality, mode: 'insensitive' };
    if (jobTypeId) where.jobTypeId = jobTypeId;

    // SUPER USER tenant filter — platform admins only. For everyone else
    // filter.tenantId is ignored (their agency scoping above stands).
    await assertRequestedTenantExists(actor, filter.tenantId, this.legacyPrisma.tenant);
    const tenantPredicate = buildSuperUserTenantWhere(actor, filter.tenantId);
    if (tenantPredicate) where.AND = [...(where.AND ?? []), tenantPredicate];

    const validSort = ['firstName', 'lastName', 'email', 'status', 'tier', 'createdAt', 'nationality'];
    const orderField = validSort.includes(sortBy) ? sortBy : 'createdAt';

    const [items, total] = await Promise.all([
      this.prisma.applicant.findMany({ // @tenant-reviewed: phase228-pilot-scope
        where, skip, take: Number(limit),
        orderBy: { [orderField]: sortOrder },
        include: this.include,
      }),
      this.prisma.applicant.count({ where }), // @tenant-reviewed: phase228-pilot-scope
    ]);

    return PaginatedResponse.create(items.map((r: any) => this.withApplicationSource(r)), total, page, limit);
  }

  // ── Find One ──────────────────────────────────────────────────────────────────

  async findOne(id: string, actor?: { role: string; agencyId?: string; agencyIsSystem?: boolean }) {
    // findFirst (was findUnique) so we can compose tenant predicate.
    const t = this.scope().tenantWhere();
    const applicant = await this.prisma.applicant.findFirst({ // @tenant-reviewed: phase228-pilot-scope
      where: { id, deletedAt: null, ...t },
      include: this.includeWithRelations,
    });
    if (!applicant) throw new NotFoundException({ code: 'APPLICANT.NOT_FOUND', message: `Applicant ${id} not found`, params: { id } });

    // External tenants are scoped to their own agency — both tiers
    // (Leads and Candidates) are accessible as long as the row
    // belongs to the caller's agency.
    if (actor && this.isExternalActor(actor)) {
      if (actor.agencyId && applicant.agencyId && applicant.agencyId !== actor.agencyId) {
        throw new ForbiddenException({ code: 'AUTH.ACCESS_DENIED', message: 'Access denied' });
      }
    }

    return this.withApplicationSource(applicant);
  }

  // ── Create ────────────────────────────────────────────────────────────────────

  async create(dto: CreateApplicantDto & { tier?: string }, actorId?: string, actor?: { role: string; agencyId?: string; agencyIsSystem?: boolean; tenantId?: string | null }) {
    const isExternal = !!(actor && this.isExternalActor(actor));
    const isAgencySideRole = actor?.role === 'Agency User' || actor?.role === 'Agency Manager';
    // External tenants: the new record is always pinned to the
    // caller's agency. Tier defaults to LEAD (the same as admin
    // submissions) so Agency Manager can use both the Applicants and
    // Candidates surfaces; the client may explicitly send
    // tier=CANDIDATE if they want the record to land on the
    // Candidates queue directly. Agency-side submissions still enter
    // the Tempworks approval workflow below.
    if (isExternal && actor!.agencyId) {
      (dto as any).agencyId = actor!.agencyId;
    } else if ((dto as any).agencyId) {
      // Internal actor (System Admin / HR Manager / Recruiter) supplied
      // an explicit agency: it MUST belong to the active tenant.
      // findAgencyOrFail() raises 404 on cross-tenant ids so the bad
      // assignment never reaches the database.
      await this.findAgencyOrFail((dto as any).agencyId);
    }

    // Always generate a Lead identifier. Records that are born as a
    // Candidate (agency-side submissions) also get a Candidate
    // identifier up-front so the Candidates list never has to fall
    // back to showing the "A…" lead number.
    const leadNumber = await this.generateIdentifier('A');
    const bornAsCandidate = (dto.tier as any) === 'CANDIDATE';
    const candidateNumber = bornAsCandidate ? await this.generateIdentifier('C') : null;
    const candidateConvertedAt = bornAsCandidate ? new Date() : null;

    // Ensure nationality is always populated — mirror publicSubmit fallback logic
    const citizenship = (dto as any).citizenship || (dto as any).nationality;
    const nationality = (dto as any).nationality || citizenship;

    // Never trust a client-sent tenantId — it would otherwise leak through
    // the `...dto` spread when scope().tenantData() is empty (pilot off).
    delete (dto as any).tenantId;

    const tdata = this.scope().tenantData();

    // If this applicant is created from a Job Ad, the ad's tenant is
    // authoritative — the applicant must belong to the same tenant. A
    // staff member may not attach an applicant to a Job Ad from another
    // tenant unless they hold cross-tenant (platform) access.
    let jobAdTenantId: string | null | undefined;
    if ((dto as any).jobAdId) {
      const jobAd = await this.resolveJobAdForApplication((dto as any).jobAdId, { requirePublished: false });
      jobAdTenantId = jobAd.tenantId ?? null;
      const activeTenantId = (tdata as any).tenantId ?? null;
      if (jobAdTenantId && activeTenantId && jobAdTenantId !== activeTenantId && actor?.agencyIsSystem !== true) {
        throw new ForbiddenException({
          code: 'APPLICANT.JOB_AD_TENANT_MISMATCH',
          message: 'This job ad belongs to a different tenant.',
        });
      }
    }

    const applicant = await this.legacyPrisma.applicant.create({ // @tenant-reviewed: phase229-pilot-scope (tenant from scope.tenantData; jobAd tenant authoritative when present)
      data: {
        ...dto,
        citizenship,
        nationality,
        leadNumber,
        candidateNumber,
        candidateConvertedAt,
        tier: (dto.tier as any) || 'LEAD',
        dateOfBirth: dto.dateOfBirth ? new Date(dto.dateOfBirth) : undefined,
        workAuthorizationExpiry: dto.workAuthorizationExpiry ? new Date(dto.workAuthorizationExpiry) : undefined,
        preferredStartDate: dto.preferredStartDate ? new Date(dto.preferredStartDate) : undefined,
        status: dto.status || 'NEW',
        approvalStatus: isAgencySideRole ? ('PENDING_APPROVAL' as any) : ('APPROVED' as any),
        createdById: actorId ?? null,
        source: 'STAFF_CREATED',
        ...tdata,
        // Phase 1B (#23) — default the new applicant's tenant to the
        // caller's active tenant when the pilot scope didn't supply
        // one (covers SUPER creating from the dashboard while pilot is
        // off). Job Ad tenant still wins below.
        ...(!(tdata as any).tenantId && actor?.tenantId ? { tenantId: actor.tenantId } : {}),
        // Job Ad tenant wins over the ALS active tenant when present.
        ...(jobAdTenantId ? { tenantId: jobAdTenantId } : {}),
      } as any,
      include: this.include,
    });

    await this.auditLog(actorId, 'CREATE', applicant.id, { leadNumber });

    // Send confirmation email (fire-and-forget — never blocks response)
    const fullName = [dto.firstName, dto.lastName].filter(Boolean).join(' ');
    this.email.sendApplicationConfirmation(dto.email, fullName, leadNumber, (dto as any).applicationData ?? {}).catch(() => {});

    // Spec §4.11 — Applicants: when an agency-side role submits a
    // candidate, the row lands as PENDING_APPROVAL and the staff
    // approver needs to know. For internal staff creates we skip the
    // notification (the row is already APPROVED).
    if (isAgencySideRole) {
      this.notifications?.notifyUsersByRoles(
        ApplicantsService.APPLICANT_NOTIFY_ROLES,
        NOTIF_EVENTS.APPLICANT_AGENCY_PENDING,
        'Candidate pending approval',
        `${fullName || 'A candidate'} (${leadNumber}) was submitted by an agency and is awaiting approval.`,
        'APPLICANT',
        applicant.id,
        {
          titleKey: 'events.applicantAgencyPending.title',
          messageKey: 'events.applicantAgencyPending.body',
          params: { fullName, leadNumber },
        },
      ).catch(e => this.logger.error('Applicant agency-pending notification error:', e));
    }

    return applicant;
  }

  // ── Update ────────────────────────────────────────────────────────────────────

  async update(id: string, dto: UpdateApplicantDto, actorId?: string, actor?: { role: string; agencyId?: string; agencyIsSystem?: boolean }) {
    const existing = await this.findOne(id, actor);

    // Agency User/Manager can only edit candidates in their own agency
    if (actor && this.isExternalActor(actor)) {
      if (actor.agencyId && existing.agencyId !== actor.agencyId) {
        throw new ForbiddenException({ code: 'APPLICANT.AGENCY_SCOPE', message: 'You can only edit candidates in your own agency' });
      }
    }

    if (dto.email && dto.email !== existing.email) {
      const dup = await this.legacyPrisma.applicant.findFirst({ where: { email: dto.email, NOT: { id } } }); // @tenant-reviewed: phase228-global
      if (dup) throw new ConflictException({ code: 'APPLICANT.EMAIL_IN_USE', message: 'Email already in use' });
    }
    const updateData: any = { ...dto };
    if (dto.dateOfBirth) updateData.dateOfBirth = new Date(dto.dateOfBirth);
    if (dto.workAuthorizationExpiry) updateData.workAuthorizationExpiry = new Date(dto.workAuthorizationExpiry);
    if (dto.preferredStartDate) updateData.preferredStartDate = new Date(dto.preferredStartDate);

    // SUPER-only tenant reassignment (strips tenantId for everyone else).
    // On a tenant change, a foreign agency is dropped to keep the agency
    // consistent with the new tenant.
    await applySuperTenantReassignment(this.legacyPrisma, actorId, updateData, (existing as any).agencyId);

    // Edits by agency-side users re-arm the Tempworks approval gate:
    // the changes land immediately, but approvalStatus flips back to
    // PENDING_APPROVAL so existing gates (setCurrentStage,
    // convertToEmployee) block downstream actions until a Tempworks
    // admin re-approves. Other external roles (HR Manager in a
    // tenant agency) edit without re-arming, same as Tempworks-internal
    // staff.
    const isAgencySideRoleEdit = actor?.role === 'Agency User' || actor?.role === 'Agency Manager';
    if (actor && this.isExternalActor(actor) && isAgencySideRoleEdit) {
      updateData.approvalStatus = 'PENDING_APPROVAL';
      updateData.approvedById = null;
      updateData.approvedAt = null;
      updateData.rejectionReason = null;
    }

    const applicant = await this.legacyPrisma.applicant.update({ // @tenant-reviewed: phase229-pilot-scope-precheck
      where: { id }, data: updateData, include: this.include,
    });
    await this.auditLog(actorId, 'UPDATE', id, dto as any);

    // Spec §4.11 — Applicants: emit APPLICANT_PROFILE_COMPLETED the
    // FIRST time the row transitions from "core fields missing" to
    // "all core fields present". Re-emits are suppressed by checking
    // the pre-update completeness — a row that was already complete
    // before this update doesn't trigger again on routine edits.
    const wasComplete = ApplicantsService.hasCompleteCoreProfile(existing as any);
    const isComplete  = ApplicantsService.hasCompleteCoreProfile(applicant as any);
    if (!wasComplete && isComplete) {
      const displayName = [(applicant as any).firstName, (applicant as any).lastName].filter(Boolean).join(' ');
      this.notifications?.notifyUsersByRoles(
        ApplicantsService.APPLICANT_NOTIFY_ROLES,
        NOTIF_EVENTS.APPLICANT_PROFILE_COMPLETED,
        'Candidate profile completed',
        `${displayName || 'A candidate'} completed their profile.`,
        'APPLICANT',
        id,
        {
          titleKey: 'events.applicantProfileCompleted.title',
          messageKey: 'events.applicantProfileCompleted.body',
          params: { fullName: displayName },
        },
      ).catch(e => this.logger.error('Applicant profile-completed notification error:', e));
    }

    return applicant;
  }

  /** Core compliance fields that must be present for a candidate
   *  profile to be considered "complete". Used by the §4.11
   *  APPLICANT_PROFILE_COMPLETED trigger above. Kept conservative on
   *  purpose — adding required fields would re-fire the event for
   *  every existing applicant the first time they hit `update`. */
  private static hasCompleteCoreProfile(a: {
    firstName?: string | null;
    lastName?: string | null;
    email?: string | null;
    phone?: string | null;
    dateOfBirth?: Date | string | null;
    nationality?: string | null;
  } | null | undefined): boolean {
    if (!a) return false;
    const truthy = (v: any) => typeof v === 'string' ? v.trim().length > 0 : !!v;
    return truthy(a.firstName) && truthy(a.lastName) && truthy(a.email)
        && truthy(a.phone) && truthy(a.dateOfBirth) && truthy(a.nationality);
  }

  async uploadPhoto(id: string, file: Express.Multer.File) {
    // Phase 2.31 — storage guard. Resolve the applicant through the
    // pilot-aware parent gate BEFORE writing bytes to storage. In
    // legacy mode (`scope.active === false`) this still runs, but
    // the where-clause has no tenant predicate, so it reduces to a
    // tenant-agnostic by-id lookup and behaviour is byte-identical
    // to pre-2.31. In pilot mode, a cross-tenant id raises 404
    // BEFORE `storage.uploadFile` is called, so no orphan bytes
    // ever land for a foreign tenant.
    const t = this.scope().tenantWhere();
    const applicant = await this.prisma.applicant.findFirst({ // @tenant-reviewed: phase231-storage-guard
      where: { id, deletedAt: null, ...t },
      select: { firstName: true, lastName: true, photoUrl: true },
    });
    if (!applicant) throw new NotFoundException({ code: 'APPLICANT.NOT_FOUND', message: 'Applicant not found' });

    const upload = await this.storage.uploadFile(file.buffer, {
      keyPrefix: `applicants/${id}/photos`,
      contentType: file.mimetype,
      originalName: file.originalname,
      inline: true,
    });

    const updated = await this.legacyPrisma.applicant.update({ // @tenant-reviewed: phase228-excluded-mutation
      where: { id },
      data: { photoUrl: upload.url },
      include: this.include,
    });

    if (applicant.photoUrl && applicant.photoUrl !== upload.url) {
      await this.storage.deleteFileByUrlOrKey(applicant.photoUrl);
    }

    return updated;
  }

  // ── Update Status ─────────────────────────────────────────────────────────────

  async updateStatus(id: string, status: string, actorId?: string, actor?: { role: string; agencyId?: string; agencyIsSystem?: boolean }) {
    await this.findOne(id);
    const data: any = { status: status as any };
    // Status changes by agency-side users re-arm the approval gate;
    // tenant HR Managers and Tempworks-internal staff don't trigger it.
    const isAgencySideRole = actor?.role === 'Agency User' || actor?.role === 'Agency Manager';
    if (actor && this.isExternalActor(actor) && isAgencySideRole) {
      data.approvalStatus = 'PENDING_APPROVAL';
      data.approvedById = null;
      data.approvedAt = null;
      data.rejectionReason = null;
    }
    const applicant = await this.legacyPrisma.applicant.update({ // @tenant-reviewed: phase229-pilot-scope-precheck
      where: { id }, data, include: this.include,
    });
    await this.auditLog(actorId, 'STATUS_CHANGE', id, { status });
    return applicant;
  }

  // ── Remove ────────────────────────────────────────────────────────────────────

  async remove(id: string, actorId?: string, actor?: { role: string; agencyId?: string; agencyIsSystem?: boolean }) {
    if (actor && actor.role === 'Agency User') {
      throw new ForbiddenException({ code: 'APPLICANT.AGENCY_DELETE_REQUEST_REQUIRED', message: 'Agency users cannot directly delete candidates. Please submit a delete request.' });
    }
    await this.findOne(id);
    await this.legacyPrisma.applicant.update({ where: { id }, data: { deletedAt: new Date(), deletedBy: actorId ?? null } }); // @tenant-reviewed: phase229-pilot-scope-precheck
    await this.auditLog(actorId, 'DELETE', id);
    return { message: 'Applicant deleted' };
  }

  // ── Public Submit ─────────────────────────────────────────────────────────────

  async publicSubmit(dto: CreateApplicantDto & { applicationNotes?: string; recaptchaToken?: string }) {
    // ── Server-side reCAPTCHA v2 verification ──────────────────────────────────
    const secretKey = process.env.RECAPTCHA_SECRET_KEY;
    if (secretKey) {
      if (!dto.recaptchaToken) {
        throw new BadRequestException({ code: 'APPLICANT.CAPTCHA_REQUIRED', message: 'reCAPTCHA verification required' });
      }
      const verifyRes = await fetch('https://www.google.com/recaptcha/api/siteverify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: `secret=${encodeURIComponent(secretKey)}&response=${encodeURIComponent(dto.recaptchaToken)}`,
      });
      const verifyData = await verifyRes.json() as { success: boolean; 'error-codes'?: string[] };
      if (!verifyData.success) {
        throw new BadRequestException({ code: 'APPLICANT.CAPTCHA_FAILED', message: 'reCAPTCHA verification failed. Please try again.' });
      }
    }

    // Strip any client-sent tenantId: a public request must NEVER decide
    // its own tenant ownership (spoofing guard). Tenant is derived
    // server-side from the Job Ad (authoritative) or the resolved agency.
    const { applicationNotes, applicationData, recaptchaToken: _token, tenantId: _ignoredTenantId, ...coreData } = dto as any;

    // Derive backward-compat fields from rich applicationData if present
    const appData = applicationData ?? {};
    const residencyStatus = coreData.residencyStatus
      || (appData.workPermit?.hasWorkPermit === 'yes' ? 'Work Permit'
        : appData.euResidence?.hasResidence === 'yes' ? 'EU Residence'
        : appData.euVisa?.hasVisa === 'yes' ? 'EU Visa'
        : 'Other');
    const availability = coreData.availability
      || appData.additionalInfo?.earliestStartDate
      || 'Immediate';

    // citizenship ↔ nationality: prefer citizenship, fallback to nationality
    const citizenship = coreData.citizenship || coreData.nationality || appData.personal?.citizenship;
    const nationality = coreData.nationality || citizenship;

    // Tenant ownership resolution for the public application.
    //
    // RULE: if the applicant applies through a Job Ad, the Job Ad is the
    // authoritative tenant source — applicant.tenantId := jobAd.tenantId.
    // This holds regardless of pilot mode (it is a plain column copy) and
    // closes the bug where job-ad applicants landed with a null/foreign
    // tenant. Only when there is NO Job Ad do we fall back to the existing
    // ALS-host / agency attribution.
    let resolvedTenantId: string | null = null;
    let resolvedJobAdId: string | undefined = undefined;
    if (coreData.jobAdId) {
      const jobAd = await this.resolveJobAdForApplication(coreData.jobAdId, { requirePublished: true });
      resolvedJobAdId = jobAd.id;
      resolvedTenantId = jobAd.tenantId ?? null;
    } else {
      const attribution = await this.resolvePublicSubmitTenantId(coreData.agencyId);
      resolvedTenantId = attribution.tenantId;
    }

    // Generate Lead identifier for public submissions
    const leadNumber = await this.generateIdentifier('A');

    const applicant = await this.legacyPrisma.applicant.create({ // @tenant-reviewed: phase231-public-submit-attribution
      data: {
        ...coreData,
        leadNumber,
        citizenship,
        nationality,
        tier: 'LEAD',
        status: 'NEW',
        residencyStatus,
        availability,
        hasDrivingLicense: coreData.hasDrivingLicense ?? (appData.drivingLicense?.hasDrivingLicense === 'yes'),
        dateOfBirth: coreData.dateOfBirth ? new Date(coreData.dateOfBirth) : undefined,
        workAuthorizationExpiry: coreData.workAuthorizationExpiry ? new Date(coreData.workAuthorizationExpiry) : undefined,
        preferredStartDate: (coreData.preferredStartDate || appData.additionalInfo?.earliestStartDate)
          ? new Date(coreData.preferredStartDate || appData.additionalInfo.earliestStartDate)
          : undefined,
        applicationData: appData,
        notes: coreData.notes || (applicationNotes ? `[Submitted] ${applicationNotes}` : undefined),
        // Flag this record as filled out by the applicant themself via
        // the public /apply form. createdById stays null (no staff
        // user is responsible); the profile UI keys off `source` to
        // show a "Self-applied" badge instead of a creator name.
        source: 'SELF_APPLIED',
        // Link to the validated Job Ad (overrides any body-sent value).
        ...(resolvedJobAdId ? { jobAdId: resolvedJobAdId } : {}),
        ...(resolvedTenantId ? { tenantId: resolvedTenantId } : {}),
      } as any,
      include: this.include,
    });

    // Send confirmation email (fire-and-forget — never blocks submit)
    const fullName = [coreData.firstName, coreData.lastName].filter(Boolean).join(' ');
    this.email.sendApplicationConfirmation(coreData.email, fullName, leadNumber, appData).catch(() => {});

    // Spec §4.11 — Applicants: a new lead came in from the public
    // apply form. No uploader id (the submitter isn't authenticated),
    // so we pass an empty string and let the role-fanout do the work.
    this.notifications?.notifyUsersByRoles(
      ApplicantsService.APPLICANT_NOTIFY_ROLES,
      NOTIF_EVENTS.APPLICANT_NEW_LEAD,
      'New Lead Received',
      `${fullName || 'A new applicant'} submitted an application (${leadNumber}).`,
      'APPLICANT',
      applicant.id,
      {
        titleKey: 'events.applicantNewLead.title',
        messageKey: 'events.applicantNewLead.body',
        params: { fullName, leadNumber },
      },
    ).catch(e => this.logger.error('Applicant new-lead notification error:', e));

    return this.withApplicationSource(applicant);
  }

  // ── Assign Owner ───────────────────────────────────────────────────────────
  //
  // §4.11 Notifications — APPLICANT_ASSIGNED_TO_ME. Recruiters claim
  // a candidate; the new owner gets the in-app + email notification.
  // Idempotent: re-assigning to the same owner is silent. Passing
  // null clears the assignment and emits nothing (the previous owner
  // already had the candidate in their inbox).

  async assignOwner(id: string, ownerUserId: string | null, actorId?: string) {
    const existing = await this.findOne(id);
    const previousOwnerId = (existing as any).ownerUserId as string | null;
    if (previousOwnerId === ownerUserId) {
      // No-op. Return the row as-is so the caller's PATCH-then-GET
      // pattern still works.
      return existing;
    }

    // Validate the new owner exists when not clearing.
    if (ownerUserId) {
      const owner = await this.legacyPrisma.user.findFirst({
        where: { id: ownerUserId, deletedAt: null, status: 'ACTIVE' },
        select: { id: true },
      });
      if (!owner) {
        throw new BadRequestException({
          code: 'APPLICANT.OWNER_NOT_FOUND',
          message: 'The selected owner user does not exist or is inactive',
        });
      }
    }

    const updated = await this.legacyPrisma.applicant.update({ // @tenant-reviewed: phase229-pilot-scope-precheck (findOne above gates the parent)
      where: { id },
      data: { ownerUserId } as any,
      include: this.include,
    });
    await this.auditLog(actorId, 'ASSIGN_OWNER', id, { previousOwnerId, ownerUserId });

    // Emit only when a new owner was set — clears don't notify.
    if (ownerUserId) {
      const candidateName = [(updated as any).firstName, (updated as any).lastName].filter(Boolean).join(' ');
      this.notifications?.notifyUsers(
        [ownerUserId],
        NOTIF_EVENTS.APPLICANT_ASSIGNED_TO_ME,
        'Candidate assigned to you',
        `${candidateName || 'A candidate'} was assigned to you.`,
        'APPLICANT',
        id,
        {
          titleKey: 'events.applicantAssignedToMe.title',
          messageKey: 'events.applicantAssignedToMe.body',
          params: { candidateName },
        },
      ).catch(e => this.logger.error('Applicant assigned-to-me notification error:', e));
    }

    return updated;
  }

  // ── Set Workflow Stage ────────────────────────────────────────────────────────

  async setCurrentStage(id: string, stageId: string | null, actorId?: string) {
    const applicant = await this.findOne(id);
    // Cannot move an agency-submitted candidate into the workflow until
    // Tempworks has approved them.
    if ((applicant as any).approvalStatus === 'PENDING_APPROVAL' && stageId) {
      throw new BadRequestException({ code: 'APPLICANT.PENDING_APPROVAL_WORKFLOW', message: 'This candidate is pending Tempworks approval and cannot enter the workflow yet' });
    }
    if (stageId) {
      const stage = await this.legacyPrisma.stageTemplate.findUnique({ where: { id: stageId } }); // @tenant-reviewed: phase228-global
      if (!stage) throw new NotFoundException({ code: 'WORKFLOW.STAGE_NOT_FOUND', message: 'Workflow stage not found' });
    }
    const updated = await this.legacyPrisma.applicant.update({ // @tenant-reviewed: phase229-pilot-scope-precheck
      where: { id },
      data: { currentWorkflowStageId: stageId },
      include: this.include,
    });
    await this.auditLog(actorId, 'WORKFLOW_STAGE_UPDATE', id, { currentWorkflowStageId: stageId });
    return updated;
  }

  // ── Agency-submitted candidate approval ──────────────────────────────────────

  async approveApplicant(id: string, actorId?: string) {
    const applicant = await this.findOne(id);
    if ((applicant as any).approvalStatus === 'APPROVED') return applicant;
    const updated = await this.legacyPrisma.applicant.update({ // @tenant-reviewed: phase229-pilot-scope-precheck
      where: { id },
      data: {
        approvalStatus: 'APPROVED' as any,
        approvedById: actorId ?? null,
        approvedAt: new Date(),
        rejectionReason: null,
      },
      include: this.include,
    });
    await this.auditLog(actorId, 'APPROVE_CANDIDATE', id);

    // Spec §4.11 — Applicants: the submitting agency / recruiter is
    // notified of the approval decision so they can act on the next
    // step (e.g. assign to a workflow).
    const displayName = [(updated as any).firstName, (updated as any).lastName].filter(Boolean).join(' ');
    this.notifications?.notifyUsersByRoles(
      ApplicantsService.APPLICANT_NOTIFY_ROLES,
      NOTIF_EVENTS.APPLICANT_APPROVAL_DECISION,
      'Candidate approved',
      `${displayName || 'A candidate'} was approved.`,
      'APPLICANT',
      id,
      {
        titleKey: 'events.applicantApproved.title',
        messageKey: 'events.applicantApproved.body',
        params: { fullName: displayName },
      },
    ).catch(e => this.logger.error('Applicant approval notification error:', e));

    return updated;
  }

  async rejectApplicant(id: string, reason: string | undefined, actorId?: string) {
    const applicant = await this.findOne(id);
    const updated = await this.legacyPrisma.applicant.update({ // @tenant-reviewed: phase229-pilot-scope-precheck
      where: { id },
      data: {
        approvalStatus: 'REJECTED' as any,
        approvedById: actorId ?? null,
        approvedAt: new Date(),
        rejectionReason: reason ?? null,
      },
      include: this.include,
    });
    await this.auditLog(actorId, 'REJECT_CANDIDATE', id, { reason });

    // Spec §4.11 — Applicants: same APPLICANT_APPROVAL_DECISION
    // event covers reject; the recipient sees the verdict + reason in
    // the message body so they can follow up.
    const displayName = [(updated as any).firstName, (updated as any).lastName].filter(Boolean).join(' ');
    this.notifications?.notifyUsersByRoles(
      ApplicantsService.APPLICANT_NOTIFY_ROLES,
      NOTIF_EVENTS.APPLICANT_APPROVAL_DECISION,
      'Candidate rejected',
      reason
        ? `${displayName || 'A candidate'} was rejected: ${reason}`
        : `${displayName || 'A candidate'} was rejected.`,
      'APPLICANT',
      id,
      {
        titleKey: 'events.applicantRejected.title',
        messageKey: 'events.applicantRejected.body',
        params: { fullName: displayName, reason: reason ?? '' },
      },
    ).catch(e => this.logger.error('Applicant rejection notification error:', e));

    return updated;
  }

  // ── Convert Lead → Candidate ──────────────────────────────────────────────────

  async convertLeadToCandidate(id: string, dto: ConvertLeadDto, actorId?: string) {
    const applicant = await this.findOne(id);
    if (applicant.tier === 'CANDIDATE') {
      throw new ConflictException({ code: 'APPLICANT.ALREADY_CANDIDATE', message: 'Applicant is already a Candidate' });
    }

    // Guard: candidateNumber should never already be set (double-conversion protection)
    if ((applicant as any).candidateNumber) {
      throw new ConflictException({ code: 'APPLICANT.CANDIDATE_ID_ASSIGNED', message: 'A Candidate identifier has already been assigned to this applicant' });
    }

    // Resolve target agency: use provided agencyId, or system default, or keep existing
    let targetAgencyId: string | undefined = dto.agencyId ?? undefined;

    if (!targetAgencyId) {
      // Try to load default holding agency from SystemSetting
      const setting = await this.legacyPrisma.systemSetting.findUnique({ // @tenant-reviewed: phase228-global
        where: { key: 'applicants.defaultHoldingAgencyId' },
      });
      if (setting?.value) targetAgencyId = setting.value;
    }

    const prevAgencyId = applicant.agencyId;

    // Phase 2.34 — validate target agency BEFORE the update so a
    // cross-tenant id (DTO-supplied or systemSetting fallback) fails
    // closed and never persists. Pre-2.34 the check ran AFTER the
    // update, so an invalid id left the applicant pointing at a
    // foreign agency before the 404 surfaced. Skip the gate when the
    // value is unchanged — prevAgencyId is already in-tenant.
    if (targetAgencyId && targetAgencyId !== prevAgencyId) {
      await this.findAgencyOrFail(targetAgencyId);
    }
    const prevAgencyName = (applicant.agency as any)?.name ?? 'None';
    const prevLeadNumber = (applicant as any).leadNumber ?? null;

    // Generate Candidate identifier and record the exact conversion timestamp
    const candidateNumber = await this.generateIdentifier('C');
    const candidateConvertedAt = new Date();

    const updated = await this.legacyPrisma.applicant.update({ // @tenant-reviewed: phase229-pilot-scope-precheck
      where: { id },
      data: {
        tier: 'CANDIDATE',
        candidateNumber,
        candidateConvertedAt,
        ...(targetAgencyId ? { agencyId: targetAgencyId } : {}),
      },
      include: this.includeWithRelations,
    });

    // Record agency history if agency changed
    if (targetAgencyId && targetAgencyId !== prevAgencyId) {
      // Phase 2.29 — agency tenant gate. Cross-tenant agency raises 404.
      const newAgency = await this.findAgencyOrFail(targetAgencyId);
      // Close previous assignment
      if (prevAgencyId) {
        await this.legacyPrisma.applicantAgencyHistory.updateMany({ // @tenant-reviewed: phase229-pilot-scope-precheck
          where: { applicantId: id, removedAt: null },
          data: { removedAt: new Date() },
        });
      }
      // Open new assignment
      await this.legacyPrisma.applicantAgencyHistory.create({ // @tenant-reviewed: phase229-pilot-scope-precheck
        data: {
          id: this.uuid(),
          applicantId: id,
          agencyId: targetAgencyId,
          agencyName: newAgency?.name ?? 'Unknown',
          assignedById: actorId,
          reason: 'Lead converted to Candidate',
          notes: dto.notes,
        },
      });
    }

    await this.auditLog(actorId, 'CONVERT_LEAD_TO_CANDIDATE', id, {
      oldTier: 'LEAD', newTier: 'CANDIDATE',
      oldIdentifier: prevLeadNumber, newIdentifier: candidateNumber,
      candidateConvertedAt: candidateConvertedAt.toISOString(),
      oldAgencyId: prevAgencyId, newAgencyId: targetAgencyId,
    });

    // Spec §4.11 — Applicants: lead promoted to candidate. The new
    // candidate has a fresh business id (candidateNumber) so we put
    // both old and new identifiers in the params for the i18n message.
    const displayName = [(updated as any).firstName, (updated as any).lastName].filter(Boolean).join(' ');
    this.notifications?.notifyUsersByRoles(
      ApplicantsService.APPLICANT_NOTIFY_ROLES,
      NOTIF_EVENTS.APPLICANT_LEAD_CONVERTED,
      'Lead converted',
      `${displayName || 'A lead'} was converted to a candidate (${candidateNumber}).`,
      'APPLICANT',
      id,
      {
        titleKey: 'events.applicantLeadConverted.title',
        messageKey: 'events.applicantLeadConverted.body',
        params: {
          fullName: displayName,
          leadNumber: prevLeadNumber ?? '',
          candidateNumber,
        },
      },
    ).catch(e => this.logger.error('Applicant lead-converted notification error:', e));

    return updated;
  }

  // ── Reassign Agency ───────────────────────────────────────────────────────────

  async reassignAgency(id: string, dto: AssignAgencyDto, actorId?: string, actor?: { role: string; agencyId?: string; agencyIsSystem?: boolean }) {
    if (actor && this.isExternalActor(actor)) {
      throw new ForbiddenException({ code: 'APPLICANT.AGENCY_CHANGE_FORBIDDEN', message: 'Agency users cannot change a candidate\'s agency.' });
    }

    const applicant = await this.findOne(id);

    // Phase 2.29 — agency tenant gate.
    const newAgency = await this.findAgencyOrFail(dto.agencyId);

    const prevAgencyId = applicant.agencyId;

    // Close previous open history entry
    if (prevAgencyId) {
      await this.legacyPrisma.applicantAgencyHistory.updateMany({ // @tenant-reviewed: phase229-pilot-scope-precheck
        where: { applicantId: id, removedAt: null },
        data: { removedAt: new Date() },
      });
    }

    // Record new assignment
    await this.legacyPrisma.applicantAgencyHistory.create({ // @tenant-reviewed: phase229-pilot-scope-precheck
      data: {
        id: this.uuid(),
        applicantId: id,
        agencyId: dto.agencyId,
        agencyName: newAgency.name,
        assignedById: actorId,
        reason: dto.reason,
        notes: dto.notes,
      },
    });

    const updated = await this.legacyPrisma.applicant.update({ // @tenant-reviewed: phase229-pilot-scope-precheck
      where: { id },
      data: { agencyId: dto.agencyId },
      include: this.includeWithRelations,
    });

    await this.auditLog(actorId, 'REASSIGN_AGENCY', id, {
      oldAgencyId: prevAgencyId, newAgencyId: dto.agencyId, reason: dto.reason,
    });

    return updated;
  }

  // ── Financial Profile ─────────────────────────────────────────────────────────

  async getFinancialProfile(id: string) {
    await this.findOne(id);
    const profile = await this.prisma.applicantFinancialProfile.findUnique({ // @tenant-reviewed: phase228-pilot-scope-precheck
      where: { applicantId: id },
    });
    return profile ?? null;
  }

  async upsertFinancialProfile(id: string, dto: UpsertFinancialProfileDto, actorId?: string) {
    const applicant = await this.findOne(id);
    if (applicant.tier !== 'CANDIDATE') {
      throw new ForbiddenException({ code: 'APPLICANT.FINANCE_CANDIDATE_ONLY', message: 'Financial profile is only available for Candidates' });
    }

    const data: any = { ...dto };
    if (dto.salaryAgreed !== undefined) data.salaryAgreed = dto.salaryAgreed;

    const profile = await this.legacyPrisma.applicantFinancialProfile.upsert({ // @tenant-reviewed: phase229-pilot-scope-precheck
      where: { applicantId: id },
      update: data,
      create: { id: this.uuid(), applicantId: id, ...data },
    });

    await this.auditLog(actorId, 'UPSERT_FINANCIAL_PROFILE', id, dto as any);
    return profile;
  }

  // ── Agency History ────────────────────────────────────────────────────────────

  async getAgencyHistory(id: string) {
    await this.findOne(id);
    return this.prisma.applicantAgencyHistory.findMany({ // @tenant-reviewed: phase228-pilot-scope-precheck
      where: { applicantId: id },
      orderBy: { assignedAt: 'desc' },
    });
  }

  // ── Bulk Actions ──────────────────────────────────────────────────────────────

  async bulkAction(dto: BulkActionDto, actorId?: string, actor?: { role: string; agencyId?: string; agencyIsSystem?: boolean }) {
    const { ids, action, value, agencyId } = dto;
    const results: { id: string; success: boolean; error?: string; employeeId?: string; candidateNumber?: string; employeeNumber?: string }[] = [];

    // Phase 2.29 — BULK FILTER. Pre-filter the requested id list by
    // the active tenant BEFORE the per-id loop. In legacy mode the
    // spread is `{}` and the lookup matches the whole list (modulo
    // soft-deleted rows). In pilot mode foreign-tenant ids are
    // silently dropped — same shape as documents 2.22 download-guard.
    const t = this.scope().tenantWhere();
    const allowed = await this.prisma.applicant.findMany({ // @tenant-reviewed: phase229-bulk-filter (drops cross-tenant ids before mutation loop)
      where: { id: { in: ids }, deletedAt: null, ...t },
      select: { id: true },
    });
    const allowedIds = new Set(allowed.map((a: any) => a.id));
    const filtered = ids.filter((id: string) => allowedIds.has(id));

    // Phase 2.34 — pre-validate the target agency once for
    // ASSIGN_AGENCY so a cross-tenant id is rejected for the whole
    // batch instead of silently corrupting every row in the loop.
    if (action === BulkActionType.ASSIGN_AGENCY) {
      const targetAgencyId = agencyId ?? value;
      if (!targetAgencyId) {
        throw new BadRequestException({
          code: 'APPLICANT.BULK_ASSIGN_AGENCY_REQUIRED',
          message: 'agencyId is required for ASSIGN_AGENCY',
        });
      }
      await this.findAgencyOrFail(String(targetAgencyId));
    }

    for (const id of filtered) {
      try {
        switch (action) {
          case BulkActionType.STATUS_CHANGE:
            if (!value) throw new Error('value is required for STATUS_CHANGE');
            await this.legacyPrisma.applicant.update({ where: { id }, data: { status: value as any } }); // @tenant-reviewed: phase229-pilot-scope-precheck
            await this.auditLog(actorId, 'BULK_STATUS_CHANGE', id, { status: value });
            results.push({ id, success: true });
            break;

          case BulkActionType.TIER_CHANGE:
            if (value !== 'LEAD' && value !== 'CANDIDATE') throw new Error('Invalid tier');
            if (value === 'CANDIDATE') {
              // Promotion — route through convertLeadToCandidate so the
              // Candidate identifier, agency history, and full audit
              // trail are produced exactly like the single-action path.
              const updated = await this.convertLeadToCandidate(
                id,
                { agencyId: agencyId, notes: 'Bulk promotion' } as any,
                actorId,
              );
              results.push({
                id,
                success: true,
                candidateNumber: (updated as any).candidateNumber ?? undefined,
              });
            } else {
              // Demotion back to LEAD — rare, just flips the flag.
              await this.legacyPrisma.applicant.update({ where: { id }, data: { tier: 'LEAD' as any } }); // @tenant-reviewed: phase229-pilot-scope-precheck
              await this.auditLog(actorId, 'BULK_TIER_CHANGE', id, { tier: 'LEAD' });
              results.push({ id, success: true });
            }
            break;

          case BulkActionType.ASSIGN_AGENCY: {
            // Target agency already validated above against the active
            // tenant — safe to use directly here.
            const targetAgencyId = String((agencyId ?? value)!);
            await this.legacyPrisma.applicant.update({ where: { id }, data: { agencyId: targetAgencyId } }); // @tenant-reviewed: phase229-pilot-scope-precheck
            await this.auditLog(actorId, 'BULK_ASSIGN_AGENCY', id, { agencyId: targetAgencyId });
            results.push({ id, success: true });
            break;
          }

          case BulkActionType.CONVERT_TO_EMPLOYEE: {
            // Candidate→Employee in bulk. convertToEmployee requires
            // address + emergency fields; derive what we can from the
            // applicant's applicationData blob so operators don't have
            // to re-enter per row. If the mandatory fields still aren't
            // available we report the row as failed and keep going.
            const applicant = await this.legacyPrisma.applicant.findFirst({ where: { id, deletedAt: null } }); // @tenant-reviewed: phase229-pilot-scope-precheck
            if (!applicant) throw new Error('Applicant not found');
            if (applicant.tier !== 'CANDIDATE') {
              throw new Error('Only Candidates can be converted to employees');
            }
            const ad: any = (applicant as any).applicationData ?? {};
            const extracted = extractApplicantAddressForConversion(ad);
            const missing = missingAddressFields(extracted);
            if (missing.length > 0) {
              // Phase 3 (#26) — actionable, per-row error. The previous
              // "convert this one individually" hint was misleading
              // because the individual dialog defaulted to empty fields
              // and would fail the same way once submitted. We now name
              // the candidate and the missing fields so the operator
              // can open the candidate, fill the address, and retry.
              const name = `${(applicant as any).firstName ?? ''} ${(applicant as any).lastName ?? ''}`.trim()
                || (applicant as any).candidateNumber || id;
              throw new Error(`Candidate "${name}" is missing address fields: ${missing.join(', ')}. Open the candidate profile to complete the address, then retry.`);
            }
            const emergencyContact = [ad.emergencyFirstName, ad.emergencyLastName].filter(Boolean).join(' ') || undefined;
            const emergencyPhone = [ad.emergencyPhoneCode, ad.emergencyPhone].filter(Boolean).join(' ').trim() || undefined;

            const dtoForConvert: any = {
              addressLine1: extracted.addressLine1,
              addressLine2: extracted.addressLine2 || undefined,
              city: extracted.city,
              country: extracted.country,
              postalCode: extracted.postalCode,
              licenseNumber: ad.licenseNumber ?? undefined,
              licenseCategory: Array.isArray(ad.licenseCategories) && ad.licenseCategories.length > 0
                ? ad.licenseCategories.join(',')
                : undefined,
              yearsExperience: Number(ad.euExpYears ?? ad.domesticExpYears ?? 0) || 0,
              emergencyContact,
              emergencyPhone,
            };
            // If agencyId override supplied on the bulk DTO, pin the
            // applicant to it before conversion so the employee row
            // inherits the new agency.
            if (agencyId && applicant.agencyId !== agencyId) {
              await this.legacyPrisma.applicant.update({ where: { id }, data: { agencyId } }); // @tenant-reviewed: phase229-pilot-scope-precheck
            }
            const { employee, employeeNumber } = await this.convertToEmployee(id, dtoForConvert, actorId, actor);
            results.push({ id, success: true, employeeId: (employee as any).id, employeeNumber });
            break;
          }

          case BulkActionType.DELETE:
            await this.legacyPrisma.applicant.update({ where: { id }, data: { deletedAt: new Date(), deletedBy: actorId ?? null } }); // @tenant-reviewed: phase229-pilot-scope-precheck
            await this.auditLog(actorId, 'BULK_DELETE', id);
            results.push({ id, success: true });
            break;
        }
      } catch (err: any) {
        results.push({ id, success: false, error: err.message });
      }
    }

    // Spec §4.11 — SYSTEM_BULK_JOB_RESULT auto-emit. Mirrors the
    // pipeline bulk-assign and users bulk-import emissions; admins
    // see the rollup immediately. Failed rows trip HIGH so the inbox
    // surfaces the partial failure above routine NORMAL traffic.
    const succeeded = results.filter(r => r.success).length;
    const failed = results.length - succeeded;
    const ok = failed === 0;
    this.notifications?.notifyUsersByRoles(
      ApplicantsService.APPLICANT_NOTIFY_ROLES,
      NOTIF_EVENTS.SYSTEM_BULK_JOB_RESULT,
      ok ? `Bulk applicant ${dto.action.toLowerCase()} completed` : `Bulk applicant ${dto.action.toLowerCase()} finished with errors`,
      `${succeeded} succeeded, ${failed} failed out of ${ids.length}.`,
      'APPLICANT',
      'bulk',
      {
        titleKey: 'events.systemBulkJobResult.title',
        messageKey: 'events.systemBulkJobResult.body',
        params: { jobId: `bulk-applicant:${dto.action}`, success: ok, succeeded, failed, total: ids.length },
      },
    ).catch(() => undefined);

    return { processed: ids.length, results };
  }

  // ── CSV Export ────────────────────────────────────────────────────────────────

  async exportCsv(
    filter: FilterApplicantsDto,
    actor?: { role: string; agencyId?: string; agencyIsSystem?: boolean },
    ids?: string[],
  ): Promise<string> {
    // If specific ids were requested, scope the query to just those rows
    // (filters are ignored — this is the 'Export Selected' path). The
    // agency/tier guards in findOne still apply.
    let items: any[];
    const t = this.scope().tenantWhere();
    if (ids && ids.length > 0) {
      const where: any = { id: { in: ids }, deletedAt: null, ...t };
      if (actor && this.isExternalActor(actor) && actor.agencyId) {
        where.agencyId = actor.agencyId;
      }
      items = await this.prisma.applicant.findMany({ // @tenant-reviewed: phase228-pilot-scope
        where,
        include: this.include,
        orderBy: { createdAt: 'desc' },
      });
    } else {
      // Fetch all matching records (no pagination limit)
      const bigFilter = { ...filter, limit: 10000, page: 1 };
      const result = await this.findAll(bigFilter as FilterApplicantsDto, actor);
      items = result.data;
    }

    const headers = [
      'ID', 'Lead Number', 'Candidate Number', 'Tier',
      'First Name', 'Last Name', 'Email', 'Phone', 'Citizenship',
      'Status', 'Job Type', 'Agency', 'Residency Status', 'Has NI', 'NI Number',
      'Has Work Auth', 'Work Auth Type', 'Availability', 'Salary Expectation',
      'Preferred Start Date', 'Created At',
    ];

    // RFC 4180 quoting: always quote strings that contain a comma, quote,
    // CR or LF; escape embedded quotes by doubling them.
    const escape = (v: any) => {
      const s = v == null ? '' : String(v);
      if (/[",\r\n]/.test(s)) {
        return `"${s.replace(/"/g, '""')}"`;
      }
      return s;
    };

    const rows = items.map(a => [
      a.id, a.leadNumber ?? '', a.candidateNumber ?? '', a.tier,
      a.firstName, a.lastName, a.email, a.phone, a.nationality,
      a.status, a.jobType?.name ?? '', a.agency?.name ?? '',
      a.residencyStatus, a.hasNationalInsurance, a.nationalInsuranceNumber ?? '',
      a.hasWorkAuthorization, a.workAuthorizationType ?? '',
      a.availability, a.salaryExpectation ?? '',
      a.preferredStartDate ? new Date(a.preferredStartDate).toISOString().split('T')[0] : '',
      new Date(a.createdAt).toISOString().split('T')[0],
    ].map(escape).join(','));

    // Prepend:
    //  - UTF-8 BOM so Excel opens the file as UTF-8 (otherwise accented
    //    characters break and, on some locales, Excel dumps everything
    //    into a single column).
    //  - CRLF line endings (RFC 4180 and what Excel expects).
    const BOM = '\uFEFF';
    return BOM + [headers.join(','), ...rows].join('\r\n') + '\r\n';
  }

  // ── XLSX Export ───────────────────────────────────────────────────────────────
  //
  // Mirrors exportCsv's scoping rules (ids → selected-only; otherwise
  // the filtered list) but writes a proper .xlsx using ExcelJS: real
  // column widths, frozen header row, Date cells that Excel formats
  // natively, and human-friendly Yes/No for boolean columns. Powers the
  // "Export to Excel" button on the Applicants and Candidates pages.
  async exportExcel(
    filter: FilterApplicantsDto,
    actor?: { role: string; agencyId?: string; agencyIsSystem?: boolean },
    ids?: string[],
    locale: ServerLocale = 'en',
  ): Promise<Buffer> {
    let items: any[];
    const t = this.scope().tenantWhere();
    if (ids && ids.length > 0) {
      const where: any = { id: { in: ids }, deletedAt: null, ...t };
      if (actor && this.isExternalActor(actor) && actor.agencyId) {
        where.agencyId = actor.agencyId;
      }
      items = await this.prisma.applicant.findMany({ // @tenant-reviewed: phase228-pilot-scope
        where,
        include: this.include,
        orderBy: { createdAt: 'desc' },
      });
    } else {
      const bigFilter = { ...filter, limit: 10000, page: 1 };
      const result = await this.findAll(bigFilter as FilterApplicantsDto, actor);
      items = result.data;
    }

    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'TempWorks';
    workbook.created = new Date();

    const col = (key: string) => tServer(`applicants.columns.${key}`, {}, locale, 'exports');
    const sheet = workbook.addWorksheet(
      tServer('applicants.sheetName', {}, locale, 'exports'),
      { views: [{ state: 'frozen', ySplit: 1 }] },
    );

    sheet.columns = [
      { header: col('id'),                 key: 'id',                  width: 36 },
      { header: col('leadNumber'),         key: 'leadNumber',          width: 18 },
      { header: col('candidateNumber'),    key: 'candidateNumber',     width: 18 },
      { header: col('tier'),               key: 'tier',                width: 12 },
      { header: col('firstName'),          key: 'firstName',           width: 16 },
      { header: col('lastName'),           key: 'lastName',            width: 16 },
      { header: col('email'),              key: 'email',               width: 28 },
      { header: col('phone'),              key: 'phone',               width: 18 },
      { header: col('citizenship'),        key: 'citizenship',         width: 16 },
      { header: col('status'),             key: 'status',              width: 14 },
      { header: col('jobType'),            key: 'jobType',             width: 22 },
      { header: col('agency'),             key: 'agency',              width: 22 },
      { header: col('residencyStatus'),    key: 'residencyStatus',     width: 18 },
      { header: col('hasNi'),              key: 'hasNi',               width: 10 },
      { header: col('niNumber'),           key: 'niNumber',            width: 16 },
      { header: col('hasWorkAuth'),        key: 'hasWorkAuth',         width: 14 },
      { header: col('workAuthType'),       key: 'workAuthType',        width: 20 },
      { header: col('availability'),       key: 'availability',        width: 16 },
      { header: col('salaryExpectation'),  key: 'salaryExpectation',   width: 18 },
      { header: col('preferredStartDate'), key: 'preferredStartDate',  width: 18, style: { numFmt: 'yyyy-mm-dd' } },
      { header: col('createdAt'),          key: 'createdAt',           width: 18, style: { numFmt: 'yyyy-mm-dd' } },
    ];

    sheet.getRow(1).eachCell((cell) => {
      cell.font      = { bold: true, color: { argb: 'FFFFFFFF' } };
      cell.fill      = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF2563EB' } };
      cell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
      cell.border    = { bottom: { style: 'thin', color: { argb: 'FF1D4ED8' } } };
    });
    sheet.getRow(1).height = 28;

    const yesNo = (v: any) => (v === true ? 'Yes' : v === false ? 'No' : '');

    for (const a of items) {
      sheet.addRow({
        id:                 a.id ?? '',
        leadNumber:         a.leadNumber ?? '',
        candidateNumber:    a.candidateNumber ?? '',
        tier:               a.tier ?? '',
        firstName:          a.firstName ?? '',
        lastName:           a.lastName ?? '',
        email:              a.email ?? '',
        phone:              a.phone ?? '',
        citizenship:        a.nationality ?? '',
        status:             a.status ?? '',
        jobType:            a.jobType?.name ?? '',
        agency:             a.agency?.name ?? '',
        residencyStatus:    a.residencyStatus ?? '',
        hasNi:              yesNo(a.hasNationalInsurance),
        niNumber:           a.nationalInsuranceNumber ?? '',
        hasWorkAuth:        yesNo(a.hasWorkAuthorization),
        workAuthType:       a.workAuthorizationType ?? '',
        availability:       a.availability ?? '',
        salaryExpectation:  a.salaryExpectation ?? '',
        preferredStartDate: a.preferredStartDate ? new Date(a.preferredStartDate) : null,
        createdAt:          a.createdAt ? new Date(a.createdAt) : null,
      });
    }

    return Buffer.from(await workbook.xlsx.writeBuffer() as ArrayBuffer);
  }

  // ── Convert Applicant → Employee ──────────────────────────────────────────────

  async convertToEmployee(id: string, dto: ConvertToEmployeeDto, actorId?: string, actor?: { role: string; agencyId?: string; agencyIsSystem?: boolean }) {
    // Only agency-side role names are blocked from converting. Tenant
    // HR Manager / Recruiter / Compliance Officer inside an external
    // agency can convert their own-agency candidates — findOne below
    // already restricts them to own-agency records, so they can't
    // reach a candidate belonging to another tenant.
    const isAgencySideRole = actor?.role === 'Agency User' || actor?.role === 'Agency Manager';
    if (isAgencySideRole) {
      throw new ForbiddenException({ code: 'APPLICANT.AGENCY_CONVERT_FORBIDDEN', message: 'Agency users cannot convert candidates to employees.' });
    }

    const applicant = await this.findOne(id, actor);

    if (applicant.tier !== 'CANDIDATE') {
      throw new ForbiddenException({ code: 'APPLICANT.CONVERT_REQUIRES_CANDIDATE', message: 'Only Candidates can be converted to employees. Convert the Lead to a Candidate first.' });
    }
    if ((applicant as any).approvalStatus === 'PENDING_APPROVAL') {
      throw new ForbiddenException({ code: 'APPLICANT.PENDING_APPROVAL_CONVERT', message: 'This candidate is pending Tempworks approval and cannot be converted yet.' });
    }
    if ((applicant as any).approvalStatus === 'REJECTED') {
      throw new ForbiddenException({ code: 'APPLICANT.REJECTED_CANNOT_CONVERT', message: 'This candidate was rejected and cannot be converted.' });
    }

    const existing = await this.legacyPrisma.employee.findFirst({ // @tenant-reviewed: phase229-pilot-scope-precheck
      where: { email: applicant.email, deletedAt: null },
    });
    if (existing) {
      throw new ConflictException({ code: 'EMPLOYEE.EMAIL_EXISTS', message: `An employee with email ${applicant.email} already exists`, params: { email: applicant.email } });
    }

    // Phase 3 (#26) — fall back to the candidate's stored applicationData
    // address when the dialog didn't supply one. This is the same
    // extraction the bulk path uses, so individual and bulk now share
    // identical mapping rules. If the merged address is still missing
    // any required field, we raise a structured 400 so the frontend
    // can render a "please complete: <fields>" message instead of a
    // generic DB constraint error.
    const extracted = extractApplicantAddressForConversion((applicant as any).applicationData);
    const merged = {
      addressLine1: (dto.addressLine1 ?? '').trim() || extracted.addressLine1,
      addressLine2: (dto.addressLine2 ?? '').trim() || extracted.addressLine2,
      city:         (dto.city         ?? '').trim() || extracted.city,
      country:      (dto.country      ?? '').trim() || extracted.country,
      postalCode:   (dto.postalCode   ?? '').trim() || extracted.postalCode,
    };
    const missing = missingAddressFields(merged);
    if (missing.length > 0) {
      throw new BadRequestException({
        code: 'APPLICANT.CONVERT_MISSING_ADDRESS',
        message: `Cannot convert candidate: missing address fields (${missing.join(', ')}). Open the candidate profile to complete the address and retry.`,
        params: { missing, applicantId: id },
      });
    }

    const stages = await this.legacyPrisma.stageTemplate.findMany({ // @tenant-reviewed: phase228-global
      where: { isActive: true },
      orderBy: { order: 'asc' },
    });

    // Use the centralized identifier generator for the Employee prefix.
    const employeeNumber = await this.generateIdentifier('E');
    const employeeConvertedAt = new Date();

    // Carry forward prior-stage identifiers for full traceability on the
    // employee record (the applicant will be soft-deleted after this).
    const prevLeadNumber      = (applicant as any).leadNumber      ?? null;
    const prevCandidateNumber = (applicant as any).candidateNumber ?? null;
    const prevCandidateConvertedAt = (applicant as any).candidateConvertedAt ?? null;

    // Phase 2.29 — write tenantId on the new Employee. Applicant
    // already gated by findOne above; the new Employee inherits the
    // active tenant.
    const tdata = this.scope().tenantData();
    const employee = await this.legacyPrisma.employee.create({ // @tenant-reviewed: phase229-pilot-scope (writes tenantId via scope.tenantData)
      data: {
        employeeNumber,
        // ── Lifecycle traceability ──────────────────────────────────────
        leadNumber: prevLeadNumber,
        candidateNumber: prevCandidateNumber,
        candidateConvertedAt: prevCandidateConvertedAt,
        employeeConvertedAt,
        // ── Core identity ───────────────────────────────────────────────
        firstName: applicant.firstName,
        lastName: applicant.lastName,
        email: applicant.email,
        phone: applicant.phone,
        nationality: applicant.nationality,
        dateOfBirth: applicant.dateOfBirth ?? new Date('1990-01-01'),
        addressLine1: merged.addressLine1,
        addressLine2: merged.addressLine2 || undefined,
        city: merged.city,
        country: merged.country,
        postalCode: merged.postalCode,
        licenseNumber: dto.licenseNumber,
        licenseCategory: dto.licenseCategory,
        yearsExperience: dto.yearsExperience ?? 0,
        emergencyContact: dto.emergencyContact,
        emergencyPhone: dto.emergencyPhone,
        notes: applicant.notes,
        photoUrl: (applicant as any).photoUrl ?? null,
        status: 'ONBOARDING' as any,
        ...(applicant.agencyId ? { agencyId: applicant.agencyId } : {}),
        // Carry forward the original applicant's attribution so the
        // Employee profile still shows "Created by …" or "Self-applied".
        createdById: (applicant as any).createdById ?? null,
        source: (applicant as any).source ?? 'STAFF_CREATED',
        // Preserve the structured application data so the Employee's
        // Application tab can render every field the applicant entered
        // without rehydrating the old applicant row.
        applicationData: (applicant as any).applicationData ?? undefined,
        employeeStages: {
          create: stages.map((s: any) => ({ stageId: s.id, status: 'PENDING' })),
        },
        ...tdata,
        // Preserve the (corrected) tenant from the source Applicant/Candidate
        // so conversion can never introduce a tenant mismatch. The applicant
        // tenant wins over the ALS active tenant when present.
        ...((applicant as any).tenantId ? { tenantId: (applicant as any).tenantId } : {}),
      } as any,
      include: { agency: { select: { id: true, name: true } } },
    });

    // Auto-grant the owning agency view + edit access on the new
    // Employee row. Mirrors EmployeesService.create — without this
    // row the agency's users see an empty "Agency Access" list on
    // the employee profile even though Employee.agencyId points at
    // them. Inlined here (rather than calling EmployeesService) to
    // avoid module-circular-dependency between Applicants and
    // Employees.
    if (applicant.agencyId) {
      await this.legacyPrisma.employeeAgencyAccess.upsert({ // @tenant-reviewed: phase234-agency-gate (employee + agency tenant-gated upstream)
        where:  { employeeId_agencyId: { employeeId: employee.id, agencyId: applicant.agencyId } },
        create: {
          employeeId: employee.id,
          agencyId: applicant.agencyId,
          canView: true,
          canEdit: true,
          grantedById: actorId ?? null,
          notes: 'Auto-granted on candidate→employee conversion',
        },
        update: { canView: true, canEdit: true, grantedById: actorId ?? null, grantedAt: new Date() },
      });
    }

    // Phase 2.32 — cross-module conversion gate. The applicant is
    // tenant-gated above; the new where-clause additionally narrows
    // by `tenantId` so a foreign-tenant Document or FinancialRecord
    // that happens to carry `entityId == applicant.id` (e.g. legacy
    // drift) cannot be smuggled across tenants on conversion. In
    // legacy mode `tenantWhere()` returns `{}` and the where-clause
    // collapses to the pre-2.32 shape — byte-identical behaviour.
    const tWhere = this.scope().tenantWhere();

    // Re-assign documents from applicant to employee
    await this.legacyPrisma.document.updateMany({ // @tenant-reviewed: phase232-conversion-gate
      where: { entityType: 'APPLICANT', entityId: id, deletedAt: null, ...tWhere },
      data: { entityType: 'EMPLOYEE', entityId: employee.id },
    });

    // Re-assign financial records from applicant to employee.
    // Preserve applicantId (stable person reference) for cross-stage queries.
    // stageAtCreation is NOT changed — it records what stage the person was
    // when the record was created, which is historical fact.
    const financialReassignResult = await this.legacyPrisma.financialRecord.updateMany({ // @tenant-reviewed: phase232-conversion-gate
      where: { entityType: 'APPLICANT', entityId: id, deletedAt: null, ...tWhere },
      data: {
        entityType: 'EMPLOYEE',
        entityId: employee.id,
        applicantId: id, // stamp stable person reference (idempotent)
      },
    });

    // Link the ApplicantFinancialProfile (banking/salary details) to the
    // new employee so it remains accessible from the Employee profile.
    // ApplicantFinancialProfile has no tenantId column today, so the
    // tenant safety here rides on the gated `applicantId` (unique
    // per applicant; the parent applicant load above is tenant-gated).
    await (this.prisma as any).applicantFinancialProfile.updateMany({ // @tenant-reviewed: phase232-conversion-gate
      where: { applicantId: id },
      data: { employeeId: employee.id },
    });

    // Mark applicant as converted (soft delete + store employeeId + timestamp)
    await this.legacyPrisma.applicant.update({ // @tenant-reviewed: phase229-pilot-scope-precheck
      where: { id },
      data: {
        deletedAt: new Date(),
        convertedToEmployeeId: employee.id,
        employeeConvertedAt,
      },
    });

    await this.auditLog(actorId, 'CONVERT_TO_EMPLOYEE', id, {
      employeeId: employee.id,
      leadNumber: prevLeadNumber,
      candidateNumber: prevCandidateNumber,
      employeeNumber,
      employeeConvertedAt: employeeConvertedAt.toISOString(),
      email: applicant.email,
      financialRecordsReassigned: financialReassignResult.count,
      financialContinuityPreserved: true,
    });

    // Spec §4.11 — Employees: candidate was converted to an employee.
    // Recipients are the employees-side staff (HR Manager handles
    // onboarding paperwork; Recruiter wants to know their pipeline
    // closed; System Admin always). The candidate-side notification is
    // covered by APPLICANT_LEAD_CONVERTED on the lead→candidate hop.
    const displayName = [(employee as any).firstName, (employee as any).lastName].filter(Boolean).join(' ');
    this.notifications?.notifyUsersByRoles(
      ApplicantsService.APPLICANT_NOTIFY_ROLES,
      NOTIF_EVENTS.EMPLOYEE_ONBOARDED,
      'New employee onboarded',
      `${displayName || 'A new employee'} was onboarded (${employeeNumber}).`,
      'EMPLOYEE',
      employee.id,
      {
        titleKey: 'events.employeeOnboarded.title',
        messageKey: 'events.employeeOnboarded.body',
        params: { fullName: displayName, employeeNumber },
      },
    ).catch(e => this.logger.error('Employee onboarded notification error:', e));

    return { employee, employeeNumber, message: 'Applicant successfully converted to employee' };
  }

  // ── Candidate Delete Requests ─────────────────────────────────────────────────

  async requestDelete(candidateId: string, reason: string, requestedById: string) {
    // Phase 2.29 — parent gate. Cross-tenant ids raise 404.
    await this.findApplicantOrFail(candidateId);

    // Check no pending request already exists
    const existing = await this.legacyPrisma.candidateDeleteRequest.findFirst({ // @tenant-reviewed: phase229-pilot-scope-precheck
      where: { candidateId, status: 'PENDING' },
    });
    if (existing) throw new BadRequestException({ code: 'APPLICANT.DELETE_REQUEST_PENDING', message: 'A delete request for this candidate is already pending review.' });

    const request = await this.legacyPrisma.candidateDeleteRequest.create({ // @tenant-reviewed: phase229-pilot-scope-precheck
      data: { candidateId, requestedById, reason, status: 'PENDING' },
    });

    await this.auditLog(requestedById, 'DELETE_REQUEST_SUBMITTED', candidateId, { reason });

    return request;
  }

  async getDeleteRequests(query: any) {
    const { page = 1, limit = 20, status } = query;
    // CandidateDeleteRequest has no tenantId column; narrow via the
    // applicant relation filter when pilot is active.
    const s = this.scope();
    const where: any = s.active ? { applicant: { tenantId: s.tenantId } } : {};
    if (status) where.status = status;

    const [data, total] = await Promise.all([
      this.prisma.candidateDeleteRequest.findMany({ // @tenant-reviewed: phase228-pilot-scope
        where,
        include: {
          applicant: { select: { id: true, firstName: true, lastName: true, candidateNumber: true } },
          requestedBy: { select: { id: true, firstName: true, lastName: true, email: true } },
          reviewedBy: { select: { id: true, firstName: true, lastName: true } },
        },
        orderBy: { createdAt: 'desc' },
        skip: (Number(page) - 1) * Number(limit),
        take: Number(limit),
      }),
      this.prisma.candidateDeleteRequest.count({ where }), // @tenant-reviewed: phase228-pilot-scope
    ]);

    return { data, meta: { total, page: Number(page), limit: Number(limit), totalPages: Math.ceil(total / Number(limit)) } };
  }

  async reviewDeleteRequest(requestId: string, status: 'APPROVED' | 'REJECTED', reviewNotes: string | undefined, reviewedById: string) {
    // Phase 2.29 — tenant-scoped pre-check. CandidateDeleteRequest
    // has no tenantId column; gate via the parent applicant relation
    // filter when pilot is active.
    const s = this.scope();
    const where: any = s.active ? { id: requestId, applicant: { tenantId: s.tenantId } } : { id: requestId };
    const request = await this.prisma.candidateDeleteRequest.findFirst({ // @tenant-reviewed: phase229-pilot-scope (relation filter via parent applicant)
      where,
      include: { applicant: true },
    });
    if (!request) throw new NotFoundException({ code: 'APPLICANT.DELETE_REQUEST_NOT_FOUND', message: 'Delete request not found' });
    if (request.status !== 'PENDING') throw new BadRequestException({ code: 'APPLICANT.DELETE_REQUEST_REVIEWED', message: 'This request has already been reviewed.' });

    await this.legacyPrisma.candidateDeleteRequest.update({ // @tenant-reviewed: phase229-pilot-scope-precheck
      where: { id: requestId },
      data: { status, reviewedById, reviewedAt: new Date(), reviewNotes },
    });

    if (status === 'APPROVED') {
      // Perform soft delete of the candidate
      await this.legacyPrisma.applicant.update({ // @tenant-reviewed: phase229-pilot-scope-precheck
        where: { id: request.candidateId },
        data: {
          deletedAt: new Date(),
          deletedBy: reviewedById,
          deletionReason: reviewNotes || 'Approved delete request',
        } as any,
      });
      await this.auditLog(reviewedById, 'DELETE_REQUEST_APPROVED', request.candidateId, { requestId });
    } else {
      await this.auditLog(reviewedById, 'DELETE_REQUEST_REJECTED', request.candidateId, { requestId, reviewNotes });
    }

    return { success: true, status };
  }

  // ── Private Helpers ───────────────────────────────────────────────────────────

  /**
   * True when the caller is an external tenant — their view must be
   * scoped to their own agency. The check is driven by the agency's
   * `isSystem` flag (loaded into req.user.agencyIsSystem by the JWT
   * strategy), not by role name, so an HR Manager attached to an
   * external agency is scoped identically to an Agency Manager.
   *
   * Users attached to the Tempworks root agency (`isSystem=true`)
   * retain their RBAC-defined global visibility.
   */
  private isExternalActor(actor?: { agencyId?: string; agencyIsSystem?: boolean }): boolean {
    return !!actor && !!actor.agencyId && actor.agencyIsSystem !== true;
  }

  private uuid(): string {
    return require('crypto').randomUUID();
  }

  private async auditLog(
    userId: string | undefined,
    action: string,
    entityId: string,
    changes?: Record<string, any>,
  ): Promise<void> {
    // Phase 2.30 — delegates to the shared tenant-aware audit emitter.
    // @tenant-reviewed: phase230-audit-log-pilot
    await this.tenantAuditLog.write({
      userId,
      action,
      entity: 'Applicant',
      entityId,
      changes,
    });
  }

  /**
   * Centralized lifecycle identifier generator.
   *
   * Format:  [prefix][YYYY][MM][SSSSS]
   * Example: A20260400001  /  C20260400001  /  E20260400001
   *
   * Strategy: monthly-reset serial per prefix.
   *
   * Self-healing design — the counter is seeded from the ACTUAL maximum
   * existing serial in the relevant table column on every call.  This means:
   *   - If the identifier_sequences table is ever reset/recreated, the next
   *     generated ID will still be above any already-persisted ID (no collision).
   *   - GREATEST() ensures we always advance above both the stored counter
   *     and whatever serials already exist in the real data.
   *   - The INSERT … ON CONFLICT DO UPDATE is a single atomic PostgreSQL
   *     statement, so concurrent requests still never receive duplicate serials.
   *
   * Serial format: positions 1-7 are [prefix][YYYY][MM], positions 8-12 are
   * the zero-padded 5-digit serial.  SUBSTRING(col FROM 8) extracts the serial.
   *
   * @param prefix  'A' for Lead, 'C' for Candidate, 'E' for Employee
   */
  private async generateIdentifier(prefix: 'A' | 'C' | 'E'): Promise<string> {
    const now = new Date();
    const year = now.getFullYear();
    const month = now.getMonth() + 1;
    const mm = String(month).padStart(2, '0');
    const likePattern = `${prefix}${year}${mm}%`;

    let serial: number;

    if (prefix === 'A') {
      // Lead: serial derived from applicants.leadNumber
      const newId1 = randomUUID();
      // @tenant-reviewed: phase228-global
      const result: { current: number }[] = await this.legacyPrisma.$queryRaw`
        INSERT INTO "identifier_sequences" ("id", "prefix", "year", "month", "current")
        VALUES (
          ${newId1}, ${prefix}, ${year}, ${month},
          COALESCE((
            SELECT MAX(CAST(SUBSTRING("leadNumber" FROM 8) AS INTEGER))
            FROM "applicants"
            WHERE "leadNumber" LIKE ${likePattern}
          ), 0) + 1
        )
        ON CONFLICT ("prefix", "year", "month")
        DO UPDATE SET "current" = GREATEST(
          "identifier_sequences"."current" + 1,
          COALESCE((
            SELECT MAX(CAST(SUBSTRING("leadNumber" FROM 8) AS INTEGER))
            FROM "applicants"
            WHERE "leadNumber" LIKE ${likePattern}
          ), 0) + 1
        )
        RETURNING "current"
      `;
      serial = Number(result[0]?.current ?? 1);

    } else if (prefix === 'C') {
      // Candidate: serial derived from applicants.candidateNumber
      const newId2 = randomUUID();
      // @tenant-reviewed: phase228-global
      const result: { current: number }[] = await this.legacyPrisma.$queryRaw`
        INSERT INTO "identifier_sequences" ("id", "prefix", "year", "month", "current")
        VALUES (
          ${newId2}, ${prefix}, ${year}, ${month},
          COALESCE((
            SELECT MAX(CAST(SUBSTRING("candidateNumber" FROM 8) AS INTEGER))
            FROM "applicants"
            WHERE "candidateNumber" LIKE ${likePattern}
          ), 0) + 1
        )
        ON CONFLICT ("prefix", "year", "month")
        DO UPDATE SET "current" = GREATEST(
          "identifier_sequences"."current" + 1,
          COALESCE((
            SELECT MAX(CAST(SUBSTRING("candidateNumber" FROM 8) AS INTEGER))
            FROM "applicants"
            WHERE "candidateNumber" LIKE ${likePattern}
          ), 0) + 1
        )
        RETURNING "current"
      `;
      serial = Number(result[0]?.current ?? 1);

    } else {
      // Employee: serial derived from employees.employeeNumber
      const newId3 = randomUUID();
      // @tenant-reviewed: phase228-global
      const result: { current: number }[] = await this.legacyPrisma.$queryRaw`
        INSERT INTO "identifier_sequences" ("id", "prefix", "year", "month", "current")
        VALUES (
          ${newId3}, ${prefix}, ${year}, ${month},
          COALESCE((
            SELECT MAX(CAST(SUBSTRING("employeeNumber" FROM 8) AS INTEGER))
            FROM "employees"
            WHERE "employeeNumber" LIKE ${likePattern}
          ), 0) + 1
        )
        ON CONFLICT ("prefix", "year", "month")
        DO UPDATE SET "current" = GREATEST(
          "identifier_sequences"."current" + 1,
          COALESCE((
            SELECT MAX(CAST(SUBSTRING("employeeNumber" FROM 8) AS INTEGER))
            FROM "employees"
            WHERE "employeeNumber" LIKE ${likePattern}
          ), 0) + 1
        )
        RETURNING "current"
      `;
      serial = Number(result[0]?.current ?? 1);
    }

    return `${prefix}${year}${mm}${String(serial).padStart(5, '0')}`;
  }
}
