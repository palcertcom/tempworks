import {
  Injectable, NotFoundException, ConflictException, BadRequestException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AuditLogService } from '../logs/audit-log.service';
import { ENTITY_POLICIES } from './recycle-bin.service';
import { PilotPrismaAccessor } from '../saas/prisma/pilot-prisma.accessor';
import { getPilotScope } from '../saas/prisma/tenant-pilot-scope';
import { isTenantScopedEntity } from './tenant-scope-map';

export interface RestoreResult {
  success: boolean;
  entityType: string;
  id: string;
  restored: Record<string, number>;
  skipped: Record<string, string>;
  warnings: string[];
}

@Injectable()
export class RestoreService {
  constructor(
    private legacyPrisma: PrismaService,
    private auditLog: AuditLogService,
    private pilot: PilotPrismaAccessor,
  ) {}

  /** Pilot-aware client used for the initial ownership probe. The
   *  subsequent transaction always uses `legacyPrisma.$transaction` so
   *  legacy code paths inside the transaction body run unchanged.
   *  Cross-tenant id is filtered out at the probe step, before any
   *  mutation. */
  private get prisma(): PrismaService {
    return this.pilot.client();
  }

  /** Tenant ownership pre-check. Returns true iff the pilot is inactive
   *  OR the entity is global OR the record exists for the active tenant. */
  private async assertTenantOwnership(entityType: string, id: string): Promise<void> {
    const scope = getPilotScope(this.pilot, 'recycle-bin');
    if (!scope.active || !isTenantScopedEntity(entityType)) return;
    const t = scope.tenantWhere();
    const probe = await (this.prisma as any)[this.modelOf(entityType)].findFirst({
      where: { id, ...t },
      select: { id: true },
    });
    if (!probe) throw new NotFoundException(`Record not found in current tenant`);
  }

  private modelOf(entityType: string): string {
    return ({
      APPLICANT: 'applicant', EMPLOYEE: 'employee', AGENCY: 'agency',
      DOCUMENT: 'document', FINANCIAL_RECORD: 'financialRecord',
      JOB_AD: 'jobAd', NOTIFICATION: 'notification',
      VEHICLE: 'vehicle', VEHICLE_DOCUMENT: 'vehicleDocument',
      MAINTENANCE_RECORD: 'maintenanceRecord',
    } as Record<string, string>)[entityType] ?? entityType.toLowerCase();
  }

  // ── Main restore entry point ────────────────────────────────────────────────

  async restore(entityType: string, id: string, actorId: string, withRelated: boolean, reason?: string): Promise<RestoreResult> {
    const policy = ENTITY_POLICIES[entityType];
    if (!policy) {
      throw new BadRequestException(`Unknown entity type: ${entityType}`);
    }
    if (!policy.canRestore) {
      throw new BadRequestException(`Restore is not permitted for entity type: ${entityType}`);
    }
    if (withRelated && !policy.canRestoreWithRelated) {
      throw new BadRequestException(`Restore-with-related is not permitted for entity type: ${entityType}`);
    }

    // Phase 2.11 — tenant-ownership pre-check. No-op when the pilot is
    // off OR the entity is global. When the pilot is active and the
    // entity belongs to another tenant, raises NotFoundException
    // before any per-entity branch runs.
    await this.assertTenantOwnership(entityType, id);

    switch (entityType) {
      case 'APPLICANT':   return this.restoreApplicant(id, actorId, withRelated, reason);
      case 'EMPLOYEE':    return this.restoreEmployee(id, actorId, withRelated, reason);
      case 'USER':        return this.restoreUser(id, actorId, reason);
      case 'AGENCY':      return this.restoreAgency(id, actorId, reason);
      case 'DOCUMENT':    return this.restoreDocument(id, actorId, reason);
      case 'DOCUMENT_TYPE': return this.restoreDocumentType(id, actorId, reason);
      case 'JOB_AD':      return this.restoreJobAd(id, actorId, reason);
      case 'JOB_TYPE':    return this.restoreJobType(id, actorId, reason);
      case 'FINANCIAL_RECORD': return this.restoreFinancialRecord(id, actorId, withRelated, reason);
      case 'ROLE':        return this.restoreRole(id, actorId, reason);
      case 'REPORT':      return this.restoreReport(id, actorId, reason);
      case 'VEHICLE':     return this.restoreVehicle(id, actorId, withRelated, reason);
      case 'VEHICLE_DOCUMENT': return this.restoreVehicleDocument(id, actorId, reason);
      case 'MAINTENANCE_RECORD': return this.restoreMaintenanceRecord(id, actorId, reason);
      case 'MAINTENANCE_TYPE':   return this.restoreMaintenanceType(id, actorId, reason);
      case 'WORKSHOP':           return this.restoreWorkshop(id, actorId, reason);
      case 'NOTIFICATION':       return this.restoreNotification(id, actorId, reason);
      default:
        throw new BadRequestException(`No restore handler for entity type: ${entityType}`);
    }
  }

  // ── Restore handlers ────────────────────────────────────────────────────────

  private async restoreApplicant(id: string, actorId: string, withRelated: boolean, reason?: string): Promise<RestoreResult> {
    const record = await this.legacyPrisma.applicant.findUnique({ where: { id } }); // @tenant-reviewed: phase211-pilot-scope (ownership pre-checked)
    if (!record) throw new NotFoundException(`Applicant ${id} not found`);
    if (!record.deletedAt) throw new ConflictException('Applicant is not deleted');

    // Check unique email conflict
    const emailConflict = await this.legacyPrisma.applicant.findFirst({ // @tenant-reviewed: phase211-pilot-scope (ownership pre-checked)
      where: { email: record.email, deletedAt: null, id: { not: id } },
    });
    if (emailConflict) {
      throw new ConflictException(`Cannot restore: email ${record.email} is already in use by another applicant`);
    }

    const restored: Record<string, number> = { applicant: 0 };
    const skipped: Record<string, string> = {};
    const warnings: string[] = [];

    await this.legacyPrisma.$transaction(async tx => { // @tenant-reviewed: phase211-pilot-scope (ownership pre-checked)
      await tx.applicant.update({ where: { id }, data: { deletedAt: null, deletedBy: null, deletionReason: null } });
      restored.applicant = 1;

      if (withRelated) {
        const docs = await tx.document.updateMany({
          where: { entityId: id, entityType: 'APPLICANT', deletedAt: { not: null } },
          data: { deletedAt: null, deletedBy: null, deletionReason: null },
        });
        restored.documents = docs.count;

        const frs = await tx.financialRecord.updateMany({
          where: { entityId: id, entityType: 'APPLICANT', deletedAt: { not: null } },
          data: { deletedAt: null, deletedBy: null, deletionReason: null },
        });
        restored.financialRecords = frs.count;

        // Restore attachments for restored financial records
        const frIds = await tx.financialRecord
          .findMany({ where: { entityId: id, entityType: 'APPLICANT' }, select: { id: true } })
          .then(rs => rs.map(r => r.id));
        if (frIds.length > 0) {
          const atts = await tx.financialRecordAttachment.updateMany({
            where: { financialRecordId: { in: frIds }, deletedAt: { not: null } },
            data: { deletedAt: null, deletedBy: null, deletionReason: null },
          });
          restored.financialAttachments = atts.count;
        }
      }
    });

    await this.logRestore('APPLICANT', id, actorId, restored, reason).catch(() => {});
    return { success: true, entityType: 'APPLICANT', id, restored, skipped, warnings };
  }

  private async restoreEmployee(id: string, actorId: string, withRelated: boolean, reason?: string): Promise<RestoreResult> {
    const record = await this.legacyPrisma.employee.findUnique({ where: { id } }); // @tenant-reviewed: phase211-pilot-scope (ownership pre-checked)
    if (!record) throw new NotFoundException(`Employee ${id} not found`);
    if (!record.deletedAt) throw new ConflictException('Employee is not deleted');

    const emailConflict = await this.legacyPrisma.employee.findFirst({ // @tenant-reviewed: phase211-pilot-scope (ownership pre-checked)
      where: { email: record.email, deletedAt: null, id: { not: id } },
    });
    if (emailConflict) {
      throw new ConflictException(`Cannot restore: email ${record.email} is already in use by another employee`);
    }

    const restored: Record<string, number> = { employee: 0 };
    const skipped: Record<string, string> = {};
    const warnings: string[] = [];

    await this.legacyPrisma.$transaction(async tx => { // @tenant-reviewed: phase211-pilot-scope (ownership pre-checked)
      await tx.employee.update({ where: { id }, data: { deletedAt: null, deletedBy: null, deletionReason: null } });
      restored.employee = 1;

      if (withRelated) {
        const docs = await tx.document.updateMany({
          where: { entityId: id, entityType: 'EMPLOYEE', deletedAt: { not: null } },
          data: { deletedAt: null, deletedBy: null, deletionReason: null },
        });
        restored.documents = docs.count;

        const frs = await tx.financialRecord.updateMany({
          where: { entityId: id, entityType: 'EMPLOYEE', deletedAt: { not: null } },
          data: { deletedAt: null, deletedBy: null, deletionReason: null },
        });
        restored.financialRecords = frs.count;
      }

      warnings.push('WorkPermit and EmployeeWorkflowStage records use cascade-delete and cannot be restored independently.');
    });

    await this.logRestore('EMPLOYEE', id, actorId, restored, reason).catch(() => {});
    return { success: true, entityType: 'EMPLOYEE', id, restored, skipped, warnings };
  }

  private async restoreUser(id: string, actorId: string, reason?: string): Promise<RestoreResult> {
    const record = await this.legacyPrisma.user.findUnique({ where: { id } }); // @tenant-reviewed: phase211-pilot-scope (ownership pre-checked)
    if (!record) throw new NotFoundException(`User ${id} not found`);
    if (!record.deletedAt) throw new ConflictException('User is not deleted');

    const emailConflict = await this.legacyPrisma.user.findFirst({ // @tenant-reviewed: phase211-pilot-scope (ownership pre-checked)
      where: { email: record.email, deletedAt: null, id: { not: id } },
    });
    if (emailConflict) {
      throw new ConflictException(`Cannot restore: email ${record.email} is already in use by another user`);
    }

    // Check that the role still exists (not deleted)
    const role = await this.legacyPrisma.role.findUnique({ where: { id: record.roleId } }); // @tenant-reviewed: phase211-pilot-scope (ownership pre-checked)
    if (!role || role.deletedAt) {
      throw new ConflictException(`Cannot restore: user's role no longer exists. Assign a valid role first.`);
    }

    // Check that the agency still exists
    const agency = await this.legacyPrisma.agency.findUnique({ where: { id: record.agencyId } }); // @tenant-reviewed: phase211-pilot-scope (ownership pre-checked)
    if (!agency || agency.deletedAt) {
      throw new ConflictException(`Cannot restore: user's agency no longer exists. Reassign agency first.`);
    }

    await this.legacyPrisma.user.update({ where: { id }, data: { deletedAt: null, deletedBy: null, deletionReason: null } }); // @tenant-reviewed: phase211-pilot-scope (ownership pre-checked)
    await this.logRestore('USER', id, actorId, { user: 1 }, reason).catch(() => {});
    return { success: true, entityType: 'USER', id, restored: { user: 1 }, skipped: {}, warnings: [] };
  }

  private async restoreAgency(id: string, actorId: string, reason?: string): Promise<RestoreResult> {
    const record = await this.legacyPrisma.agency.findUnique({ where: { id } }); // @tenant-reviewed: phase211-pilot-scope (ownership pre-checked)
    if (!record) throw new NotFoundException(`Agency ${id} not found`);
    if (!record.deletedAt) throw new ConflictException('Agency is not deleted');

    await this.legacyPrisma.agency.update({ where: { id }, data: { deletedAt: null, deletedBy: null, deletionReason: null } }); // @tenant-reviewed: phase211-pilot-scope (ownership pre-checked)
    await this.logRestore('AGENCY', id, actorId, { agency: 1 }, reason).catch(() => {});
    return { success: true, entityType: 'AGENCY', id, restored: { agency: 1 }, skipped: {}, warnings: [] };
  }

  private async restoreDocument(id: string, actorId: string, reason?: string): Promise<RestoreResult> {
    const record = await this.legacyPrisma.document.findUnique({ where: { id } }); // @tenant-reviewed: phase211-pilot-scope (ownership pre-checked)
    if (!record) throw new NotFoundException(`Document ${id} not found`);
    if (!record.deletedAt) throw new ConflictException('Document is not deleted');

    // Verify the parent entity still exists
    const parentExists = await this.checkParentEntityExists(record.entityType as string, record.entityId);
    const warnings: string[] = [];
    if (!parentExists) {
      warnings.push(`Parent entity (${record.entityType} ${record.entityId}) is soft-deleted or no longer exists.`);
    }

    await this.legacyPrisma.document.update({ where: { id }, data: { deletedAt: null, deletedBy: null, deletionReason: null } }); // @tenant-reviewed: phase211-pilot-scope (ownership pre-checked)
    await this.logRestore('DOCUMENT', id, actorId, { document: 1 }, reason).catch(() => {});
    return { success: true, entityType: 'DOCUMENT', id, restored: { document: 1 }, skipped: {}, warnings };
  }

  private async restoreDocumentType(id: string, actorId: string, reason?: string): Promise<RestoreResult> {
    const record = await this.legacyPrisma.documentType.findUnique({ where: { id } }); // @tenant-reviewed: phase211-pilot-scope (ownership pre-checked)
    if (!record) throw new NotFoundException(`DocumentType ${id} not found`);
    if (!record.deletedAt) throw new ConflictException('DocumentType is not deleted');

    // Check name uniqueness
    const nameConflict = await this.legacyPrisma.documentType.findFirst({ // @tenant-reviewed: phase211-pilot-scope (ownership pre-checked)
      where: { name: record.name, deletedAt: null, id: { not: id } },
    });
    if (nameConflict) {
      throw new ConflictException(`Cannot restore: a document type named "${record.name}" already exists`);
    }

    await this.legacyPrisma.documentType.update({ where: { id }, data: { deletedAt: null, deletedBy: null, deletionReason: null } }); // @tenant-reviewed: phase211-pilot-scope (ownership pre-checked)
    await this.logRestore('DOCUMENT_TYPE', id, actorId, { documentType: 1 }, reason).catch(() => {});
    return { success: true, entityType: 'DOCUMENT_TYPE', id, restored: { documentType: 1 }, skipped: {}, warnings: [] };
  }

  private async restoreJobAd(id: string, actorId: string, reason?: string): Promise<RestoreResult> {
    const record = await this.legacyPrisma.jobAd.findUnique({ where: { id } }); // @tenant-reviewed: phase211-pilot-scope (ownership pre-checked)
    if (!record) throw new NotFoundException(`JobAd ${id} not found`);
    if (!record.deletedAt) throw new ConflictException('JobAd is not deleted');

    // Check slug uniqueness
    const slugConflict = await this.legacyPrisma.jobAd.findFirst({ // @tenant-reviewed: phase211-pilot-scope (ownership pre-checked)
      where: { slug: record.slug, deletedAt: null, id: { not: id } },
    });
    const warnings: string[] = [];
    if (slugConflict) {
      warnings.push(`Slug "${record.slug}" is already taken. The job ad will be restored but may need slug update.`);
    }

    await this.legacyPrisma.jobAd.update({ // @tenant-reviewed: phase211-pilot-scope (ownership pre-checked)
      where: { id },
      data: { deletedAt: null, deletedBy: null, deletionReason: null, status: 'DRAFT' },
    });
    await this.logRestore('JOB_AD', id, actorId, { jobAd: 1 }, reason).catch(() => {});
    return { success: true, entityType: 'JOB_AD', id, restored: { jobAd: 1 }, skipped: {}, warnings };
  }

  private async restoreJobType(id: string, actorId: string, reason?: string): Promise<RestoreResult> {
    const record = await (this.legacyPrisma as any).jobType.findUnique({ where: { id } });
    if (!record) throw new NotFoundException(`JobType ${id} not found`);
    if (!record.deletedAt) throw new ConflictException('JobType is not deleted');

    // JobType.name is @unique so a conflict with a live row is a hard fail.
    const nameConflict = await this.legacyPrisma.jobType.findFirst({
      where: { name: record.name, deletedAt: null, id: { not: id } },
    });
    if (nameConflict) {
      throw new ConflictException(`Cannot restore: a job type named "${record.name}" already exists`);
    }

    await this.legacyPrisma.jobType.update({
      where: { id },
      data: { deletedAt: null, deletedBy: null, deletionReason: null },
    });
    await this.logRestore('JOB_TYPE', id, actorId, { jobType: 1 }, reason).catch(() => {});
    return { success: true, entityType: 'JOB_TYPE', id, restored: { jobType: 1 }, skipped: {}, warnings: [] };
  }

  private async restoreFinancialRecord(id: string, actorId: string, withRelated: boolean, reason?: string): Promise<RestoreResult> {
    const record = await this.legacyPrisma.financialRecord.findUnique({ where: { id } }); // @tenant-reviewed: phase211-pilot-scope (ownership pre-checked)
    if (!record) throw new NotFoundException(`FinancialRecord ${id} not found`);
    if (!record.deletedAt) throw new ConflictException('FinancialRecord is not deleted');

    const restored: Record<string, number> = {};

    await this.legacyPrisma.$transaction(async tx => { // @tenant-reviewed: phase211-pilot-scope (ownership pre-checked)
      await tx.financialRecord.update({ where: { id }, data: { deletedAt: null, deletedBy: null, deletionReason: null } });
      restored.financialRecord = 1;

      if (withRelated) {
        const atts = await tx.financialRecordAttachment.updateMany({
          where: { financialRecordId: id, deletedAt: { not: null } },
          data: { deletedAt: null, deletedBy: null, deletionReason: null },
        });
        restored.attachments = atts.count;
      }
    });

    await this.logRestore('FINANCIAL_RECORD', id, actorId, restored, reason).catch(() => {});
    return { success: true, entityType: 'FINANCIAL_RECORD', id, restored, skipped: {}, warnings: [] };
  }

  private async restoreRole(id: string, actorId: string, reason?: string): Promise<RestoreResult> {
    const record = await this.legacyPrisma.role.findUnique({ where: { id } }); // @tenant-reviewed: phase211-pilot-scope (ownership pre-checked)
    if (!record) throw new NotFoundException(`Role ${id} not found`);
    if (!record.deletedAt) throw new ConflictException('Role is not deleted');

    const nameConflict = await this.legacyPrisma.role.findFirst({ // @tenant-reviewed: phase211-pilot-scope (ownership pre-checked)
      where: { name: record.name, deletedAt: null, id: { not: id } },
    });
    if (nameConflict) {
      throw new ConflictException(`Cannot restore: a role named "${record.name}" already exists`);
    }

    await this.legacyPrisma.role.update({ where: { id }, data: { deletedAt: null, deletedBy: null, deletionReason: null } }); // @tenant-reviewed: phase211-pilot-scope (ownership pre-checked)
    await this.logRestore('ROLE', id, actorId, { role: 1 }, reason).catch(() => {});
    return { success: true, entityType: 'ROLE', id, restored: { role: 1 }, skipped: {}, warnings: [] };
  }

  private async restoreReport(id: string, actorId: string, reason?: string): Promise<RestoreResult> {
    const record = await this.legacyPrisma.report.findUnique({ where: { id } }); // @tenant-reviewed: phase211-pilot-scope (ownership pre-checked)
    if (!record) throw new NotFoundException(`Report ${id} not found`);
    if (!record.deletedAt) throw new ConflictException('Report is not deleted');

    const nameConflict = await this.legacyPrisma.report.findFirst({ // @tenant-reviewed: phase211-pilot-scope (ownership pre-checked)
      where: { name: record.name, deletedAt: null, id: { not: id } },
    });
    const warnings: string[] = [];
    if (nameConflict) {
      warnings.push(`Report name "${record.name}" is already in use. Rename after restoring.`);
    }

    await this.legacyPrisma.report.update({ where: { id }, data: { deletedAt: null, deletedBy: null, deletionReason: null } }); // @tenant-reviewed: phase211-pilot-scope (ownership pre-checked)
    await this.logRestore('REPORT', id, actorId, { report: 1 }, reason).catch(() => {});
    return { success: true, entityType: 'REPORT', id, restored: { report: 1 }, skipped: {}, warnings };
  }

  private async restoreVehicle(id: string, actorId: string, withRelated: boolean, reason?: string): Promise<RestoreResult> {
    const record = await this.legacyPrisma.vehicle.findUnique({ where: { id } }); // @tenant-reviewed: phase211-pilot-scope (ownership pre-checked)
    if (!record) throw new NotFoundException(`Vehicle ${id} not found`);
    if (!record.deletedAt) throw new ConflictException('Vehicle is not deleted');

    const restored: Record<string, number> = {};
    await this.legacyPrisma.vehicle.update({ where: { id }, data: { deletedAt: null, deletedBy: null } }); // @tenant-reviewed: phase211-pilot-scope (ownership pre-checked)
    restored.vehicle = 1;

    if (withRelated) {
      const docs = await (this.prisma as any).vehicleDocument.updateMany({
        where: { vehicleId: id, deletedAt: { not: null } },
        data: { deletedAt: null, deletedBy: null },
      });
      const maint = await (this.prisma as any).maintenanceRecord.updateMany({
        where: { vehicleId: id, deletedAt: { not: null } },
        data: { deletedAt: null, deletedBy: null },
      });
      restored.vehicleDocuments = docs.count;
      restored.maintenanceRecords = maint.count;
    }

    await this.logRestore('VEHICLE', id, actorId, restored, reason).catch(() => {});
    return { success: true, entityType: 'VEHICLE', id, restored, skipped: {}, warnings: [] };
  }

  private async restoreVehicleDocument(id: string, actorId: string, reason?: string): Promise<RestoreResult> {
    const record = await (this.prisma as any).vehicleDocument.findUnique({ where: { id } });
    if (!record) throw new NotFoundException(`Vehicle document ${id} not found`);
    if (!record.deletedAt) throw new ConflictException('Vehicle document is not deleted');

    await (this.prisma as any).vehicleDocument.update({ where: { id }, data: { deletedAt: null, deletedBy: null } });
    await this.logRestore('VEHICLE_DOCUMENT', id, actorId, { vehicleDocument: 1 }, reason).catch(() => {});
    return { success: true, entityType: 'VEHICLE_DOCUMENT', id, restored: { vehicleDocument: 1 }, skipped: {}, warnings: [] };
  }

  private async restoreMaintenanceRecord(id: string, actorId: string, reason?: string): Promise<RestoreResult> {
    const record = await (this.prisma as any).maintenanceRecord.findUnique({ where: { id } });
    if (!record) throw new NotFoundException(`Maintenance record ${id} not found`);
    if (!record.deletedAt) throw new ConflictException('Maintenance record is not deleted');

    await (this.prisma as any).maintenanceRecord.update({ where: { id }, data: { deletedAt: null, deletedBy: null } });
    await this.logRestore('MAINTENANCE_RECORD', id, actorId, { maintenanceRecord: 1 }, reason).catch(() => {});
    return { success: true, entityType: 'MAINTENANCE_RECORD', id, restored: { maintenanceRecord: 1 }, skipped: {}, warnings: [] };
  }

  private async restoreMaintenanceType(id: string, actorId: string, reason?: string): Promise<RestoreResult> {
    const record = await (this.prisma as any).maintenanceType.findUnique({ where: { id } });
    if (!record) throw new NotFoundException(`Maintenance type ${id} not found`);
    if (!record.deletedAt) throw new ConflictException('Maintenance type is not deleted');

    await (this.prisma as any).maintenanceType.update({ where: { id }, data: { deletedAt: null, deletedBy: null } });
    await this.logRestore('MAINTENANCE_TYPE', id, actorId, { maintenanceType: 1 }, reason).catch(() => {});
    return { success: true, entityType: 'MAINTENANCE_TYPE', id, restored: { maintenanceType: 1 }, skipped: {}, warnings: [] };
  }

  private async restoreWorkshop(id: string, actorId: string, reason?: string): Promise<RestoreResult> {
    const record = await (this.prisma as any).workshop.findUnique({ where: { id } });
    if (!record) throw new NotFoundException(`Workshop ${id} not found`);
    if (!record.deletedAt) throw new ConflictException('Workshop is not deleted');

    await (this.prisma as any).workshop.update({ where: { id }, data: { deletedAt: null, deletedBy: null } });
    await this.logRestore('WORKSHOP', id, actorId, { workshop: 1 }, reason).catch(() => {});
    return { success: true, entityType: 'WORKSHOP', id, restored: { workshop: 1 }, skipped: {}, warnings: [] };
  }

  private async restoreNotification(id: string, actorId: string, reason?: string): Promise<RestoreResult> {
    const record = await this.legacyPrisma.notification.findUnique({ where: { id } }); // @tenant-reviewed: phase211-pilot-scope (ownership pre-checked)
    if (!record) throw new NotFoundException(`Notification ${id} not found`);
    if (!record.deletedAt) throw new ConflictException('Notification is not deleted');

    await this.legacyPrisma.notification.update({ where: { id }, data: { deletedAt: null, deletedBy: null, deletionReason: null } }); // @tenant-reviewed: phase211-pilot-scope (ownership pre-checked)
    await this.logRestore('NOTIFICATION', id, actorId, { notification: 1 }, reason).catch(() => {});
    return { success: true, entityType: 'NOTIFICATION', id, restored: { notification: 1 }, skipped: {}, warnings: [] };
  }

  // ── Helpers ─────────────────────────────────────────────────────────────────

  private async checkParentEntityExists(entityType: string, entityId: string): Promise<boolean> {
    if (entityType === 'APPLICANT') {
      const a = await this.legacyPrisma.applicant.findUnique({ where: { id: entityId }, select: { deletedAt: true } }); // @tenant-reviewed: phase211-pilot-scope (ownership pre-checked)
      return !!a && !a.deletedAt;
    }
    if (entityType === 'EMPLOYEE') {
      const e = await this.legacyPrisma.employee.findUnique({ where: { id: entityId }, select: { deletedAt: true } }); // @tenant-reviewed: phase211-pilot-scope (ownership pre-checked)
      return !!e && !e.deletedAt;
    }
    return true; // unknown type: allow
  }

  private async logRestore(entity: string, entityId: string, actorId: string, restored: Record<string, number>, reason?: string) {
    await this.auditLog.log({
      userId: actorId,
      action: 'RESTORE',
      entity,
      entityId,
      changes: { restored, reason: reason ?? null },
    });
  }
}
