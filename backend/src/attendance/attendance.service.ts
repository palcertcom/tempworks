import { Injectable, NotFoundException, BadRequestException, ForbiddenException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { PilotPrismaAccessor } from '../saas/prisma/pilot-prisma.accessor';
import { getPilotScope, PilotScope } from '../saas/prisma/tenant-pilot-scope';
import { buildSuperUserTenantWhereDirect, assertRequestedTenantExists } from '../saas/prisma/super-user-tenant-filter';
import { TenantAuditLogService } from '../saas/audit/tenant-audit-log.service';
import { PaginatedResponse } from '../common/dto/pagination-response.dto';
import { tServer, ServerLocale } from '../common/i18n/server-translate';
import * as ExcelJS from 'exceljs';
import {
  FilterAttendanceEmployeesDto,
  GetEmployeeAttendanceDto,
  UpsertAttendanceDto,
  UpdateAttendanceDto,
  ExportAttendanceDto,
  BulkUpsertAttendanceDto,
  BulkApplyAttendanceDto,
  LockPeriodDto,
  ATTENDANCE_STATUSES,
} from './dto/attendance.dto';
import { v4 as uuidv4 } from 'uuid';

// ── Calculation rules (Phase 3 #29) ───────────────────────────────────────────

/**
 * Statuses for which the employee was not on the clock. Working hours
 * must be 0 and the time fields (checkIn/Out, breakIn/Out, interruption*)
 * are persisted as NULL so a later edit can't compound stale values.
 *
 * Keep in sync with frontend `NON_WORKING_STATUSES` if reused there.
 */
export const NON_WORKING_STATUSES: readonly string[] = [
  'OFF', 'VACATION', 'SICK', 'ABSENT',
  'HOLIDAY', 'ON_LEAVE', 'UNPAID_LEAVE', 'PAID_LEAVE',
];

export function isNonWorkingStatus(status: string | null | undefined): boolean {
  return !!status && NON_WORKING_STATUSES.includes(String(status));
}

interface RawAttendanceInput {
  status: string;
  checkIn?: string | null;
  checkOut?: string | null;
  breakIn?: string | null;
  breakOut?: string | null;
  interruptionIn?: string | null;
  interruptionOut?: string | null;
  interruptionStatus?: string | null;
}
interface NormalizedAttendance {
  status: string;
  checkIn: string | null;
  checkOut: string | null;
  breakIn: string | null;
  breakOut: string | null;
  interruptionIn: string | null;
  interruptionOut: string | null;
  interruptionStatus: string | null;
  workingHours: number;
}

/**
 * Single source of truth for what gets persisted to an AttendanceRecord
 * row given a raw create/update payload. Applied symmetrically by
 * `upsertRecord` and `updateRecord` so editing the same record N times
 * yields a deterministic result.
 *
 *   • Non-working status (sick/paid leave/vacation/holiday/off/…) →
 *     workingHours = 0 AND every time/interruption column is nulled.
 *     This is the fix for the "kept old interruption/leave values after
 *     status changes" + "deducts hours more than once" report (#29):
 *     stale checkIn/breakIn/interruption values would otherwise get
 *     re-merged on the next edit and re-deduct.
 *   • Working status (PRESENT/LATE/HALF_DAY) → workingHours is
 *     recalculated from the canonical time fields via the injected
 *     `calc` function; clamped to ≥ 0; stored to 2 decimals (the
 *     existing `calcWorkingHours` already rounds).
 *
 * The function is injected with the host's `calcWorkingHours` so the
 * formula stays in one place; we just enforce the surrounding policy
 * here.
 */
export function normalizeAttendancePayload(
  input: RawAttendanceInput,
  calc: (
    checkIn?: string | null,
    checkOut?: string | null,
    breakIn?: string | null,
    breakOut?: string | null,
    interruptionIn?: string | null,
    interruptionOut?: string | null,
  ) => number | null,
): NormalizedAttendance {
  const status = input.status;
  if (isNonWorkingStatus(status)) {
    return {
      status,
      checkIn: null, checkOut: null,
      breakIn: null, breakOut: null,
      interruptionIn: null, interruptionOut: null,
      interruptionStatus: null,
      workingHours: 0,
    };
  }
  const hours = calc(
    input.checkIn ?? null, input.checkOut ?? null,
    input.breakIn ?? null, input.breakOut ?? null,
    input.interruptionIn ?? null, input.interruptionOut ?? null,
  );
  const safeHours = hours == null ? 0 : Math.max(0, hours);
  return {
    status,
    checkIn:            input.checkIn            ?? null,
    checkOut:           input.checkOut           ?? null,
    breakIn:            input.breakIn            ?? null,
    breakOut:           input.breakOut           ?? null,
    interruptionIn:     input.interruptionIn     ?? null,
    interruptionOut:    input.interruptionOut    ?? null,
    interruptionStatus: input.interruptionStatus ?? null,
    workingHours:       safeHours,
  };
}

// ── Status display helpers ────────────────────────────────────────────────────

const STATUS_ABBR: Record<string, string> = {
  PRESENT:  'P',
  ABSENT:   'A',
  OFF:      'O',
  VACATION: 'V',
  SICK:     'S',
  UNPAID_LEAVE: 'NV',
  // Phase 2B (#1) — Paid Leave (Slovak: Platené voľno).
  PAID_LEAVE: 'PV',
  // Legacy values — rendered compactly so existing rows still display
  // until they're edited/replaced.
  LATE:     'L',
  ON_LEAVE: 'OL',
  HALF_DAY: 'HD',
  HOLIDAY:  'H',
};

/** bg ARGB, fg ARGB */
const STATUS_COLORS: Record<string, { bg: string; fg: string }> = {
  PRESENT:  { bg: 'FFD1FAE5', fg: 'FF065F46' },
  ABSENT:   { bg: 'FFFEE2E2', fg: 'FF991B1B' },
  OFF:      { bg: 'FFF3F4F6', fg: 'FF374151' },
  VACATION: { bg: 'FFDBEAFE', fg: 'FF1E40AF' },
  SICK:     { bg: 'FFEDE9FE', fg: 'FF5B21B6' },
  UNPAID_LEAVE: { bg: 'FFFEE2E2', fg: 'FF991B1B' },
  // Phase 2B (#1) — Paid Leave colour: soft amber, distinct from SICK/UNPAID.
  PAID_LEAVE: { bg: 'FFFEF3C7', fg: 'FF92400E' },
  LATE:     { bg: 'FFFEF3C7', fg: 'FF92400E' },
  ON_LEAVE: { bg: 'FFDBEAFE', fg: 'FF1E40AF' },
  HALF_DAY: { bg: 'FFEDE9FE', fg: 'FF5B21B6' },
  HOLIDAY:  { bg: 'FFF3F4F6', fg: 'FF374151' },
};

/**
 * Phase 2.47 — Attendance reads-first TenantPrisma pilot.
 *
 * READ paths (`listEmployeesWithStats`, `getEmployeeAttendance`) route
 * through `pilot.client()` and spread `scope.tenantWhere()` into both
 * the parent `Employee` lookup and the child `AttendanceRecord`
 * queries (since `AttendanceRecord.tenantId` is denormalised, Phase
 * 2.3). Production default (flag off) is byte-identical to pre-2.47.
 *
 * WRITE / mutation / bulk / lock / export paths
 * (`upsertRecord`, `bulkUpsert`, `bulkApply`, `updateRecord`,
 * `deleteRecord`, `lockPeriod`, `unlockPeriod`, `exportExcel`) remain
 * on `legacyPrisma` and are explicitly out of scope for Phase 2.47 —
 * they are deferred to a follow-up mutation phase.
 *
 * `AttendanceLockedPeriod` is intentionally global (no `tenantId`
 * column per the schema comment) so `listLockedPeriods` is left
 * unchanged. Audit emission via `legacyPrisma.auditLog.create` stays
 * on the legacy path; routing through `TenantAuditLogService` is
 * deferred to the mutation phase.
 */
@Injectable()
export class AttendanceService {
  constructor(
    private legacyPrisma: PrismaService,
    private pilot: PilotPrismaAccessor,
    private tenantAuditLog: TenantAuditLogService,
  ) {}

  /** Pilot-aware Prisma surface used by READ paths only. Mutation
   *  paths use `legacyPrisma` directly. */
  private get prisma(): PrismaService {
    return this.pilot.client();
  }

  private scope(): PilotScope {
    return getPilotScope(this.pilot, 'attendance');
  }

  /**
   * Phase 3.18 — caller-driven tenant filter. PlatformAdmin bypasses
   * the filter; everyone else sees only their own tenant's employees.
   * Falls back to `{}` when no tenant context is present so legacy
   * single-tenant deployments behave exactly like before.
   *
   * Phase 3.22 — also short-circuit to `{}` when the pilot scope is
   * INACTIVE (MULTI_TENANT_ENABLED=false or the module isn't on the
   * allow-list). Pilot-off employees are created with `tenantId=null`,
   * and applying a strict `{ tenantId: caller.tenantId }` filter would
   * exclude every one of them — making the Attendance Sheets page
   * report "0 employees" while the /employees list (which uses only
   * `scope().tenantWhere()`) shows them all. In pilot-off mode the
   * legacy single-tenant deployment is implicitly tenant-isolated,
   * so this extra filter adds no security and breaks the read.
   * @tenant-reviewed: phase318-tenant-public-jobs
   */
  private callerTenantWhere(caller: any): Record<string, any> {
    if (!caller) return {};
    if (caller.agencyIsSystem) return {};
    if (!this.scope().active) return {};
    const t = caller.tenantId;
    if (!t) return {};
    return { tenantId: t };
  }

  /** Mutation parent gate. Loads the employee through the pilot
   *  client with `tenantWhere()` so cross-tenant ids raise 404 when
   *  the pilot is active. Legacy mode (`tenantWhere() === {}`) reduces
   *  to a plain by-id lookup — byte-identical to pre-2.47. */
  private async findEmployeeForMutationOrFail(employeeId: string) {
    const t = this.scope().tenantWhere();
    const e = await this.prisma.employee.findFirst({ // @tenant-reviewed: phase247-attendance-mutation-scope (parent gate; reduces to by-id lookup with flag off)
      where: { id: employeeId, deletedAt: null, ...t },
      select: { id: true, firstName: true, lastName: true, employeeNumber: true },
    });
    if (!e) throw new NotFoundException(`Employee ${employeeId} not found`);
    return e;
  }

  /** Mutation parent gate for an existing AttendanceRecord by id. */
  private async findRecordForMutationOrFail(id: string, caller?: any) {
    const t = this.scope().tenantWhere();
    const r = await (this.prisma as any).attendanceRecord.findFirst({ // @tenant-reviewed: phase247-attendance-mutation-scope (parent gate)
      where: { id, ...t, ...this.callerTenantWhere(caller) },
    });
    if (!r) throw new NotFoundException(`Attendance record ${id} not found`);
    // Phase 2B (#36) — external agency users (Agency Manager etc.) may
    // only mutate attendance for employees in their OWN agency. SUPER
    // and System Admin (agencyIsSystem) keep the global view.
    if (caller && !caller.agencyIsSystem && caller.agencyId) {
      const emp = await this.prisma.employee.findUnique({
        where: { id: r.employeeId },
        select: { agencyId: true },
      });
      if (!emp || emp.agencyId !== caller.agencyId) {
        throw new ForbiddenException('You can only edit attendance for employees in your own agency');
      }
    }
    return r;
  }

  // ── List employees with attendance stats ─────────────────────────────────────

  async listEmployeesWithStats(dto: FilterAttendanceEmployeesDto, caller?: any): Promise<PaginatedResponse<any>> {
    const {
      page = 1,
      limit = 20,
      search,
      dateFrom,
      dateTo,
      month,
      year,
      status,
      driversOnly,
      agencyId,
    } = dto;

    const skip = (Number(page) - 1) * Number(limit);

    // Phase F2 (SPIKE-010 Batch 2) — SUPER USER tenant override.
    await assertRequestedTenantExists(caller, (dto as any).tenantId, this.legacyPrisma.tenant);
    const superTenantPredicate = buildSuperUserTenantWhereDirect(caller, (dto as any).tenantId);

    // Build employee where clause
    const tenantWhere = this.scope().tenantWhere();
    const where: any = { deletedAt: null, ...tenantWhere, ...this.callerTenantWhere(caller) }; // @tenant-reviewed: phase318-tenant-public-jobs
    if (superTenantPredicate) where.AND = [...(where.AND ?? []), superTenantPredicate];

    // Phase 3.22 — external actors (Agency User/Manager + any custom
    // role tied to a non-system agency) must see only employees they
    // have an EmployeeAgencyAccess grant for, mirroring
    // EmployeesService.findAll. Without this, Officer's Attendance
    // Sheets page listed every employee in the tenant — including
    // ones never granted to TempWorks — and the /employees list
    // (with the grant filter) showed only 2.
    if (caller && caller.agencyId && caller.agencyIsSystem !== true) {
      const grants = await this.prisma.employeeAgencyAccess.findMany({ // @tenant-reviewed: phase322-attendance-agency-access (relation by employeeId; gated parents are tenant-scoped)
        where: { agencyId: caller.agencyId, canView: true },
        select: { employeeId: true },
      });
      const allowedIds = grants.map((g: any) => g.employeeId);
      if (allowedIds.length === 0) {
        return PaginatedResponse.create([], 0, page, limit);
      }
      where.id = { in: allowedIds };
    }

    if (agencyId) where.agencyId = agencyId;

    if (driversOnly) {
      where.OR = [
        { licenseNumber: { not: null } },
        { licenseCategory: { not: null } },
      ];
    }

    if (search) {
      const searchConditions = [
        { firstName:      { contains: search, mode: 'insensitive' } },
        { lastName:       { contains: search, mode: 'insensitive' } },
        { email:          { contains: search, mode: 'insensitive' } },
        { employeeNumber: { contains: search, mode: 'insensitive' } },
        { licenseCategory: { contains: search, mode: 'insensitive' } },
      ];
      if (where.OR) {
        // driversOnly already sets OR — wrap both in AND
        where.AND = [{ OR: where.OR }, { OR: searchConditions }];
        delete where.OR;
      } else {
        where.OR = searchConditions;
      }
    }

    const [employees, total] = await Promise.all([
      this.prisma.employee.findMany({ // @tenant-reviewed: phase247-attendance-pilot-scope (parent gate via where = {..., ...tenantWhere})
        where,
        skip,
        take: Number(limit),
        orderBy: [{ lastName: 'asc' }, { firstName: 'asc' }],
        select: {
          id:              true,
          employeeNumber:  true,
          firstName:       true,
          lastName:        true,
          email:           true,
          photoUrl:        true,
          licenseNumber:   true,
          licenseCategory: true,
          status:          true,
          agencyId:        true,
          // Phase 3.22 — include the agency relation so the frontend
          // can render the agency name. Previously only agencyId (UUID)
          // came back, and the AttendanceList table fell back to
          // rendering "Direct" for every row.
          agency: { select: { id: true, name: true } },
        },
      }),
      this.prisma.employee.count({ where }), // @tenant-reviewed: phase247-attendance-pilot-scope
    ]);

    // Compute date range for stats
    let statsFrom: Date | null = null;
    let statsTo:   Date | null = null;

    if (month && year) {
      const range = this.computeDateRange(Number(month), Number(year));
      statsFrom = range.from;
      statsTo   = range.to;
    } else if (dateFrom || dateTo) {
      if (dateFrom) statsFrom = new Date(dateFrom + 'T00:00:00.000Z');
      if (dateTo)   statsTo   = new Date(dateTo   + 'T00:00:00.000Z');
    }

    const zeroStats = {
      presentCount: 0, absentCount: 0, lateCount: 0,
      onLeaveCount: 0, halfDayCount: 0, holidayCount: 0,
      totalWorkingHours: 0, todayStatus: null as string | null,
    };

    // Enrich each employee with attendance stats — wrapped in try/catch so a
    // missing table or Prisma client mismatch never silently kills the list.
    const today = new Date().toISOString().split('T')[0];

    const enriched = await Promise.all(
      employees.map(async (emp) => {
        try {
          const attWhere: any = { employeeId: emp.id, ...tenantWhere }; // @tenant-reviewed: phase247-attendance-pilot-scope (child table also tenantId-denormed)
          if (statsFrom || statsTo) {
            attWhere.date = {};
            if (statsFrom) attWhere.date.gte = statsFrom;
            if (statsTo)   attWhere.date.lte = statsTo;
          }
          if (status) attWhere.status = status;

          const records = await (this.prisma as any).attendanceRecord.findMany({ // @tenant-reviewed: phase247-attendance-pilot-scope
            where: attWhere,
            select: { status: true, workingHours: true, date: true },
          });

          const counts: Record<string, number> = {
            presentCount: 0, absentCount: 0, lateCount: 0,
            onLeaveCount: 0, halfDayCount: 0, holidayCount: 0,
          };
          let totalWorkingHours = 0;
          let todayStatus: string | null = null;

          for (const r of records) {
            const dateStr = r.date instanceof Date
              ? r.date.toISOString().split('T')[0]
              : String(r.date).slice(0, 10);
            if (dateStr === today) todayStatus = r.status;

            switch (r.status) {
              case 'PRESENT':  counts.presentCount++;  break;
              case 'ABSENT':   counts.absentCount++;   break;
              case 'LATE':     counts.lateCount++;     break;
              case 'ON_LEAVE': counts.onLeaveCount++;  break;
              case 'HALF_DAY': counts.halfDayCount++;  break;
              case 'HOLIDAY':  counts.holidayCount++;  break;
            }
            if (r.workingHours) totalWorkingHours += Number(r.workingHours);
          }

          return { ...emp, ...counts, totalWorkingHours, todayStatus };
        } catch {
          return { ...emp, ...zeroStats };
        }
      }),
    );

    return PaginatedResponse.create(enriched, total, Number(page), Number(limit));
  }

  // ── Get single employee attendance ──────────────────────────────────────────

  async getEmployeeAttendance(employeeId: string, dto: GetEmployeeAttendanceDto, caller?: any) {
    const tenantWhere = this.scope().tenantWhere();
    // Phase 3.22 — external actors only see employees they hold an
    // EmployeeAgencyAccess(canView=true) grant for. Mirrors the
    // list endpoint above; without this an Officer could open the
    // attendance tab on an employee they shouldn't see.
    if (caller && caller.agencyId && caller.agencyIsSystem !== true) {
      const grant = await this.prisma.employeeAgencyAccess.findUnique({ // @tenant-reviewed: phase322-attendance-agency-access
        where: { employeeId_agencyId: { employeeId, agencyId: caller.agencyId } },
        select: { canView: true },
      });
      if (!grant?.canView) {
        throw new NotFoundException({ code: 'EMPLOYEE.NOT_FOUND', message: `Employee ${employeeId} not found`, params: { id: employeeId } });
      }
    }
    const employee = await this.prisma.employee.findFirst({ // @tenant-reviewed: phase318-tenant-public-jobs
      where: { id: employeeId, deletedAt: null, ...tenantWhere, ...this.callerTenantWhere(caller) },
      select: {
        id:              true,
        employeeNumber:  true,
        firstName:       true,
        lastName:        true,
        email:           true,
        photoUrl:        true,
        licenseNumber:   true,
        licenseCategory: true,
        status:          true,
        agencyId:        true,
      },
    });
    if (!employee) throw new NotFoundException(`Employee ${employeeId} not found`);

    // Resolve date range — default to current month
    let from: Date;
    let to:   Date;

    if (dto.month && dto.year) {
      const range = this.computeDateRange(Number(dto.month), Number(dto.year));
      from = range.from;
      to   = range.to;
    } else if (dto.dateFrom || dto.dateTo) {
      const now = new Date();
      from = dto.dateFrom ? new Date(dto.dateFrom + 'T00:00:00.000Z') : new Date(now.getUTCFullYear(), now.getUTCMonth(), 1);
      to   = dto.dateTo   ? new Date(dto.dateTo   + 'T00:00:00.000Z') : new Date(now.getUTCFullYear(), now.getUTCMonth() + 1, 0);
    } else {
      // Default: current month
      const now = new Date();
      const range = this.computeDateRange(now.getUTCMonth() + 1, now.getUTCFullYear());
      from = range.from;
      to   = range.to;
    }

    const records = await (this.prisma as any).attendanceRecord.findMany({ // @tenant-reviewed: phase247-attendance-pilot-scope
      where: {
        employeeId,
        date: { gte: from, lte: to },
        ...tenantWhere,
      },
      orderBy: { date: 'asc' },
    });

    // Phase 2C #32 — annotate each row with how many supporting
    // documents are attached AND a lightweight {id, name} list so the
    // timesheet grid can show the paperclip + popover from one round-
    // trip. We deliberately do not call /documents/entity from the
    // frontend because that endpoint's role allowlist differs from
    // attendance:read — a role that can read the sheet (e.g. Officer)
    // would otherwise see the count but get 0 attachments back.
    const recordIds = records.map((r: any) => r.id);
    let docsByRecord: Record<string, Array<{ id: string; name: string }>> = {};
    if (recordIds.length) {
      const docs = await (this.prisma as any).document.findMany({ // @tenant-reviewed: phase2c32-attendance-doc-annot (record ids already tenant-scoped above)
        where: { entityType: 'ATTENDANCE', entityId: { in: recordIds }, deletedAt: null },
        select: { id: true, name: true, entityId: true },
        orderBy: { createdAt: 'asc' },
      });
      for (const d of docs) {
        (docsByRecord[d.entityId] ??= []).push({ id: d.id, name: d.name });
      }
    }
    const recordsWithDocs = records.map((r: any) => ({
      ...r,
      attachments:      docsByRecord[r.id] ?? [],
      attachmentCount: (docsByRecord[r.id] ?? []).length,
    }));

    const summary = this.buildSummaryFromRecords(recordsWithDocs);

    return {
      employee,
      records: recordsWithDocs,
      summary,
      dateRange: {
        from: from.toISOString().split('T')[0],
        to:   to.toISOString().split('T')[0],
      },
    };
  }

  // ── Upsert single record ─────────────────────────────────────────────────────

  async upsertRecord(dto: UpsertAttendanceDto, actorId?: string) {
    // Validate employee through the pilot parent gate (legacy when flag off).
    const employee = await this.findEmployeeForMutationOrFail(dto.employeeId);

    // Validate date format
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dto.date)) {
      throw new BadRequestException('date must be in YYYY-MM-DD format');
    }

    const date = new Date(dto.date + 'T00:00:00.000Z');
    if (isNaN(date.getTime())) {
      throw new BadRequestException(`Invalid date: ${dto.date}`);
    }

    // Refuse writes into a locked month (employee-specific OR legacy global).
    await this.assertPeriodUnlocked(dto.date, dto.employeeId);

    // Ordering guards — so UI-side errors never slip past.
    if (dto.checkIn && dto.checkOut) {
      const ci = this.toMin(dto.checkIn);
      const co = this.toMin(dto.checkOut);
      // Overnight shifts are legal — only fail if both are same-day
      // and out < in AND the delta is small (< 4h) which almost
      // certainly means operator error rather than overnight.
      if (ci != null && co != null && co < ci && (ci - co) < 4 * 60) {
        throw new BadRequestException('Check-out is earlier than Check-in');
      }
    }
    if (dto.breakIn && dto.breakOut) {
      const bi = this.toMin(dto.breakIn);
      const bo = this.toMin(dto.breakOut);
      if (bi != null && bo != null && bo < bi) {
        throw new BadRequestException('Break-out is earlier than Break-in');
      }
    }

    // Phase 3 (#29) — backend is the source of truth for workingHours.
    // We ALWAYS recompute from the four time fields and never trust a
    // value sent by the client (the frontend may show a preview but a
    // stale preview must not be persisted). For non-working statuses
    // the time fields are nulled to prevent stale check-in/break/
    // interruption rows from compounding hours on the next edit.
    const normalized = normalizeAttendancePayload(
      {
        status:             dto.status,
        checkIn:            dto.checkIn,
        checkOut:           dto.checkOut,
        breakIn:            (dto as any).breakIn,
        breakOut:           (dto as any).breakOut,
        interruptionIn:     (dto as any).interruptionIn,
        interruptionOut:    (dto as any).interruptionOut,
        interruptionStatus: (dto as any).interruptionStatus,
      },
      (ci, co, bi, bo, ii, io) => this.calcWorkingHours(ci, co, bi, bo, ii, io),
    );

    const id = uuidv4();
    const tenantData = this.scope().tenantData(); // @tenant-reviewed: phase248-attendance-mutation-pilot (stamps tenantId on create when pilot active)

    const record = await (this.legacyPrisma as any).attendanceRecord.upsert({ // @tenant-reviewed: phase248-attendance-mutation-pilot (tenantData stamped via pilot scope)
      where: {
        employeeId_date: { employeeId: dto.employeeId, date },
      },
      create: {
        id,
        employeeId:   dto.employeeId,
        date,
        status:       normalized.status,
        checkIn:      normalized.checkIn,
        checkOut:     normalized.checkOut,
        breakIn:      normalized.breakIn,
        breakOut:     normalized.breakOut,
        interruptionIn:     normalized.interruptionIn,
        interruptionOut:    normalized.interruptionOut,
        interruptionStatus: normalized.interruptionStatus,
        workingHours: normalized.workingHours,
        notes:        dto.notes        ?? null,
        createdById:  actorId          ?? null,
        updatedById:  null,
        ...tenantData,
      },
      update: {
        status:       normalized.status,
        checkIn:      normalized.checkIn,
        checkOut:     normalized.checkOut,
        breakIn:      normalized.breakIn,
        breakOut:     normalized.breakOut,
        interruptionIn:     normalized.interruptionIn,
        interruptionOut:    normalized.interruptionOut,
        interruptionStatus: normalized.interruptionStatus,
        workingHours: normalized.workingHours,
        notes:        dto.notes        ?? null,
        updatedById:  actorId          ?? null,
        updatedAt:    new Date(),
      },
    });

    await this.auditLog(actorId, 'ATTENDANCE_UPSERTED', record.id, {
      employeeId: dto.employeeId,
      date:       dto.date,
      status:     dto.status,
    });

    return { ...record, employee };
  }

  // ── Bulk upsert ──────────────────────────────────────────────────────────────

  async bulkUpsert(dto: BulkUpsertAttendanceDto, actorId?: string) {
    if (!dto.records || dto.records.length === 0) {
      throw new BadRequestException('records array must not be empty');
    }

    let created = 0;
    let updated = 0;
    const errors: { index: number; error: string; record?: any }[] = [];

    await Promise.all(
      dto.records.map(async (rec, index) => {
        try {
          // Check if record already exists so we can count create vs update
          const date = new Date(rec.date + 'T00:00:00.000Z');
          const existing = await (this.legacyPrisma as any).attendanceRecord.findUnique({ // @tenant-reviewed: phase247-attendance-mutation-scope (bulk mutation precheck on legacy)
            where: { employeeId_date: { employeeId: rec.employeeId, date } },
            select: { id: true },
          });

          await this.upsertRecord(rec, actorId);

          if (existing) {
            updated++;
          } else {
            created++;
          }
        } catch (err: any) {
          errors.push({ index, error: err?.message ?? 'Unknown error', record: rec });
        }
      }),
    );

    return {
      created,
      updated,
      errors,
      total: dto.records.length,
      processed: created + updated,
    };
  }

  // ── Update record ────────────────────────────────────────────────────────────

  async updateRecord(id: string, dto: UpdateAttendanceDto, actorId?: string, caller?: any) {
    const existing = await this.findRecordForMutationOrFail(id, caller);

    // Refuse writes into a locked month (based on the existing row's date).
    const existingDate = new Date(existing.date);
    const y = existingDate.getUTCFullYear();
    const m = existingDate.getUTCMonth() + 1;
    if (await this.isPeriodLocked(y, m, existing.employeeId)) {
      throw new BadRequestException(`Payroll period ${y}-${String(m).padStart(2, '0')} is locked`);
    }

    const newCheckIn  = dto.checkIn  !== undefined ? dto.checkIn  : existing.checkIn;
    const newCheckOut = dto.checkOut !== undefined ? dto.checkOut : existing.checkOut;
    const newBreakIn  = (dto as any).breakIn  !== undefined ? (dto as any).breakIn  : existing.breakIn;
    const newBreakOut = (dto as any).breakOut !== undefined ? (dto as any).breakOut : existing.breakOut;
    const newInterruptionIn     = (dto as any).interruptionIn     !== undefined ? (dto as any).interruptionIn     : (existing as any).interruptionIn;
    const newInterruptionOut    = (dto as any).interruptionOut    !== undefined ? (dto as any).interruptionOut    : (existing as any).interruptionOut;
    const newInterruptionStatus = (dto as any).interruptionStatus !== undefined ? (dto as any).interruptionStatus : (existing as any).interruptionStatus;
    const newStatus   = dto.status   !== undefined ? dto.status   : existing.status;

    // Re-validate ordering with the merged values.
    if (newCheckIn && newCheckOut) {
      const ci = this.toMin(newCheckIn), co = this.toMin(newCheckOut);
      if (ci != null && co != null && co < ci && (ci - co) < 4 * 60) {
        throw new BadRequestException('Check-out is earlier than Check-in');
      }
    }
    if (newBreakIn && newBreakOut) {
      const bi = this.toMin(newBreakIn), bo = this.toMin(newBreakOut);
      if (bi != null && bo != null && bo < bi) {
        throw new BadRequestException('Break-out is earlier than Break-in');
      }
    }

    // Phase 3 (#29) — recompute from the MERGED canonical inputs and
    // never trust a client-supplied workingHours value. For non-working
    // statuses (sick/paid leave/vacation/etc.) we also null the time
    // and interruption columns so the next edit can't compound stale
    // values into another deduction.
    const normalized = normalizeAttendancePayload(
      {
        status:             newStatus,
        checkIn:            newCheckIn,
        checkOut:           newCheckOut,
        breakIn:            newBreakIn,
        breakOut:           newBreakOut,
        interruptionIn:     newInterruptionIn,
        interruptionOut:    newInterruptionOut,
        interruptionStatus: newInterruptionStatus,
      },
      (ci, co, bi, bo, ii, io) => this.calcWorkingHours(ci, co, bi, bo, ii, io),
    );

    const data: any = {
      updatedAt: new Date(),
      updatedById: actorId ?? null,
      status:             normalized.status,
      checkIn:            normalized.checkIn,
      checkOut:           normalized.checkOut,
      breakIn:            normalized.breakIn,
      breakOut:           normalized.breakOut,
      interruptionIn:     normalized.interruptionIn,
      interruptionOut:    normalized.interruptionOut,
      interruptionStatus: normalized.interruptionStatus,
      workingHours:       normalized.workingHours,
    };
    if (dto.notes !== undefined) data.notes = dto.notes;

    const updated = await (this.legacyPrisma as any).attendanceRecord.update({ // @tenant-reviewed: phase247-attendance-mutation-scope
      where: { id },
      data,
    });

    await this.auditLog(actorId, 'ATTENDANCE_UPDATED', id, dto as any);
    return updated;
  }

  // ── Delete record ────────────────────────────────────────────────────────────

  async deleteRecord(id: string, actorId?: string, caller?: any) {
    const existing = await this.findRecordForMutationOrFail(id, caller);

    const existingDate = new Date(existing.date);
    const y = existingDate.getUTCFullYear();
    const m = existingDate.getUTCMonth() + 1;
    if (await this.isPeriodLocked(y, m, existing.employeeId)) {
      throw new BadRequestException(`Payroll period ${y}-${String(m).padStart(2, '0')} is locked`);
    }

    await (this.legacyPrisma as any).attendanceRecord.delete({ where: { id } }); // @tenant-reviewed: phase247-attendance-mutation-scope

    await this.auditLog(actorId, 'ATTENDANCE_DELETED', id, {
      employeeId: existing.employeeId,
      date:       existing.date,
      status:     existing.status,
    });

    return { message: 'Attendance record deleted' };
  }

  // ── Delete a single proof attachment ─────────────────────────────────────
  /**
   * Soft-delete one document attached to an attendance record. Tenant /
   * agency gating reuses the same record predicate as the row mutation
   * paths; the document is verified to belong to that attendance row
   * before it is touched.
   */
  async deleteAttachment(
    recordId: string,
    documentId: string,
    actorId?: string,
    caller?: any,
  ) {
    const existing = await this.findRecordForMutationOrFail(recordId, caller);

    const doc = await (this.prisma as any).document.findFirst({
      where: {
        id: documentId,
        entityType: 'ATTENDANCE',
        entityId: recordId,
        deletedAt: null,
      },
      select: { id: true, name: true },
    });
    if (!doc) throw new NotFoundException(`Attachment ${documentId} not found on attendance record ${recordId}`);

    await (this.legacyPrisma as any).document.update({
      where: { id: documentId },
      data: { deletedAt: new Date(), deletedBy: actorId ?? null },
    });

    await this.auditLog(actorId, 'ATTENDANCE_ATTACHMENT_DELETED', recordId, {
      employeeId: existing.employeeId,
      documentId,
      documentName: doc.name,
    });

    return { message: 'Attendance attachment deleted', documentId };
  }

  // ── Reset month for a single employee ────────────────────────────────────
  /**
   * Hard-delete every attendance record for one employee within one month.
   * Tenant- and agency-scoped: the employee must be visible to the caller
   * via the same predicate the regular employee lookup uses. A locked
   * payroll period blocks the reset. Returns the deleted-row count.
   *
   * Only the specified (employeeId, year, month) tuple is touched —
   * no other employee or month is affected.
   */
  async resetEmployeeMonth(
    employeeId: string,
    year: number,
    month: number,
    caller: any,
    actorId?: string,
  ): Promise<{ message: string; deleted: number }> {
    if (!employeeId) throw new BadRequestException({ code: 'ATTENDANCE.EMPLOYEE_REQUIRED', message: 'employeeId is required' });
    if (!Number.isInteger(year) || year < 2000 || year > 2100) {
      throw new BadRequestException({ code: 'ATTENDANCE.YEAR_INVALID', message: 'year is invalid' });
    }
    if (!Number.isInteger(month) || month < 1 || month > 12) {
      throw new BadRequestException({ code: 'ATTENDANCE.MONTH_INVALID', message: 'month must be between 1 and 12' });
    }

    // Tenant/agency-scoped employee lookup. A caller who cannot see this
    // employee can never reset their attendance — same as the read path.
    const tenantWhere = this.scope().tenantWhere();
    const employee = await this.prisma.employee.findFirst({ // @tenant-reviewed: phase248-attendance-reset-scope
      where: { id: employeeId, deletedAt: null, ...tenantWhere, ...this.callerTenantWhere(caller) },
      select: { id: true, firstName: true, lastName: true, employeeNumber: true, agencyId: true },
    });
    if (!employee) {
      throw new NotFoundException({ code: 'EMPLOYEE.NOT_FOUND', message: `Employee ${employeeId} not found`, params: { id: employeeId } });
    }

    if (await this.isPeriodLocked(year, month, employeeId)) {
      throw new BadRequestException({
        code: 'ATTENDANCE.PERIOD_LOCKED',
        message: `Payroll period ${year}-${String(month).padStart(2, '0')} is locked`,
        params: { year, month },
      });
    }

    // Inclusive-exclusive range covering the whole month in UTC, matching
    // how single records are stored (date column is the day in UTC).
    const start = new Date(Date.UTC(year, month - 1, 1));
    const end = new Date(Date.UTC(year, month, 1));
    const { count } = await (this.legacyPrisma as any).attendanceRecord.deleteMany({ // @tenant-reviewed: phase248-attendance-mutation-scope (employee ownership gated above)
      where: { employeeId, date: { gte: start, lt: end } },
    });

    await this.auditLog(actorId, 'ATTENDANCE_MONTH_RESET', employeeId, {
      employeeId,
      employeeNumber: employee.employeeNumber,
      name: `${employee.firstName ?? ''} ${employee.lastName ?? ''}`.trim(),
      year, month, deleted: count,
    });

    return { message: `Reset ${count} attendance record(s)`, deleted: count };
  }

  // ── Excel Export (Zeiterfassung template) ──────────────────────────────────

  /** Builds one Zeiterfassung sheet per employee in the workbook,
   *  matching the structure of the supplied template:
   *    row 1       : title "Zeiterfassung" (merged)
   *    row 2       : Zamestnanec / employee name
   *    row 3       : Mitarbeiter, Monat/Jahr — month + year label
   *    rows 4-5    : bilingual column headers
   *    rows 6..    : one row per day of the month (check-in, out,
   *                  break-in, out, 2nd-session in/out reserved,
   *                  total)
   *    totals rows : Odpracované (working), sviatok (holiday),
   *                  Spolu Odpracovan (working + holiday),
   *                  dovolenka (vacation), absencia (absence),
   *                  choroba (sick), Spolu (grand total all hours)
   */
  private buildZeiterfassungSheet(
    workbook: ExcelJS.Workbook,
    employee: { firstName: string; lastName: string; employeeNumber?: string | null },
    month: number, year: number,
    dayMap: Map<number, any>,
    companyProfile?: any,
  ) {
    const MONTH_SK = ['Jan', 'Feb', 'Mar', 'Apr', 'Maj', 'Jun', 'Jul', 'Aug', 'Sep', 'Okt', 'Nov', 'Dec'];
    const daysInMonth = new Date(year, month, 0).getDate();
    const fullName = [employee.firstName, employee.lastName].filter(Boolean).join(' ');
    const monthLabel = `${MONTH_SK[month - 1]} ${year}`;
    const sheetName = (fullName || 'Timesheet').slice(0, 31);

    const sheet = workbook.addWorksheet(sheetName, {
      pageSetup: { paperSize: 9, orientation: 'portrait', fitToPage: true, fitToWidth: 1 },
    });

    sheet.columns = [
      { width: 5 }, { width: 9 }, { width: 9 },
      { width: 11 }, { width: 11 },
      { width: 11 }, { width: 11 },
      { width: 10 },
    ];

    // ── Optional company header (selected Company Export Profile) ──
    let topOffset = 0;
    if (companyProfile) {
      let r = 1;
      sheet.mergeCells(`A${r}:H${r}`);
      const c = sheet.getCell(`A${r}`);
      c.value = companyProfile.legalName || companyProfile.name;
      c.alignment = { horizontal: 'left', vertical: 'middle' };
      c.font = { bold: true, size: 14, color: { argb: 'FF0F172A' } };
      sheet.getRow(r).height = 22;
      r++;

      const addrParts: string[] = [];
      if (companyProfile.addressLine1) addrParts.push(companyProfile.addressLine1);
      if (companyProfile.addressLine2) addrParts.push(companyProfile.addressLine2);
      if (companyProfile.postalCode || companyProfile.city) {
        addrParts.push([companyProfile.postalCode, companyProfile.city].filter(Boolean).join(' '));
      }
      if (companyProfile.country) addrParts.push(companyProfile.country);
      if (addrParts.length > 0) {
        sheet.mergeCells(`A${r}:H${r}`);
        sheet.getCell(`A${r}`).value = addrParts.join(' · ');
        sheet.getCell(`A${r}`).font  = { size: 9, color: { argb: 'FF475569' } };
        r++;
      }

      const contactParts: string[] = [];
      if (companyProfile.phone) contactParts.push(`Tel: ${companyProfile.phone}`);
      if (companyProfile.email) contactParts.push(companyProfile.email);
      if (companyProfile.vatNumber) contactParts.push(`VAT: ${companyProfile.vatNumber}`);
      if (companyProfile.registrationNumber) contactParts.push(`Reg: ${companyProfile.registrationNumber}`);
      if (contactParts.length > 0) {
        sheet.mergeCells(`A${r}:H${r}`);
        sheet.getCell(`A${r}`).value = contactParts.join(' · ');
        sheet.getCell(`A${r}`).font  = { size: 9, color: { argb: 'FF475569' } };
        r++;
      }

      r++; // blank line separator
      topOffset = r - 1;
    }

    // Helper: shift any absolute row index by topOffset so the rest of
    // the function keeps using the original 1-based layout while the
    // company header pushes the whole sheet down.
    const R = (n: number) => n + topOffset;

    sheet.mergeCells(`A${R(1)}:H${R(1)}`);
    const title = sheet.getCell(`A${R(1)}`);
    title.value     = 'Zeiterfassung';
    title.alignment = { horizontal: 'center', vertical: 'middle' };
    title.font      = { bold: true, size: 20, color: { argb: 'FF1E3A8A' } };
    sheet.getRow(R(1)).height = 28;

    sheet.getCell(`A${R(2)}`).value = 'Zamestnanec';
    sheet.getCell(`A${R(2)}`).font  = { bold: true, size: 9 };
    sheet.mergeCells(`B${R(2)}:D${R(2)}`);
    sheet.getCell(`B${R(2)}`).value = fullName || '';

    sheet.getCell(`A${R(3)}`).value = 'Mitarbeiter, Monat/Jahr';
    sheet.getCell(`A${R(3)}`).font  = { bold: true, size: 9 };
    sheet.mergeCells(`B${R(3)}:D${R(3)}`);
    sheet.getCell(`B${R(3)}`).value = monthLabel;

    // Rows 4-5 — bilingual headers (Slovak / German stacked).
    // Font sizes and borders match the printable reference template
    // (size 14 with thin borders on every header + grid cell), not the
    // earlier compact size-9 layout — operators reported the old output
    // was too dense to read on paper.
    const GRID_BORDER: ExcelJS.Borders = {
      top:    { style: 'thin', color: { argb: 'FF000000' } },
      bottom: { style: 'thin', color: { argb: 'FF000000' } },
      left:   { style: 'thin', color: { argb: 'FF000000' } },
      right:  { style: 'thin', color: { argb: 'FF000000' } },
      diagonal: { style: 'thin' },
    } as any;
    const headerRow1 = ['den', 'zac', 'kon', 'zac pres', 'kon pres', 'zac prer', 'kon prer', 'total'];
    const headerRow2 = ['tag', 'beginn', 'ende', 'beginn pause', 'ende pause', 'beginn untrbr', 'ende untrbr', 'total'];
    headerRow1.forEach((t, i) => {
      const cell = sheet.getCell(R(4), i + 1);
      cell.value = t;
      cell.font  = { bold: true, size: 14, color: { argb: 'FF1E40AF' } };
      cell.alignment = { horizontal: 'center', vertical: 'middle' };
      cell.border = GRID_BORDER;
    });
    headerRow2.forEach((t, i) => {
      const cell = sheet.getCell(R(5), i + 1);
      cell.value = t;
      cell.font  = { italic: true, size: 14, color: { argb: 'FF64748B' } };
      cell.alignment = { horizontal: 'center', vertical: 'middle' };
      cell.border = GRID_BORDER;
    });
    sheet.getRow(R(4)).height = 22;
    sheet.getRow(R(5)).height = 22;

    // Rows 6..(5 + daysInMonth) — daily data.
    const dailyStart = R(6);
    const dailyEnd   = dailyStart + daysInMonth - 1;
    const WORK_HOURS_PER_DAY = 8;

    // Per-status totals (in hours).
    let totalPresent      = 0; // Odpracované
    let totalHoliday      = 0; // sviatok
    let totalVacation     = 0; // dovolenka
    let totalUnpaidLeave  = 0; // neplatené voľno
    let totalSick         = 0; // sick leave (lekár)
    let totalPaidLeave    = 0; // Phase 2B (#1) — platené voľno (paid leave)
    let totalAbsent       = 0; // absencia

    const interruptionDurationHrs = (rec: any): number => {
      const i = this.toMin(rec?.interruptionIn);
      const o = this.toMin(rec?.interruptionOut);
      if (i == null || o == null || o <= i) return 0;
      return Math.round(((o - i) / 60) * 100) / 100;
    };

    const bumpStatusTotal = (st: string, hrs: number) => {
      if (hrs <= 0) return;
      switch (st) {
        case 'HOLIDAY':       totalHoliday     += hrs; break;
        case 'VACATION':      totalVacation    += hrs; break;
        case 'UNPAID_LEAVE':  totalUnpaidLeave += hrs; break;
        case 'PAID_LEAVE':    totalPaidLeave   += hrs; break;
        case 'SICK':          totalSick        += hrs; break;
        case 'ABSENT':
        case 'OFF':           totalAbsent      += hrs; break;
      }
    };

    for (let d = 1; d <= daysInMonth; d++) {
      const rec = dayMap.get(d);
      const r   = dailyStart + d - 1;
      sheet.getCell(r, 1).value = d;
      sheet.getCell(r, 1).alignment = { horizontal: 'center', vertical: 'middle' };
      sheet.getCell(r, 1).font = { size: 14 };
      sheet.getCell(r, 1).border = GRID_BORDER;

      if (rec && rec.status === 'PRESENT') {
        // Present day — B/C/D/E are the real times. Interruption (if
        // any) goes into F/G and its duration rolls up into whatever
        // status the user attributed it to. The total in H is the
        // working-hours figure the service already deducted.
        sheet.getCell(r, 2).value = rec.checkIn  ?? '';
        sheet.getCell(r, 3).value = rec.checkOut ?? '';
        sheet.getCell(r, 4).value = rec.breakIn  ?? '';
        sheet.getCell(r, 5).value = rec.breakOut ?? '';
        sheet.getCell(r, 6).value = rec.interruptionIn  ?? '';
        sheet.getCell(r, 7).value = rec.interruptionOut ?? '';

        const hours = Number(rec.workingHours ?? 0);
        sheet.getCell(r, 8).value = this.hoursAsClock(hours);
        totalPresent += hours;

        const interruptHrs = interruptionDurationHrs(rec);
        if (interruptHrs > 0 && rec.interruptionStatus) {
          bumpStatusTotal(rec.interruptionStatus, interruptHrs);
        }
      } else if (rec && ['ABSENT', 'OFF', 'VACATION', 'SICK', 'UNPAID_LEAVE', 'PAID_LEAVE', 'HOLIDAY'].includes(rec.status)) {
        // Full-day leave / absence — actual times stay 0:00 (per the
        // updated reference template's red-line note). Columns F/G are
        // filled with the worked window the leave covered: 08:00–16:00.
        // A non-PRESENT full day has no lunch-break deduction, so the
        // window is a clean 8 hours (08:00–16:00) — unlike a PRESENT day
        // which runs 08:00–16:30 with a 12:00–12:30 break. The row's
        // total in H stays 0; the status total below gets +8h.
        sheet.getCell(r, 2).value = '0:00';
        sheet.getCell(r, 3).value = '0:00';
        sheet.getCell(r, 4).value = '0:00';
        sheet.getCell(r, 5).value = '0:00';
        sheet.getCell(r, 6).value = '08:00';
        sheet.getCell(r, 7).value = '16:00';
        sheet.getCell(r, 8).value = '0:00';
        bumpStatusTotal(rec.status, WORK_HOURS_PER_DAY);
      } else {
        // No record — show 0:00 grid (matches the reference template).
        sheet.getCell(r, 2).value = '0:00';
        sheet.getCell(r, 3).value = '0:00';
        sheet.getCell(r, 4).value = '0:00';
        sheet.getCell(r, 5).value = '0:00';
        sheet.getCell(r, 8).value = '0:00';
      }

      // Formatting — readable font + borders so the printed grid
      // has clean visible cell boundaries (matches the printable
      // reference template).
      for (let c = 2; c <= 8; c++) {
        const cell = sheet.getCell(r, c);
        cell.font      = { size: 14 };
        cell.alignment = { horizontal: 'center', vertical: 'middle' };
        cell.border    = GRID_BORDER;
      }

      // Colorize the whole day line by its status so each status type
      // reads at a glance on the exported/printed sheet — same palette
      // the on-screen Attendance Sheet and the summary grid use. The
      // soft pastel fill keeps the default dark text legible. Days with
      // no record stay white.
      if (rec && STATUS_COLORS[rec.status]) {
        const bg = STATUS_COLORS[rec.status].bg;
        for (let c = 1; c <= 8; c++) {
          sheet.getCell(r, c).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: bg } };
        }
      }

      sheet.getRow(r).height = 22;
    }

    // Totals block — placed two rows below the daily grid. Layout
    // mirrors the reference template (label in G, value in H).
    const totalsStart = dailyEnd + 4;
    const totalsRows: Array<{ label: string; hours: number; tone?: string; bold?: boolean }> = [
      { label: 'Odpracované',          hours: totalPresent,                              tone: 'FF1E40AF', bold: true  }, // worked (blue)
      { label: 'sviatok',              hours: totalHoliday,                              tone: 'FF7C3AED'              }, // public holiday (purple)
      { label: 'Spolu Odpracované',    hours: totalPresent + totalHoliday,               tone: 'FF1E40AF', bold: true  }, // present + holiday
      { label: 'dovolenka',            hours: totalVacation,                             tone: 'FF0891B2'              }, // vacation (cyan)
      { label: 'neplatené voľno',      hours: totalUnpaidLeave,                          tone: 'FFB91C1C'              }, // unpaid (red)
      { label: 'platené voľno',        hours: totalPaidLeave,                            tone: 'FFD97706'              }, // Phase 2B (#1) — paid leave (amber)
      { label: 'lekár',                hours: totalSick,                                 tone: 'FFC026D3'              }, // sick (magenta) — relabeled from "platené voľno / lekár"
      { label: 'absencia',             hours: totalAbsent,                               tone: 'FFEA580C'              }, // absent (orange)
      { label: 'Spolu',                hours: totalPresent + totalHoliday + totalVacation + totalUnpaidLeave + totalSick + totalAbsent, tone: 'FF0F172A', bold: true }, // monthly grand total
    ];

    // Totals rows. Label + value share the same colour (matches the
    // reference template — a glance picks the colour of, say, the
    // 'neplatené voľno' label and finds the matching hours value in the
    // same hue) and both get thin borders so the bottom block reads as a
    // proper sub-table rather than floating text.
    totalsRows.forEach((t, i) => {
      const row = totalsStart + i;
      const colour = t.tone ? { argb: t.tone } : undefined;
      const labelCell = sheet.getCell(row, 7);
      labelCell.value = t.label;
      labelCell.font  = { bold: !!t.bold, size: 11, color: colour };
      labelCell.border = GRID_BORDER;
      const valueCell = sheet.getCell(row, 8);
      valueCell.value = this.hoursAsClock(t.hours);
      valueCell.alignment = { horizontal: 'right', vertical: 'middle' };
      valueCell.font = { bold: !!t.bold, size: 11, color: colour };
      valueCell.border = GRID_BORDER;
      sheet.getRow(row).height = 20;
    });

    // Signature label at the bottom so the printed sheet looks like
    // the reference template's "podpis / Unterschrift" section.
    const sigRow = totalsStart + totalsRows.length + 2;
    sheet.getCell(sigRow, 2).value = 'podpis';
    sheet.getCell(sigRow, 2).font  = { size: 9, color: { argb: 'FF1E40AF' } };
    sheet.getCell(sigRow + 1, 2).value = 'Unterschrift';
    sheet.getCell(sigRow + 1, 2).font  = { italic: true, size: 8, color: { argb: 'FF64748B' } };

    // Slovak labour-law note + optional company footer (matches the
    // reference template's German legal block at the bottom).
    const lawRow = sigRow + 4;
    const labourNotes = [
      'Bitte beachten Sie die arbeitsrechtlichen Regelungen in der Slowakei:',
      'Die wöchentliche Arbeitszeit ist maximal 40 Stunden. Einschließlich der Überstunden',
      'maximal 48 Stunden wöchentlich, für Führungskräfte maximal 56 Stunden wöchentlich.',
      'Eine Pause ist nach 6 Stunden notwendig, in der Länge von 30 Minuten.',
      'Urlaub ist vorgeschrieben 4 Wochen im Jahr (nach dem Alter 33 Jahren 5 Wochen im Jahr).',
      'Mit der Unterschrift bestätigt der Mitarbeiter, dass die Angaben in der Zeiterfassung vollständig',
      'sind und der Wahrheit entsprechen.',
    ];
    labourNotes.forEach((line, i) => {
      const c = sheet.getCell(lawRow + i, 1);
      c.value = line;
      c.font  = { size: 8, color: { argb: 'FF475569' } };
      sheet.mergeCells(lawRow + i, 1, lawRow + i, 8);
    });

    if (companyProfile?.footer) {
      const fr = lawRow + labourNotes.length + 2;
      const c = sheet.getCell(fr, 1);
      c.value = companyProfile.footer;
      c.font  = { size: 8, italic: true, color: { argb: 'FF64748B' } };
      sheet.mergeCells(fr, 1, fr, 8);
    }
  }

  /** Formats a decimal hours value as "H:MM" (e.g. 8.5 → "8:30"). */
  private hoursAsClock(hours: number): string {
    if (!Number.isFinite(hours) || hours <= 0) return '0:00';
    const totalMin = Math.round(hours * 60);
    const h = Math.floor(totalMin / 60);
    const m = totalMin % 60;
    return `${h}:${String(m).padStart(2, '0')}`;
  }

  async exportExcel(dto: ExportAttendanceDto, locale: ServerLocale = 'en', caller?: any): Promise<Buffer> {
    const month = Number(dto.month);
    const year  = Number(dto.year);

    if (month < 1 || month > 12) throw new BadRequestException('month must be 1–12');
    if (year < 2000 || year > 2100) throw new BadRequestException('year must be 2000–2100');

    const { from, to } = this.computeDateRange(month, year);
    const daysInMonth  = new Date(year, month, 0).getDate();

    // Build employee filter — explicit ID > selected list > driversOnly > everyone.
    const empWhere: any = { deletedAt: null };
    if (dto.employeeId) {
      empWhere.id = dto.employeeId;
    } else if (dto.employeeIds && dto.employeeIds.length > 0) {
      empWhere.id = { in: dto.employeeIds };
    } else if (dto.driversOnly) {
      empWhere.OR = [
        { licenseNumber:   { not: null } },
        { licenseCategory: { not: null } },
      ];
    }

    // Resolve selected company export profile (renders in the header).
    let companyProfile: any = null;
    if (dto.companyProfileId) {
      companyProfile = await (this.prisma as any).companyExportProfile.findUnique({
        where: { id: dto.companyProfileId },
      });
    }

    const exportTenantWhere = this.scope().tenantWhere(); // @tenant-reviewed: phase248-attendance-export-scope
    const callerTenantWhere = this.callerTenantWhere(caller);
    const employees = await this.prisma.employee.findMany({ // @tenant-reviewed: phase318-tenant-public-jobs
      where: { ...empWhere, ...exportTenantWhere, ...callerTenantWhere },
      orderBy: [{ lastName: 'asc' }, { firstName: 'asc' }],
      select: {
        id:              true,
        employeeNumber:  true,
        firstName:       true,
        lastName:        true,
        licenseCategory: true,
      },
    });

    if (employees.length === 0) {
      throw new BadRequestException('No employees found matching the given criteria');
    }

    // Fetch all attendance records for the month in one query
    const employeeIds = employees.map((e) => e.id);
    const allRecords: any[] = await (this.prisma as any).attendanceRecord.findMany({ // @tenant-reviewed: phase248-attendance-export-scope
      where: {
        employeeId: { in: employeeIds },
        date:       { gte: from, lte: to },
        ...exportTenantWhere,
      },
    });

    // Build lookup: employeeId → Map<dayOfMonth, record>
    const recordMap = new Map<string, Map<number, any>>();
    for (const rec of allRecords) {
      if (!recordMap.has(rec.employeeId)) {
        recordMap.set(rec.employeeId, new Map());
      }
      const day = new Date(rec.date).getUTCDate();
      recordMap.get(rec.employeeId)!.set(day, rec);
    }

    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'TempWorks Attendance Module';
    workbook.created = new Date();

    // ── Primary output: one Zeiterfassung sheet per employee,
    //    matching the reference payroll template. For multi-employee
    //    exports we still include the summary sheet below so HR can
    //    see every driver at a glance.
    for (const emp of employees) {
      const dayMap = recordMap.get(emp.id) ?? new Map<number, any>();
      this.buildZeiterfassungSheet(workbook, emp, month, year, dayMap, companyProfile);
    }

    // ── Secondary summary sheet — only when the caller asked for
    //    a whole-org export. Skipped for single-employee so the
    //    generated file stays clean (it matches the template exactly).
    if (dto.employeeId) {
      const buffer = await workbook.xlsx.writeBuffer();
      return Buffer.from(buffer);
    }

    // Localize fixed UI labels via the shared exports catalog. Day-number
    // headers (1..N) stay numeric — they're language-neutral.
    const col = (key: string) => tServer(`attendance.columns.${key}`, {}, locale, 'exports');
    const summarySheet = workbook.addWorksheet(
      tServer('attendance.summarySheetName', {}, locale, 'exports'),
      { views: [{ state: 'frozen', xSplit: 3, ySplit: 1 }] },
    );

    // Build columns
    const summaryColumns: Partial<ExcelJS.Column>[] = [
      { header: col('driverName'),     key: 'name',            width: 24 },
      { header: col('employeeNumber'), key: 'employeeNumber',  width: 14 },
      { header: col('licenseCategory'), key: 'licenseCategory', width: 16 },
    ];
    for (let d = 1; d <= daysInMonth; d++) {
      summaryColumns.push({ header: String(d), key: `day_${d}`, width: 5 });
    }
    summaryColumns.push(
      { header: col('present'),    key: 'present',      width: 9  },
      { header: col('absent'),     key: 'absent',       width: 9  },
      { header: col('late'),       key: 'late',         width: 7  },
      { header: col('onLeave'),    key: 'onLeave',      width: 9  },
      { header: col('halfDay'),    key: 'halfDay',      width: 9  },
      { header: col('holiday'),    key: 'holiday',      width: 9  },
      { header: col('totalHours'), key: 'totalHours',   width: 10 },
    );
    summarySheet.columns = summaryColumns;

    // Header row styling — blue
    summarySheet.getRow(1).eachCell((cell) => {
      cell.font      = { bold: true, color: { argb: 'FFFFFFFF' } };
      cell.fill      = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1D4ED8' } };
      cell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: false };
      cell.border    = { bottom: { style: 'thin', color: { argb: 'FF1E40AF' } } };
    });
    summarySheet.getRow(1).height = 28;

    // Data rows
    for (const emp of employees) {
      const dayMap   = recordMap.get(emp.id) ?? new Map<number, any>();
      const rowData: Record<string, any> = {
        name:            `${emp.firstName} ${emp.lastName}`,
        employeeNumber:  emp.employeeNumber ?? '',
        licenseCategory: emp.licenseCategory ?? '',
      };

      let presentCount  = 0;
      let absentCount   = 0;
      let lateCount     = 0;
      let onLeaveCount  = 0;
      let halfDayCount  = 0;
      let holidayCount  = 0;
      let totalHours    = 0;

      for (let d = 1; d <= daysInMonth; d++) {
        const rec = dayMap.get(d);
        rowData[`day_${d}`] = rec ? (STATUS_ABBR[rec.status] ?? rec.status) : '';
        if (rec) {
          switch (rec.status) {
            case 'PRESENT':  presentCount++;  break;
            case 'ABSENT':   absentCount++;   break;
            case 'LATE':     lateCount++;     break;
            case 'ON_LEAVE': onLeaveCount++;  break;
            case 'HALF_DAY': halfDayCount++;  break;
            case 'HOLIDAY':  holidayCount++;  break;
          }
          if (rec.workingHours) totalHours += Number(rec.workingHours);
        }
      }

      rowData.present    = presentCount;
      rowData.absent     = absentCount;
      rowData.late       = lateCount;
      rowData.onLeave    = onLeaveCount;
      rowData.halfDay    = halfDayCount;
      rowData.holiday    = holidayCount;
      rowData.totalHours = Math.round(totalHours * 100) / 100;

      const row = summarySheet.addRow(rowData);

      // Color each day cell by status
      for (let d = 1; d <= daysInMonth; d++) {
        const rec = dayMap.get(d);
        if (rec && STATUS_COLORS[rec.status]) {
          const cell = row.getCell(`day_${d}`);
          const colors = STATUS_COLORS[rec.status];
          cell.fill  = { type: 'pattern', pattern: 'solid', fgColor: { argb: colors.bg } };
          cell.font  = { color: { argb: colors.fg }, bold: true, size: 9 };
          cell.alignment = { horizontal: 'center', vertical: 'middle' };
        }
      }

      // Color summary columns
      this.colorSummaryCell(row.getCell('present'),    STATUS_COLORS['PRESENT']);
      this.colorSummaryCell(row.getCell('absent'),     STATUS_COLORS['ABSENT']);
      this.colorSummaryCell(row.getCell('late'),       STATUS_COLORS['LATE']);
      this.colorSummaryCell(row.getCell('onLeave'),    STATUS_COLORS['ON_LEAVE']);
      this.colorSummaryCell(row.getCell('halfDay'),    STATUS_COLORS['HALF_DAY']);
      this.colorSummaryCell(row.getCell('holiday'),    STATUS_COLORS['HOLIDAY']);

      // Total hours: light blue
      const hoursCell = row.getCell('totalHours');
      hoursCell.fill  = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEFF6FF' } };
      hoursCell.font  = { bold: true, color: { argb: 'FF1E40AF' } };
      hoursCell.alignment = { horizontal: 'right' };
      hoursCell.numFmt    = '0.00';
    }

    // Auto-filter
    summarySheet.autoFilter = {
      from: { row: 1, column: 1 },
      to:   { row: 1, column: summarySheet.columnCount },
    };

    // ── Sheet 2: Timesheet Detail (single employee only) ─────────────────────

    if (dto.employeeId && employees.length === 1) {
      const emp = employees[0];
      const detailSheet = workbook.addWorksheet(
        tServer('attendance.detailSheetName', {}, locale, 'exports'),
        { views: [{ state: 'frozen', ySplit: 1 }] },
      );

      detailSheet.columns = [
        { header: col('date'),     key: 'date',     width: 14 },
        { header: col('day'),      key: 'day',      width: 12 },
        { header: col('status'),   key: 'status',   width: 12 },
        { header: col('checkIn'),  key: 'checkIn',  width: 10 },
        { header: col('checkOut'), key: 'checkOut', width: 10 },
        { header: col('hours'),    key: 'hours',    width: 10 },
        { header: col('notes'),    key: 'notes',    width: 30 },
      ];

      // Header styling
      detailSheet.getRow(1).eachCell((cell) => {
        cell.font      = { bold: true, color: { argb: 'FFFFFFFF' } };
        cell.fill      = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1D4ED8' } };
        cell.alignment = { vertical: 'middle', horizontal: 'center' };
        cell.border    = { bottom: { style: 'thin', color: { argb: 'FF1E40AF' } } };
      });
      detailSheet.getRow(1).height = 28;

      const dayMap = recordMap.get(emp.id) ?? new Map<number, any>();
      const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

      for (let d = 1; d <= daysInMonth; d++) {
        const dateObj = new Date(Date.UTC(year, month - 1, d));
        const dateStr = dateObj.toISOString().split('T')[0];
        const dayName = dayNames[dateObj.getUTCDay()];
        const rec     = dayMap.get(d);

        const rowData: Record<string, any> = {
          date:    dateStr,
          day:     dayName,
          status:  rec?.status  ?? '',
          checkIn:  rec?.checkIn  ?? '',
          checkOut: rec?.checkOut ?? '',
          hours:    rec?.workingHours != null ? Number(rec.workingHours) : '',
          notes:   rec?.notes   ?? '',
        };

        const row = detailSheet.addRow(rowData);

        // Colorize the whole line by status (soft pastel fill across the
        // row), then emphasise the status cell itself with the matching
        // dark text. Keeps the detail sheet consistent with the
        // per-employee Zeiterfassung sheet and the on-screen view.
        if (rec && STATUS_COLORS[rec.status]) {
          const colors = STATUS_COLORS[rec.status];
          // 7 fixed columns (date, day, status, checkIn, checkOut, hours,
          // notes) — fill each explicitly so empty cells aren't skipped.
          for (let c = 1; c <= 7; c++) {
            row.getCell(c).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: colors.bg } };
          }
          const statusCell = row.getCell('status');
          statusCell.font = { color: { argb: colors.fg }, bold: true };
        }

        // Format hours
        if (typeof rowData.hours === 'number') {
          row.getCell('hours').numFmt = '0.00';
          row.getCell('hours').alignment = { horizontal: 'right' };
        }

        // Shade weekends lightly
        if (dateObj.getUTCDay() === 0 || dateObj.getUTCDay() === 6) {
          row.eachCell((cell) => {
            if (!cell.fill || (cell.fill as any).fgColor?.argb === 'FFFFFFFF' || !(cell.fill as ExcelJS.FillPattern).fgColor) {
              cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFDFDFD' } };
            }
          });
        }
      }

      // Totals row
      const dataStart = 2;
      const dataEnd   = daysInMonth + 1;
      detailSheet.addRow({});
      const totalsRow = detailSheet.addRow({
        date:  'TOTALS',
        hours: { formula: `SUM(F${dataStart}:F${dataEnd})` },
      });
      totalsRow.eachCell((cell) => {
        cell.font = { bold: true };
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEFF6FF' } };
      });
      totalsRow.getCell('hours').numFmt = '0.00';

      detailSheet.autoFilter = {
        from: { row: 1, column: 1 },
        to:   { row: 1, column: detailSheet.columnCount },
      };
    }

    const buffer = await workbook.xlsx.writeBuffer();
    return Buffer.from(buffer);
  }

  // ── Private helpers ──────────────────────────────────────────────────────────

  private colorSummaryCell(
    cell: ExcelJS.Cell,
    colors: { bg: string; fg: string },
  ): void {
    cell.fill      = { type: 'pattern', pattern: 'solid', fgColor: { argb: colors.bg } };
    cell.font      = { color: { argb: colors.fg }, bold: true };
    cell.alignment = { horizontal: 'center' };
  }

  private buildStatsFromGroupBy(grouped: any[]): Record<string, any> {
    const stats: Record<string, number> = {
      presentDays: 0,
      absentDays:  0,
      lateDays:    0,
      onLeaveDays: 0,
      halfDayDays: 0,
      holidayDays: 0,
    };
    let totalWorkingHours = 0;

    for (const g of grouped) {
      const count = g._count?.status ?? 0;
      const hours = Number(g._sum?.workingHours ?? 0);
      totalWorkingHours += hours;

      switch (g.status) {
        case 'PRESENT':  stats.presentDays  += count; break;
        case 'ABSENT':   stats.absentDays   += count; break;
        case 'LATE':     stats.lateDays     += count; break;
        case 'ON_LEAVE': stats.onLeaveDays  += count; break;
        case 'HALF_DAY': stats.halfDayDays  += count; break;
        case 'HOLIDAY':  stats.holidayDays  += count; break;
      }
    }

    const totalRecorded =
      stats.presentDays + stats.absentDays + stats.lateDays +
      stats.onLeaveDays + stats.halfDayDays + stats.holidayDays;

    return { ...stats, totalRecorded, totalWorkingHours: Math.round(totalWorkingHours * 100) / 100 };
  }

  private buildSummaryFromRecords(records: any[]): Record<string, any> {
    // Day counts + per-status hour totals so the UI can show both the
    // raw number of days and the hour figure that rolls into payroll.
    const stats: Record<string, number> = {
      // counts
      presentCount: 0, absentCount: 0, vacationCount: 0, sickCount: 0,
      unpaidLeaveCount: 0, paidLeaveCount: 0, holidayCount: 0,
      // legacy counts kept for any UI still using them
      lateCount: 0, onLeaveCount: 0, halfDayCount: 0,
      // hour totals (after interruption deduction for PRESENT)
      presentHours: 0, absentHours: 0, vacationHours: 0, sickHours: 0,
      unpaidLeaveHours: 0, paidLeaveHours: 0, holidayHours: 0,
      // grand totals
      totalWorkingHours: 0,
      monthlyTotalHours: 0,
    };

    const WORK_HOURS_PER_DAY = 8;
    const toMin = (t?: string | null) => this.toMin(t);

    for (const rec of records) {
      switch (rec.status) {
        case 'PRESENT': {
          stats.presentCount++;
          const hours = Number(rec.workingHours ?? 0);
          stats.presentHours += hours;
          // Interruption: deducted from working hours by the upsert, so
          // we just need to roll the duration into the chosen status.
          const i = toMin(rec.interruptionIn);
          const o = toMin(rec.interruptionOut);
          if (i != null && o != null && o > i && rec.interruptionStatus) {
            const ih = Math.round(((o - i) / 60) * 100) / 100;
            switch (rec.interruptionStatus) {
              case 'VACATION':     stats.vacationHours    += ih; break;
              case 'SICK':         stats.sickHours        += ih; break;
              case 'UNPAID_LEAVE': stats.unpaidLeaveHours += ih; break;
              case 'PAID_LEAVE':   stats.paidLeaveHours   += ih; break;
              case 'HOLIDAY':      stats.holidayHours     += ih; break;
              case 'ABSENT':
              case 'OFF':          stats.absentHours      += ih; break;
            }
          }
          break;
        }
        case 'ABSENT':
        case 'OFF':           stats.absentCount++;      stats.absentHours      += WORK_HOURS_PER_DAY; break;
        case 'VACATION':      stats.vacationCount++;    stats.vacationHours    += WORK_HOURS_PER_DAY; break;
        case 'SICK':          stats.sickCount++;        stats.sickHours        += WORK_HOURS_PER_DAY; break;
        case 'UNPAID_LEAVE':  stats.unpaidLeaveCount++; stats.unpaidLeaveHours += WORK_HOURS_PER_DAY; break;
        case 'PAID_LEAVE':    stats.paidLeaveCount++;   stats.paidLeaveHours   += WORK_HOURS_PER_DAY; break;
        case 'HOLIDAY':       stats.holidayCount++;     stats.holidayHours     += WORK_HOURS_PER_DAY; break;
        // Legacy values still surfaced as counts only.
        case 'LATE':     stats.lateCount++;     break;
        case 'ON_LEAVE': stats.onLeaveCount++;  break;
        case 'HALF_DAY': stats.halfDayCount++;  break;
      }
    }

    // Round all hour figures + compute the monthly grand total.
    for (const k of ['presentHours','absentHours','vacationHours','sickHours','unpaidLeaveHours','paidLeaveHours','holidayHours']) {
      stats[k] = Math.round(stats[k] * 100) / 100;
    }
    stats.totalWorkingHours = stats.presentHours;
    stats.monthlyTotalHours = Math.round(
      (stats.presentHours + stats.absentHours + stats.vacationHours +
       stats.sickHours + stats.unpaidLeaveHours + stats.paidLeaveHours +
       stats.holidayHours) * 100,
    ) / 100;
    return stats;
  }

  private computeDateRange(month: number, year: number): { from: Date; to: Date } {
    const from = new Date(Date.UTC(year, month - 1, 1));
    const to   = new Date(Date.UTC(year, month, 0));       // last day of month at UTC midnight
    return { from, to };
  }

  /**
   * Total Hours = (checkOut - checkIn) - (breakOut - breakIn)
   *
   * Invariants enforced here:
   *  • checkIn / checkOut are both required for any positive total;
   *    missing either returns null (status-only rows like Off / Sick).
   *  • Overnight shifts are supported (checkOut < checkIn wraps
   *    through midnight).
   *  • Partial or invalid break times are silently ignored rather than
   *    throwing — UI validators enforce ordering at entry time.
   *  • Result clamped at 0 so a too-large break never produces
   *    negative hours in reports.
   */
  private toMin(t?: string | null): number | null {
    if (!t) return null;
    const [hStr, mStr] = t.split(':');
    const h = Number(hStr), m = Number(mStr);
    if (!Number.isFinite(h) || !Number.isFinite(m)) return null;
    if (h < 0 || h > 23 || m < 0 || m > 59) return null;
    return h * 60 + m;
  }

  private calcWorkingHours(
    checkIn?: string | null,
    checkOut?: string | null,
    breakIn?: string | null,
    breakOut?: string | null,
    interruptionIn?: string | null,
    interruptionOut?: string | null,
  ): number | null {
    const toMin = (t?: string | null) => this.toMin(t);
    const ci = toMin(checkIn);
    const co = toMin(checkOut);
    if (ci == null || co == null) return null;

    // Overnight shift — wrap through midnight.
    let shiftMin = co >= ci ? co - ci : (24 * 60 - ci) + co;

    const bi = toMin(breakIn);
    const bo = toMin(breakOut);
    if (bi != null && bo != null && bo > bi) {
      shiftMin -= (bo - bi);
    }

    // In-day interruption (Slovak: prerušenie) deducted from the
    // shift on PRESENT days so the difference rolls up into whatever
    // leave status the user attributed the interruption to.
    const ii = toMin(interruptionIn);
    const io = toMin(interruptionOut);
    if (ii != null && io != null && io > ii) {
      shiftMin -= (io - ii);
    }

    if (shiftMin < 0) shiftMin = 0;
    return Math.round((shiftMin / 60) * 100) / 100;
  }

  // ── Lock periods ─────────────────────────────────────────────────────────────

  /** True if the (year, month) is locked and therefore read-only.
   *  Phase 2.49: pilot mode looks up the lock by `(tenantId, year,
   *  month)` so a tenant-A lock blocks tenant-A only and a tenant-B
   *  lock blocks tenant-B only. Legacy mode preserves the pre-2.49
   *  global lookup (any NULL-tenant row blocks every mutation). */
  async isPeriodLocked(year: number, month: number, employeeId?: string | null): Promise<boolean> {
    const scope = this.scope();
    try {
      // Locks are evaluated per-employee. When the caller supplies an
      // employeeId we look for a row with that exact employeeId — legacy
      // global locks (employeeId IS NULL) are ignored in this branch so
      // a single pre-2C global row can no longer shadow the new
      // per-employee model. Operators see legacy globals in the lock
      // modal (with a "blocks every employee" badge) and can unlock
      // them from there.
      //
      // Without an employeeId (bulk paths that operate across the
      // tenant) we still honour the legacy global as the only sensible
      // proxy.
      const tenantId = scope.active ? scope.tenantId : null;
      const where: any = { tenantId, year, month };
      where.employeeId = employeeId ? employeeId : null;
      const row = await (this.legacyPrisma as any).attendanceLockedPeriod.findFirst({
        where,
        select: { id: true },
      });
      return !!row;
    } catch {
      // Prisma client may not know about the new column on first boot
      // — fail-open rather than blocking writes.
      return false;
    }
  }

  /** Throws if the given YYYY-MM-DD falls in a locked month. */
  private async assertPeriodUnlocked(dateStr: string, employeeId?: string | null): Promise<void> {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return;
    const y = Number(dateStr.slice(0, 4));
    const m = Number(dateStr.slice(5, 7));
    if (await this.isPeriodLocked(y, m, employeeId)) {
      throw new BadRequestException(`Payroll period ${y}-${String(m).padStart(2, '0')} is locked`);
    }
  }

  async listLockedPeriods() {
    const scope = this.scope();
    const where = scope.active
      ? { tenantId: scope.tenantId }
      : { tenantId: null };
    try {
      return await (this.legacyPrisma as any).attendanceLockedPeriod.findMany({ // @tenant-reviewed: phase249-attendance-lock-period-tenant-scope
        where,
        orderBy: [{ year: 'desc' }, { month: 'desc' }],
        include: { lockedBy: { select: { id: true, firstName: true, lastName: true, email: true } } },
      });
    } catch {
      return [];
    }
  }

  async lockPeriod(dto: LockPeriodDto, actorId?: string) {
    const scope = this.scope();
    const tenantId = scope.active ? scope.tenantId : null;
    // Phase 2C (#33) — when dto.employeeId is provided the lock is
    // employee-specific; otherwise it falls back to a legacy global
    // lock for backward compatibility with the existing UI.
    const employeeId = (dto as any).employeeId || null;
    const existing = await (this.legacyPrisma as any).attendanceLockedPeriod.findFirst({
      where: { tenantId, year: dto.year, month: dto.month, employeeId },
    });
    if (existing) throw new BadRequestException('Period is already locked');
    const row = await (this.legacyPrisma as any).attendanceLockedPeriod.create({
      data: {
        year: dto.year, month: dto.month, reason: dto.reason,
        lockedById: actorId ?? null,
        ...(tenantId ? { tenantId } : {}),
        ...(employeeId ? { employeeId } : {}),
      },
      include: { lockedBy: { select: { id: true, firstName: true, lastName: true, email: true } } },
    });
    await this.auditLog(actorId, 'ATTENDANCE_PERIOD_LOCKED', row.id, { year: dto.year, month: dto.month, employeeId });
    return row;
  }

  async unlockPeriod(id: string, actorId?: string) {
    const scope = this.scope();
    // Pilot mode: only unlock if the row belongs to the active tenant.
    // Legacy mode: only unlock NULL-tenant global rows.
    const tenantWhere = scope.active
      ? { tenantId: scope.tenantId }
      : { tenantId: null };
    const existing = await (this.legacyPrisma as any).attendanceLockedPeriod.findFirst({ // @tenant-reviewed: phase249-attendance-lock-period-tenant-scope
      where: { id, ...tenantWhere },
    });
    if (!existing) throw new NotFoundException('Locked period not found');
    await (this.legacyPrisma as any).attendanceLockedPeriod.delete({ where: { id } }); // @tenant-reviewed: phase249-attendance-lock-period-tenant-scope
    await this.auditLog(actorId, 'ATTENDANCE_PERIOD_UNLOCKED', id, {
      year: existing.year, month: existing.month,
    });
    return { message: 'Period unlocked' };
  }

  // ── Bulk apply ──────────────────────────────────────────────────────────────

  /**
   * Applies one status + time template to a date range or explicit
   * date list. Respects the lock table (skips locked dates) and the
   * overwriteExisting flag (skips dates with existing records when
   * false). Returns per-date outcomes so the UI can render a summary.
   */
  async bulkApply(dto: BulkApplyAttendanceDto, actorId?: string) {
    // Bulk parent gate (legacy when flag off; tenant-scoped when pilot active).
    await this.findEmployeeForMutationOrFail(dto.employeeId);

    // Expand the target date set.
    let dates: string[] = [];
    if (Array.isArray(dto.dates) && dto.dates.length > 0) {
      dates = [...new Set(dto.dates)].filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d));
    } else if (dto.dateFrom && dto.dateTo) {
      const from = new Date(dto.dateFrom + 'T00:00:00.000Z');
      const to   = new Date(dto.dateTo   + 'T00:00:00.000Z');
      if (isNaN(from.getTime()) || isNaN(to.getTime()) || from > to) {
        throw new BadRequestException('Invalid dateFrom / dateTo range');
      }
      for (let d = new Date(from); d <= to; d.setUTCDate(d.getUTCDate() + 1)) {
        if (dto.skipWeekends) {
          const dow = d.getUTCDay();
          if (dow === 0 || dow === 6) continue;
        }
        dates.push(d.toISOString().slice(0, 10));
      }
    } else {
      throw new BadRequestException('Provide either `dates` or both `dateFrom` and `dateTo`');
    }
    if (dates.length === 0) throw new BadRequestException('No dates to process');
    if (dates.length > 366) throw new BadRequestException('Refusing to process more than 366 dates in one call');

    const overwrite = dto.overwriteExisting !== false;
    const results: Array<{ date: string; outcome: 'created' | 'updated' | 'skipped_existing' | 'skipped_locked' | 'error'; error?: string }> = [];

    for (const dateStr of dates) {
      try {
        const y = Number(dateStr.slice(0, 4));
        const m = Number(dateStr.slice(5, 7));
        if (await this.isPeriodLocked(y, m, dto.employeeId)) {
          results.push({ date: dateStr, outcome: 'skipped_locked' });
          continue;
        }
        const dateObj = new Date(dateStr + 'T00:00:00.000Z');
        const existing = await (this.legacyPrisma as any).attendanceRecord.findUnique({ // @tenant-reviewed: phase247-attendance-mutation-scope
          where: { employeeId_date: { employeeId: dto.employeeId, date: dateObj } },
          select: { id: true },
        });
        if (existing && !overwrite) {
          results.push({ date: dateStr, outcome: 'skipped_existing' });
          continue;
        }
        await this.upsertRecord({
          employeeId: dto.employeeId,
          date: dateStr,
          status: dto.status,
          checkIn:  dto.checkIn,
          checkOut: dto.checkOut,
          breakIn:  dto.breakIn,
          breakOut: dto.breakOut,
          notes:    dto.notes,
        } as any, actorId);
        results.push({ date: dateStr, outcome: existing ? 'updated' : 'created' });
      } catch (err: any) {
        results.push({ date: dateStr, outcome: 'error', error: err?.message ?? 'Unknown error' });
      }
    }

    const summary = {
      requested: dates.length,
      created:          results.filter(r => r.outcome === 'created').length,
      updated:          results.filter(r => r.outcome === 'updated').length,
      skipped_existing: results.filter(r => r.outcome === 'skipped_existing').length,
      skipped_locked:   results.filter(r => r.outcome === 'skipped_locked').length,
      errors:           results.filter(r => r.outcome === 'error').length,
    };
    await this.auditLog(actorId, 'ATTENDANCE_BULK_APPLY', dto.employeeId, { ...summary, status: dto.status });
    return { summary, results };
  }

  private async auditLog(
    userId: string | undefined,
    action: string,
    entityId: string,
    changes?: Record<string, any>,
  ): Promise<void> {
    // @tenant-reviewed: phase248-attendance-audit-log-pilot
    await this.tenantAuditLog.write({
      userId,
      action,
      entity:   'AttendanceRecord',
      entityId,
      changes:  changes as any,
    });
  }
}
