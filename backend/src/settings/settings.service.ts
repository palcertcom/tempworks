import { Injectable, NotFoundException } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { PrismaService } from '../prisma/prisma.service';
import { StorageService } from '../common/storage/storage.service';
import { AuditLogService } from '../logs/audit-log.service';
import { BatchUpdateSettingsDto } from './dto/update-settings.dto';
import { CreateJobTypeDto } from './dto/create-job-type.dto';
import { CreateDocumentTypeDto } from './dto/create-document-type.dto';
import { CreateNotificationRuleDto } from './dto/create-notification-rule.dto';
import { NotificationsService } from '../notifications/notifications.service';
import { NOTIF_EVENTS } from '../notifications/notification-events';

@Injectable()
export class SettingsService {
  constructor(
    private prisma: PrismaService,
    private auditLog: AuditLogService,
    private storage: StorageService,
    private moduleRef: ModuleRef,
  ) {}

  /** Late-bound notifications handle. NotificationsModule isn't imported
   *  here to avoid a circular dependency (NotificationsService pulls in
   *  audit-log → settings). Resolved lazily on first use. */
  private notificationsCache: NotificationsService | null = null;
  private getNotifications(): NotificationsService | null {
    if (this.notificationsCache) return this.notificationsCache;
    try {
      this.notificationsCache = this.moduleRef.get(NotificationsService, { strict: false });
    } catch {
      this.notificationsCache = null;
    }
    return this.notificationsCache;
  }

  async getPublicFormSettings(): Promise<Record<string, any>> {
    const settings = await this.prisma.systemSetting.findMany({
      where: { category: 'form' },
      orderBy: { key: 'asc' },
    });
    const result: Record<string, any> = {};
    for (const s of settings) {
      // Strip category prefix (e.g. "form.visaTypes" → "visaTypes")
      const key = s.key.replace(/^form\./, '');
      try { result[key] = JSON.parse(s.value); } catch { result[key] = s.value; }
    }
    return result;
  }

  // ─── Vehicle Settings (centralised lookup lists) ─────────────────────────────
  // Every vehicle dropdown list (statuses, fuel types, body types, etc.)
  // is stored in system_settings under the `vehicle` category as a
  // JSON-encoded array of strings. The frontend Vehicle Settings page
  // and Vehicle form both read from this single endpoint.
  private readonly VEHICLE_LOOKUP_KEYS = [
    'vehicle.vehicleTypes',
    'vehicle.statuses',
    'vehicle.fuelTypes',
    'vehicle.bodyTypes',
    'vehicle.hitchTypes',
    'vehicle.tankMaterials',
    'vehicle.adrClasses',
    'vehicle.vinSubTypes',
    'vehicle.insuranceGroups',
    'vehicle.insuranceTypes',
    'vehicle.documentTypes',
    'vehicle.euroEmissionClasses',
  ];

  async getVehicleSettings(): Promise<Record<string, string[]>> {
    const settings = await this.prisma.systemSetting.findMany({
      where: { category: 'vehicle' },
    });
    const result: Record<string, string[]> = {};
    for (const key of this.VEHICLE_LOOKUP_KEYS) {
      const found = settings.find((s) => s.key === key);
      const short = key.replace(/^vehicle\./, '');
      if (!found) { result[short] = []; continue; }
      try {
        const parsed = JSON.parse(found.value);
        result[short] = Array.isArray(parsed) ? parsed.map((v) => String(v)) : [];
      } catch {
        result[short] = [];
      }
    }
    return result;
  }

  async updateVehicleSetting(shortKey: string, values: string[], userId: string) {
    const fullKey = `vehicle.${shortKey}`;
    if (!this.VEHICLE_LOOKUP_KEYS.includes(fullKey)) {
      throw new NotFoundException(`Unknown vehicle settings key: ${shortKey}`);
    }
    const cleaned = Array.from(
      new Set(
        (values ?? [])
          .map((v) => (typeof v === 'string' ? v.trim() : ''))
          .filter((v) => v.length > 0),
      ),
    );
    const updated = await this.prisma.systemSetting.upsert({
      where: { key: fullKey },
      update: { value: JSON.stringify(cleaned), updatedById: userId },
      create: {
        key: fullKey,
        value: JSON.stringify(cleaned),
        category: 'vehicle',
        description: `Vehicle Management — ${shortKey} lookup`,
        isPublic: false,
        updatedById: userId,
      },
    });
    await this.auditLog.log({
      userId,
      action: 'UPDATE',
      entity: 'VehicleSetting',
      entityId: fullKey,
      changes: { values: cleaned },
    });
    return { key: shortKey, values: cleaned, updatedAt: updated.updatedAt };
  }

  async findAll(includePrivate = false) {
    const where = includePrivate ? {} : { isPublic: true };
    const settings = await this.prisma.systemSetting.findMany({
      where, orderBy: [{ category: 'asc' }, { key: 'asc' }],
    });
    const grouped: Record<string, any[]> = {};
    for (const s of settings) {
      if (!grouped[s.category]) grouped[s.category] = [];
      grouped[s.category].push(s);
    }
    return grouped;
  }

  async batchUpdate(dto: BatchUpdateSettingsDto, userId: string, activeTenantId?: string) {
    // Phase 3.17 — branding.* keys are tenant-scoped when there is an
    // active tenant on the JWT: they land on Tenant.branding so each
    // tenant gets its own logo, name, colour, tagline, etc. without
    // overwriting the others. Non-branding keys still go to the
    // shared system_settings table (legacy behaviour).
    // @tenant-reviewed: phase317-multi-tenant-login
    const tenantBrandingPatch: Record<string, string> = {};
    let tenantDisplayName: string | undefined;

    const results: any[] = [];
    for (const [key, value] of Object.entries(dto.settings ?? {})) {
      const isBranding = key.startsWith('branding.');
      if (activeTenantId && isBranding) {
        const field = key.replace(/^branding\./, '');
        if (field === 'companyName') tenantDisplayName = value;
        else tenantBrandingPatch[field] = value;
        continue;
      }
      const updated = await this.prisma.systemSetting.upsert({
        where: { key },
        update: { value, updatedById: userId },
        create: {
          key, value, updatedById: userId, description: key,
          category: key.split('.')[0] || 'general',
          isPublic: isBranding,
        },
      });
      results.push(updated);
    }

    if (activeTenantId && (Object.keys(tenantBrandingPatch).length || tenantDisplayName !== undefined)) {
      const tenant = await (this.prisma as any).tenant.findUnique({
        where: { id: activeTenantId }, select: { branding: true },
      }).catch(() => null);
      const merged = { ...(tenant?.branding ?? {}), ...tenantBrandingPatch };
      await (this.prisma as any).tenant.update({
        where: { id: activeTenantId },
        data: {
          branding: merged as any,
          ...(tenantDisplayName !== undefined ? { name: tenantDisplayName } : {}),
        },
      });
    }

    await this.auditLog.log({
      userId,
      action: 'UPDATE',
      entity: activeTenantId ? 'Tenant' : 'Settings',
      entityId: activeTenantId ?? 'system',
      changes: dto.settings as any,
    });
    return results;
  }

  // ─── Branding ────────────────────────────────────────────────────────────────
  async getBranding(opts?: { tenantId?: string; tenantHint?: string }): Promise<Record<string, string>> {
    // System defaults from system_settings (legacy single-tenant path).
    const settings = await this.prisma.systemSetting.findMany({
      where: { key: { startsWith: 'branding.' } },
    });
    const result: Record<string, string> = {};
    for (const s of settings) {
      result[s.key.replace('branding.', '')] = s.value;
    }

    // Phase 3.17 — overlay the active tenant's branding so each tenant
    // can show its own logo, primary color, and display name. The
    // Tenant model stores these on the existing `branding Json?` column
    // (see Phase 3.15). Falls back silently when no tenant is resolved
    // so single-tenant deployments keep the old behaviour.
    // @tenant-reviewed: phase317-multi-tenant-login
    let tenant: any = null;
    try {
      if (opts?.tenantId) {
        tenant = await (this.prisma as any).tenant.findUnique({
          where: { id: opts.tenantId },
          select: { id: true, name: true, slug: true, branding: true },
        });
      } else if (opts?.tenantHint) {
        const hint = opts.tenantHint.trim().toLowerCase();
        tenant = await (this.prisma as any).tenant.findFirst({
          where: { OR: [{ slug: hint }, { customDomain: hint }] },
          select: { id: true, name: true, slug: true, branding: true },
        });
      }
    } catch { tenant = null; }

    if (tenant) {
      const b: any = tenant.branding ?? {};
      // companyName: the tenant's display name takes precedence.
      result.companyName = tenant.name || result.companyName;
      // Logo + primary colour come straight from Tenant.branding when set.
      if (typeof b.logoUrl === 'string' && b.logoUrl)        result.logoUrl      = b.logoUrl;
      if (typeof b.primaryColor === 'string' && b.primaryColor) result.primaryColor = b.primaryColor;
      // Optional copy fields — only override when the tenant has set them.
      for (const k of ['tagline', 'heroBadge', 'heroHeadline', 'heroDescription',
                       'address', 'phone1', 'phone2',
                       'emailInfo', 'emailRecruitment', 'emailSupport',
                       'linkedIn', 'facebook', 'footerTagline', 'vatInfo']) {
        if (typeof b[k] === 'string' && b[k]) result[k] = b[k];
      }
      result.tenantId   = tenant.id;
      result.tenantSlug = tenant.slug;
    }

    return result;
  }

  async uploadLogo(file: Express.Multer.File, userId: string, activeTenantId?: string) {
    // Push the file to the storage backend first so we have a stable URL
    // to write into either the tenant branding blob or the system setting.
    const upload = await this.storage.uploadFile(file.buffer, {
      keyPrefix: activeTenantId ? `tenants/${activeTenantId}/branding` : 'settings/branding',
      contentType: file.mimetype,
      originalName: file.originalname,
      inline: true,
    });

    // Phase 3.17 — when a tenant context is present, the new logo
    // belongs to that tenant's branding blob so the overlay in
    // getBranding picks it up immediately. The legacy system setting
    // is left untouched so single-tenant deployments keep their
    // existing logo as a fallback.
    // @tenant-reviewed: phase317-multi-tenant-login
    let previousUrl: string | null = null;
    if (activeTenantId) {
      const tenant = await (this.prisma as any).tenant.findUnique({
        where: { id: activeTenantId }, select: { branding: true },
      }).catch(() => null);
      const branding = { ...(tenant?.branding ?? {}) };
      previousUrl = typeof branding.logoUrl === 'string' ? branding.logoUrl : null;
      branding.logoUrl = upload.url;
      await (this.prisma as any).tenant.update({
        where: { id: activeTenantId },
        data: { branding: branding as any },
      });
    } else {
      const previous = await this.prisma.systemSetting.findUnique({ where: { key: 'branding.logoUrl' } });
      previousUrl = previous?.value ?? null;
      await this.prisma.systemSetting.upsert({
        where: { key: 'branding.logoUrl' },
        update: { value: upload.url, updatedById: userId },
        create: { key: 'branding.logoUrl', value: upload.url, category: 'branding', description: 'Company logo URL', isPublic: true, updatedById: userId },
      });
    }

    if (previousUrl && previousUrl !== upload.url) {
      await this.storage.deleteFileByUrlOrKey(previousUrl);
    }

    await this.auditLog.log({
      userId, action: 'UPDATE', entity: activeTenantId ? 'Tenant' : 'Settings',
      entityId: activeTenantId ?? 'branding.logoUrl',
      changes: { logoUrl: upload.url, tenantId: activeTenantId ?? null },
    });
    return { logoUrl: upload.url, tenantId: activeTenantId ?? null };
  }

  // ─── Job Types ──────────────────────────────────────────────────────────────
  async findJobTypes(opts?: { includeInactive?: boolean }) {
    // Phase 3.16 — `deletedAt` rows are out of scope here (they live in
    // the Recycle Bin). Ensure the soft-delete columns exist before
    // querying so dev DBs that have drifted from the migration history
    // are self-healed on the very first list call.
    await this.ensureJobTypeSoftDeleteColumns();
    const where: any = { deletedAt: null };
    if (!opts?.includeInactive) where.isActive = true;
    return this.prisma.jobType.findMany({
      where,
      orderBy: { name: 'asc' },
      include: { _count: { select: { applicants: true } } },
    });
  }

  async createJobType(dto: CreateJobTypeDto, actorId?: string) {
    const jt = await this.prisma.jobType.create({ data: { ...dto, isActive: dto.isActive ?? true } });
    await this.auditLog.log({
      userId: actorId,
      action: 'CREATE',
      entity: 'JobType',
      entityId: jt.id,
      changes: { name: jt.name },
    });
    return jt;
  }

  async updateJobType(id: string, dto: Partial<CreateJobTypeDto>, actorId?: string) {
    const jt = await this.prisma.jobType.findUnique({ where: { id } });
    if (!jt) throw new NotFoundException('Job type not found');
    const updated = await this.prisma.jobType.update({ where: { id }, data: dto });
    await this.auditLog.log({
      userId: actorId,
      action: 'UPDATE',
      entity: 'JobType',
      entityId: id,
      changes: dto as any,
    });
    return updated;
  }

  /**
   * Phase 3.16 — make sure the job_types soft-delete columns exist
   * before any read/write touches them. Idempotent and additive;
   * matches the saas_phase316_jobtype_soft_delete migration so dev DBs
   * that have drifted from the migration history are auto-healed on
   * the first job-type list or delete call. Memoised per process so
   * we don't issue redundant ALTERs.
   */
  private jobTypeSoftDeleteReady: Promise<void> | null = null;
  private ensureJobTypeSoftDeleteColumns(): Promise<void> {
    if (this.jobTypeSoftDeleteReady) return this.jobTypeSoftDeleteReady;
    this.jobTypeSoftDeleteReady = (async () => {
      try {
        await this.prisma.$executeRawUnsafe(`
          ALTER TABLE "job_types"
            ADD COLUMN IF NOT EXISTS "deletedAt"      TIMESTAMP(3),
            ADD COLUMN IF NOT EXISTS "deletedBy"      TEXT,
            ADD COLUMN IF NOT EXISTS "deletionReason" TEXT;
        `);
        await this.prisma.$executeRawUnsafe(
          `CREATE INDEX IF NOT EXISTS "job_types_deletedAt_idx" ON "job_types"("deletedAt");`,
        );
      } catch {
        // best-effort: if the ALTER fails the subsequent typed query
        // will surface the real error. Reset the promise so a retry
        // is possible on the next call.
        this.jobTypeSoftDeleteReady = null;
      }
    })();
    return this.jobTypeSoftDeleteReady;
  }

  async deleteJobType(id: string, actorId?: string) {
    const jt = await this.prisma.jobType.findUnique({ where: { id } });
    if (!jt) throw new NotFoundException('Job type not found');
    if ((jt as any).deletedAt) {
      return { deleted: true, message: 'Job type is already deleted' };
    }
    await this.ensureJobTypeSoftDeleteColumns();

    // Phase 3.16 — soft-delete via deletedAt. The row drops out of the
    // settings list and surfaces in the Recycle Bin for restore or
    // hard delete. isActive is left untouched so a Restore that does
    // not also flip isActive returns the row to whatever active/
    // deactivated state it was in before deletion.
    const [applicantCount, employeeCount] = await Promise.all([
      this.prisma.applicant.count({ where: { jobTypeId: id } }),
      this.prisma.employee.count({ where: { jobTypeId: id } }),
    ]);

    // Update via raw SQL so the path works even on a runtime whose
    // Prisma client still predates the new columns (the schema in this
    // commit knows about them, but a stale `node_modules/@prisma/client`
    // build will reject the typed update).
    await this.prisma.$executeRawUnsafe(
      `UPDATE "job_types" SET "deletedAt" = NOW(), "deletedBy" = $1 WHERE "id" = $2`,
      actorId ?? null, id,
    );

    await this.auditLog.log({
      userId: actorId,
      action: 'DELETE',
      entity: 'JobType',
      entityId: id,
      changes: { name: jt.name, mode: 'soft', applicantCount, employeeCount },
    });
    return {
      deleted: true,
      applicantCount,
      employeeCount,
      message: 'Job type moved to Deleted Records',
    };
  }

  // ─── Finance Transaction Types ───────────────────────────────────────────────
  // Configurable list that populates the "Transaction Type" dropdown
  // on the financial record form. Historical financial_records rows
  // keep their plain-string transactionType regardless of whether a
  // type is deactivated later.

  async findTransactionTypes(opts?: { includeInactive?: boolean }) {
    return (this.prisma as any).financeTransactionType.findMany({
      where: opts?.includeInactive ? {} : { isActive: true },
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
    });
  }

  async createTransactionType(dto: { name: string; sortOrder?: number; isActive?: boolean }, actorId?: string) {
    const trimmed = (dto.name ?? '').trim();
    if (!trimmed) throw new NotFoundException('Name is required');
    try {
      const created = await (this.prisma as any).financeTransactionType.create({
        data: {
          name: trimmed,
          sortOrder: dto.sortOrder ?? 100,
          isActive: dto.isActive ?? true,
        },
      });
      await this.auditLog.log({
        userId: actorId, action: 'CREATE', entity: 'FinanceTransactionType',
        entityId: created.id, changes: { name: created.name },
      });
      return created;
    } catch (err: any) {
      // Unique-constraint collision — friendly error.
      if (err?.code === 'P2002') throw new NotFoundException(`Transaction type "${trimmed}" already exists`);
      throw err;
    }
  }

  async updateTransactionType(
    id: string,
    dto: { name?: string; sortOrder?: number; isActive?: boolean },
    actorId?: string,
  ) {
    const existing = await (this.prisma as any).financeTransactionType.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('Transaction type not found');
    const data: any = {};
    if (dto.name !== undefined) data.name = dto.name.trim();
    if (dto.sortOrder !== undefined) data.sortOrder = dto.sortOrder;
    if (dto.isActive !== undefined) data.isActive = dto.isActive;
    try {
      const updated = await (this.prisma as any).financeTransactionType.update({ where: { id }, data });
      await this.auditLog.log({
        userId: actorId, action: 'UPDATE', entity: 'FinanceTransactionType',
        entityId: id, changes: dto as any,
      });
      return updated;
    } catch (err: any) {
      if (err?.code === 'P2002') throw new NotFoundException(`Transaction type "${data.name}" already exists`);
      throw err;
    }
  }

  // ─── Work History Event Types ───────────────────────────────────────────────
  // Populates the Event Type dropdown inside the Employee profile's
  // Contracts tab. Deactivating a type hides it from the dropdown but
  // keeps existing employee_work_history rows intact (value is a free
  // string on that table).

  async findWorkHistoryEventTypes(opts?: { includeInactive?: boolean }) {
    return (this.prisma as any).workHistoryEventTypeSetting.findMany({
      where: opts?.includeInactive ? {} : { isActive: true },
      orderBy: [{ sortOrder: 'asc' }, { label: 'asc' }],
    });
  }

  async createWorkHistoryEventType(
    dto: { value: string; label: string; sortOrder?: number; isActive?: boolean },
    actorId?: string,
  ) {
    const value = (dto.value ?? '').trim();
    const label = (dto.label ?? '').trim();
    if (!value) throw new NotFoundException('Value is required');
    if (!label) throw new NotFoundException('Label is required');
    try {
      const created = await (this.prisma as any).workHistoryEventTypeSetting.create({
        data: {
          value,
          label,
          sortOrder: dto.sortOrder ?? 100,
          isActive: dto.isActive ?? true,
        },
      });
      await this.auditLog.log({
        userId: actorId, action: 'CREATE', entity: 'WorkHistoryEventType',
        entityId: created.id, changes: { value, label },
      });
      return created;
    } catch (err: any) {
      if (err?.code === 'P2002') throw new NotFoundException(`Event type "${value}" already exists`);
      throw err;
    }
  }

  async updateWorkHistoryEventType(
    id: string,
    dto: { value?: string; label?: string; sortOrder?: number; isActive?: boolean },
    actorId?: string,
  ) {
    const existing = await (this.prisma as any).workHistoryEventTypeSetting.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('Event type not found');
    const data: any = {};
    if (dto.value !== undefined)     data.value = dto.value.trim();
    if (dto.label !== undefined)     data.label = dto.label.trim();
    if (dto.sortOrder !== undefined) data.sortOrder = dto.sortOrder;
    if (dto.isActive !== undefined)  data.isActive = dto.isActive;
    try {
      const updated = await (this.prisma as any).workHistoryEventTypeSetting.update({ where: { id }, data });
      await this.auditLog.log({
        userId: actorId, action: 'UPDATE', entity: 'WorkHistoryEventType',
        entityId: id, changes: dto as any,
      });
      return updated;
    } catch (err: any) {
      if (err?.code === 'P2002') throw new NotFoundException(`Event type "${data.value}" already exists`);
      throw err;
    }
  }

  async deleteWorkHistoryEventType(id: string, actorId?: string) {
    const existing = await (this.prisma as any).workHistoryEventTypeSetting.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('Event type not found');
    await (this.prisma as any).workHistoryEventTypeSetting.update({
      where: { id }, data: { isActive: false },
    });
    await this.auditLog.log({
      userId: actorId, action: 'DELETE', entity: 'WorkHistoryEventType',
      entityId: id, changes: { value: existing.value, label: existing.label },
    });
    return { message: 'Event type deactivated' };
  }

  async deleteTransactionType(id: string, actorId?: string) {
    const existing = await (this.prisma as any).financeTransactionType.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('Transaction type not found');
    // Soft delete — deactivate so existing financial_records keep
    // rendering the label without reintroducing it to the dropdown.
    await (this.prisma as any).financeTransactionType.update({ where: { id }, data: { isActive: false } });
    await this.auditLog.log({
      userId: actorId, action: 'DELETE', entity: 'FinanceTransactionType',
      entityId: id, changes: { name: existing.name },
    });
    return { message: 'Transaction type deactivated' };
  }

  // ─── Document Types ──────────────────────────────────────────────────────────
  async findDocumentTypes() {
    return this.prisma.documentType.findMany({
      where: { isActive: true },
      orderBy: [{ category: 'asc' }, { name: 'asc' }],
      include: { _count: { select: { documents: true } } },
    });
  }

  async findDocumentType(id: string) {
    const dt = await this.prisma.documentType.findUnique({
      where: { id },
      include: { _count: { select: { documents: true } } },
    });
    if (!dt) throw new NotFoundException('Document type not found');
    return dt;
  }

  async createDocumentType(dto: CreateDocumentTypeDto, actorId?: string) {
    const dt = await this.prisma.documentType.create({ data: { ...dto, isActive: dto.isActive ?? true } });
    await this.auditLog.log({
      userId: actorId,
      action: 'CREATE',
      entity: 'DocumentType',
      entityId: dt.id,
      changes: { name: dt.name, category: dt.category },
    });
    return dt;
  }

  async updateDocumentType(id: string, dto: Partial<CreateDocumentTypeDto>, actorId?: string) {
    const dt = await this.prisma.documentType.findUnique({ where: { id } });
    if (!dt) throw new NotFoundException('Document type not found');
    const updated = await this.prisma.documentType.update({ where: { id }, data: dto });
    await this.auditLog.log({
      userId: actorId,
      action: 'UPDATE',
      entity: 'DocumentType',
      entityId: id,
      changes: dto as any,
    });
    return updated;
  }

  async deleteDocumentType(id: string, actorId?: string) {
    const dt = await this.prisma.documentType.findUnique({ where: { id } });
    if (!dt) throw new NotFoundException('Document type not found');
    await this.prisma.documentType.update({ where: { id }, data: { isActive: false } });
    await this.auditLog.log({
      userId: actorId,
      action: 'DELETE',
      entity: 'DocumentType',
      entityId: id,
      changes: { name: dt.name },
    });
    return { message: 'Document type deactivated' };
  }

  // ─── Workflow Stages ─────────────────────────────────────────────────────────
  async findWorkflowStages() {
    return this.prisma.stageTemplate.findMany({ orderBy: { order: 'asc' } });
  }

  async createWorkflowStage(dto: any, actorId?: string) {
    const maxOrder = await this.prisma.stageTemplate.aggregate({ _max: { order: true } });
    const nextOrder = (maxOrder._max.order ?? 0) + 1;
    const stage = await this.prisma.stageTemplate.create({
      data: {
        name: dto.name,
        description: dto.description,
        color: dto.color ?? '#2563EB',
        order: nextOrder,
        category: dto.category ?? 'INITIAL',
        requirementsDocuments: dto.requirementsDocuments ?? [],
        requirementsActions: dto.requirementsActions ?? [],
        requirementsApprovals: dto.requirementsApprovals ?? [],
      },
    });
    await this.auditLog.log({
      userId: actorId,
      action: 'CREATE',
      entity: 'StageTemplate',
      entityId: stage.id,
      changes: { name: stage.name },
    });
    return stage;
  }

  async updateWorkflowStage(id: string, dto: any, actorId?: string) {
    const stage = await this.prisma.stageTemplate.findUnique({ where: { id } });
    if (!stage) throw new NotFoundException('Workflow stage not found');
    const updated = await this.prisma.stageTemplate.update({ where: { id }, data: dto });
    await this.auditLog.log({
      userId: actorId,
      action: 'UPDATE',
      entity: 'StageTemplate',
      entityId: id,
      changes: dto,
    });
    return updated;
  }

  async deleteWorkflowStage(id: string, actorId?: string) {
    const stage = await this.prisma.stageTemplate.findUnique({ where: { id } });
    if (!stage) throw new NotFoundException('Workflow stage not found');
    await this.prisma.stageTemplate.update({ where: { id }, data: { isActive: false } });
    await this.auditLog.log({
      userId: actorId,
      action: 'DELETE',
      entity: 'StageTemplate',
      entityId: id,
      changes: { name: stage.name },
    });
    return { message: 'Workflow stage deleted' };
  }

  async reorderWorkflowStages(orders: { id: string; order: number }[], actorId?: string) {
    await Promise.all(
      orders.map(({ id, order }) =>
        this.prisma.stageTemplate.update({ where: { id }, data: { order } }),
      ),
    );
    await this.auditLog.log({
      userId: actorId,
      action: 'UPDATE',
      entity: 'StageTemplate',
      entityId: 'bulk',
      changes: { reorder: orders },
    });
    return { message: 'Stages reordered' };
  }

  // ─── System Information ──────────────────────────────────────────────────────
  private readonly SYSTEM_INFO_KEYS = [
    'system.version',
    'system.organizationName',
    'system.contactEmail',
    'system.supportPhone',
    'system.address',
    'system.website',
    'system.lastUpdated',
  ];

  async getSystemInfo(): Promise<Record<string, string>> {
    const settings = await this.prisma.systemSetting.findMany({
      where: { category: 'system' },
    });
    const map: Record<string, string> = {};
    for (const key of this.SYSTEM_INFO_KEYS) {
      const found = settings.find((s) => s.key === key);
      map[key.replace('system.', '')] = found?.value ?? '';
    }
    return map;
  }

  async updateSystemInfo(data: Record<string, string>, userId: string): Promise<Record<string, string>> {
    // Snapshot the current version BEFORE the upsert so we can detect a
    // delta and fire SYSTEM_VERSION_UPDATED to every active user. The
    // value lives in the same `system_settings` table the form writes
    // to; an unchanged version is a silent no-op.
    const prevVersionRow = await this.prisma.systemSetting.findUnique({
      where: { key: 'system.version' },
      select: { value: true },
    });
    const previousVersion = prevVersionRow?.value ?? null;

    for (const [field, value] of Object.entries(data)) {
      const key = `system.${field}`;
      if (!this.SYSTEM_INFO_KEYS.includes(key)) continue;
      await this.prisma.systemSetting.upsert({
        where: { key },
        update: { value, updatedById: userId },
        create: { key, value, updatedById: userId, description: field, category: 'system', isPublic: false },
      });
    }
    await this.auditLog.log({
      userId,
      action: 'UPDATE',
      entity: 'SystemInfo',
      entityId: 'system',
      changes: data as any,
    });

    const nextVersion = typeof data.version === 'string' ? data.version.trim() : null;
    if (nextVersion && nextVersion !== (previousVersion ?? '').trim()) {
      const notifications = this.getNotifications();
      if (notifications) {
        const title = `New version available — v${nextVersion}`;
        const body = previousVersion
          ? `The platform has been upgraded from v${previousVersion} to v${nextVersion}. Refresh your browser to load the latest build.`
          : `The platform is now running v${nextVersion}. Refresh your browser to load the latest build.`;
        notifications.notifyAllUsers(
          undefined,
          NOTIF_EVENTS.SYSTEM_VERSION_UPDATED,
          title,
          body,
          'SYSTEM',
          nextVersion,
          {
            titleKey:   'events.systemVersionUpdated.title',
            messageKey: 'events.systemVersionUpdated.body',
            params:     { previousVersion, currentVersion: nextVersion, actorId: userId },
          },
          'NORMAL',
        ).catch(() => undefined);
      }
    }

    return this.getSystemInfo();
  }

  async getSystemStats(): Promise<Record<string, any>> {
    const [userCount, employeeCount, applicantCount, agencyCount] = await Promise.all([
      this.prisma.user.count({ where: { deletedAt: null } }),
      this.prisma.employee.count({ where: { deletedAt: null } }),
      this.prisma.applicant.count({ where: { deletedAt: null } }),
      this.prisma.agency.count({ where: { deletedAt: null } }),
    ]);
    return {
      totalUsers: userCount,
      totalEmployees: employeeCount,
      totalApplicants: applicantCount,
      totalAgencies: agencyCount,
      databaseStatus: 'Connected',
    };
  }

  // ─── Notification Rules ──────────────────────────────────────────────────────
  async findNotificationRules() {
    return this.prisma.notificationRule.findMany({ where: { deletedAt: null }, orderBy: { name: 'asc' } });
  }

  async createNotificationRule(dto: CreateNotificationRuleDto, actorId?: string) {
    const rule = await this.prisma.notificationRule.create({ data: { ...dto, isActive: dto.isActive ?? true } });
    await this.auditLog.log({
      userId: actorId,
      action: 'CREATE',
      entity: 'NotificationRule',
      entityId: rule.id,
      changes: { name: rule.name },
    });
    return rule;
  }

  async updateNotificationRule(id: string, dto: Partial<CreateNotificationRuleDto>, actorId?: string) {
    const rule = await this.prisma.notificationRule.findUnique({ where: { id } });
    if (!rule) throw new NotFoundException('Notification rule not found');
    const updated = await this.prisma.notificationRule.update({ where: { id }, data: dto });
    await this.auditLog.log({
      userId: actorId,
      action: 'UPDATE',
      entity: 'NotificationRule',
      entityId: id,
      changes: dto as any,
    });
    return updated;
  }

  async deleteNotificationRule(id: string, actorId?: string) {
    const rule = await this.prisma.notificationRule.findUnique({ where: { id } });
    if (!rule) throw new NotFoundException('Notification rule not found');
    await this.prisma.notificationRule.update({ where: { id }, data: { deletedAt: new Date() } });
    await this.auditLog.log({
      userId: actorId,
      action: 'DELETE',
      entity: 'NotificationRule',
      entityId: id,
      changes: { name: rule.name },
    });
    return { message: 'Notification rule deleted' };
  }
}
