import { Injectable, NotFoundException, BadRequestException, Logger, Inject, Optional, forwardRef } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { PilotPrismaAccessor } from '../saas/prisma/pilot-prisma.accessor';
import { getPilotScope, PilotScope } from '../saas/prisma/tenant-pilot-scope';
import { CreateContractDto, UpdateContractDto } from './dto/contract.dto';
import { DocumentsService } from '../documents/documents.service';
import { decodeUploadFilename } from '../common/storage/multer.config';

/**
 * Employment Contracts — first-class contract records for an employee.
 *
 * Each row has an effective `startDate` and an optional `endDate`
 * (NULL = open-ended). Multiple rows chain into a chronological
 * employment timeline (initial contract → renewal → …). This is
 * distinct from EmployeeWorkHistory, which records discrete post-hire
 * events (probation, termination).
 *
 * Integration: `syncFromDocument()` is called by DocumentsService after
 * an "Employment/Work Contract" document is uploaded, so the contract
 * record is auto-created/updated from the document (Issue Date → start,
 * Expiry Date → end) — no double data entry.
 *
 * Tenant scoping mirrors the EmployeeWorkHistory pilot: reads/writes go
 * through `PilotPrismaAccessor` and apply `scope.tenantWhere()` /
 * `scope.tenantData()` when the pilot is active; production default is
 * legacy behaviour.
 */
@Injectable()
export class ContractsService {
  private readonly logger = new Logger('ContractsService');

  /** system_settings key holding the JSON array of DocumentType ids that
   *  map to contracts. Empty/unset → fall back to name matching. */
  private static readonly SETTING_KEY = 'contracts.documentTypeIds';
  /** Default document-type name matches when no ids are configured. */
  private static readonly DEFAULT_TYPE_NAMES = ['employment contract', 'work contract'];

  constructor(
    private legacyPrisma: PrismaService,
    private pilot: PilotPrismaAccessor,
    // forwardRef + Optional: DocumentsModule imports ContractsModule
    // (for auto-sync), so this is a two-way link resolved lazily.
    // Optional keeps harness scripts that build ContractsService
    // directly working.
    @Optional() @Inject(forwardRef(() => DocumentsService)) private documents?: DocumentsService,
  ) {}

  private get prisma(): PrismaService {
    return this.pilot.client();
  }

  private scope(): PilotScope {
    return getPilotScope(this.pilot, 'contracts');
  }

  private get include() {
    // `createdById` is a plain column, not a relation — so it is NOT
    // includable. Only the document relation is joined here.
    return {
      document: { select: { id: true, docId: true, name: true, fileUrl: true, documentTypeId: true } },
    };
  }

  /** Derive the display status from the effective dates. */
  private static deriveStatus(start: Date, end: Date | null): string {
    const now = Date.now();
    if (start.getTime() > now) return 'UPCOMING';
    if (end && end.getTime() < now) return 'ENDED';
    return 'ACTIVE';
  }

  private async assertEmployeeExists(employeeId: string, scope: PilotScope): Promise<void> {
    const emp = await this.prisma.employee.findFirst({ // @tenant-reviewed: contracts-pilot-scope (parent gate)
      where: { id: employeeId, deletedAt: null, ...scope.tenantWhere() },
      select: { id: true },
    });
    if (!emp) throw new NotFoundException(`Employee ${employeeId} not found`);
  }

  /** Chronological timeline — oldest contract first so the sequence
   *  reads top-to-bottom as the employment history unfolds. */
  async list(employeeId: string) {
    const scope = this.scope();
    await this.assertEmployeeExists(employeeId, scope);
    const rows = await (this.prisma as any).employmentContract.findMany({ // @tenant-reviewed: contracts-pilot-scope
      where: { employeeId, deletedAt: null, ...scope.tenantWhere() },
      orderBy: [{ startDate: 'asc' }, { createdAt: 'asc' }],
      include: this.include,
    });
    // Recompute status on read so an ACTIVE contract that just passed
    // its end date shows as ENDED without a background job.
    return rows.map((r: any) => ({
      ...r,
      status: ContractsService.deriveStatus(new Date(r.startDate), r.endDate ? new Date(r.endDate) : null),
    }));
  }

  async create(employeeId: string, dto: CreateContractDto, actorId?: string) {
    const scope = this.scope();
    await this.assertEmployeeExists(employeeId, scope);
    const start = new Date(dto.startDate);
    const end = dto.endDate ? new Date(dto.endDate) : null;
    const entry = await (this.prisma as any).employmentContract.create({ // @tenant-reviewed: contracts-pilot-scope
      data: {
        employeeId,
        startDate: start,
        endDate: end,
        contractType: dto.contractType?.trim() || 'Full-time',
        status: ContractsService.deriveStatus(start, end),
        documentId: dto.documentId ?? null,
        notes: dto.notes ?? null,
        source: 'MANUAL',
        createdById: actorId ?? null,
        ...scope.tenantData(),
      },
      include: this.include,
    });
    await this.refreshEmployeeContractDates(employeeId, actorId);
    await this.auditLog(actorId, 'EMPLOYMENT_CONTRACT_CREATED', entry.id, {
      employeeId, startDate: dto.startDate, endDate: dto.endDate ?? null,
    });
    return entry;
  }

  // ── Create / update WITH an uploaded contract document ──────────────────────

  /** Resolve the DocumentType id to file a contract document under:
   *  the first configured contract type, else a type matching the
   *  default names. Throws when none is available so the caller can
   *  ask the admin to configure one. */
  private async resolveContractDocumentTypeId(): Promise<string> {
    const configured = await this.getConfiguredDocumentTypeIds();
    if (configured.length > 0) return configured[0];
    const types = await this.legacyPrisma.documentType.findMany({
      where: { deletedAt: null, isActive: true },
      select: { id: true, name: true },
    });
    const match = types.find(t =>
      ContractsService.DEFAULT_TYPE_NAMES.some(n => (t.name ?? '').trim().toLowerCase().includes(n)));
    if (!match) {
      throw new BadRequestException(
        'No contract document type is configured. Set one in Settings → Document Types (contract mapping), or create an "Employment Contract" type.',
      );
    }
    return match.id;
  }

  /** Upload the file as a contract Document (auto-sync suppressed) and
   *  return the created document id. */
  private async uploadContractDocument(
    employeeId: string, file: Express.Multer.File,
    startDate: string, endDate: string | null | undefined, actorId?: string,
  ): Promise<string> {
    if (!this.documents) {
      throw new BadRequestException('Document upload is not available in this context.');
    }
    const documentTypeId = await this.resolveContractDocumentTypeId();
    const doc = await this.documents.create(
      {
        name: decodeUploadFilename(file.originalname),
        documentTypeId,
        entityType: 'EMPLOYEE' as any,
        entityId: employeeId,
        issueDate: startDate,
        expiryDate: endDate || undefined,
      } as any,
      file,
      actorId ?? '',
      undefined,
      { skipContractSync: true }, // we link the contract explicitly below
    );
    return (doc as any).id as string;
  }

  /** Add a contract AND attach its uploaded document in one step. */
  async createWithDocument(
    employeeId: string, dto: CreateContractDto, file: Express.Multer.File, actorId?: string,
  ) {
    const scope = this.scope();
    await this.assertEmployeeExists(employeeId, scope);
    const documentId = await this.uploadContractDocument(employeeId, file, dto.startDate, dto.endDate, actorId);
    return this.create(employeeId, { ...dto, documentId }, actorId);
  }

  /** Update a contract; when a file is provided, upload it and relink. */
  async updateWithDocument(
    employeeId: string, contractId: string, dto: UpdateContractDto, file: Express.Multer.File, actorId?: string,
  ) {
    const scope = this.scope();
    const existing = await (this.prisma as any).employmentContract.findFirst({ // @tenant-reviewed: contracts-pilot-scope
      where: { id: contractId, employeeId, deletedAt: null, ...scope.tenantWhere() },
      select: { id: true },
    });
    if (!existing) throw new NotFoundException('Contract not found');
    const startForDoc = dto.startDate ?? (await (this.prisma as any).employmentContract.findUnique({
      where: { id: contractId }, select: { startDate: true },
    }))?.startDate?.toISOString?.() ?? new Date().toISOString();
    const documentId = await this.uploadContractDocument(employeeId, file, startForDoc, dto.endDate, actorId);
    return this.update(employeeId, contractId, { ...dto, documentId }, actorId);
  }

  async update(employeeId: string, contractId: string, dto: UpdateContractDto, actorId?: string) {
    const scope = this.scope();
    const existing = await (this.prisma as any).employmentContract.findFirst({ // @tenant-reviewed: contracts-pilot-scope
      where: { id: contractId, employeeId, deletedAt: null, ...scope.tenantWhere() },
    });
    if (!existing) throw new NotFoundException('Contract not found');

    const data: any = {};
    if (dto.startDate !== undefined) data.startDate = new Date(dto.startDate);
    if (dto.endDate !== undefined)   data.endDate = dto.endDate ? new Date(dto.endDate) : null;
    if (dto.contractType !== undefined) data.contractType = dto.contractType?.trim() || 'Full-time';
    if (dto.notes !== undefined)     data.notes = dto.notes;
    if (dto.documentId !== undefined) data.documentId = dto.documentId ?? null;

    const nextStart = data.startDate ?? existing.startDate;
    const nextEnd = 'endDate' in data ? data.endDate : existing.endDate;
    data.status = ContractsService.deriveStatus(new Date(nextStart), nextEnd ? new Date(nextEnd) : null);

    const updated = await (this.prisma as any).employmentContract.update({ // @tenant-reviewed: contracts-pilot-scope
      where: { id: contractId }, data, include: this.include,
    });
    await this.refreshEmployeeContractDates(employeeId, actorId);
    await this.auditLog(actorId, 'EMPLOYMENT_CONTRACT_UPDATED', contractId, { employeeId, ...dto });
    return updated;
  }

  async remove(employeeId: string, contractId: string, actorId?: string) {
    const scope = this.scope();
    const existing = await (this.prisma as any).employmentContract.findFirst({ // @tenant-reviewed: contracts-pilot-scope
      where: { id: contractId, employeeId, deletedAt: null, ...scope.tenantWhere() },
    });
    if (!existing) throw new NotFoundException('Contract not found');
    await (this.prisma as any).employmentContract.update({ // @tenant-reviewed: contracts-pilot-scope
      where: { id: contractId },
      data: { deletedAt: new Date(), deletedBy: actorId ?? null },
    });
    await this.refreshEmployeeContractDates(employeeId, actorId);
    await this.auditLog(actorId, 'EMPLOYMENT_CONTRACT_DELETED', contractId, { employeeId });
    return { message: 'Contract deleted' };
  }

  /**
   * Close the employee's current contract with an effective end date —
   * used when a termination / end-of-contract is recorded (from the
   * Work History mirror, or the Contract Timeline "End" action routes
   * through the normal update). Picks the latest contract that is still
   * open-ended or ends on/after the given date, and sets its endDate.
   * No-op when there's no such contract.
   */
  async closeCurrentContract(employeeId: string, endDate: Date, actorId?: string): Promise<{ closed: boolean; contractId?: string }> {
    const contract = await this.legacyPrisma.employmentContract.findFirst({
      where: {
        employeeId, deletedAt: null,
        OR: [{ endDate: null }, { endDate: { gte: endDate } }],
      },
      orderBy: [{ startDate: 'desc' }, { createdAt: 'desc' }],
      select: { id: true, startDate: true, endDate: true },
    });
    if (!contract) return { closed: false };
    // Don't churn if it's already closed on that exact date.
    if (contract.endDate && ContractsService.calNum(new Date(contract.endDate)) === ContractsService.calNum(endDate)) {
      return { closed: true, contractId: contract.id };
    }
    await this.legacyPrisma.employmentContract.update({
      where: { id: contract.id },
      data: {
        endDate,
        status: ContractsService.deriveStatus(new Date(contract.startDate), endDate),
      },
    });
    await this.refreshEmployeeContractDates(employeeId, actorId);
    await this.auditLog(actorId, 'EMPLOYMENT_CONTRACT_CLOSED', contract.id, { employeeId, endDate });
    return { closed: true, contractId: contract.id };
  }

  // ── Documents integration ──────────────────────────────────────────────────

  /**
   * Auto-create/update a contract record from a just-uploaded contract
   * document. Best-effort: never throws into the upload path.
   *
   * Mapping: Document.issueDate → contract start; Document.expiryDate →
   * contract end (nullable). The row is keyed by `documentId` so a
   * re-upload / metadata edit updates the same contract instead of
   * creating duplicates.
   */
  async syncFromDocument(documentId: string, actorId?: string): Promise<void> {
    try {
      const doc = await this.legacyPrisma.document.findUnique({
        where: { id: documentId },
        select: {
          id: true, documentTypeId: true, entityType: true, entityId: true,
          issueDate: true, expiryDate: true, tenantId: true, deletedAt: true,
        },
      });
      if (!doc || doc.deletedAt) return;
      // Contracts are an employee concept only.
      if (doc.entityType !== 'EMPLOYEE') return;
      if (!(await this.isContractDocumentType(doc.documentTypeId))) return;

      const employeeId = doc.entityId;
      const start = doc.issueDate ? new Date(doc.issueDate) : new Date();
      const end = doc.expiryDate ? new Date(doc.expiryDate) : null;
      const status = ContractsService.deriveStatus(start, end);

      const existing = await this.legacyPrisma.employmentContract.findFirst({
        where: { documentId, deletedAt: null },
        select: { id: true },
      });

      if (existing) {
        await this.legacyPrisma.employmentContract.update({
          where: { id: existing.id },
          data: { startDate: start, endDate: end, status },
        });
        await this.auditLog(actorId, 'EMPLOYMENT_CONTRACT_SYNCED_FROM_DOCUMENT', existing.id, {
          employeeId, documentId, updated: true,
        });
      } else {
        const created = await this.legacyPrisma.employmentContract.create({
          data: {
            employeeId,
            startDate: start,
            endDate: end,
            contractType: 'Full-time',
            status,
            documentId,
            source: 'DOCUMENT',
            createdById: actorId ?? null,
            ...(doc.tenantId ? { tenantId: doc.tenantId } : {}),
          },
          select: { id: true },
        });
        await this.auditLog(actorId, 'EMPLOYMENT_CONTRACT_SYNCED_FROM_DOCUMENT', created.id, {
          employeeId, documentId, created: true,
        });
      }

      await this.refreshEmployeeContractDates(employeeId, actorId);
    } catch (e) {
      this.logger.warn(`syncFromDocument(${documentId}) failed: ${(e as Error)?.message ?? e}`);
    }
  }

  /** Whether a document type maps to contracts — configured id list
   *  first, else the default name match. */
  async isContractDocumentType(documentTypeId: string | null | undefined): Promise<boolean> {
    if (!documentTypeId) return false;
    const configured = await this.getConfiguredDocumentTypeIds();
    if (configured.length > 0) return configured.includes(documentTypeId);
    const dt = await this.legacyPrisma.documentType.findUnique({
      where: { id: documentTypeId }, select: { name: true },
    });
    const name = (dt?.name ?? '').trim().toLowerCase();
    return ContractsService.DEFAULT_TYPE_NAMES.some(n => name.includes(n));
  }

  /** Keep Employee.contractStartDate/EndDate synced to the most recent
   *  (latest-starting) contract so the existing contract-expiry cron and
   *  RENEWED detection keep working off a single source of truth. */
  private async refreshEmployeeContractDates(employeeId: string, actorId?: string): Promise<void> {
    try {
      const latest = await this.legacyPrisma.employmentContract.findFirst({
        where: { employeeId, deletedAt: null },
        orderBy: [{ startDate: 'desc' }, { createdAt: 'desc' }],
        select: { startDate: true, endDate: true },
      });
      await this.legacyPrisma.employee.update({
        where: { id: employeeId },
        data: {
          contractStartDate: latest?.startDate ?? null,
          contractEndDate: latest?.endDate ?? null,
        },
      });
    } catch (e) {
      this.logger.warn(`refreshEmployeeContractDates(${employeeId}) failed: ${(e as Error)?.message ?? e}`);
    }
    // After the dates are synced, re-evaluate the employment status so a
    // back-dated end terminates immediately; a future end does nothing
    // until the day passes (handled by the daily cron).
    await this.evaluateEmployeeStatusFromContracts(employeeId, actorId);
  }

  // ── Automatic status from the contract end date ─────────────────────────────
  //
  // Business rule: the employee stays ACTIVE through the whole of their
  // last contract's end day; only AFTER 00:00 the following day does the
  // status auto-change to TERMINATED. This lets HR enter a termination
  // in advance (e.g. sign on 02.06 with an agreed end of 30.06) without
  // the status flipping early. We never auto-reactivate — a manual
  // TERMINATED set by an admin is respected.

  private static readonly STATUS_TZ = process.env.CONTRACT_STATUS_TZ?.trim() || 'Europe/Bratislava';

  /** Calendar-date key (YYYYMMDD) from a Date's UTC components — contract
   *  dates are stored at UTC midnight representing a calendar day. */
  private static calNum(d: Date): number {
    return d.getUTCFullYear() * 10000 + (d.getUTCMonth() + 1) * 100 + d.getUTCDate();
  }

  /** Today's calendar-date key in the configured timezone, so "after
   *  00:00 the following day" matches local expectations. */
  private todayNum(): number {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: ContractsService.STATUS_TZ, year: 'numeric', month: '2-digit', day: '2-digit',
    }).formatToParts(new Date());
    const get = (t: string) => Number(parts.find(p => p.type === t)?.value ?? '0');
    return get('year') * 10000 + get('month') * 100 + get('day');
  }

  /**
   * Re-evaluate an employee's status from their latest contract.
   * Auto-terminates once the last contract's end day has fully passed.
   * No-op when the employee has no contracts (status is then manual).
   */
  async evaluateEmployeeStatusFromContracts(employeeId: string, actorId?: string): Promise<'terminated' | 'unchanged'> {
    try {
      const latest = await this.legacyPrisma.employmentContract.findFirst({
        where: { employeeId, deletedAt: null },
        orderBy: [{ startDate: 'desc' }, { createdAt: 'desc' }],
        select: { endDate: true },
      });
      if (!latest) return 'unchanged'; // no contract → don't manage status
      const ended = !!latest.endDate && ContractsService.calNum(new Date(latest.endDate)) < this.todayNum();
      if (!ended) return 'unchanged';

      const emp = await this.legacyPrisma.employee.findUnique({
        where: { id: employeeId }, select: { status: true },
      });
      if (!emp || (emp.status as string) === 'TERMINATED') return 'unchanged';

      await this.legacyPrisma.employee.update({
        where: { id: employeeId }, data: { status: 'TERMINATED' as any },
      });
      await this.auditLog(actorId, 'EMPLOYEE_AUTO_TERMINATED_CONTRACT_ENDED', employeeId, {
        endDate: latest.endDate, previousStatus: emp.status,
      });
      return 'terminated';
    } catch (e) {
      this.logger.warn(`evaluateEmployeeStatusFromContracts(${employeeId}) failed: ${(e as Error)?.message ?? e}`);
      return 'unchanged';
    }
  }

  /**
   * Daily sweep: terminate every employee whose last contract's end day
   * has passed. Called by ContractStatusCron. Broad candidate query
   * (contractEndDate already elapsed) then the precise per-employee
   * calendar check inside evaluate.
   */
  async runStatusSweep(): Promise<{ scanned: number; terminated: number }> {
    const candidates = await this.legacyPrisma.employee.findMany({
      where: {
        deletedAt: null,
        status: { not: 'TERMINATED' as any },
        contractEndDate: { not: null, lt: new Date() },
      },
      select: { id: true },
      take: 10000,
    });
    let terminated = 0;
    for (const c of candidates) {
      const r = await this.evaluateEmployeeStatusFromContracts(c.id);
      if (r === 'terminated') terminated += 1;
    }
    return { scanned: candidates.length, terminated };
  }

  // ── Settings — which document types map to contracts ────────────────────────

  async getConfiguredDocumentTypeIds(): Promise<string[]> {
    try {
      const row = await this.legacyPrisma.systemSetting.findUnique({
        where: { key: ContractsService.SETTING_KEY },
        select: { value: true },
      });
      if (!row?.value) return [];
      const parsed = JSON.parse(row.value);
      return Array.isArray(parsed) ? parsed.filter((x: any) => typeof x === 'string') : [];
    } catch {
      return [];
    }
  }

  /** Admin settings view: the configured ids + the full document-type
   *  list to choose from. */
  async getSettings(): Promise<{ documentTypeIds: string[]; available: Array<{ id: string; name: string; category: string }> }> {
    const [documentTypeIds, available] = await Promise.all([
      this.getConfiguredDocumentTypeIds(),
      this.legacyPrisma.documentType.findMany({
        where: { deletedAt: null, isActive: true },
        select: { id: true, name: true, category: true },
        orderBy: { name: 'asc' },
      }),
    ]);
    return { documentTypeIds, available };
  }

  async setDocumentTypeIds(ids: string[], actorId?: string): Promise<{ documentTypeIds: string[] }> {
    const clean = Array.from(new Set((ids ?? []).filter(x => typeof x === 'string' && x.trim()))).map(x => x.trim());
    const value = JSON.stringify(clean);
    await this.legacyPrisma.systemSetting.upsert({
      where: { key: ContractsService.SETTING_KEY },
      update: { value, updatedById: actorId ?? null },
      create: {
        key: ContractsService.SETTING_KEY,
        value,
        description: 'Document type ids that auto-create/update employment contracts on upload.',
        category: 'contracts',
        isPublic: false,
        updatedById: actorId ?? null,
      },
    });
    return { documentTypeIds: clean };
  }

  private async auditLog(userId: string | undefined, action: string, entityId: string, changes?: any) {
    try {
      await this.legacyPrisma.auditLog.create({
        data: { userId, action, entity: 'EmploymentContract', entityId, changes: changes as any },
      });
    } catch { /* audit must never crash main flow */ }
  }
}
