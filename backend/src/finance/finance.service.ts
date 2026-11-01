import {
  Injectable, NotFoundException, BadRequestException, Logger,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import { NOTIF_EVENTS } from '../notifications/notification-events';
import { tServer, ServerLocale } from '../common/i18n/server-translate';
import { decodeUploadFilename } from '../common/storage/multer.config';
import { formatDisplayDate, formatDisplayDateTime } from '../common/i18n/date-format';
import { CreateFinancialRecordDto } from './dto/create-financial-record.dto';
import { UpdateFinancialRecordDto } from './dto/update-financial-record.dto';
import { UpdateStatusDto } from './dto/update-status.dto';
import { FilterFinancialRecordsDto } from './dto/filter-financial-records.dto';
import { PaginatedResponse } from '../common/dto/pagination-response.dto';
import { StorageService } from '../common/storage/storage.service';
import * as ExcelJS from 'exceljs';
import { PilotPrismaAccessor } from '../saas/prisma/pilot-prisma.accessor';
import { getPilotScope, PilotScope } from '../saas/prisma/tenant-pilot-scope';
import { activeTenantWhere } from '../saas/prisma/active-tenant-where';
import { buildSuperUserTenantWhereDirect, assertRequestedTenantExists } from '../saas/prisma/super-user-tenant-filter';
import { TenantAuditLogService } from '../saas/audit/tenant-audit-log.service';

// Roles that receive financial notifications
const FINANCE_ROLES = ['System Admin', 'Finance', 'HR Manager'];
// High-balance threshold in EUR (also check SystemSetting key 'notifications.highBalanceThreshold')
const DEFAULT_HIGH_BALANCE_THRESHOLD = 500;

/**
 * Phase 2.16 + 2.17 — Finance pilot (reads + selected mutations).
 *
 * READ paths route through `pilot.client()` and spread
 * `scope.tenantWhere()` when the pilot scope is active. Production
 * default (flag off) is byte-identical to pre-2.16.
 *
 * WRITE / mutation paths (Phase 2.17):
 *  - `create` writes `tenantId` via `scope.tenantData()` in pilot mode
 *    (`phase217-pilot-scope`).
 *  - `update`, `remove`, `updateStatus`, `addDeduction`,
 *    `addAttachment`, `removeAttachment` rely on the tenant-scoped
 *    `findOne(id)` pre-check (`phase217-pilot-scope-precheck`). The
 *    by-id update / soft-delete therefore never reaches a foreign
 *    tenant's row.
 *  - `removeDeduction` adds a NEW parent tenant pre-check via
 *    `findFirst({ where: { id, tenantWhere() } })` before deleting
 *    the child deduction (`phase217-pilot-scope`).
 *
 * Audit log writes use `legacyPrisma` always (global side effect).
 *
 * The pilot scope is active iff:
 *   - `TENANT_PRISMA_PILOT_ENABLED=true`
 *   - `TENANT_PRISMA_PILOT_MODULES` empty or includes `finance`
 *   - env classifies as SAFE_CLONE / SAFE_STAGING
 *   - a tenant is in the active ALS frame
 */
@Injectable()
export class FinanceService {
  private readonly logger = new Logger(FinanceService.name);

  constructor(
    private readonly legacyPrisma: PrismaService,
    private readonly notifications: NotificationsService,
    private readonly storage: StorageService,
    private readonly pilot: PilotPrismaAccessor,
    private readonly tenantAuditLog: TenantAuditLogService,
  ) {}

  /** Pilot-aware Prisma surface used by READ paths only. Mutation
   *  paths use `legacyPrisma` directly. */
  private get prisma(): PrismaService {
    return this.pilot.client();
  }

  private scope(): PilotScope {
    return getPilotScope(this.pilot, 'finance');
  }

  // ── Prisma include helpers ───────────────────────────────────────────────────

  private get recordInclude() {
    return {
      paidByUser: { select: { id: true, firstName: true, lastName: true, email: true } },
      createdBy:  { select: { id: true, firstName: true, lastName: true, email: true } },
      attachments: { where: { deletedAt: null }, orderBy: { createdAt: 'asc' as const } },
      // Oldest-first so the expanded panel reads chronologically.
      deductions: {
        orderBy: { deductionDate: 'asc' as const },
        include: { createdBy: { select: { id: true, firstName: true, lastName: true } } },
      },
    };
  }

  // ── List / Global View ───────────────────────────────────────────────────────

  async findAll(filter: FilterFinancialRecordsDto, caller?: any) {
    const {
      page = 1, limit = 20, entityType, entityId, search, status,
      transactionType, currency, dateFrom, dateTo,
      sortBy = 'transactionDate', sortOrder = 'desc',
    } = filter as any;
    const skip = (Number(page) - 1) * Number(limit);

    // Phase 2 (#5) — enforce the caller's active tenant on every read,
    // even when the read-pilot is off (legacy mode). Stops SUPER from
    // seeing records from a tenant they aren't currently switched to.
    // Phase F2 (SPIKE-010) — accept SUPER USER ?tenantId= override.
    await assertRequestedTenantExists(caller, (filter as any).tenantId, this.legacyPrisma.tenant);
    // FinancialRecord has no `agency` relation — use direct-only variant.
    const superTenantPredicate = buildSuperUserTenantWhereDirect(caller, (filter as any).tenantId);
    const t = this.scope().tenantWhere();
    // SUPER's explicit per-page tenant override wins over the session's
    // active tenant (otherwise ANDing the two yields 0 rows when they differ).
    const where: any = {
      deletedAt: null, ...t,
      ...(superTenantPredicate ? {} : activeTenantWhere(caller)),
    };
    if (superTenantPredicate) where.AND = [...(where.AND ?? []), superTenantPredicate];
    if (entityType) where.entityType = entityType;
    if (entityId)   where.entityId   = entityId;
    if (status)     where.status     = status;
    if (transactionType) where.transactionType = transactionType;
    if (currency)   where.currency   = currency;
    if (dateFrom || dateTo) {
      where.transactionDate = {};
      if (dateFrom) where.transactionDate.gte = new Date(dateFrom);
      if (dateTo)   where.transactionDate.lte = new Date(dateTo);
    }
    if (search) {
      where.OR = [
        { description:      { contains: search, mode: 'insensitive' } },
        { payrollReference: { contains: search, mode: 'insensitive' } },
        { paidByName:       { contains: search, mode: 'insensitive' } },
        { notes:            { contains: search, mode: 'insensitive' } },
      ];
    }

    const validSort = [
      'transactionDate', 'companyDisbursedAmount', 'status',
      'transactionType', 'currency', 'createdAt',
    ];
    const orderField = validSort.includes(sortBy) ? sortBy : 'transactionDate';

    const [items, total] = await Promise.all([
      this.prisma.financialRecord.findMany({ // @tenant-reviewed: phase216-pilot-scope
        where, skip, take: Number(limit),
        orderBy: { [orderField]: sortOrder },
        include: this.recordInclude,
      }),
      this.prisma.financialRecord.count({ where }), // @tenant-reviewed: phase216-pilot-scope
    ]);

    // Attach entity (applicant / employee) name to each record so the
    // global dashboard can show who the disbursement belongs to.
    const enriched = await this.attachEntityNames(items);

    return PaginatedResponse.create(enriched, total, page, limit);
  }

  // ── Totals for one entity (current stage) ───────────────────────────────────

  /**
   * Balance calculation rules:
   *   totalDisbursed  = SUM(companyDisbursedAmount)
   *   totalDeducted   = SUM(deductionAmount WHERE deductionAmount IS NOT NULL)
   *   currentBalance  = totalDisbursed − totalDeducted
   *
   * employeeOrAgencyPaidAmount is NOT included in any balance figure —
   * it is informational/reconciliation data only.
   */
  async getTotals(entityType: string, entityId: string) {
    const t = this.scope().tenantWhere();
    const agg = await this.prisma.financialRecord.aggregate({ // @tenant-reviewed: phase216-pilot-scope
      where: { entityType, entityId, deletedAt: null, ...t },
      _sum: {
        companyDisbursedAmount:     true,
        employeeOrAgencyPaidAmount: true,
        deductionAmount:            true,
      },
      _count: { id: true },
    });

    const totalDisbursed  = Number(agg._sum.companyDisbursedAmount     ?? 0);
    const totalDeducted   = Number(agg._sum.deductionAmount            ?? 0);
    const totalEmpAgency  = Number(agg._sum.employeeOrAgencyPaidAmount ?? 0);
    const currentBalance  = totalDisbursed - totalDeducted;
    const recordCount     = agg._count.id;

    return { totalDisbursed, totalDeducted, currentBalance, totalEmpAgency, recordCount };
  }

  // ── All records + totals for a person across ALL lifecycle stages ────────────

  /**
   * Returns all financial records for a person identified by their stable
   * applicantId, regardless of which stage they are at now.
   *
   * This is the correct cross-lifecycle view: it works whether the person
   * is still a Lead/Candidate (entityType=APPLICANT) or has been converted
   * to an Employee (entityType=EMPLOYEE, applicantId still set).
   *
   * Also returns the ApplicantFinancialProfile (banking/salary details) so
   * the Employee profile can display it after conversion.
   */
  async getPersonRecords(applicantId: string) {
    const t = this.scope().tenantWhere();
    // Resolve applicant (include soft-deleted so converted persons are found)
    const applicant = await this.prisma.applicant.findFirst({ // @tenant-reviewed: phase216-pilot-scope (id+tenant scoped when active)
      where: { id: applicantId, ...t },
      select: {
        id: true, firstName: true, lastName: true, email: true,
        tier: true, deletedAt: true, convertedToEmployeeId: true,
        leadNumber: true, candidateNumber: true,
        financialProfile: true,
      },
    });
    if (!applicant) throw new NotFoundException(`Applicant ${applicantId} not found`);

    // Resolve linked employee if converted
    let employee: any = null;
    if (applicant.convertedToEmployeeId) {
      employee = await this.prisma.employee.findFirst({ // @tenant-reviewed: phase216-pilot-scope
        where: { id: applicant.convertedToEmployeeId, ...t },
        select: {
          id: true, firstName: true, lastName: true, email: true,
          employeeNumber: true, status: true,
        },
      });
    }

    // All financial records across all stages for this person
    const records = await this.prisma.financialRecord.findMany({ // @tenant-reviewed: phase216-pilot-scope
      where: {
        applicantId,
        deletedAt: null,
        ...t,
      },
      orderBy: { transactionDate: 'desc' },
      include: this.recordInclude,
    });

    // Aggregate totals across all stages
    const agg = await this.prisma.financialRecord.aggregate({ // @tenant-reviewed: phase216-pilot-scope
      where: { applicantId, deletedAt: null, ...t },
      _sum: {
        companyDisbursedAmount:     true,
        employeeOrAgencyPaidAmount: true,
        deductionAmount:            true,
      },
      _count: { id: true },
    });

    const totalDisbursed = Number(agg._sum.companyDisbursedAmount     ?? 0);
    const totalDeducted  = Number(agg._sum.deductionAmount            ?? 0);
    const totalEmpAgency = Number(agg._sum.employeeOrAgencyPaidAmount ?? 0);
    const currentBalance = totalDisbursed - totalDeducted;

    // Stage breakdown for reporting
    const byStage = records.reduce((acc: Record<string, number>, r: any) => {
      const stage = r.stageAtCreation ?? 'UNKNOWN';
      acc[stage] = (acc[stage] ?? 0) + 1;
      return acc;
    }, {});

    return {
      applicant: {
        id: applicant.id,
        name: `${applicant.firstName} ${applicant.lastName}`,
        email: applicant.email,
        tier: applicant.tier,
        isConverted: !!applicant.convertedToEmployeeId,
        leadNumber: applicant.leadNumber,
        candidateNumber: applicant.candidateNumber,
      },
      employee: employee ? {
        id: employee.id,
        name: `${employee.firstName} ${employee.lastName}`,
        employeeNumber: employee.employeeNumber,
        status: employee.status,
      } : null,
      financialProfile: applicant.financialProfile ?? null,
      records,
      totals: {
        totalDisbursed, totalDeducted, currentBalance, totalEmpAgency,
        recordCount: agg._count.id,
        byStage,
      },
    };
  }

  // ── CRUD ─────────────────────────────────────────────────────────────────────

  /** Configurable transaction types surfaced by the constants endpoint.
   *  The list lives in the DB (seeded once with the hardcoded defaults)
   *  so System Admins can manage it from Settings without a deploy. */
  async listTransactionTypes(): Promise<Array<{ id: string; name: string; sortOrder: number }>> {
    try {
      return await (this.prisma as any).financeTransactionType.findMany({ // @tenant-reviewed: phase216-global (FinanceTransactionType is a global catalog)
        where: { isActive: true },
        orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
        select: { id: true, name: true, sortOrder: true },
      });
    } catch {
      // Prisma client may not have been regenerated yet on first boot
      // of this feature — fall back to the hardcoded defaults rather
      // than blowing up the whole finance UI.
      return [];
    }
  }

  async findOne(id: string, caller?: any) {
    const t = this.scope().tenantWhere();
    // Phase 2 (#5) — cross-tenant id lookup must 404, not return the row.
    const record = await this.prisma.financialRecord.findFirst({ // @tenant-reviewed: phase216-pilot-scope
      where: { id, deletedAt: null, ...t, ...activeTenantWhere(caller) },
      include: this.recordInclude,
    });
    if (!record) throw new NotFoundException(`Financial record ${id} not found`);
    return record;
  }

  /** Returns the full audit trail for a financial record — who did what
   *  (CREATE / UPDATE / STATUS / DEDUCTION_ADDED / DEDUCTION_REMOVED /
   *  ATTACHMENT_ADDED / ATTACHMENT_REMOVED / DELETE) and when. Used by
   *  the profile's ledger expand panel to show a change history. */
  async getHistory(id: string) {
    const t = this.scope().tenantWhere();
    // Cheap existence check so we return 404 rather than an empty list
    // when the id is wrong (or belongs to another tenant in pilot mode).
    const record = await this.prisma.financialRecord.findFirst({ // @tenant-reviewed: phase216-pilot-scope
      where: { id, ...t }, select: { id: true },
    });
    if (!record) throw new NotFoundException(`Financial record ${id} not found`);

    // Audit log is global by design (no tenant filter). The parent
    // FinancialRecord existence + tenant check above already
    // authorized access to this entity's history.
    const logs = await this.legacyPrisma.auditLog.findMany({ // @tenant-reviewed: phase216-audit-log (auditLog is global; parent already tenant-checked)
      where: { entity: 'FinancialRecord', entityId: id, deletedAt: null },
      orderBy: { createdAt: 'desc' },
      include: {
        user: { select: { id: true, firstName: true, lastName: true, email: true } },
      },
    });

    return logs.map(l => ({
      id: l.id,
      action: l.action,
      createdAt: l.createdAt,
      changes: l.changes,
      user: l.user
        ? {
            id: l.user.id,
            name: [l.user.firstName, l.user.lastName].filter(Boolean).join(' '),
            email: l.user.email,
          }
        : null,
      userEmail: l.userEmail,
    }));
  }

  async create(dto: CreateFinancialRecordDto, actorId?: string, callerTenantId?: string | null) {
    if (!['APPLICANT', 'EMPLOYEE', 'AGENCY'].includes(dto.entityType)) {
      throw new BadRequestException('entityType must be APPLICANT, EMPLOYEE or AGENCY');
    }

    // Verify entity exists and resolve stable applicantId + stageAtCreation
    const { applicantId, stageAtCreation } =
      await this.resolvePersonIdentity(dto.entityType, dto.entityId);

    const tdata = this.scope().tenantData();
    const record = await this.prisma.financialRecord.create({ // @tenant-reviewed: phase217-pilot-scope (writes tenantId in pilot mode via scope.tenantData)
      data: {
        entityType:                 dto.entityType,
        entityId:                   dto.entityId,
        applicantId,
        stageAtCreation,
        transactionDate:            new Date(dto.transactionDate),
        currency:                   dto.currency ?? 'EUR',
        transactionType:            dto.transactionType,
        description:                dto.description,
        paymentMethod:              dto.paymentMethod,
        paidByName:                 dto.paidByName,
        paidById:                   dto.paidById,
        companyDisbursedAmount:     dto.companyDisbursedAmount,
        employeeOrAgencyPaidAmount: dto.employeeOrAgencyPaidAmount ?? 0,
        status:                     'PENDING',
        notes:                      dto.notes,
        createdById:                actorId,
        ...tdata,
        // Phase 2 (#23) — default to caller's active tenant when the
        // read-pilot didn't supply one (pilot off / no ALS frame).
        ...(!(tdata as any).tenantId && callerTenantId ? { tenantId: callerTenantId } : {}),
      },
      include: this.recordInclude,
    });

    await this.auditLog(actorId, 'FINANCIAL_RECORD_CREATED', record.id, {
      entityType: dto.entityType, entityId: dto.entityId,
      applicantId, stageAtCreation,
      transactionType: dto.transactionType,
      companyDisbursedAmount: dto.companyDisbursedAmount,
    });

    // ── Notification ─────────────────────────────────────────────────────────
    const entityName = await this.resolveEntityNameForNotif(dto.entityType, dto.entityId);
    const amountSuffix = dto.companyDisbursedAmount
      ? ` — ${dto.currency ?? 'EUR'} ${dto.companyDisbursedAmount}`
      : '';
    this.notifications.notifyUsersByRoles(
      FINANCE_ROLES,
      NOTIF_EVENTS.FINANCIAL_RECORD_CREATED,
      'New Financial Record Added',
      `A new financial record was added for ${entityName}: ${dto.transactionType}${amountSuffix}`,
      dto.entityType,
      dto.entityId,
      {
        titleKey: 'events.financeRecordCreated.title',
        messageKey: 'events.financeRecordCreated.body',
        params: {
          entityName,
          transactionType: dto.transactionType,
          amountSuffix,
        },
      },
    ).catch(e => this.logger.error('Notification error (create):', e));

    // Check high balance after creation
    this.checkAndNotifyHighBalance(dto.entityType, dto.entityId).catch(
      e => this.logger.error('High balance check error:', e),
    );

    return record;
  }

  async update(id: string, dto: UpdateFinancialRecordDto, actorId?: string) {
    const existing = await this.findOne(id);
    const data: any = { ...dto };
    // Phase 2.17.1 — defensive scrub of identity-reassignment fields.
    // UpdateFinancialRecordDto structurally omits entityType / entityId;
    // applicantId + stageAtCreation are computed at create time only.
    // Stripping them here keeps the cross-entity invariant intact even
    // if a future DTO refactor accidentally re-introduces them.
    delete data.entityType;
    delete data.entityId;
    delete data.applicantId;
    delete data.stageAtCreation;
    if (dto.transactionDate) data.transactionDate = new Date(dto.transactionDate);

    const updated = await this.legacyPrisma.financialRecord.update({ // @tenant-reviewed: phase217-pilot-scope-precheck (findOne above is tenant-scoped in pilot mode)
      where: { id }, data, include: this.recordInclude,
    });

    // Build a compact before/after diff so the history panel can show
    // exactly which fields the operator touched rather than the whole
    // submitted DTO (which may contain unchanged fields).
    const TRACKED = [
      'transactionDate', 'transactionType', 'description', 'currency',
      'paymentMethod', 'paidByName', 'companyDisbursedAmount',
      'employeeOrAgencyPaidAmount', 'notes',
    ] as const;
    const diff: Record<string, { from: any; to: any }> = {};
    for (const k of TRACKED) {
      const before = (existing as any)[k];
      const after = (dto as any)[k];
      if (after === undefined) continue;
      const norm = (v: any) => v instanceof Date ? v.toISOString() : v == null ? null : typeof v === 'object' ? JSON.stringify(v) : v;
      if (norm(before) !== norm(after)) diff[k] = { from: before ?? null, to: after ?? null };
    }
    await this.auditLog(actorId, 'FINANCIAL_RECORD_UPDATED', id, {
      changed: Object.keys(diff),
      diff,
    });

    // ── Notification ─────────────────────────────────────────────────────────
    const entityName = await this.resolveEntityNameForNotif(existing.entityType, existing.entityId);
    this.notifications.notifyUsersByRoles(
      FINANCE_ROLES,
      NOTIF_EVENTS.FINANCIAL_RECORD_UPDATED,
      'Financial Record Updated',
      `A financial record was updated for ${entityName}.`,
      existing.entityType,
      existing.entityId,
      {
        titleKey: 'events.financeRecordUpdated.title',
        messageKey: 'events.financeRecordUpdated.body',
        params: { entityName },
      },
    ).catch(e => this.logger.error('Notification error (update):', e));

    return updated;
  }

  async remove(id: string, actorId?: string) {
    const existing = await this.findOne(id);
    await this.legacyPrisma.financialRecord.update({ // @tenant-reviewed: phase217-pilot-scope-precheck (findOne above is tenant-scoped in pilot mode)
      where: { id }, data: { deletedAt: new Date(), deletedBy: actorId ?? null },
    });
    await this.auditLog(actorId, 'FINANCIAL_RECORD_DELETED', id);

    // ── Notification ─────────────────────────────────────────────────────────
    const entityName = await this.resolveEntityNameForNotif(existing.entityType, existing.entityId);
    this.notifications.notifyUsersByRoles(
      FINANCE_ROLES,
      NOTIF_EVENTS.FINANCIAL_RECORD_DELETED,
      'Financial Record Deleted',
      `A financial record was deleted for ${entityName}.`,
      existing.entityType,
      existing.entityId,
      {
        titleKey: 'events.financeRecordDeleted.title',
        messageKey: 'events.financeRecordDeleted.body',
        params: { entityName },
      },
    ).catch(e => this.logger.error('Notification error (delete):', e));

    return { message: 'Financial record deleted' };
  }

  // ── Status / Deduction ───────────────────────────────────────────────────────

  async updateStatus(id: string, dto: UpdateStatusDto, actorId?: string) {
    const record = await this.findOne(id);

    // Validation: DEDUCTED requires a deductionAmount
    if (dto.status === 'DEDUCTED') {
      const deductionAmt = dto.deductionAmount ?? Number(record.deductionAmount ?? 0);
      if (deductionAmt <= 0) {
        throw new BadRequestException(
          'A positive deductionAmount is required when marking a record as DEDUCTED',
        );
      }
      if (deductionAmt > Number(record.companyDisbursedAmount)) {
        throw new BadRequestException(
          'deductionAmount cannot exceed companyDisbursedAmount',
        );
      }
    }

    const data: any = { status: dto.status };
    if (dto.deductionAmount !== undefined) data.deductionAmount = dto.deductionAmount;
    if (dto.deductionDate)    data.deductionDate    = new Date(dto.deductionDate);
    if (dto.payrollReference) data.payrollReference = dto.payrollReference;

    const updated = await this.legacyPrisma.financialRecord.update({ // @tenant-reviewed: phase217-pilot-scope-precheck (findOne above is tenant-scoped in pilot mode)
      where: { id }, data, include: this.recordInclude,
    });

    await this.auditLog(actorId, 'FINANCIAL_RECORD_STATUS_CHANGED', id, {
      oldStatus: record.status, newStatus: dto.status,
      deductionAmount: dto.deductionAmount,
      deductionDate: dto.deductionDate,
      payrollReference: dto.payrollReference,
    });

    // ── Notification ─────────────────────────────────────────────────────────
    if (dto.status === 'DEDUCTED') {
      const entityName = await this.resolveEntityNameForNotif(record.entityType, record.entityId);
      const amount = dto.deductionAmount ?? record.companyDisbursedAmount;
      const amountSuffix = amount ? ` (${record.currency} ${amount})` : '';
      this.notifications.notifyUsersByRoles(
        FINANCE_ROLES,
        NOTIF_EVENTS.FINANCIAL_RECORD_DEDUCTED,
        'Record Marked for Deduction',
        `A financial record for ${entityName} has been marked as deducted${amountSuffix}.`,
        record.entityType,
        record.entityId,
        {
          titleKey: 'events.financeRecordDeducted.title',
          messageKey: 'events.financeRecordDeducted.body',
          params: { entityName, amountSuffix },
        },
      ).catch(e => this.logger.error('Notification error (deduct):', e));
    }

    return updated;
  }

  // ── Deductions (partial + multi) ────────────────────────────────────────────
  // Each call appends a row to financial_record_deductions and keeps
  // the parent record's aggregate fields (deductionAmount / date /
  // payrollReference / status) in sync so legacy consumers that still
  // read them unchanged don't regress.

  async addDeduction(
    recordId: string,
    dto: { amount: number; deductionDate: string; payrollReference?: string; notes?: string },
    actorId?: string,
  ) {
    const record = await this.findOne(recordId);
    if ((record as any).deletedAt) throw new BadRequestException('Record is deleted');

    const amount = Number(dto.amount);
    if (!amount || amount <= 0) {
      throw new BadRequestException('Deduction amount must be a positive number');
    }

    const existingSum = (record as any).deductions?.reduce(
      (s: number, d: any) => s + Number(d.amount ?? 0),
      0,
    ) ?? Number(record.deductionAmount ?? 0);
    const disbursed = Number(record.companyDisbursedAmount);
    const newSum = existingSum + amount;
    if (newSum > disbursed) {
      throw new BadRequestException(
        `Deductions would exceed the disbursed amount (${disbursed.toFixed(2)}). Remaining: ${(disbursed - existingSum).toFixed(2)}.`,
      );
    }

    const deductionDate = new Date(dto.deductionDate);
    if (isNaN(deductionDate.getTime())) {
      throw new BadRequestException('Invalid deductionDate');
    }

    await (this.prisma as any).financialRecordDeduction.create({
      data: {
        financialRecordId: recordId,
        amount,
        deductionDate,
        payrollReference: dto.payrollReference ?? null,
        notes: dto.notes ?? null,
        createdById: actorId ?? null,
      },
    });

    // Status flips to DEDUCTED when the sum reaches the disbursed
    // amount (within rounding tolerance); otherwise PARTIAL so the
    // expanded panel can still show "Add another deduction".
    const nextStatus = Math.abs(newSum - disbursed) < 0.005 ? 'DEDUCTED' : 'PARTIAL';

    const updated = await this.legacyPrisma.financialRecord.update({ // @tenant-reviewed: phase217-pilot-scope-precheck (findOne above is tenant-scoped in pilot mode)
      where: { id: recordId },
      data: {
        deductionAmount: newSum,
        deductionDate,
        payrollReference: dto.payrollReference ?? record.payrollReference,
        status: nextStatus,
      },
      include: this.recordInclude,
    });

    await this.auditLog(actorId, 'FINANCIAL_RECORD_DEDUCTION_ADDED', recordId, {
      amount, deductionDate: dto.deductionDate, payrollReference: dto.payrollReference,
      runningTotal: newSum, nextStatus,
    });

    if (nextStatus === 'DEDUCTED') {
      const entityName = await this.resolveEntityNameForNotif(record.entityType, record.entityId);
      const amountStr = newSum.toFixed(2);
      this.notifications.notifyUsersByRoles(
        FINANCE_ROLES,
        NOTIF_EVENTS.FINANCIAL_RECORD_DEDUCTED,
        'Record Fully Deducted',
        `A financial record for ${entityName} has been fully deducted (${record.currency} ${amountStr}).`,
        record.entityType,
        record.entityId,
        {
          titleKey: 'events.financeRecordFullyDeducted.title',
          messageKey: 'events.financeRecordFullyDeducted.body',
          params: { entityName, currency: record.currency, amount: amountStr },
        },
      ).catch(e => this.logger.error('Notification error (deduct):', e));
    }

    // Spec §4.11.2 — "Deduction processed (payroll reference set)".
    // Distinct from FINANCIAL_RECORD_DEDUCTED (which fires only on
    // the cumulative-equals-disbursed close): this fires for every
    // deduction that carries a payroll reference so the operator
    // sees the binding to payroll batches as it happens, including
    // partial deductions split across pay periods.
    if (dto.payrollReference?.trim()) {
      const entityName = await this.resolveEntityNameForNotif(record.entityType, record.entityId);
      const amountStr = amount.toFixed(2);
      this.notifications.notifyUsersByRoles(
        FINANCE_ROLES,
        NOTIF_EVENTS.FINANCIAL_DEDUCTION_PROCESSED,
        'Deduction Processed',
        `A deduction of ${record.currency} ${amountStr} for ${entityName} was processed (payroll ref ${dto.payrollReference}).`,
        record.entityType,
        record.entityId,
        {
          titleKey: 'events.financeDeductionProcessed.title',
          messageKey: 'events.financeDeductionProcessed.body',
          params: {
            entityName,
            currency: record.currency,
            amount: amountStr,
            payrollReference: dto.payrollReference,
          },
        },
      ).catch(e => this.logger.error('Notification error (deduction processed):', e));
    }

    return updated;
  }

  async removeDeduction(deductionId: string, actorId?: string) {
    const deduction = await (this.prisma as any).financialRecordDeduction.findUnique({
      where: { id: deductionId },
    });
    if (!deduction) throw new NotFoundException('Deduction not found');

    const recordId: string = deduction.financialRecordId;

    // Phase 2.17 — parent tenant pre-check. In pilot mode this raises
    // 404 if the parent FinancialRecord belongs to a different tenant
    // than the active ALS frame. Legacy mode: spread is `{}` and the
    // lookup matches by id alone (legacy semantics preserved).
    const parent = await this.prisma.financialRecord.findFirst({ // @tenant-reviewed: phase217-pilot-scope (parent tenant pre-check before child delete)
      where: { id: recordId, ...this.scope().tenantWhere() },
      select: { id: true },
    });
    if (!parent) throw new NotFoundException('Deduction not found');

    await (this.prisma as any).financialRecordDeduction.delete({ where: { id: deductionId } });

    // Recompute aggregates from whatever remains.
    const remaining = await (this.prisma as any).financialRecordDeduction.findMany({
      where: { financialRecordId: recordId },
      orderBy: { deductionDate: 'desc' },
    });
    const newSum = remaining.reduce((s: number, d: any) => s + Number(d.amount ?? 0), 0);
    const record = await this.legacyPrisma.financialRecord.findUnique({ where: { id: recordId } }); // @tenant-reviewed: phase217-pilot-scope-precheck (parent already tenant-checked above)
    const disbursed = Number(record?.companyDisbursedAmount ?? 0);
    const nextStatus = newSum === 0
      ? 'PENDING'
      : Math.abs(newSum - disbursed) < 0.005
        ? 'DEDUCTED'
        : 'PARTIAL';
    const latest = remaining[0];

    const updated = await this.legacyPrisma.financialRecord.update({ // @tenant-reviewed: phase217-pilot-scope-precheck (parent already tenant-checked above)
      where: { id: recordId },
      data: {
        deductionAmount: newSum > 0 ? newSum : null,
        deductionDate: latest?.deductionDate ?? null,
        payrollReference: latest?.payrollReference ?? null,
        status: nextStatus,
      },
      include: this.recordInclude,
    });

    await this.auditLog(actorId, 'FINANCIAL_RECORD_DEDUCTION_REMOVED', recordId, {
      removedAmount: Number(deduction.amount),
      runningTotal: newSum,
      nextStatus,
    });

    return updated;
  }

  // ── Attachments ──────────────────────────────────────────────────────────────

  async addAttachment(
    recordId: string,
    file: Express.Multer.File,
    uploadedById?: string,
  ) {
    await this.findOne(recordId);

    const displayName = decodeUploadFilename(file.originalname);
    const upload = await this.storage.uploadFile(file.buffer, {
      keyPrefix: `finance/${recordId}/attachments`,
      contentType: file.mimetype,
      originalName: displayName,
      inline: file.mimetype === 'application/pdf' || file.mimetype.startsWith('image/'),
    });

    const attachment = await this.legacyPrisma.financialRecordAttachment.create({ // @tenant-reviewed: phase217-pilot-scope-precheck (findOne above is tenant-scoped in pilot mode)
      data: {
        financialRecordId: recordId,
        name: displayName,
        fileUrl: upload.url,
        mimeType: file.mimetype,
        fileSize: file.size,
        uploadedById,
      },
    });

    await this.auditLog(uploadedById, 'FINANCIAL_ATTACHMENT_ADDED', recordId, {
      attachmentId: attachment.id, name: displayName,
    });

    return attachment;
  }

  async removeAttachment(
    recordId: string,
    attachmentId: string,
    actorId?: string,
  ) {
    await this.findOne(recordId);
    const att = await this.legacyPrisma.financialRecordAttachment.findFirst({ // @tenant-reviewed: phase217-pilot-scope-precheck (findOne above is tenant-scoped; parent FK enforces attachment scope)
      where: { id: attachmentId, financialRecordId: recordId, deletedAt: null },
    });
    if (!att) throw new NotFoundException('Attachment not found');

    await this.legacyPrisma.financialRecordAttachment.update({ // @tenant-reviewed: phase217-pilot-scope-precheck (findOne above is tenant-scoped in pilot mode)
      where: { id: attachmentId }, data: { deletedAt: new Date() },
    });

    if ((att as any).fileUrl) {
      await this.storage.deleteFileByUrlOrKey((att as any).fileUrl);
    }

    await this.auditLog(actorId, 'FINANCIAL_ATTACHMENT_REMOVED', recordId, {
      attachmentId, name: att.name,
    });

    return { message: 'Attachment removed' };
  }

  // ── Excel Export ─────────────────────────────────────────────────────────────

  async exportExcel(filter: FilterFinancialRecordsDto, locale: ServerLocale = 'en'): Promise<Buffer> {
    // Fetch all matching records (no pagination)
    const { data: records } = (await this.findAll({
      ...filter, limit: 100000, page: 1,
    } as any)) as any;

    const workbook  = new ExcelJS.Workbook();
    workbook.creator  = 'TempWorks Finance Module';
    workbook.created  = new Date();

    const col = (key: string) => tServer(`finance.columns.${key}`, {}, locale, 'exports');
    const sheet = workbook.addWorksheet(tServer('finance.sheetName', {}, locale, 'exports'), {
      views: [{ state: 'frozen', ySplit: 1 }],
    });

    // Column definitions — tuned for payroll accountant use. The
    // "deduction" columns are now summaries over the deductions[]
    // sidecar (total + count + last date/ref), with the full breakdown
    // living on a second "Deductions" sheet built below.
    sheet.columns = [
      { header: col('id'),                 key: 'id',               width: 18 },
      { header: col('entityName'),         key: 'entityName',       width: 24 },
      { header: col('stageAtCreation'),    key: 'stageAtCreation',  width: 14 },
      { header: col('entityType'),         key: 'entityType',       width: 12 },
      { header: col('entityId'),           key: 'entityId',         width: 18 },
      { header: col('transactionDate'),    key: 'transactionDate',  width: 22 },
      { header: col('transactionType'),    key: 'transactionType',  width: 24 },
      { header: col('description'),        key: 'description',      width: 30 },
      { header: col('currency'),           key: 'currency',         width: 10 },
      { header: col('companyDisbursed'),   key: 'companyDisbursed', width: 20 },
      { header: col('empAgency'),          key: 'empAgency',        width: 22 },
      { header: col('paymentMethod'),      key: 'paymentMethod',    width: 16 },
      { header: col('paidBy'),             key: 'paidBy',           width: 20 },
      { header: col('status'),             key: 'status',           width: 12 },
      { header: col('deductionAmount'),    key: 'deductionAmount',  width: 20 },
      { header: col('remaining'),          key: 'remaining',        width: 16 },
      { header: col('deductionCount'),     key: 'deductionCount',   width: 12 },
      { header: col('deductionDate'),      key: 'deductionDate',    width: 18 },
      { header: col('payrollReference'),   key: 'payrollReference', width: 20 },
      { header: col('notes'),              key: 'notes',            width: 30 },
      { header: col('createdAt'),          key: 'createdAt',        width: 16 },
    ];

    // Header styling
    sheet.getRow(1).eachCell((cell) => {
      cell.font      = { bold: true, color: { argb: 'FFFFFFFF' } };
      cell.fill      = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF2563EB' } };
      cell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
      cell.border    = {
        bottom: { style: 'thin', color: { argb: 'FF1D4ED8' } },
      };
    });
    sheet.getRow(1).height = 32;

    // Data rows
    for (const rec of records as any[]) {
      const deductions: any[] = Array.isArray(rec.deductions) ? rec.deductions : [];
      const totalDeducted = deductions.length > 0
        ? deductions.reduce((s, d) => s + Number(d.amount ?? 0), 0)
        : Number(rec.deductionAmount ?? 0);
      const remaining = Math.max(0, Number(rec.companyDisbursedAmount ?? 0) - totalDeducted);
      const lastDeduction = deductions.length > 0
        ? deductions.slice().sort(
            (a, b) => new Date(b.deductionDate).getTime() - new Date(a.deductionDate).getTime(),
          )[0]
        : null;

      const row = sheet.addRow({
        id:              rec.id,
        entityName:      rec.entityName ?? '',
        stageAtCreation: rec.stageAtCreation ?? '',
        entityType:      rec.entityType,
        entityId:        rec.entityId,
        transactionDate: rec.transactionDate ? formatDisplayDateTime(rec.transactionDate) : '',
        transactionType: rec.transactionType,
        description:     rec.description ?? '',
        currency:        rec.currency,
        companyDisbursed: Number(rec.companyDisbursedAmount ?? 0),
        empAgency:        Number(rec.employeeOrAgencyPaidAmount ?? 0),
        paymentMethod:   rec.paymentMethod ?? '',
        paidBy:          rec.paidByName ?? (rec.paidByUser ? `${rec.paidByUser.firstName} ${rec.paidByUser.lastName}` : ''),
        status:          rec.status,
        deductionAmount: totalDeducted > 0 ? totalDeducted : '',
        remaining:       remaining,
        deductionCount:  deductions.length,
        deductionDate:   lastDeduction?.deductionDate
          ? formatDisplayDate(lastDeduction.deductionDate)
          : rec.deductionDate ? formatDisplayDate(rec.deductionDate) : '',
        payrollReference: lastDeduction?.payrollReference ?? rec.payrollReference ?? '',
        notes:           rec.notes ?? '',
        createdAt:       formatDisplayDate(rec.createdAt),
      });

      // Color by status — Partial gets its own shade so the sheet
      // visually matches the in-app status chips.
      const statusCell = row.getCell('status');
      if (rec.status === 'DEDUCTED') {
        statusCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFD1FAE5' } };
        statusCell.font = { color: { argb: 'FF065F46' }, bold: true };
      } else if (rec.status === 'PARTIAL') {
        statusCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFDBEAFE' } };
        statusCell.font = { color: { argb: 'FF1E40AF' }, bold: true };
      } else {
        statusCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFEF3C7' } };
        statusCell.font = { color: { argb: 'FF92400E' }, bold: true };
      }

      // Format currency columns
      ['companyDisbursed', 'empAgency', 'deductionAmount', 'remaining'].forEach((col) => {
        const cell = row.getCell(col);
        if (typeof cell.value === 'number') {
          cell.numFmt = '#,##0.00';
          cell.alignment = { horizontal: 'right' };
        }
      });
    }

    // Totals row (if there are records). Column letters map to the
    // new layout — J=companyDisbursed, K=empAgency, O=totalDeducted,
    // P=remaining. Keep them in sync if columns are reordered above.
    if (records.length > 0) {
      const dataStart = 2;
      const dataEnd   = records.length + 1;
      sheet.addRow({});  // spacer
      const totalsRow = sheet.addRow({
        id:              'TOTALS',
        companyDisbursed: { formula: `SUM(J${dataStart}:J${dataEnd})` },
        empAgency:        { formula: `SUM(K${dataStart}:K${dataEnd})` },
        deductionAmount:  { formula: `SUM(O${dataStart}:O${dataEnd})` },
        remaining:        { formula: `SUM(P${dataStart}:P${dataEnd})` },
      });
      totalsRow.eachCell((cell) => {
        cell.font = { bold: true };
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEFF6FF' } };
      });
      ['J', 'K', 'O', 'P'].forEach((col) => {
        const cell = totalsRow.getCell(col);
        cell.numFmt = '#,##0.00';
      });
    }

    // Auto-filter on header row
    sheet.autoFilter = {
      from: { row: 1, column: 1 },
      to:   { row: 1, column: sheet.columnCount },
    };

    // ── Deductions sheet ─────────────────────────────────────────────────────
    // One line per partial deduction so finance can pivot / filter /
    // reconcile against payroll runs directly in Excel.
    const dedCol = (key: string) => tServer(`finance.deductionColumns.${key}`, {}, locale, 'exports');
    const dedSheet = workbook.addWorksheet(tServer('finance.deductionsSheetName', {}, locale, 'exports'), {
      views: [{ state: 'frozen', ySplit: 1 }],
    });
    dedSheet.columns = [
      { header: dedCol('id'),                key: 'id',                width: 38 },
      { header: dedCol('recordId'),          key: 'recordId',          width: 38 },
      { header: dedCol('entityName'),        key: 'entityName',        width: 24 },
      { header: dedCol('transactionType'),   key: 'transactionType',   width: 24 },
      { header: dedCol('description'),       key: 'description',       width: 30 },
      { header: dedCol('currency'),          key: 'currency',          width: 10 },
      { header: dedCol('amount'),            key: 'amount',            width: 18 },
      { header: dedCol('deductionDate'),     key: 'deductionDate',     width: 16 },
      { header: dedCol('payrollReference'),  key: 'payrollReference',  width: 20 },
      { header: dedCol('notes'),             key: 'notes',             width: 30 },
      { header: dedCol('loggedBy'),          key: 'loggedBy',          width: 22 },
      { header: dedCol('loggedAt'),          key: 'loggedAt',          width: 18 },
    ];
    dedSheet.getRow(1).eachCell((cell) => {
      cell.font      = { bold: true, color: { argb: 'FFFFFFFF' } };
      cell.fill      = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF59E0B' } };
      cell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
      cell.border    = { bottom: { style: 'thin', color: { argb: 'FFB45309' } } };
    });
    dedSheet.getRow(1).height = 28;

    let dedCount = 0;
    for (const rec of records as any[]) {
      for (const d of (rec.deductions ?? []) as any[]) {
        const row = dedSheet.addRow({
          id:               d.id,
          recordId:         rec.id,
          entityName:       rec.entityName ?? '',
          transactionType:  rec.transactionType,
          description:      rec.description ?? '',
          currency:         rec.currency,
          amount:           Number(d.amount ?? 0),
          deductionDate:    d.deductionDate ? formatDisplayDate(d.deductionDate) : '',
          payrollReference: d.payrollReference ?? '',
          notes:            d.notes ?? '',
          loggedBy:         d.createdBy ? `${d.createdBy.firstName ?? ''} ${d.createdBy.lastName ?? ''}`.trim() : '',
          loggedAt:         d.createdAt ? formatDisplayDate(d.createdAt) : '',
        });
        const amt = row.getCell('amount');
        amt.numFmt    = '#,##0.00';
        amt.alignment = { horizontal: 'right' };
        dedCount++;
      }
    }

    if (dedCount > 0) {
      const dataStart = 2;
      const dataEnd   = dedCount + 1;
      dedSheet.addRow({});
      const totalsRow = dedSheet.addRow({
        id:     'TOTAL',
        amount: { formula: `SUM(G${dataStart}:G${dataEnd})` },
      });
      totalsRow.eachCell((cell) => {
        cell.font = { bold: true };
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFEF3C7' } };
      });
      totalsRow.getCell('G').numFmt = '#,##0.00';
    } else {
      dedSheet.addRow({ id: 'No deductions recorded.' });
    }

    dedSheet.autoFilter = {
      from: { row: 1, column: 1 },
      to:   { row: 1, column: dedSheet.columnCount },
    };

    const buffer = await workbook.xlsx.writeBuffer();
    return Buffer.from(buffer);
  }

  // ── Entity resolution ────────────────────────────────────────────────────────

  /**
   * Batch-resolve entity names for a list of records.
   * Groups IDs by entityType → one query per type → merges back.
   * Includes soft-deleted applicants so names still resolve after conversion.
   */
  private async attachEntityNames(records: any[]): Promise<any[]> {
    const applicantIds = [...new Set(
      records.filter(r => r.entityType === 'APPLICANT').map(r => r.entityId),
    )];
    const employeeIds  = [...new Set(
      records.filter(r => r.entityType === 'EMPLOYEE').map(r => r.entityId),
    )];
    const agencyIds    = [...new Set(
      records.filter(r => r.entityType === 'AGENCY').map(r => r.entityId),
    )];

    const t = this.scope().tenantWhere();
    const [applicants, employees, agencies] = await Promise.all([
      applicantIds.length
        // Include soft-deleted: after conversion the applicant is soft-deleted
        // but the name must still resolve for historical records
        ? this.prisma.applicant.findMany({ // @tenant-reviewed: phase2171-helper-narrowed (pilot mode constrains by tenantId)
            where: { id: { in: applicantIds }, ...t },
            select: { id: true, firstName: true, lastName: true },
          })
        : [],
      employeeIds.length
        ? this.prisma.employee.findMany({ // @tenant-reviewed: phase2171-helper-narrowed (pilot mode constrains by tenantId)
            where: { id: { in: employeeIds }, ...t },
            select: { id: true, firstName: true, lastName: true },
          })
        : [],
      agencyIds.length
        ? this.prisma.agency.findMany({ // @tenant-reviewed: phase2171-helper-narrowed (pilot mode constrains by tenantId)
            where: { id: { in: agencyIds }, ...t },
            select: { id: true, name: true },
          })
        : [],
    ]);

    const applicantMap = new Map<string, string>(applicants.map((a: any) => [a.id, `${a.firstName} ${a.lastName}`] as [string, string]));
    const employeeMap  = new Map<string, string>(employees.map((e: any)  => [e.id, `${e.firstName} ${e.lastName}`] as [string, string]));
    const agencyMap    = new Map<string, string>(agencies.map((g: any)   => [g.id, g.name] as [string, string]));

    return records.map(r => {
      let entityName = 'Unknown';
      if (r.entityType === 'APPLICANT') entityName = applicantMap.get(r.entityId) ?? 'Unknown Applicant';
      else if (r.entityType === 'EMPLOYEE') entityName = employeeMap.get(r.entityId) ?? 'Unknown Employee';
      else if (r.entityType === 'AGENCY') entityName = agencyMap.get(r.entityId) ?? 'Unknown Agency';
      return { ...r, entityName };
    });
  }

  /**
   * Resolve the stable person identity for a new financial record.
   *
   * For APPLICANT entities: applicantId = entityId, stageAtCreation from tier.
   * For EMPLOYEE entities: resolve back to the originating applicant.
   *
   * Also validates the entity exists (throws NotFoundException if not).
   * NOTE: Does NOT filter by deletedAt — converted applicants are soft-deleted
   * but remain the stable person reference.
   */
  private async resolvePersonIdentity(
    entityType: string,
    entityId: string,
  ): Promise<{ applicantId: string | null; stageAtCreation: string }> {
    // Phase 2.17.1 — narrow the entity lookup so a tenant-A caller
    // cannot create a financial record pointing at a tenant-B entity.
    // In pilot mode the tenant filter rejects cross-tenant ids; in
    // legacy mode the spread is `{}` and behaviour is unchanged.
    const t = this.scope().tenantWhere();

    if (entityType === 'APPLICANT') {
      const a = await this.prisma.applicant.findFirst({ // @tenant-reviewed: phase2171-helper-narrowed (cross-tenant create blocked in pilot mode)
        where: { id: entityId, ...t },
        select: { firstName: true, lastName: true, tier: true, deletedAt: true },
      });
      if (!a || (a.deletedAt !== null))
        throw new NotFoundException(`Applicant ${entityId} not found or has been converted`);
      const stageAtCreation = (a.tier as string) === 'LEAD' ? 'LEAD' : 'CANDIDATE';
      return { applicantId: entityId, stageAtCreation };
    }

    if (entityType === 'EMPLOYEE') {
      const e = await this.prisma.employee.findFirst({ // @tenant-reviewed: phase2171-helper-narrowed (cross-tenant create blocked in pilot mode)
        where: { id: entityId, deletedAt: null, ...t },
        select: { firstName: true, lastName: true },
      });
      if (!e) throw new NotFoundException(`Employee ${entityId} not found`);

      // Try to find the originating applicant via convertedToEmployeeId
      const originApplicant = await this.prisma.applicant.findFirst({ // @tenant-reviewed: phase2171-helper-narrowed (pilot mode constrains by tenantId)
        where: { convertedToEmployeeId: entityId, ...t },
        select: { id: true },
      });

      return {
        applicantId: originApplicant?.id ?? null,
        stageAtCreation: 'EMPLOYEE',
      };
    }

    if (entityType === 'AGENCY') {
      // Agencies are not persons — no applicantId, no lifecycle stage.
      // Verify the agency exists so we don't orphan records on bad IDs.
      const ag = await this.prisma.agency.findFirst({ // @tenant-reviewed: phase2171-helper-narrowed (cross-tenant create blocked in pilot mode)
        where: { id: entityId, ...t },
        select: { id: true, deletedAt: true },
      });
      if (!ag || ag.deletedAt !== null) throw new NotFoundException(`Agency ${entityId} not found`);
      return { applicantId: null, stageAtCreation: 'AGENCY' };
    }

    throw new BadRequestException('Invalid entityType');
  }

  // ── Notification helpers ──────────────────────────────────────────────────────

  /** Resolve a short entity name for notification messages. */
  private async resolveEntityNameForNotif(entityType: string, entityId: string): Promise<string> {
    // Phase 2.17.1 — narrow by tenant in pilot mode. The callers
    // (`create` etc.) hand us entityIds from already tenant-filtered
    // records, but defending in depth keeps a future caller from
    // leaking a cross-tenant name into a notification body.
    const t = this.scope().tenantWhere();
    try {
      if (entityType === 'APPLICANT') {
        const a = await this.prisma.applicant.findFirst({ where: { id: entityId, ...t }, select: { firstName: true, lastName: true } }); // @tenant-reviewed: phase2171-helper-narrowed
        return a ? `${a.firstName} ${a.lastName}` : 'Unknown';
      }
      if (entityType === 'EMPLOYEE') {
        const e = await this.prisma.employee.findFirst({ where: { id: entityId, ...t }, select: { firstName: true, lastName: true } }); // @tenant-reviewed: phase2171-helper-narrowed
        return e ? `${e.firstName} ${e.lastName}` : 'Unknown';
      }
      if (entityType === 'AGENCY') {
        const ag = await this.prisma.agency.findFirst({ where: { id: entityId, ...t }, select: { name: true } }); // @tenant-reviewed: phase2171-helper-narrowed
        return ag?.name ?? 'Unknown Agency';
      }
    } catch { /* ignore */ }
    return 'Unknown';
  }

  /**
   * Check if the current balance for an entity exceeds the high-balance threshold.
   * Fires FINANCIAL_HIGH_BALANCE notification if it does and no alert was sent in the last 24h.
   *
   * Threshold is read from SystemSetting 'notifications.highBalanceThreshold' (value in EUR).
   * Falls back to DEFAULT_HIGH_BALANCE_THRESHOLD (500 EUR).
   *
   * Spam prevention: only one alert per entity per 24 hours.
   */
  private async checkAndNotifyHighBalance(entityType: string, entityId: string): Promise<void> {
    const totals = await this.getTotals(entityType, entityId);
    if (totals.currentBalance <= 0) return;

    // Read threshold from system settings (if configured)
    let threshold = DEFAULT_HIGH_BALANCE_THRESHOLD;
    try {
      const setting = await this.legacyPrisma.systemSetting.findUnique({ // @tenant-reviewed: phase216-global
        where: { key: 'notifications.highBalanceThreshold' },
        select: { value: true },
      });
      if (setting) threshold = parseFloat(setting.value) || DEFAULT_HIGH_BALANCE_THRESHOLD;
    } catch { /* use default */ }

    if (totals.currentBalance < threshold) return;

    // Spam guard
    const alreadySent = await this.notifications.wasHighBalanceAlertRecentlySent(entityId);
    if (alreadySent) return;

    const entityName = await this.resolveEntityNameForNotif(entityType, entityId);
    const amountStr = totals.currentBalance.toFixed(2);
    await this.notifications.notifyUsersByRoles(
      FINANCE_ROLES,
      NOTIF_EVENTS.FINANCIAL_HIGH_BALANCE,
      'High Balance Alert',
      `Outstanding balance for ${entityName} has reached ${amountStr} EUR (threshold: ${threshold} EUR).`,
      entityType,
      entityId,
      {
        titleKey: 'events.financeHighBalance.title',
        messageKey: 'events.financeHighBalance.body',
        params: { entityName, amount: amountStr, threshold },
      },
    );
  }

  // ── Audit ────────────────────────────────────────────────────────────────────

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
      entity: 'FinancialRecord',
      entityId,
      changes,
    });
  }
}
