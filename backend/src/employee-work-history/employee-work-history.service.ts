import { Injectable, NotFoundException, BadRequestException, Optional } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { StorageService } from '../common/storage/storage.service';
import { decodeUploadFilename } from '../common/storage/multer.config';
import { PilotPrismaAccessor } from '../saas/prisma/pilot-prisma.accessor';
import { getPilotScope, PilotScope } from '../saas/prisma/tenant-pilot-scope';
import { CreateWorkHistoryDto, UpdateWorkHistoryDto, CONTRACT_ENDING_EVENT_TYPES } from './dto/work-history.dto';
import { ContractsService } from '../contracts/contracts.service';

/**
 * Work History is the post-hire business timeline for an Employee:
 * new contract, probation start/end, unpaid leave, end of contract,
 * termination. It lives next to the workflow history but is
 * intentionally a different table / module so pipeline events and
 * contract events never get mixed in reports or audits.
 *
 * Phase 2.7 — first tenant-scoped TenantPrisma pilot. The service
 * routes all Prisma calls through `PilotPrismaAccessor.client()` and
 * applies a `tenantId` equality filter (read paths) plus `tenantId`
 * injection (create paths) when `getPilotScope()` reports `active=true`.
 *
 * The pilot scope is active iff:
 *   - `TENANT_PRISMA_PILOT_ENABLED=true`, AND
 *   - env classifies as SAFE_CLONE / SAFE_STAGING, AND
 *   - a tenant is in the ALS frame.
 *
 * Otherwise (production default) scope is inactive and `scope.tenantWhere()`
 * / `scope.tenantData()` both return `{}` — call sites stay legacy.
 */
@Injectable()
export class EmployeeWorkHistoryService {
  constructor(
    private legacyPrisma: PrismaService,
    private storage: StorageService,
    private pilot: PilotPrismaAccessor,
    // Optional so harness scripts that build the service directly keep
    // working; guarded with `?.` at the mirror call site.
    @Optional() private contracts?: ContractsService,
  ) {}

  /** Mirror a termination/end-of-contract event into the Contract
   *  Timeline: close the current contract with the event's effective
   *  date. Best-effort — never blocks the work-history write. */
  private async mirrorContractEnd(employeeId: string, eventType: string, effectiveDate?: string | null, actorId?: string) {
    if (!effectiveDate) return;
    if (!CONTRACT_ENDING_EVENT_TYPES.includes(eventType)) return;
    try {
      await this.contracts?.closeCurrentContract(employeeId, new Date(effectiveDate), actorId);
    } catch (e) {
      // swallow — the timeline entry still saved.
    }
  }

  /** Prisma surface chosen by the pilot accessor. */
  private get prisma(): PrismaService {
    return this.pilot.client();
  }

  /** Per-call pilot decision. Stays inactive in production. The module
   *  name gates this service against `TENANT_PRISMA_PILOT_MODULES` when
   *  set; if the env var is unset (default) every module is allowed. */
  private scope(): PilotScope {
    return getPilotScope(this.pilot, 'employee-work-history');
  }

  private get include() {
    return {
      createdBy:  { select: { id: true, firstName: true, lastName: true, email: true } },
      approvedBy: { select: { id: true, firstName: true, lastName: true, email: true } },
      attachments: { where: { deletedAt: null }, orderBy: { createdAt: 'asc' as const } },
    };
  }

  /** Enforces "this timeline belongs to an Employee, not a lead /
   *  candidate". Throws 404 for both deleted and non-existent rows so
   *  the feature never leaks Applicant timelines through this route.
   *
   *  When the pilot scope is active, the lookup is also tenant-scoped
   *  so a foreign-tenant employee id presents as 404 (not as a leak). */
  private async assertEmployeeExists(employeeId: string, scope: PilotScope): Promise<void> {
    const emp = await this.prisma.employee.findFirst({ // @tenant-reviewed: phase27-pilot-scope
      where: { id: employeeId, deletedAt: null, ...scope.tenantWhere() },
      select: { id: true },
    });
    if (!emp) throw new NotFoundException(`Employee ${employeeId} not found`);
  }

  async list(employeeId: string) {
    const scope = this.scope();
    await this.assertEmployeeExists(employeeId, scope);
    return (this.prisma as any).employeeWorkHistory.findMany({ // @tenant-reviewed: phase27-pilot-scope
      where: { employeeId, deletedAt: null, ...scope.tenantWhere() },
      // Newest first — operators need to see the most recent event at
      // the top of the Contracts tab; older events are still reachable
      // by scrolling.
      orderBy: [{ date: 'desc' }, { createdAt: 'desc' }],
      include: this.include,
    });
  }

  /** Configured event types — active only, in the operator-defined
   *  order. Surfaced by the controller so the Add/Edit dropdown
   *  reflects Settings without a second round-trip.
   *
   *  Event types are global catalog rows (no `tenantId`) so the pilot
   *  scope is intentionally NOT applied here — every tenant sees the
   *  same configured event types. */
  async listEventTypes() {
    try {
      return await (this.prisma as any).workHistoryEventTypeSetting.findMany({ // @tenant-reviewed: phase27-pilot-scope (global catalog)
        where: { isActive: true },
        orderBy: [{ sortOrder: 'asc' }, { label: 'asc' }],
      });
    } catch {
      return [];
    }
  }

  /** Throws BadRequest when the value isn't registered in Settings.
   *  Soft-fails open when the settings table is empty so the first
   *  install still accepts writes. */
  private async assertEventTypeConfigured(value: string) {
    const list = await this.listEventTypes();
    if (list.length === 0) return;
    if (!list.some((e: any) => e.value === value)) {
      throw new BadRequestException(`Event type "${value}" is not configured in Settings`);
    }
  }

  async create(employeeId: string, dto: CreateWorkHistoryDto, actorId?: string) {
    const scope = this.scope();
    await this.assertEmployeeExists(employeeId, scope);
    await this.assertEventTypeConfigured(dto.eventType);
    const entry = await (this.prisma as any).employeeWorkHistory.create({ // @tenant-reviewed: phase27-pilot-scope
      data: {
        employeeId,
        date:        new Date(dto.date),
        eventType:   dto.eventType,
        description: dto.description ?? null,
        effectiveDate: dto.effectiveDate ? new Date(dto.effectiveDate) : null,
        approvedById: dto.approvedById ?? null,
        createdById: actorId ?? null,
        ...scope.tenantData(),
      },
      include: this.include,
    });
    await this.auditLog(actorId, 'EMPLOYEE_WORK_HISTORY_CREATED', entry.id, {
      employeeId, eventType: dto.eventType, date: dto.date,
    });
    // Mirror termination/end-of-contract into the Contract Timeline.
    await this.mirrorContractEnd(employeeId, dto.eventType, dto.effectiveDate, actorId);
    return entry;
  }

  async update(employeeId: string, entryId: string, dto: UpdateWorkHistoryDto, actorId?: string) {
    const scope = this.scope();
    const existing = await (this.prisma as any).employeeWorkHistory.findFirst({ // @tenant-reviewed: phase27-pilot-scope
      where: { id: entryId, employeeId, deletedAt: null, ...scope.tenantWhere() },
    });
    if (!existing) throw new NotFoundException('Work history entry not found');
    if (dto.eventType !== undefined) await this.assertEventTypeConfigured(dto.eventType);
    const data: any = {};
    if (dto.date !== undefined)        data.date = new Date(dto.date);
    if (dto.eventType !== undefined)   data.eventType = dto.eventType;
    if (dto.description !== undefined) data.description = dto.description;
    if (dto.approvedById !== undefined) data.approvedById = dto.approvedById;
    if (dto.effectiveDate !== undefined) data.effectiveDate = dto.effectiveDate ? new Date(dto.effectiveDate) : null;
    // The lookup above already constrained by tenantId when the pilot is
    // active, so a cross-tenant entryId presents as 404 BEFORE the
    // update runs. The update itself uses the unique id key — that's
    // safe because we proved the row belongs to the active tenant.
    const updated = await (this.prisma as any).employeeWorkHistory.update({ // @tenant-reviewed: phase27-pilot-scope
      where: { id: entryId }, data, include: this.include,
    });
    await this.auditLog(actorId, 'EMPLOYEE_WORK_HISTORY_UPDATED', entryId, { employeeId, ...dto });
    // Re-mirror when the event now carries an effective date.
    const evType = dto.eventType ?? existing.eventType;
    const effDate = dto.effectiveDate ?? (existing.effectiveDate ? new Date(existing.effectiveDate).toISOString().slice(0, 10) : undefined);
    await this.mirrorContractEnd(employeeId, evType, effDate, actorId);
    return updated;
  }

  async remove(employeeId: string, entryId: string, actorId?: string) {
    const scope = this.scope();
    const existing = await (this.prisma as any).employeeWorkHistory.findFirst({ // @tenant-reviewed: phase27-pilot-scope
      where: { id: entryId, employeeId, deletedAt: null, ...scope.tenantWhere() },
    });
    if (!existing) throw new NotFoundException('Work history entry not found');
    // Soft delete — preserves the timeline for audit purposes even
    // when a row is hidden from operators.
    await (this.prisma as any).employeeWorkHistory.update({ // @tenant-reviewed: phase27-pilot-scope
      where: { id: entryId },
      data: { deletedAt: new Date(), deletedBy: actorId ?? null },
    });
    await this.auditLog(actorId, 'EMPLOYEE_WORK_HISTORY_DELETED', entryId, {
      employeeId, eventType: existing.eventType,
    });
    return { message: 'Work history entry deleted' };
  }

  // ── Attachments ────────────────────────────────────────────────────────────

  async addAttachment(
    employeeId: string, entryId: string,
    file: Express.Multer.File, uploadedById?: string,
  ) {
    const scope = this.scope();
    const entry = await (this.prisma as any).employeeWorkHistory.findFirst({ // @tenant-reviewed: phase27-pilot-scope
      where: { id: entryId, employeeId, deletedAt: null, ...scope.tenantWhere() },
      select: { id: true },
    });
    if (!entry) throw new NotFoundException('Work history entry not found');
    if (!file) throw new BadRequestException('No file uploaded');

    // Recover UTF-8 filenames multer decoded as latin1 (e.g. Slovak
    // "Dohoda o skončení pracovného pomeru.pdf").
    const displayName = decodeUploadFilename(file.originalname);

    const upload = await this.storage.uploadFile(file.buffer, {
      keyPrefix: `employees/${employeeId}/work-history/${entryId}/attachments`,
      contentType: file.mimetype,
      originalName: displayName,
      inline: file.mimetype === 'application/pdf' || file.mimetype.startsWith('image/'),
    });

    const attachment = await (this.prisma as any).employeeWorkHistoryAttachment.create({ // @tenant-reviewed: phase27-pilot-scope
      data: {
        workHistoryId: entryId,
        name:     displayName,
        fileUrl:  upload.url,
        mimeType: file.mimetype,
        fileSize: file.size,
        uploadedById: uploadedById ?? null,
        ...scope.tenantData(),
      },
    });
    await this.auditLog(uploadedById, 'EMPLOYEE_WORK_HISTORY_ATTACHMENT_ADDED', entryId, {
      attachmentId: attachment.id, name: displayName, employeeId,
    });
    return attachment;
  }

  async removeAttachment(
    employeeId: string, entryId: string, attachmentId: string, actorId?: string,
  ) {
    const scope = this.scope();
    const att = await (this.prisma as any).employeeWorkHistoryAttachment.findFirst({ // @tenant-reviewed: phase27-pilot-scope
      where: {
        id: attachmentId, workHistoryId: entryId, deletedAt: null,
        workHistory: { employeeId, ...scope.tenantWhere() },
        ...scope.tenantWhere(),
      },
    });
    if (!att) throw new NotFoundException('Attachment not found');
    await (this.prisma as any).employeeWorkHistoryAttachment.update({ // @tenant-reviewed: phase27-pilot-scope
      where: { id: attachmentId }, data: { deletedAt: new Date() },
    });
    if (att.fileUrl) {
      await this.storage.deleteFileByUrlOrKey(att.fileUrl);
    }
    await this.auditLog(actorId, 'EMPLOYEE_WORK_HISTORY_ATTACHMENT_REMOVED', entryId, {
      attachmentId, employeeId,
    });
    return { message: 'Attachment removed' };
  }

  // ── Internal ───────────────────────────────────────────────────────────────

  private async auditLog(userId: string | undefined, action: string, entityId: string, changes?: any) {
    try {
      await this.legacyPrisma.auditLog.create({ // @tenant-reviewed: phase27-audit-log (writes use legacy prisma intentionally)
        data: { userId, action, entity: 'EmployeeWorkHistory', entityId, changes: changes as any },
      });
    } catch { /* audit must never crash main flow */ }
  }
}
