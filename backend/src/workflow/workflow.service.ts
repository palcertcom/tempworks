import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { PilotPrismaAccessor } from '../saas/prisma/pilot-prisma.accessor';
import { getPilotScope, PilotScope } from '../saas/prisma/tenant-pilot-scope';
import { TenantAuditLogService } from '../saas/audit/tenant-audit-log.service';
import { CreateWorkPermitDto } from './dto/create-work-permit.dto';
import { CreateVisaDto } from './dto/create-visa.dto';
import { UpdateWorkflowStageDto } from './dto/update-workflow-stage.dto';
import { PaginationDto } from '../common/dto/pagination.dto';
import { PaginatedResponse } from '../common/dto/pagination-response.dto';

/**
 * Phase 2.26 — Workflow reads-first pilot.
 *
 * READ paths route through `pilot.client()` and spread
 * `scope.tenantWhere()` / relation-filter into where clauses when
 * the pilot scope is active. Production default (flag off) is
 * byte-identical to pre-2.26.
 *
 * `StageTemplate` is a global catalog (no `tenantId` column today).
 * All `stageTemplate.*` reads are tagged `phase226-global`.
 *
 * `EmployeeStage` has no `tenantId` column either; aggregate
 * counts are narrowed via the `employee: { tenantId }` relation
 * filter, and direct queries by parent employee id are gated by
 * the tenant-scoped `findEmployee`.
 *
 * WRITE / mutation paths (`updateEmployeeWorkflowStage`,
 * `setEmployeeCurrentStage`, `createWorkPermit`, `updateWorkPermit`,
 * `createVisa`, `updateVisa`) explicitly use `legacyPrisma` and
 * remain annotated `phase226-excluded-mutation` until Phase 2.27+.
 *
 * Audit-log writes use `legacyPrisma` always (`phase226-audit-log`).
 */
@Injectable()
export class WorkflowService {
  constructor(
    private legacyPrisma: PrismaService,
    private pilot: PilotPrismaAccessor,
    private tenantAuditLog: TenantAuditLogService,
  ) {}

  /** Pilot-aware Prisma surface used by READ paths only. */
  private get prisma(): PrismaService {
    return this.pilot.client();
  }

  private scope(): PilotScope {
    return getPilotScope(this.pilot, 'workflow');
  }

  /**
   * Phase 2.27 — parent gate for mutations. Loads the employee
   * through the pilot client with `tenantWhere()`. Cross-tenant
   * employee ids raise 404 BEFORE any mutation. Legacy mode
   * (`tenantWhere()` returns `{}`) reduces to a plain by-id
   * lookup — same as the prior `findUnique` calls.
   */
  private async findEmployeeOrFail(id: string) {
    const t = this.scope().tenantWhere();
    const e = await this.prisma.employee.findFirst({ where: { id, deletedAt: null, ...t } }); // @tenant-reviewed: phase227-pilot-scope (mutation pre-check)
    if (!e) throw new NotFoundException({ code: 'EMPLOYEE.NOT_FOUND', message: 'Employee not found' });
    return e;
  }

  private async findApplicantOrFail(id: string) {
    const t = this.scope().tenantWhere();
    const a = await this.prisma.applicant.findFirst({ where: { id, deletedAt: null, ...t } }); // @tenant-reviewed: phase227-pilot-scope (mutation pre-check)
    if (!a) throw new NotFoundException({ code: 'APPLICANT.NOT_FOUND', message: 'Applicant not found' });
    return a;
  }

  async getStages() {
    return this.prisma.stageTemplate.findMany({ // @tenant-reviewed: phase226-global
      where: { isActive: true },
      orderBy: { order: 'asc' },
      include: { _count: { select: { employeeStages: true } } },
    });
  }

  async getOverview() {
    const t = this.scope().tenantWhere();
    const stages = await this.prisma.stageTemplate.findMany({ // @tenant-reviewed: phase226-global
      where: { isActive: true },
      orderBy: { order: 'asc' },
    });

    const overview = await Promise.all(
      stages.map(async (stage) => {
        // EmployeeStage has no tenantId; narrow via the parent
        // Employee relation filter. In legacy mode the spread is
        // {} and the filter does not apply.
        const employeeFilter = this.scope().active ? { employee: { tenantId: this.scope().tenantId } } : {};
        const [pending, inProgress, completed, applicantsCount] = await Promise.all([
          this.prisma.employeeStage.count({ where: { stageId: stage.id, status: 'PENDING', ...employeeFilter } }), // @tenant-reviewed: phase226-pilot-scope (relation filter via employee.tenantId)
          this.prisma.employeeStage.count({ where: { stageId: stage.id, status: 'IN_PROGRESS', ...employeeFilter } }), // @tenant-reviewed: phase226-pilot-scope
          this.prisma.employeeStage.count({ where: { stageId: stage.id, status: 'COMPLETED', ...employeeFilter } }), // @tenant-reviewed: phase226-pilot-scope
          this.prisma.applicant.count({ where: { currentWorkflowStageId: stage.id, deletedAt: null, ...t } }), // @tenant-reviewed: phase226-pilot-scope
        ]);
        return {
          ...stage,
          pending,
          inProgress: inProgress + applicantsCount,
          completed,
          total: pending + inProgress + completed,
          applicants: applicantsCount,
        };
      }),
    );
    return overview;
  }

  async getAnalytics() {
    const t = this.scope().tenantWhere();
    const employeeFilter = this.scope().active ? { employee: { tenantId: this.scope().tenantId } } : {};
    const [totalEmployees, stageBreakdown, recentActivity] = await Promise.all([
      this.prisma.employee.count({ where: { deletedAt: null, ...t } }), // @tenant-reviewed: phase226-pilot-scope
      this.prisma.employeeStage.groupBy({ // @tenant-reviewed: phase226-pilot-scope (relation filter via employee.tenantId)
        by: ['status'],
        _count: { id: true },
        where: employeeFilter as any,
      }),
      this.prisma.employeeStage.findMany({ // @tenant-reviewed: phase226-pilot-scope (relation filter via employee.tenantId)
        where: { updatedAt: { gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) }, ...employeeFilter },
        include: {
          employee: { select: { id: true, firstName: true, lastName: true } },
          stage: { select: { id: true, name: true, order: true } },
        },
        orderBy: { updatedAt: 'desc' },
        take: 20,
      }),
    ]);
    return { totalEmployees, stageBreakdown, recentActivity };
  }

  async updateEmployeeWorkflowStage(
    employeeId: string,
    stageId: string,
    dto: UpdateWorkflowStageDto,
    updatedById?: string,
  ) {
    // Phase 2.27 — parent employee gate. EmployeeStage has no
    // tenantId column; cross-tenant safety comes from validating
    // the parent employee through the pilot client first.
    await this.findEmployeeOrFail(employeeId);
    const workflowEntry = await this.legacyPrisma.employeeStage.findUnique({ // @tenant-reviewed: phase227-pilot-scope-precheck (parent employee tenant-checked above)
      where: { employeeId_stageId: { employeeId, stageId } },
      include: { stage: true },
    });
    if (!workflowEntry) throw new NotFoundException({ code: 'WORKFLOW.STAGE_NOT_FOUND_FOR_EMPLOYEE', message: 'Workflow stage not found for this employee' });

    const updateData: any = {
      status: dto.status,
      notes: dto.notes,
      assignedToId: dto.assignedToId,
    };
    if (dto.status === 'IN_PROGRESS' && !workflowEntry.startedAt) {
      updateData.startedAt = new Date();
    }
    if (dto.status === 'COMPLETED') {
      updateData.completedAt = new Date();
    }

    const updated = await this.legacyPrisma.employeeStage.update({ // @tenant-reviewed: phase227-pilot-scope-precheck (parent employee tenant-checked above)
      where: { employeeId_stageId: { employeeId, stageId } },
      data: updateData,
      include: { stage: true, assignedTo: { select: { id: true, firstName: true, lastName: true } } },
    });

    if (updatedById) {
      // @tenant-reviewed: phase230-audit-log-pilot
      await this.tenantAuditLog.write({
        userId: updatedById,
        action: 'WORKFLOW_STAGE_UPDATE',
        entity: 'EmployeeWorkflowStage',
        entityId: `${employeeId}:${stageId}`,
        changes: { status: dto.status },
      });
    }
    return updated;
  }

  async setEmployeeCurrentStage(employeeId: string, stageId: string, updatedById?: string) {
    // Phase 2.27 — parent employee gate.
    await this.findEmployeeOrFail(employeeId);

    const stage = await this.legacyPrisma.stageTemplate.findUnique({ where: { id: stageId } }); // @tenant-reviewed: phase226-global
    if (!stage) throw new NotFoundException({ code: 'WORKFLOW.STAGE_NOT_FOUND', message: 'Workflow stage not found' });

    // Complete any currently IN_PROGRESS stages (parent already gated)
    await this.legacyPrisma.employeeStage.updateMany({ // @tenant-reviewed: phase227-pilot-scope-precheck (parent employee tenant-checked above)
      where: { employeeId, status: 'IN_PROGRESS' },
      data: { status: 'COMPLETED', completedAt: new Date() },
    });

    // Upsert the chosen stage as IN_PROGRESS
    const result = await this.legacyPrisma.employeeStage.upsert({ // @tenant-reviewed: phase227-pilot-scope-precheck (parent employee tenant-checked above)
      where: { employeeId_stageId: { employeeId, stageId } },
      create: { employeeId, stageId, status: 'IN_PROGRESS', startedAt: new Date() },
      update: { status: 'IN_PROGRESS', startedAt: new Date(), completedAt: null },
      include: { stage: true },
    });

    if (updatedById) {
      // @tenant-reviewed: phase230-audit-log-pilot
      await this.tenantAuditLog.write({
        userId: updatedById,
        action: 'WORKFLOW_STAGE_UPDATE',
        entity: 'Employee',
        entityId: employeeId,
        changes: { currentStageId: stageId, currentStageName: stage.name },
      });
    }

    return result;
  }

  async getTimeline(employeeId: string) {
    const t = this.scope().tenantWhere();
    // findFirst (was findUnique) so we can compose tenant predicate.
    const employee = await this.prisma.employee.findFirst({ // @tenant-reviewed: phase226-pilot-scope
      where: { id: employeeId, deletedAt: null, ...t },
      include: {
        employeeStages: {
          include: {
            stage: true,
            assignedTo: { select: { id: true, firstName: true, lastName: true } },
          },
          orderBy: { stage: { order: 'asc' } },
        },
      },
    });
    if (!employee) throw new NotFoundException({ code: 'EMPLOYEE.NOT_FOUND', message: `Employee ${employeeId} not found`, params: { id: employeeId } });
    return {
      employee: { id: employee.id, firstName: employee.firstName, lastName: employee.lastName, status: employee.status },
      timeline: employee.employeeStages,
    };
  }

  async getStageDetails(stageId: string) {
    const t = this.scope().tenantWhere();
    const employeeFilter = this.scope().active ? { employee: { tenantId: this.scope().tenantId } } : {};
    const stage = await this.prisma.stageTemplate.findUnique({ where: { id: stageId } }); // @tenant-reviewed: phase226-global
    if (!stage) throw new NotFoundException({ code: 'WORKFLOW.STAGE_NOT_FOUND', message: 'Stage not found' });

    const [applicants, employeeStages] = await Promise.all([
      this.prisma.applicant.findMany({ // @tenant-reviewed: phase226-pilot-scope
        where: { currentWorkflowStageId: stageId, deletedAt: null, ...t },
        include: { jobType: { select: { id: true, name: true } } },
        orderBy: { createdAt: 'asc' },
      }),
      this.prisma.employeeStage.findMany({ // @tenant-reviewed: phase226-pilot-scope (relation filter via employee.tenantId)
        where: { stageId, status: 'IN_PROGRESS', ...employeeFilter },
        include: {
          employee: { select: { id: true, firstName: true, lastName: true, email: true, nationality: true, photoUrl: true, status: true } },
        },
        orderBy: { startedAt: 'asc' },
      }),
    ]);

    // Build document checklist for each person if the stage has required docs
    const buildDocChecklist = async (entityType: string, entityId: string) => {
      if (stage.requirementsDocuments.length === 0) return [];
      const docs = await this.prisma.document.findMany({ // @tenant-reviewed: phase226-pilot-scope
        where: { entityType: entityType as any, entityId, deletedAt: null, ...t },
        include: { documentType: { select: { name: true } } },
      });
      return stage.requirementsDocuments.map(reqName => {
        const doc = (docs as any[]).find(d => d.documentType.name === reqName);
        return { name: reqName, status: doc?.status ?? 'MISSING', documentId: doc?.id ?? null };
      });
    };

    const enrichedApplicants = await Promise.all(
      applicants.map(async (a: any) => ({
        ...a,
        docChecklist: await buildDocChecklist('APPLICANT', a.id),
      })),
    );

    const enrichedEmployees = await Promise.all(
      employeeStages.map(async (es: any) => ({
        ...es.employee,
        startedAt: es.startedAt,
        stageStatus: es.status,
        docChecklist: await buildDocChecklist('EMPLOYEE', es.employee.id),
      })),
    );

    return {
      stage,
      applicants: enrichedApplicants,
      employees: enrichedEmployees,
      stats: {
        total: applicants.length + employeeStages.length,
        applicantsCount: applicants.length,
        employeesCount: employeeStages.length,
      },
    };
  }

  // Work Permits
  async findWorkPermits(pagination: PaginationDto, employeeId?: string) {
    const { page = 1, limit = 10 } = pagination;
    const t = this.scope().tenantWhere();
    const where: any = { ...(employeeId ? { employeeId } : {}), ...t };
    const [items, total] = await Promise.all([
      this.prisma.workPermit.findMany({ // @tenant-reviewed: phase226-pilot-scope
        where,
        skip: (Number(page) - 1) * Number(limit),
        take: Number(limit),
        orderBy: { createdAt: 'desc' },
        include: { employee: { select: { id: true, firstName: true, lastName: true, email: true } } },
      }),
      this.prisma.workPermit.count({ where }), // @tenant-reviewed: phase226-pilot-scope
    ]);
    return PaginatedResponse.create(items, total, page, limit);
  }

  async createWorkPermit(dto: CreateWorkPermitDto, createdById?: string, callerTenantId?: string | null) {
    // Phase 2.27 — parent employee gate + tenantId on the new permit.
    await this.findEmployeeOrFail(dto.employeeId);
    const tdata = this.scope().tenantData();
    const permit = await this.legacyPrisma.workPermit.create({ // @tenant-reviewed: phase227-pilot-scope (writes tenantId via scope.tenantData)
      data: {
        ...dto,
        applicationDate: new Date(dto.applicationDate),
        approvalDate: dto.approvalDate ? new Date(dto.approvalDate) : undefined,
        expiryDate: new Date(dto.expiryDate),
        status: dto.status || 'PENDING',
        ...tdata,
        // Phase 2C (#23) — default to caller.tenantId when scope is empty.
        ...(!(tdata as any).tenantId && callerTenantId ? { tenantId: callerTenantId } : {}),
      },
      include: { employee: { select: { id: true, firstName: true, lastName: true } } },
    });
    if (createdById) {
      // @tenant-reviewed: phase230-audit-log-pilot
      await this.tenantAuditLog.write({
        userId: createdById,
        action: 'CREATE',
        entity: 'WorkPermit',
        entityId: permit.id,
      });
    }
    return permit;
  }

  async updateWorkPermit(id: string, dto: Partial<CreateWorkPermitDto>, updatedById?: string) {
    // Phase 2.27 — tenant-scoped pre-check via the pilot client.
    const t = this.scope().tenantWhere();
    const permit = await this.prisma.workPermit.findFirst({ where: { id, ...t } }); // @tenant-reviewed: phase227-pilot-scope (mutation pre-check)
    if (!permit) throw new NotFoundException({ code: 'WORKFLOW.WORK_PERMIT_NOT_FOUND', message: 'Work permit not found' });
    const updateData: any = { ...dto };
    if (dto.applicationDate) updateData.applicationDate = new Date(dto.applicationDate);
    if (dto.approvalDate) updateData.approvalDate = new Date(dto.approvalDate);
    if (dto.expiryDate) updateData.expiryDate = new Date(dto.expiryDate);
    return this.legacyPrisma.workPermit.update({ where: { id }, data: updateData }); // @tenant-reviewed: phase227-pilot-scope-precheck (pre-check above is tenant-scoped)
  }

  // Visas
  async findVisas(pagination: PaginationDto, entityId?: string) {
    const { page = 1, limit = 10 } = pagination;
    const t = this.scope().tenantWhere();
    const where: any = { ...(entityId ? { entityId } : {}), ...t };
    const [items, total] = await Promise.all([
      this.prisma.visa.findMany({ where, skip: (Number(page) - 1) * Number(limit), take: Number(limit), orderBy: { createdAt: 'desc' } }), // @tenant-reviewed: phase226-pilot-scope
      this.prisma.visa.count({ where }), // @tenant-reviewed: phase226-pilot-scope
    ]);
    return PaginatedResponse.create(items, total, page, limit);
  }

  async createVisa(dto: CreateVisaDto, createdById?: string, callerTenantId?: string | null) {
    // Phase 2.27 — parent-entity gate (EMPLOYEE or APPLICANT) +
    // tenantId on the new visa.
    if (dto.entityType === 'EMPLOYEE') {
      await this.findEmployeeOrFail(dto.entityId);
    } else if (dto.entityType === 'APPLICANT') {
      await this.findApplicantOrFail(dto.entityId);
    } else {
      throw new BadRequestException({ code: 'WORKFLOW.VISA_ENTITY_TYPE_INVALID', message: `Invalid entityType ${dto.entityType}` });
    }
    const tdata = this.scope().tenantData();
    const visa = await this.legacyPrisma.visa.create({ // @tenant-reviewed: phase227-pilot-scope (writes tenantId via scope.tenantData)
      data: {
        ...dto,
        entityType: dto.entityType as any,
        applicationDate: new Date(dto.applicationDate),
        appointmentDate: dto.appointmentDate ? new Date(dto.appointmentDate) : undefined,
        approvalDate: dto.approvalDate ? new Date(dto.approvalDate) : undefined,
        expiryDate: dto.expiryDate ? new Date(dto.expiryDate) : undefined,
        status: dto.status || 'PENDING',
        ...tdata,
        // Phase 2C (#23) — default to caller.tenantId when scope is empty.
        ...(!(tdata as any).tenantId && callerTenantId ? { tenantId: callerTenantId } : {}),
      },
    });
    if (createdById) {
      // @tenant-reviewed: phase230-audit-log-pilot
      await this.tenantAuditLog.write({
        userId: createdById,
        action: 'CREATE',
        entity: 'Visa',
        entityId: visa.id,
      });
    }
    return visa;
  }

  async updateVisa(id: string, dto: Partial<CreateVisaDto>, updatedById?: string) {
    // Phase 2.27 — tenant-scoped pre-check via the pilot client.
    const t = this.scope().tenantWhere();
    const visa = await this.prisma.visa.findFirst({ where: { id, ...t } }); // @tenant-reviewed: phase227-pilot-scope (mutation pre-check)
    if (!visa) throw new NotFoundException({ code: 'WORKFLOW.VISA_NOT_FOUND', message: 'Visa not found' });
    const updateData: any = { ...dto };
    if (dto.applicationDate) updateData.applicationDate = new Date(dto.applicationDate);
    if (dto.appointmentDate) updateData.appointmentDate = new Date(dto.appointmentDate);
    if (dto.approvalDate) updateData.approvalDate = new Date(dto.approvalDate);
    if (dto.expiryDate) updateData.expiryDate = new Date(dto.expiryDate);
    return this.legacyPrisma.visa.update({ where: { id }, data: updateData }); // @tenant-reviewed: phase227-pilot-scope-precheck (pre-check above is tenant-scoped)
  }
}
