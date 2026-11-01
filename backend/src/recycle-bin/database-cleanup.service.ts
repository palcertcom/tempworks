import {
  Injectable, ForbiddenException, BadRequestException, Logger,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AuditLogService } from '../logs/audit-log.service';
import { ExecuteCleanupDto } from './dto/cleanup.dto';

const REQUIRED_CONFIRM_PHRASE = 'CLEAN DATABASE';

// Roles that survive the cleanup
const PRESERVED_ROLE_NAMES = ['System Admin', 'Super Admin'];

export interface CleanupPreview {
  willRemove: Record<string, number | string>;
  willPreserve: {
    users: number;
    roles: string[];
    agencies: number;
    systemSettings: number;
    workflowStages: number;
    jobTypes: number;
    documentTypes: number;
    permissions: number;
  };
  totalToRemove: number;
}

export interface CleanupResult {
  success: boolean;
  removed: Record<string, number>;
  preserved: Record<string, number>;
  warnings: string[];
  auditLogId?: string;
}

@Injectable()
export class DatabaseCleanupService {
  private readonly logger = new Logger(DatabaseCleanupService.name);

  constructor(
    private prisma: PrismaService,
    private auditLog: AuditLogService,
  ) {}

  // ── Preview ─────────────────────────────────────────────────────────────────

  async preview(): Promise<CleanupPreview> {
    const { preservedUserIds, preservedAgencyIds, preservedRoleIds } = await this.resolvePreservedEntities();

    const [
      applicants, employees, documents, financialRecords, financialAttachments,
      jobAds, agencies, users, roles, notifications, notificationRules,
      complianceAlerts, workPermits, visas, reports, workflowStages,
      employeeWorkflowStages, identifierSequences, auditLogs,
    ] = await Promise.all([
      this.prisma.applicant.count(), // @tenant-reviewed: phase211-excluded-platform (System Admin global cleanup)
      this.prisma.employee.count(), // @tenant-reviewed: phase211-excluded-platform (System Admin global cleanup)
      this.prisma.document.count(), // @tenant-reviewed: phase211-excluded-platform (System Admin global cleanup)
      this.prisma.financialRecord.count(), // @tenant-reviewed: phase211-excluded-platform (System Admin global cleanup)
      this.prisma.financialRecordAttachment.count(), // @tenant-reviewed: phase211-excluded-platform (System Admin global cleanup)
      this.prisma.jobAd.count(), // @tenant-reviewed: phase211-excluded-platform (System Admin global cleanup)
      this.prisma.agency.count({ where: { id: { notIn: preservedAgencyIds } } }), // @tenant-reviewed: phase211-excluded-platform (System Admin global cleanup)
      this.prisma.user.count({ where: { id: { notIn: preservedUserIds } } }), // @tenant-reviewed: phase211-excluded-platform (System Admin global cleanup)
      this.prisma.role.count({ where: { id: { notIn: preservedRoleIds } } }), // @tenant-reviewed: phase211-excluded-platform (System Admin global cleanup)
      this.prisma.notification.count(), // @tenant-reviewed: phase211-excluded-platform (System Admin global cleanup)
      this.prisma.notificationRule.count(), // @tenant-reviewed: phase211-excluded-platform (System Admin global cleanup)
      this.prisma.complianceAlert.count(), // @tenant-reviewed: phase211-excluded-platform (System Admin global cleanup)
      this.prisma.workPermit.count(), // @tenant-reviewed: phase211-excluded-platform (System Admin global cleanup)
      this.prisma.visa.count(), // @tenant-reviewed: phase211-excluded-platform (System Admin global cleanup)
      this.prisma.report.count(), // @tenant-reviewed: phase211-excluded-platform (System Admin global cleanup)
      this.prisma.employeeStage.count(), // @tenant-reviewed: phase211-excluded-platform (System Admin global cleanup)
      this.prisma.employeeStage.count(), // @tenant-reviewed: phase211-excluded-platform (System Admin global cleanup)
      this.prisma.identifierSequence.count(), // @tenant-reviewed: phase211-excluded-platform (System Admin global cleanup)
      this.prisma.auditLog.count(), // @tenant-reviewed: phase211-excluded-platform (System Admin global cleanup)
    ]);

    const preservedRoles = await this.prisma.role.findMany({ // @tenant-reviewed: phase211-excluded-platform (System Admin global cleanup)
      where: { id: { in: preservedRoleIds } },
      select: { name: true },
    });

    const willRemove: Record<string, number | string> = {
      applicants, employees, documents, financialRecords, financialAttachments,
      jobAds, agencies, users, roles, notifications, notificationRules,
      complianceAlerts, workPermits, visas, reports, employeeWorkflowStages,
      identifierSequences, auditLogs: `${auditLogs} (optional — preserved by default)`,
    };

    const totalToRemove = applicants + employees + documents + financialRecords + financialAttachments
      + jobAds + agencies + users + roles + notifications + notificationRules
      + complianceAlerts + workPermits + visas + reports + employeeWorkflowStages + identifierSequences;

    return {
      willRemove,
      willPreserve: {
        users: preservedUserIds.length,
        roles: preservedRoles.map(r => r.name),
        agencies: preservedAgencyIds.length,
        systemSettings: await this.prisma.systemSetting.count(), // @tenant-reviewed: phase211-excluded-platform (System Admin global cleanup)
        workflowStages: await this.prisma.stageTemplate.count(), // @tenant-reviewed: phase211-excluded-platform (System Admin global cleanup)
        jobTypes: await this.prisma.jobType.count(), // @tenant-reviewed: phase211-excluded-platform (System Admin global cleanup)
        documentTypes: await this.prisma.documentType.count(), // @tenant-reviewed: phase211-excluded-platform (System Admin global cleanup)
        permissions: await this.prisma.permission.count(), // @tenant-reviewed: phase211-excluded-platform (System Admin global cleanup)
      },
      totalToRemove,
    };
  }

  // ── Execute ─────────────────────────────────────────────────────────────────

  async execute(actorId: string, dto: ExecuteCleanupDto): Promise<CleanupResult> {
    if (dto.confirmPhrase !== REQUIRED_CONFIRM_PHRASE) {
      throw new BadRequestException(`Invalid confirmation phrase. You must type exactly: "${REQUIRED_CONFIRM_PHRASE}"`);
    }

    this.logger.warn(`⚠️  DATABASE CLEANUP initiated by user ${actorId}`);

    const { preservedUserIds, preservedAgencyIds, preservedRoleIds } = await this.resolvePreservedEntities();
    const removed: Record<string, number> = {};
    const warnings: string[] = [];

    try {
      // ── Step 1: Delete in dependency order (children before parents) ───────

      // 1. Compliance alerts (FK to documents — must go before documents)
      removed.complianceAlerts = (await this.prisma.complianceAlert.deleteMany({})).count; // @tenant-reviewed: phase211-excluded-platform (System Admin global cleanup)

      // 2. Notifications (cascade from users, but delete explicitly)
      removed.notifications = (await this.prisma.notification.deleteMany({})).count; // @tenant-reviewed: phase211-excluded-platform (System Admin global cleanup)

      // 3. Notification rules (standalone)
      removed.notificationRules = (await this.prisma.notificationRule.deleteMany({})).count; // @tenant-reviewed: phase211-excluded-platform (System Admin global cleanup)

      // 4. Financial attachments (FK to financialRecords)
      removed.financialAttachments = (await this.prisma.financialRecordAttachment.deleteMany({})).count; // @tenant-reviewed: phase211-excluded-platform (System Admin global cleanup)

      // 5. Financial records
      removed.financialRecords = (await this.prisma.financialRecord.deleteMany({})).count; // @tenant-reviewed: phase211-excluded-platform (System Admin global cleanup)

      // 6. Document type permissions for non-preserved roles
      removed.documentTypePermissions = (await this.prisma.documentTypePermission.deleteMany({ // @tenant-reviewed: phase211-excluded-platform (System Admin global cleanup)
        where: { roleId: { notIn: preservedRoleIds } },
      })).count;

      // 7. Documents
      removed.documents = (await this.prisma.document.deleteMany({})).count; // @tenant-reviewed: phase211-excluded-platform (System Admin global cleanup)

      // 8. Work permits (FK to employees)
      removed.workPermits = (await this.prisma.workPermit.deleteMany({})).count; // @tenant-reviewed: phase211-excluded-platform (System Admin global cleanup)

      // 9. Visas
      removed.visas = (await this.prisma.visa.deleteMany({})).count; // @tenant-reviewed: phase211-excluded-platform (System Admin global cleanup)

      // 10. Employee workflow stages (FK to employees)
      removed.employeeWorkflowStages = (await this.prisma.employeeStage.deleteMany({})).count; // @tenant-reviewed: phase211-excluded-platform (System Admin global cleanup)

      // 11. Employees
      removed.employees = (await this.prisma.employee.deleteMany({})).count; // @tenant-reviewed: phase211-excluded-platform (System Admin global cleanup)

      // 12. Applicant agency history (cascade from applicants, explicit for count)
      removed.applicantAgencyHistory = (await this.prisma.applicantAgencyHistory.deleteMany({})).count; // @tenant-reviewed: phase211-excluded-platform (System Admin global cleanup)

      // 13. Applicant financial profiles (cascade from applicants)
      removed.applicantFinancialProfiles = (await this.prisma.applicantFinancialProfile.deleteMany({})).count; // @tenant-reviewed: phase211-excluded-platform (System Admin global cleanup)

      // 14. Applicants
      removed.applicants = (await this.prisma.applicant.deleteMany({})).count; // @tenant-reviewed: phase211-excluded-platform (System Admin global cleanup)

      // 15. Job ads (after applicants since applicants have FK to job_ads)
      removed.jobAds = (await this.prisma.jobAd.deleteMany({})).count; // @tenant-reviewed: phase211-excluded-platform (System Admin global cleanup)

      // 16. Reports (cascades filters/columns/sorting)
      removed.reportFilters = (await this.prisma.reportFilter.deleteMany({})).count; // @tenant-reviewed: phase211-excluded-platform (System Admin global cleanup)
      removed.reportColumns = (await this.prisma.reportColumn.deleteMany({})).count; // @tenant-reviewed: phase211-excluded-platform (System Admin global cleanup)
      removed.reportSorting = (await this.prisma.reportSorting.deleteMany({})).count; // @tenant-reviewed: phase211-excluded-platform (System Admin global cleanup)
      removed.reports = (await this.prisma.report.deleteMany({})).count; // @tenant-reviewed: phase211-excluded-platform (System Admin global cleanup)

      // 17. Non-preserved users
      removed.users = (await this.prisma.user.deleteMany({ where: { id: { notIn: preservedUserIds } } })).count; // @tenant-reviewed: phase211-excluded-platform (System Admin global cleanup)

      // 18. Non-preserved agencies
      // First null out any preserved-user agency references that may now be invalid
      // (preserved users' agencies are in preservedAgencyIds so this is safe)
      removed.agencies = (await this.prisma.agency.deleteMany({ where: { id: { notIn: preservedAgencyIds } } })).count; // @tenant-reviewed: phase211-excluded-platform (System Admin global cleanup)

      // 19. Non-preserved roles (role_permissions cascade)
      removed.rolePermissions = (await this.prisma.rolePermission.deleteMany({ // @tenant-reviewed: phase211-excluded-platform (System Admin global cleanup)
        where: { roleId: { notIn: preservedRoleIds } },
      })).count;
      removed.roles = (await this.prisma.role.deleteMany({ where: { id: { notIn: preservedRoleIds } } })).count; // @tenant-reviewed: phase211-excluded-platform (System Admin global cleanup)

      // 20. Identifier sequences (reset counters)
      removed.identifierSequences = (await this.prisma.identifierSequence.deleteMany({})).count; // @tenant-reviewed: phase211-excluded-platform (System Admin global cleanup)

      // 21. Audit logs (optional)
      if (dto.clearAuditLogs) {
        removed.auditLogs = (await this.prisma.auditLog.deleteMany({})).count; // @tenant-reviewed: phase211-excluded-platform (System Admin global cleanup)
        warnings.push('Audit logs were cleared as requested.');
      } else {
        warnings.push('Audit logs were preserved (clearAuditLogs was false).');
      }

      // ── Step 2: Audit log the cleanup ─────────────────────────────────────
      // Only log if audit logs weren't cleared, or log before clearing
      const totalRemoved = Object.values(removed)
        .filter(v => typeof v === 'number')
        .reduce((s: number, n) => s + (n as number), 0);

      await this.auditLog.log({
        userId: actorId,
        action: 'DATABASE_CLEANUP',
        entity: 'SYSTEM',
        entityId: 'database',
        changes: {
          removed,
          preserved: { userIds: preservedUserIds, agencyIds: preservedAgencyIds, roleIds: preservedRoleIds },
          reason: dto.reason ?? null,
          totalRemoved,
        },
      }).catch(() => {});

      this.logger.warn(`✅  DATABASE CLEANUP complete. ${totalRemoved} records removed by user ${actorId}`);

      return {
        success: true,
        removed,
        preserved: {
          users: preservedUserIds.length,
          agencies: preservedAgencyIds.length,
          roles: preservedRoleIds.length,
        },
        warnings,
      };
    } catch (err) {
      this.logger.error('DATABASE CLEANUP FAILED', err);
      throw err;
    }
  }

  // ── Helpers ─────────────────────────────────────────────────────────────────

  private async resolvePreservedEntities() {
    const preservedRoles = await this.prisma.role.findMany({ // @tenant-reviewed: phase211-excluded-platform (System Admin global cleanup)
      where: { name: { in: PRESERVED_ROLE_NAMES } },
      select: { id: true },
    });
    const preservedRoleIds = preservedRoles.map(r => r.id);

    // Preserve users whose current (non-deleted) role is a preserved role
    const preservedUsers = await this.prisma.user.findMany({ // @tenant-reviewed: phase211-excluded-platform (System Admin global cleanup)
      where: { roleId: { in: preservedRoleIds } },
      select: { id: true, agencyId: true },
    });
    const preservedUserIds = preservedUsers.map(u => u.id);
    const preservedAgencyIds = [...new Set(preservedUsers.map(u => u.agencyId))];

    return { preservedUserIds, preservedAgencyIds, preservedRoleIds };
  }
}
