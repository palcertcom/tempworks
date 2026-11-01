import {
  Injectable, NotFoundException, ForbiddenException, BadRequestException, ConflictException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AuditLogService } from '../logs/audit-log.service';
import { ENTITY_POLICIES } from './recycle-bin.service';
import { PilotPrismaAccessor } from '../saas/prisma/pilot-prisma.accessor';
import { getPilotScope } from '../saas/prisma/tenant-pilot-scope';
import { isTenantScopedEntity } from './tenant-scope-map';

export interface HardDeleteResult {
  success: boolean;
  entityType: string;
  id: string;
  deleted: Record<string, number>;
  warnings: string[];
}

@Injectable()
export class HardDeleteService {
  constructor(
    private legacyPrisma: PrismaService,
    private auditLog: AuditLogService,
    private pilot: PilotPrismaAccessor,
  ) {}

  /** Pilot-aware client used for the ownership pre-check only. */
  private get prisma(): PrismaService {
    return this.pilot.client();
  }

  /** Tenant-ownership pre-check. Same contract as RestoreService. */
  private async assertTenantOwnership(entityType: string, id: string): Promise<void> {
    const scope = getPilotScope(this.pilot, 'recycle-bin');
    if (!scope.active || !isTenantScopedEntity(entityType)) return;
    const t = scope.tenantWhere();
    const map: Record<string, string> = {
      APPLICANT: 'applicant', EMPLOYEE: 'employee', AGENCY: 'agency',
      DOCUMENT: 'document', FINANCIAL_RECORD: 'financialRecord',
      JOB_AD: 'jobAd', NOTIFICATION: 'notification',
      VEHICLE: 'vehicle', VEHICLE_DOCUMENT: 'vehicleDocument',
      MAINTENANCE_RECORD: 'maintenanceRecord',
    };
    const model = map[entityType] ?? entityType.toLowerCase();
    const probe = await (this.prisma as any)[model].findFirst({
      where: { id, ...t },
      select: { id: true },
    });
    if (!probe) throw new NotFoundException(`Record not found in current tenant`);
  }

  async execute(entityType: string, id: string, actorId: string, reason?: string): Promise<HardDeleteResult> {
    const policy = ENTITY_POLICIES[entityType];
    if (!policy?.canHardDelete) {
      throw new ForbiddenException(`Hard delete is not permitted for entity type: ${entityType}`);
    }

    // Phase 2.11 — refuse hard-delete on a foreign-tenant record.
    await this.assertTenantOwnership(entityType, id);

    switch (entityType) {
      case 'APPLICANT':   return this.hardDeleteApplicant(id, actorId, reason);
      case 'EMPLOYEE':    return this.hardDeleteEmployee(id, actorId, reason);
      case 'USER':        return this.hardDeleteUser(id, actorId, reason);
      case 'AGENCY':      return this.hardDeleteAgency(id, actorId, reason);
      case 'DOCUMENT':    return this.hardDeleteDocument(id, actorId, reason);
      case 'DOCUMENT_TYPE': return this.hardDeleteDocumentType(id, actorId, reason);
      case 'JOB_AD':      return this.hardDeleteJobAd(id, actorId, reason);
      case 'JOB_TYPE':    return this.hardDeleteJobType(id, actorId, reason);
      case 'FINANCIAL_RECORD': return this.hardDeleteFinancialRecord(id, actorId, reason);
      case 'ROLE':        return this.hardDeleteRole(id, actorId, reason);
      case 'NOTIFICATION': return this.hardDeleteNotification(id, actorId, reason);
      case 'REPORT':      return this.hardDeleteReport(id, actorId, reason);
      case 'VEHICLE':     return this.hardDeleteVehicle(id, actorId, reason);
      case 'VEHICLE_DOCUMENT': return this.hardDeleteVehicleDocument(id, actorId, reason);
      case 'MAINTENANCE_RECORD': return this.hardDeleteMaintenanceRecord(id, actorId, reason);
      case 'MAINTENANCE_TYPE':   return this.hardDeleteMaintenanceType(id, actorId, reason);
      case 'WORKSHOP':           return this.hardDeleteWorkshop(id, actorId, reason);
      default:
        throw new BadRequestException(`No hard-delete handler for entity type: ${entityType}`);
    }
  }

  // ── Handlers ────────────────────────────────────────────────────────────────

  private async hardDeleteApplicant(id: string, actorId: string, reason?: string): Promise<HardDeleteResult> {
    const record = await this.legacyPrisma.applicant.findUnique({ where: { id } }); // @tenant-reviewed: phase211-pilot-scope (ownership pre-checked)
    if (!record) throw new NotFoundException(`Applicant ${id} not found`);

    const deleted: Record<string, number> = {};
    const warnings: string[] = [];

    await this.legacyPrisma.$transaction(async tx => { // @tenant-reviewed: phase211-pilot-scope (ownership pre-checked)
      // Delete compliance alerts first (FK to documents)
      deleted.complianceAlerts = (await tx.complianceAlert.deleteMany({ where: { entityId: id } })).count;

      // Delete documents and their alerts
      const docs = await tx.document.findMany({ where: { entityId: id, entityType: 'APPLICANT' }, select: { id: true } });
      if (docs.length) {
        await tx.complianceAlert.deleteMany({ where: { documentId: { in: docs.map(d => d.id) } } });
        deleted.documents = (await tx.document.deleteMany({ where: { entityId: id, entityType: 'APPLICANT' } })).count;
      }

      // Delete financial attachments then records
      const frs = await tx.financialRecord.findMany({ where: { entityId: id, entityType: 'APPLICANT' }, select: { id: true } });
      if (frs.length) {
        deleted.financialAttachments = (await tx.financialRecordAttachment.deleteMany({
          where: { financialRecordId: { in: frs.map(r => r.id) } },
        })).count;
        deleted.financialRecords = (await tx.financialRecord.deleteMany({ where: { entityId: id, entityType: 'APPLICANT' } })).count;
      }

      // Delete visas
      deleted.visas = (await tx.visa.deleteMany({ where: { entityId: id } })).count;

      // applicant_financial_profiles and applicant_agency_history cascade from applicant
      deleted.applicant = (await tx.applicant.delete({ where: { id } })).id ? 1 : 0;
    });

    await this.logHardDelete('APPLICANT', id, actorId, deleted, reason).catch(() => {});
    warnings.push('Audit logs referencing this applicant are preserved as compliance records.');
    return { success: true, entityType: 'APPLICANT', id, deleted, warnings };
  }

  private async hardDeleteEmployee(id: string, actorId: string, reason?: string): Promise<HardDeleteResult> {
    const record = await this.legacyPrisma.employee.findUnique({ where: { id } }); // @tenant-reviewed: phase211-pilot-scope (ownership pre-checked)
    if (!record) throw new NotFoundException(`Employee ${id} not found`);

    const deleted: Record<string, number> = {};
    const warnings: string[] = [];

    await this.legacyPrisma.$transaction(async tx => { // @tenant-reviewed: phase211-pilot-scope (ownership pre-checked)
      // Compliance alerts for this entity
      deleted.complianceAlerts = (await tx.complianceAlert.deleteMany({ where: { entityId: id } })).count;

      // Documents and their alerts
      const docs = await tx.document.findMany({ where: { entityId: id, entityType: 'EMPLOYEE' }, select: { id: true } });
      if (docs.length) {
        await tx.complianceAlert.deleteMany({ where: { documentId: { in: docs.map(d => d.id) } } });
        deleted.documents = (await tx.document.deleteMany({ where: { entityId: id, entityType: 'EMPLOYEE' } })).count;
      }

      // Financial records and attachments
      const frs = await tx.financialRecord.findMany({ where: { entityId: id, entityType: 'EMPLOYEE' }, select: { id: true } });
      if (frs.length) {
        deleted.financialAttachments = (await tx.financialRecordAttachment.deleteMany({
          where: { financialRecordId: { in: frs.map(r => r.id) } },
        })).count;
        deleted.financialRecords = (await tx.financialRecord.deleteMany({ where: { entityId: id, entityType: 'EMPLOYEE' } })).count;
      }

      // Visas
      deleted.visas = (await tx.visa.deleteMany({ where: { entityId: id } })).count;

      // EmployeeWorkflowStages and WorkPermits cascade from Employee (onDelete: Cascade)
      // but Prisma deleteMany doesn't trigger cascades — we delete them explicitly
      deleted.workflowStages = (await tx.employeeStage.deleteMany({ where: { employeeId: id } })).count;
      deleted.workPermits = (await tx.workPermit.deleteMany({ where: { employeeId: id } })).count;

      deleted.employee = (await tx.employee.delete({ where: { id } })).id ? 1 : 0;
    });

    await this.logHardDelete('EMPLOYEE', id, actorId, deleted, reason).catch(() => {});
    warnings.push('Audit logs referencing this employee are preserved as compliance records.');
    return { success: true, entityType: 'EMPLOYEE', id, deleted, warnings };
  }

  private async hardDeleteUser(id: string, actorId: string, reason?: string): Promise<HardDeleteResult> {
    const record = await this.legacyPrisma.user.findUnique({ where: { id }, include: { role: { select: { name: true } } } }); // @tenant-reviewed: phase211-pilot-scope (ownership pre-checked)
    if (!record) throw new NotFoundException(`User ${id} not found`);

    // Cannot delete self
    if (id === actorId) {
      throw new ForbiddenException('You cannot hard-delete your own account');
    }

    // Cannot delete last System Admin
    if (record.role?.name === 'System Admin') {
      const adminCount = await this.legacyPrisma.user.count({ // @tenant-reviewed: phase211-pilot-scope (ownership pre-checked)
        where: { role: { name: 'System Admin' }, deletedAt: null },
      });
      if (adminCount <= 1) {
        throw new ForbiddenException('Cannot delete the last System Admin user');
      }
    }

    const deleted: Record<string, number> = {};
    await this.legacyPrisma.$transaction(async tx => { // @tenant-reviewed: phase211-pilot-scope (ownership pre-checked)
      // Notifications cascade from user but we delete explicitly for count
      deleted.notifications = (await tx.notification.deleteMany({ where: { userId: id } })).count;
      // Null out audit log user references (preserve audit history, just orphan the FK)
      await tx.auditLog.updateMany({ where: { userId: id }, data: { userId: null } });
      deleted.user = (await tx.user.delete({ where: { id } })).id ? 1 : 0;
    });

    await this.logHardDelete('USER', id, actorId, deleted, reason).catch(() => {});
    return {
      success: true, entityType: 'USER', id, deleted,
      warnings: ['Audit logs are preserved with user reference nulled out.'],
    };
  }

  private async hardDeleteAgency(id: string, actorId: string, reason?: string): Promise<HardDeleteResult> {
    const record = await this.legacyPrisma.agency.findUnique({ where: { id } }); // @tenant-reviewed: phase211-pilot-scope (ownership pre-checked)
    if (!record) throw new NotFoundException(`Agency ${id} not found`);

    const activeEmployees = await this.legacyPrisma.employee.count({ where: { agencyId: id, deletedAt: null } }); // @tenant-reviewed: phase211-pilot-scope (ownership pre-checked)
    const activeUsers = await this.legacyPrisma.user.count({ where: { agencyId: id, deletedAt: null } }); // @tenant-reviewed: phase211-pilot-scope (ownership pre-checked)
    if (activeEmployees > 0 || activeUsers > 0) {
      throw new BadRequestException(
        `Cannot hard-delete agency: ${activeEmployees} active employee(s) and ${activeUsers} active user(s) still reference it. Reassign or delete them first.`,
      );
    }

    await this.legacyPrisma.$transaction(async tx => { // @tenant-reviewed: phase211-pilot-scope (ownership pre-checked)
      // Null out soft-deleted employee agency references
      await tx.employee.updateMany({ where: { agencyId: id }, data: { agencyId: null } });
      // Null out applicant agency references
      await tx.applicant.updateMany({ where: { agencyId: id }, data: { agencyId: null } });
      await tx.agency.delete({ where: { id } });
    });

    await this.logHardDelete('AGENCY', id, actorId, { agency: 1 }, reason).catch(() => {});
    return { success: true, entityType: 'AGENCY', id, deleted: { agency: 1 }, warnings: [] };
  }

  private async hardDeleteDocument(id: string, actorId: string, reason?: string): Promise<HardDeleteResult> {
    const record = await this.legacyPrisma.document.findUnique({ where: { id } }); // @tenant-reviewed: phase211-pilot-scope (ownership pre-checked)
    if (!record) throw new NotFoundException(`Document ${id} not found`);

    const deleted: Record<string, number> = {};
    await this.legacyPrisma.$transaction(async tx => { // @tenant-reviewed: phase211-pilot-scope (ownership pre-checked)
      // Null out renewedFromId references on other documents
      await tx.document.updateMany({ where: { renewedFromId: id }, data: { renewedFromId: null } });
      deleted.complianceAlerts = (await tx.complianceAlert.deleteMany({ where: { documentId: id } })).count;
      deleted.document = (await tx.document.delete({ where: { id } })).id ? 1 : 0;
    });

    await this.logHardDelete('DOCUMENT', id, actorId, deleted, reason).catch(() => {});
    return { success: true, entityType: 'DOCUMENT', id, deleted, warnings: [] };
  }

  private async hardDeleteDocumentType(id: string, actorId: string, reason?: string): Promise<HardDeleteResult> {
    const record = await this.legacyPrisma.documentType.findUnique({ where: { id } }); // @tenant-reviewed: phase211-pilot-scope (ownership pre-checked)
    if (!record) throw new NotFoundException(`DocumentType ${id} not found`);

    const activeDocs = await this.legacyPrisma.document.count({ where: { documentTypeId: id, deletedAt: null } }); // @tenant-reviewed: phase211-pilot-scope (ownership pre-checked)
    if (activeDocs > 0) {
      throw new BadRequestException(
        `Cannot hard-delete document type: ${activeDocs} active document(s) reference it. Soft-delete or reassign them first.`,
      );
    }

    const deleted: Record<string, number> = {};
    await this.legacyPrisma.$transaction(async tx => { // @tenant-reviewed: phase211-pilot-scope (ownership pre-checked)
      // Delete soft-deleted documents of this type
      const docs = await tx.document.findMany({ where: { documentTypeId: id }, select: { id: true } });
      if (docs.length) {
        await tx.complianceAlert.deleteMany({ where: { documentId: { in: docs.map(d => d.id) } } });
        deleted.documents = (await tx.document.deleteMany({ where: { documentTypeId: id } })).count;
      }
      deleted.typePermissions = (await tx.documentTypePermission.deleteMany({ where: { documentTypeId: id } })).count;
      deleted.documentType = (await tx.documentType.delete({ where: { id } })).id ? 1 : 0;
    });

    await this.logHardDelete('DOCUMENT_TYPE', id, actorId, deleted, reason).catch(() => {});
    return { success: true, entityType: 'DOCUMENT_TYPE', id, deleted, warnings: [] };
  }

  private async hardDeleteJobAd(id: string, actorId: string, reason?: string): Promise<HardDeleteResult> {
    const record = await this.legacyPrisma.jobAd.findUnique({ where: { id } }); // @tenant-reviewed: phase211-pilot-scope (ownership pre-checked)
    if (!record) throw new NotFoundException(`JobAd ${id} not found`);

    const deleted: Record<string, number> = {};
    await this.legacyPrisma.$transaction(async tx => { // @tenant-reviewed: phase211-pilot-scope (ownership pre-checked)
      // Unlink applicants (set jobAdId to null) — don't delete the applicants
      const unlinked = await tx.applicant.updateMany({ where: { jobAdId: id }, data: { jobAdId: null } });
      deleted.unlinkedApplicants = unlinked.count;
      deleted.jobAd = (await tx.jobAd.delete({ where: { id } })).id ? 1 : 0;
    });

    await this.logHardDelete('JOB_AD', id, actorId, deleted, reason).catch(() => {});
    return {
      success: true, entityType: 'JOB_AD', id, deleted,
      warnings: [`${deleted.unlinkedApplicants} applicant(s) were unlinked (not deleted).`],
    };
  }

  private async hardDeleteJobType(id: string, actorId: string, reason?: string): Promise<HardDeleteResult> {
    const record = await (this.legacyPrisma as any).jobType.findUnique({ where: { id } });
    if (!record) throw new NotFoundException(`JobType ${id} not found`);
    if (!record.deletedAt) {
      throw new ConflictException('JobType must be soft-deleted (moved to the recycle bin) before hard-deleting.');
    }

    // Unlink referencing applicants/employees (the FK is nullable) so
    // the row can be deleted without losing history. Anything left
    // referencing the type stays pointing to NULL.
    const deleted: Record<string, number> = {};
    await this.legacyPrisma.$transaction(async (tx) => {
      const unlinkedApplicants = await tx.applicant.updateMany({ where: { jobTypeId: id }, data: { jobTypeId: null } });
      const unlinkedEmployees = await tx.employee.updateMany({ where: { jobTypeId: id }, data: { jobTypeId: null } });
      deleted.unlinkedApplicants = unlinkedApplicants.count;
      deleted.unlinkedEmployees = unlinkedEmployees.count;
      await tx.jobType.delete({ where: { id } });
      deleted.jobType = 1;
    });

    await this.logHardDelete('JOB_TYPE', id, actorId, deleted, reason).catch(() => {});
    const warnings: string[] = [];
    if (deleted.unlinkedApplicants) warnings.push(`${deleted.unlinkedApplicants} applicant(s) were unlinked.`);
    if (deleted.unlinkedEmployees)  warnings.push(`${deleted.unlinkedEmployees} employee(s) were unlinked.`);
    return { success: true, entityType: 'JOB_TYPE', id, deleted, warnings };
  }

  private async hardDeleteFinancialRecord(id: string, actorId: string, reason?: string): Promise<HardDeleteResult> {
    const record = await this.legacyPrisma.financialRecord.findUnique({ where: { id } }); // @tenant-reviewed: phase211-pilot-scope (ownership pre-checked)
    if (!record) throw new NotFoundException(`FinancialRecord ${id} not found`);

    const deleted: Record<string, number> = {};
    await this.legacyPrisma.$transaction(async tx => { // @tenant-reviewed: phase211-pilot-scope (ownership pre-checked)
      deleted.attachments = (await tx.financialRecordAttachment.deleteMany({ where: { financialRecordId: id } })).count;
      deleted.financialRecord = (await tx.financialRecord.delete({ where: { id } })).id ? 1 : 0;
    });

    await this.logHardDelete('FINANCIAL_RECORD', id, actorId, deleted, reason).catch(() => {});
    return { success: true, entityType: 'FINANCIAL_RECORD', id, deleted, warnings: [] };
  }

  private async hardDeleteRole(id: string, actorId: string, reason?: string): Promise<HardDeleteResult> {
    const record = await this.legacyPrisma.role.findUnique({ where: { id } }); // @tenant-reviewed: phase211-pilot-scope (ownership pre-checked)
    if (!record) throw new NotFoundException(`Role ${id} not found`);

    if (record.isSystem) {
      throw new ForbiddenException('System roles cannot be hard-deleted');
    }

    const assignedUsers = await this.legacyPrisma.user.count({ where: { roleId: id, deletedAt: null } }); // @tenant-reviewed: phase211-pilot-scope (ownership pre-checked)
    if (assignedUsers > 0) {
      throw new BadRequestException(
        `Cannot hard-delete role: ${assignedUsers} active user(s) are assigned this role. Reassign them first.`,
      );
    }

    const deleted: Record<string, number> = {};
    await this.legacyPrisma.$transaction(async tx => { // @tenant-reviewed: phase211-pilot-scope (ownership pre-checked)
      deleted.rolePermissions = (await tx.rolePermission.deleteMany({ where: { roleId: id } })).count;
      deleted.docTypePermissions = (await tx.documentTypePermission.deleteMany({ where: { roleId: id } })).count;
      deleted.role = (await tx.role.delete({ where: { id } })).id ? 1 : 0;
    });

    await this.logHardDelete('ROLE', id, actorId, deleted, reason).catch(() => {});
    return { success: true, entityType: 'ROLE', id, deleted, warnings: [] };
  }

  private async hardDeleteNotification(id: string, actorId: string, reason?: string): Promise<HardDeleteResult> {
    const record = await this.legacyPrisma.notification.findUnique({ where: { id } }); // @tenant-reviewed: phase211-pilot-scope (ownership pre-checked)
    if (!record) throw new NotFoundException(`Notification ${id} not found`);

    await this.legacyPrisma.notification.delete({ where: { id } }); // @tenant-reviewed: phase211-pilot-scope (ownership pre-checked)
    await this.logHardDelete('NOTIFICATION', id, actorId, { notification: 1 }, reason).catch(() => {});
    return { success: true, entityType: 'NOTIFICATION', id, deleted: { notification: 1 }, warnings: [] };
  }

  private async hardDeleteReport(id: string, actorId: string, reason?: string): Promise<HardDeleteResult> {
    const record = await this.legacyPrisma.report.findUnique({ where: { id } }); // @tenant-reviewed: phase211-pilot-scope (ownership pre-checked)
    if (!record) throw new NotFoundException(`Report ${id} not found`);

    const deleted: Record<string, number> = {};
    await this.legacyPrisma.$transaction(async tx => { // @tenant-reviewed: phase211-pilot-scope (ownership pre-checked)
      deleted.filters = (await tx.reportFilter.deleteMany({ where: { reportId: id } })).count;
      deleted.columns = (await tx.reportColumn.deleteMany({ where: { reportId: id } })).count;
      deleted.sorting = (await tx.reportSorting.deleteMany({ where: { reportId: id } })).count;
      deleted.report = (await tx.report.delete({ where: { id } })).id ? 1 : 0;
    });

    await this.logHardDelete('REPORT', id, actorId, deleted, reason).catch(() => {});
    return { success: true, entityType: 'REPORT', id, deleted, warnings: [] };
  }

  private async hardDeleteVehicle(id: string, actorId: string, reason?: string): Promise<HardDeleteResult> {
    const record = await this.legacyPrisma.vehicle.findUnique({ where: { id } }); // @tenant-reviewed: phase211-pilot-scope (ownership pre-checked)
    if (!record) throw new NotFoundException(`Vehicle ${id} not found`);

    const deleted: Record<string, number> = {};
    await this.legacyPrisma.$transaction(async (tx: any) => { // @tenant-reviewed: phase211-pilot-scope (ownership pre-checked)
      deleted.spareParts = (await tx.maintenanceRecordSparePart.deleteMany({ where: { maintenanceRecord: { vehicleId: id } } })).count;
      deleted.maintenanceRecords = (await tx.maintenanceRecord.deleteMany({ where: { vehicleId: id } })).count;
      deleted.vehicleDocuments = (await tx.vehicleDocument.deleteMany({ where: { vehicleId: id } })).count;
      deleted.driverAssignments = (await tx.vehicleDriverAssignment.deleteMany({ where: { vehicleId: id } })).count;
      deleted.vehicle = (await tx.vehicle.delete({ where: { id } })).id ? 1 : 0;
    });

    await this.logHardDelete('VEHICLE', id, actorId, deleted, reason).catch(() => {});
    return { success: true, entityType: 'VEHICLE', id, deleted, warnings: [] };
  }

  private async hardDeleteVehicleDocument(id: string, actorId: string, reason?: string): Promise<HardDeleteResult> {
    const record = await (this.prisma as any).vehicleDocument.findUnique({ where: { id } });
    if (!record) throw new NotFoundException(`Vehicle document ${id} not found`);

    await (this.prisma as any).vehicleDocument.delete({ where: { id } });
    await this.logHardDelete('VEHICLE_DOCUMENT', id, actorId, { vehicleDocument: 1 }, reason).catch(() => {});
    return { success: true, entityType: 'VEHICLE_DOCUMENT', id, deleted: { vehicleDocument: 1 }, warnings: [] };
  }

  private async hardDeleteMaintenanceRecord(id: string, actorId: string, reason?: string): Promise<HardDeleteResult> {
    const record = await (this.prisma as any).maintenanceRecord.findUnique({ where: { id } });
    if (!record) throw new NotFoundException(`Maintenance record ${id} not found`);

    const deleted: Record<string, number> = {};
    await this.legacyPrisma.$transaction(async (tx: any) => { // @tenant-reviewed: phase211-pilot-scope (ownership pre-checked)
      deleted.spareParts = (await tx.maintenanceRecordSparePart.deleteMany({ where: { maintenanceRecordId: id } })).count;
      deleted.maintenanceRecord = (await tx.maintenanceRecord.delete({ where: { id } })).id ? 1 : 0;
    });

    await this.logHardDelete('MAINTENANCE_RECORD', id, actorId, deleted, reason).catch(() => {});
    return { success: true, entityType: 'MAINTENANCE_RECORD', id, deleted, warnings: [] };
  }

  private async hardDeleteMaintenanceType(id: string, actorId: string, reason?: string): Promise<HardDeleteResult> {
    const record = await (this.prisma as any).maintenanceType.findUnique({ where: { id } });
    if (!record) throw new NotFoundException(`Maintenance type ${id} not found`);

    await (this.prisma as any).maintenanceType.delete({ where: { id } });
    await this.logHardDelete('MAINTENANCE_TYPE', id, actorId, { maintenanceType: 1 }, reason).catch(() => {});
    return { success: true, entityType: 'MAINTENANCE_TYPE', id, deleted: { maintenanceType: 1 }, warnings: [] };
  }

  private async hardDeleteWorkshop(id: string, actorId: string, reason?: string): Promise<HardDeleteResult> {
    const record = await (this.prisma as any).workshop.findUnique({ where: { id } });
    if (!record) throw new NotFoundException(`Workshop ${id} not found`);

    await (this.prisma as any).workshop.delete({ where: { id } });
    await this.logHardDelete('WORKSHOP', id, actorId, { workshop: 1 }, reason).catch(() => {});
    return { success: true, entityType: 'WORKSHOP', id, deleted: { workshop: 1 }, warnings: [] };
  }

  // ── Helpers ─────────────────────────────────────────────────────────────────

  private async logHardDelete(entity: string, entityId: string, actorId: string, deleted: Record<string, number>, reason?: string) {
    await this.auditLog.log({
      userId: actorId,
      action: 'HARD_DELETE',
      entity,
      entityId,
      changes: { deleted, reason: reason ?? null },
    });
  }
}
