import { Injectable, NotFoundException, ConflictException, BadRequestException, ForbiddenException, Logger, Optional } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { PilotPrismaAccessor } from '../saas/prisma/pilot-prisma.accessor';
import { getPilotScope, PilotScope } from '../saas/prisma/tenant-pilot-scope';
import { buildSuperUserTenantWhereDirect, assertRequestedTenantExists } from '../saas/prisma/super-user-tenant-filter';
import { TenantAuditLogService } from '../saas/audit/tenant-audit-log.service';
import { NotificationsService } from '../notifications/notifications.service';
import { NOTIF_EVENTS } from '../notifications/notification-events';
import {
  CreateWorkflowDto,
  CreateWorkflowStageDto,
  UpdateWorkflowStageProgressDto,
  CreateStageNoteDto,
  CreateStageApprovalDto,
  AssignCandidateToWorkflowDto,
  AssignEmployeeToWorkflowDto,
} from './dto/create-pipeline.dto';

const WORKFLOW_STAGE_INCLUDE = {
  assignedUsers: { include: { user: { select: { id: true, firstName: true, lastName: true, email: true } } } },
  requiredDocs: { include: { documentType: { select: { id: true, name: true, category: true } } } },
  _count: { select: { candidateProgress: true } },
} as const;

const WORKFLOW_INCLUDE = {
  stages: { orderBy: { order: 'asc' as const }, include: WORKFLOW_STAGE_INCLUDE },
  _count: { select: { assignments: true } },
  createdBy: { select: { id: true, firstName: true, lastName: true } },
} as const;

/**
 * Phase 2.61 — Pipeline reads-first TenantPrisma pilot.
 *
 * Workflow / WorkflowStage configuration is GLOBAL by design today
 * (no `tenantId` column; intentionally cross-tenant config like
 * DocumentType). Workflow CRUD therefore stays on `legacyPrisma`
 * and is tagged `phase261-pipeline-mutation-deferred`.
 *
 * The tenant-bound surface is the *assignment* layer:
 * `CandidateWorkflowAssignment` and `EmployeeWorkflowAssignment`
 * both carry a denormalised `tenantId` (Phase 2.3). Phase 2.61
 * applies `scope.tenantWhere()` to assignment-driven read paths
 * (`getWorkflowCandidates`, `getWorkflowBoardView`,
 * `getWorkflowStats`) so a tenant-A actor cannot see tenant-B
 * candidates inside a globally-defined workflow.
 *
 * Mutation parent gates and transition flow are deferred to the
 * pipeline mutation pilot (next phase) — tag
 * `phase261-pipeline-transition-deferred`. Stage-progress audit
 * emission stays on `legacyPrisma.auditLog.create` — tag
 * `phase261-pipeline-audit-log`.
 */
@Injectable()
export class WorkflowService {
  constructor(
    private legacyPrisma: PrismaService,
    private pilot: PilotPrismaAccessor,
    private tenantAuditLog: TenantAuditLogService,
    @Optional() private notifications?: NotificationsService,
  ) {}

  private readonly logger = new Logger('WorkflowService');

  /** Helpers to resolve the audience for pipeline emissions.
   *  RESPONSIBLE users do the day-to-day work in the stage; APPROVERs
   *  sign off. Returning both is the safe default — emitters narrow by
   *  passing a specific role list when they need it. */
  private async stageAssigneeIds(stageId: string, roles?: Array<'RESPONSIBLE' | 'APPROVER' | 'REVIEWER'>): Promise<string[]> {
    const where: any = { stageId };
    if (roles?.length) where.role = { in: roles };
    const rows = await this.prisma.workflowStageUser.findMany({
      where,
      select: { userId: true },
    });
    return Array.from(new Set(rows.map(r => r.userId)));
  }

  /** Users with explicit access to a private workflow. Used as the
   *  broad audience for cross-stage events (rejection, flagging). */
  private async workflowAudienceIds(workflowId: string): Promise<string[]> {
    const rows = await this.prisma.workflowAccessUser.findMany({
      where: { workflowId },
      select: { userId: true },
    });
    return Array.from(new Set(rows.map(r => r.userId)));
  }

  /** Resolve a workflow's display name for notification text. Falls
   *  back to the id if the row was deleted between mutation and
   *  notification — never throws. */
  private async workflowNameOrId(workflowId: string): Promise<string> {
    const row = await this.prisma.workflow.findUnique({
      where: { id: workflowId },
      select: { name: true },
    }).catch(() => null);
    return row?.name ?? workflowId;
  }

  private get prisma(): PrismaService {
    return this.pilot.client();
  }

  private scope(): PilotScope {
    return getPilotScope(this.pilot, 'pipeline');
  }

  /**
   * Phase 2.62 — single audit emission hook. Routes every pipeline
   * audit row through `TenantAuditLogService.write` so the row
   * carries `tenantId` when the audit pilot is on + an ALS frame is
   * present. With `TENANT_AUDIT_LOG_PILOT_ENABLED=false` (default)
   * the row is written with NO `tenantId` — legacy/NULL-tenant
   * compatible. Rejected mutations short-circuit BEFORE this is
   * called, so denied attempts never emit audit rows.
   * Tag: phase262-pipeline-audit-log-pilot.
   */
  private async auditLog(
    userId: string | undefined | null,
    action: string,
    entity: string,
    entityId: string,
    changes?: Record<string, any>,
  ): Promise<void> {
    await this.tenantAuditLog.write({ userId, action, entity, entityId, changes });
  }

  /** Phase 2.62 — candidate parent gate. With pilot ON +
   *  audit-logs-allowed module, ensures the subject applicant
   *  belongs to the active tenant. Legacy mode (`tenantWhere = {}`)
   *  reduces to a plain by-id check — byte-identical to pre-2.62. */
  private async findCandidateForPipelineMutationOrFail(candidateId: string) {
    const t = this.scope().tenantWhere();
    const c = await this.prisma.applicant.findFirst({ // @tenant-reviewed: phase262-pipeline-mutation-pilot (candidate parent gate)
      where: { id: candidateId, tier: 'CANDIDATE', deletedAt: null, ...t },
    });
    if (!c) throw new NotFoundException({ code: 'APPLICANT.NOT_FOUND', message: 'Candidate not found' });
    return c;
  }

  /** Phase 2.62 — assignment parent gate. */
  private async findCandidateAssignmentForMutationOrFail(assignmentId: string) {
    const t = this.scope().tenantWhere();
    const a = await this.prisma.candidateWorkflowAssignment.findFirst({ // @tenant-reviewed: phase262-pipeline-mutation-pilot
      where: { id: assignmentId, ...t },
    });
    if (!a) throw new NotFoundException({ code: 'WORKFLOW.ASSIGNMENT_NOT_FOUND', message: 'Assignment not found' });
    return a;
  }

  /**
   * Phase 2.63 — workflow READ predicate. With pilot active +
   * pipeline allow-listed + ALS tenant attached, a tenant sees
   * its own workflows PLUS NULL-tenant global templates (Strategy
   * A; read-only). Legacy mode returns `{}` so behaviour is
   * byte-identical to pre-2.63.
   * Tag: phase263-workflow-tenant-scope + phase263-workflow-global-template.
   */
  private workflowReadWhere(): Record<string, unknown> {
    const s = this.scope();
    if (!s.active || !s.tenantId) return {};
    return { OR: [{ tenantId: s.tenantId }, { tenantId: null }] };
  }

  /** Phase 2.63 — workflow MUTATION predicate. With pilot active,
   *  refuses NULL-tenant global templates AND cross-tenant
   *  workflows. Legacy mode returns `{}` (no extra filter).
   *  Tag: phase263-workflow-tenant-scope. */
  private workflowMutateWhere(): Record<string, unknown> {
    const s = this.scope();
    if (!s.active || !s.tenantId) return {};
    return { tenantId: s.tenantId };
  }

  /** Phase 2.63 — assertion helper for stage / access-user routes:
   *  the parent workflow must be mutable by the active tenant.
   *  Returns the workflow row.
   *  Tag: phase263-workflow-stage-scope. */
  private async findMutableWorkflowOrFail(workflowId: string) {
    const w = await this.prisma.workflow.findFirst({ // @tenant-reviewed: phase263-workflow-stage-scope (parent gate for stage/access mutations)
      where: { id: workflowId, deletedAt: null, ...this.workflowMutateWhere() },
    });
    if (!w) throw new NotFoundException({ code: 'WORKFLOW.NOT_FOUND', message: 'Workflow not found' });
    return w;
  }

  /** Phase 2.62 — stage-progress parent gate via assignment.tenantId. */
  private async findProgressForMutationOrFail(progressId: string) {
    const t = this.scope().tenantWhere();
    const p = await this.prisma.candidateStageProgress.findFirst({ // @tenant-reviewed: phase262-pipeline-transition-pilot (progress gate via assignment.tenantId)
      where: { id: progressId, assignment: { ...t } },
      include: { stage: true },
    });
    if (!p) throw new NotFoundException({ code: 'WORKFLOW.PROGRESS_NOT_FOUND', message: 'Progress record not found' });
    return p;
  }

  // ─── Workflows ────────────────────────────────────────────────────────────

  async listWorkflows(includeArchived = false, caller?: any, tenantIdQuery?: string) {
    // @tenant-reviewed: phase263-workflow-tenant-scope (own + NULL-global templates visible)
    // Phase F2 (SPIKE-010 Batch 2) — SUPER USER tenant override.
    await assertRequestedTenantExists(caller, tenantIdQuery, this.legacyPrisma.tenant);
    const superTenantPredicate = buildSuperUserTenantWhereDirect(caller, tenantIdQuery);
    const where: any = { deletedAt: null, ...this.workflowReadWhere() };
    if (superTenantPredicate) where.AND = [...(where.AND ?? []), superTenantPredicate];
    if (!includeArchived) where.status = 'ACTIVE';
    const workflows = await this.prisma.workflow.findMany({
      where,
      orderBy: [{ isDefault: 'desc' }, { name: 'asc' }],
      include: WORKFLOW_INCLUDE,
    });
    return workflows.map((w: any) => ({
      ...w,
      stages: (w.stages as any[]).filter((s: any) => s.isActive !== false),
    }));
  }

  async getWorkflow(id: string) {
    // @tenant-reviewed: phase263-workflow-tenant-scope (own + NULL-global templates readable)
    const workflow = await this.prisma.workflow.findFirst({
      where: { id, deletedAt: null, ...this.workflowReadWhere() },
      include: WORKFLOW_INCLUDE,
    });
    if (!workflow) throw new NotFoundException({ code: 'WORKFLOW.NOT_FOUND', message: 'Workflow not found' });
    return workflow;
  }

  async createWorkflow(dto: CreateWorkflowDto, createdById?: string, callerTenantId?: string | null) {
    if (dto.isDefault) {
      // @tenant-reviewed: phase263-workflow-tenant-scope (per-tenant default flag only within own scope)
      await this.prisma.workflow.updateMany({
        where: { isDefault: true, deletedAt: null, ...this.workflowMutateWhere() },
        data: { isDefault: false },
      });
    }
    // Stamp tenantId. Order of precedence:
    //   1. ALS pilot frame via scope().tenantData() (pilot active path)
    //   2. Caller's session tenant (legacy path / pilot off)
    // Without (2), pilot-off mode left every new workflow as tenantId=NULL,
    // which is treated as a CROSS-TENANT GLOBAL TEMPLATE by workflowReadWhere
    // — meaning the workflow showed up under "All Tenants" and never under
    // the creator's own tenant. The user-facing symptom was "Workflows page
    // is empty under any specific tenant even though I just created one."
    const tdata = this.scope().tenantData();
    const tenantStamp: { tenantId?: string } =
      (tdata as any).tenantId
        ? { tenantId: (tdata as any).tenantId }
        : (callerTenantId ? { tenantId: callerTenantId } : {});
    return this.prisma.workflow.create({
      data: {
        name: dto.name,
        description: dto.description,
        isDefault: dto.isDefault ?? false,
        isPublic: dto.isPublic ?? true,
        color: dto.color ?? '#2563EB',
        createdById,
        ...tenantStamp, // @tenant-reviewed: phase263-workflow-tenant-scope (stamp tenantId on insert)
      },
      include: WORKFLOW_INCLUDE,
    });
  }

  /**
   * Duplicate an existing workflow — copies the workflow row plus every stage,
   * each stage's required documents, the stage user assignments, and the
   * private access list. Candidate / employee assignments and any in-flight
   * progress are NOT copied: the new workflow starts empty.
   *
   * The new workflow is always created as non-default (isDefault=false) so
   * copying does not dethrone the current default; the caller can promote it
   * afterwards if desired.
   */
  async copyWorkflow(sourceId: string, overrides: { name?: string } | undefined, actorId?: string, callerTenantId?: string | null) {
    // @tenant-reviewed: phase263-workflow-tenant-scope (source readable if own or NULL-global template)
    const source = await this.prisma.workflow.findFirst({
      where: { id: sourceId, deletedAt: null, ...this.workflowReadWhere() },
      include: {
        stages: {
          orderBy: { order: 'asc' },
          include: {
            assignedUsers: true,
            requiredDocs: true,
          },
        },
        accessUsers: true,
      },
    });
    if (!source) throw new NotFoundException({ code: 'WORKFLOW.NOT_FOUND', message: 'Workflow not found' });

    // Pick a unique name. If a name is passed use it verbatim; otherwise
    // append " (Copy)", " (Copy 2)", … until we find an unused slot among
    // non-deleted workflows.
    let newName = overrides?.name?.trim();
    if (!newName) {
      const base = `${source.name} (Copy)`;
      let candidate = base;
      let suffix = 2;
      // @tenant-reviewed: phase263-workflow-tenant-scope (name uniqueness check scoped to active tenant)
      while (await this.prisma.workflow.findFirst({ where: { name: candidate, deletedAt: null, ...this.workflowMutateWhere() } })) {
        candidate = `${source.name} (Copy ${suffix})`;
        suffix += 1;
      }
      newName = candidate;
    }

    // Same caller-tenant fallback as createWorkflow — without it, pilot-off
    // mode would copy the workflow into the cross-tenant global pool.
    const tdataCopy = this.scope().tenantData();
    const tenantStampCopy: { tenantId?: string } =
      (tdataCopy as any).tenantId
        ? { tenantId: (tdataCopy as any).tenantId }
        : (callerTenantId ? { tenantId: callerTenantId } : {});
    const created = await this.prisma.$transaction(async (tx) => {
      const newWorkflow = await tx.workflow.create({
        data: {
          name: newName!,
          description: source.description,
          isDefault: false,
          isPublic: source.isPublic,
          color: source.color,
          createdById: actorId,
          ...tenantStampCopy, // @tenant-reviewed: phase263-workflow-tenant-scope (copy lands in active tenant)
        },
      });

      // Re-create each stage with its required docs and assigned users.
      for (const stage of source.stages as any[]) {
        const newStage = await tx.workflowStage.create({
          data: {
            workflowId:      newWorkflow.id,
            name:            stage.name,
            description:     stage.description,
            order:           stage.order,
            color:           stage.color,
            slaHours:        stage.slaHours,
            requiresApproval: stage.requiresApproval,
            responsibleAny:  stage.responsibleAny,
            minApprovals:    stage.minApprovals,
            approvalMode:    stage.approvalMode,
            isFinal:         stage.isFinal,
            isActive:        stage.isActive,
          },
        });

        if ((stage.requiredDocs as any[]).length > 0) {
          await tx.workflowStageRequiredDoc.createMany({
            data: (stage.requiredDocs as any[]).map((rd) => ({
              stageId:        newStage.id,
              documentTypeId: rd.documentTypeId,
              isRequired:     rd.isRequired,
            })),
          });
        }

        if ((stage.assignedUsers as any[]).length > 0) {
          await tx.workflowStageUser.createMany({
            data: (stage.assignedUsers as any[]).map((au) => ({
              stageId: newStage.id,
              userId:  au.userId,
              role:    au.role,
            })),
            skipDuplicates: true,
          });
        }
      }

      // Private access users carry over so a cloned restricted workflow
      // stays accessible to the same set of users.
      if ((source.accessUsers as any[]).length > 0) {
        await (tx as any).workflowAccessUser.createMany({
          data: (source.accessUsers as any[]).map((au) => ({
            workflowId: newWorkflow.id,
            userId:     au.userId,
          })),
          skipDuplicates: true,
        });
      }

      return newWorkflow;
    });

    // @tenant-reviewed: phase262-pipeline-audit-log-pilot
    await this.auditLog(actorId, 'WORKFLOW_COPY', 'Workflow', created.id, { sourceWorkflowId: sourceId, name: created.name });

    return this.getWorkflow(created.id);
  }

  async updateWorkflow(id: string, dto: Partial<CreateWorkflowDto>, updatedById?: string) {
    await this.findMutableWorkflowOrFail(id); // @tenant-reviewed: phase263-workflow-tenant-scope (refuses global templates + cross-tenant)
    if (dto.isDefault) {
      // @tenant-reviewed: phase263-workflow-tenant-scope (per-tenant default flag only within own scope)
      await this.prisma.workflow.updateMany({
        where: { isDefault: true, deletedAt: null, id: { not: id }, ...this.workflowMutateWhere() },
        data: { isDefault: false },
      });
    }
    const updated = await this.prisma.workflow.update({
      where: { id },
      data: {
        ...(dto.name !== undefined && { name: dto.name }),
        ...(dto.description !== undefined && { description: dto.description }),
        ...(dto.isDefault !== undefined && { isDefault: dto.isDefault }),
        ...(dto.isPublic !== undefined && { isPublic: dto.isPublic }),
        ...(dto.color !== undefined && { color: dto.color }),
      },
      include: WORKFLOW_INCLUDE,
    });
    if (updatedById) {
      await this.auditLog(updatedById, 'UPDATE', 'Workflow', id, dto as any); // @tenant-reviewed: phase262-pipeline-audit-log-pilot
    }
    return updated;
  }

  async archiveWorkflow(id: string, actorId?: string) {
    await this.findMutableWorkflowOrFail(id); // @tenant-reviewed: phase263-workflow-tenant-scope (refuses global templates + cross-tenant)
    const updated = await this.prisma.workflow.update({ where: { id }, data: { status: 'ARCHIVED' as any } });
    if (actorId) {
      await this.auditLog(actorId, 'ARCHIVE', 'Workflow', id); // @tenant-reviewed: phase262-pipeline-audit-log-pilot
    }
    return updated;
  }

  async deleteWorkflow(id: string, actorId?: string) {
    await this.findMutableWorkflowOrFail(id); // @tenant-reviewed: phase263-workflow-tenant-scope (refuses global templates + cross-tenant)
    await this.prisma.workflow.update({ where: { id }, data: { deletedAt: new Date(), deletedBy: actorId } });
    if (actorId) {
      await this.auditLog(actorId, 'DELETE', 'Workflow', id); // @tenant-reviewed: phase262-pipeline-audit-log-pilot
    }
    return { message: 'Workflow deleted' };
  }

  // ─── Private Access Users ─────────────────────────────────────────────────
  // When a Workflow is marked isPublic=false, access is restricted to
  // the users returned by listAccessUsers. The UI exposes add/remove
  // endpoints on the Workflows page. Add/remove on a public workflow
  // is allowed but has no functional effect until it's flipped to
  // private — we still persist the list so flipping back later keeps
  // the previously-configured access intact.

  async listAccessUsers(workflowId: string) {
    await this.getWorkflow(workflowId);
    const rows = await (this.prisma as any).workflowAccessUser.findMany({
      where: { workflowId },
      include: { user: { select: { id: true, firstName: true, lastName: true, email: true } } },
      orderBy: { grantedAt: 'asc' },
    });
    return rows;
  }

  async addAccessUser(workflowId: string, userId: string, actorId?: string) {
    await this.findMutableWorkflowOrFail(workflowId); // @tenant-reviewed: phase263-workflow-stage-scope (access-user grant requires mutable parent)
    const user = await this.prisma.user.findFirst({ where: { id: userId, deletedAt: null } });
    if (!user) throw new NotFoundException({ code: 'USER.NOT_FOUND', message: 'User not found' });
    try {
      const row = await (this.prisma as any).workflowAccessUser.create({
        data: { workflowId, userId },
        include: { user: { select: { id: true, firstName: true, lastName: true, email: true } } },
      });
      if (actorId) {
        await this.auditLog(actorId, 'WORKFLOW_ACCESS_GRANTED', 'Workflow', workflowId, { userId }); // @tenant-reviewed: phase262-pipeline-audit-log-pilot
      }

      // Spec §4.11 — Pipeline: notify the granted user that they now
      // have access. The single recipient is the user themself, so we
      // skip the role-fanout helpers.
      const workflowName = await this.workflowNameOrId(workflowId);
      this.notifications?.notifyUsers(
        [userId],
        NOTIF_EVENTS.PIPELINE_ACCESS_CHANGED,
        'Workflow access granted',
        `You were granted access to "${workflowName}".`,
        'WORKFLOW',
        workflowId,
        {
          titleKey: 'events.pipelineAccessGranted.title',
          messageKey: 'events.pipelineAccessGranted.body',
          params: { workflowName },
        },
      ).catch(e => this.logger.error('Pipeline access-granted notification error:', e));

      return row;
    } catch (err: any) {
      if (err?.code === 'P2002') throw new ConflictException({ code: 'WORKFLOW.USER_ACCESS_EXISTS', message: 'User already has access to this workflow' });
      throw err;
    }
  }

  async removeAccessUser(workflowId: string, userId: string, actorId?: string) {
    await this.findMutableWorkflowOrFail(workflowId); // @tenant-reviewed: phase263-workflow-stage-scope (access-user revoke requires mutable parent)
    const existing = await (this.prisma as any).workflowAccessUser.findUnique({
      where: { workflowId_userId: { workflowId, userId } },
    });
    if (!existing) throw new NotFoundException({ code: 'WORKFLOW.USER_ACCESS_NOT_FOUND', message: 'User does not have access to this workflow' });
    await (this.prisma as any).workflowAccessUser.delete({
      where: { workflowId_userId: { workflowId, userId } },
    });
    if (actorId) {
      await this.auditLog(actorId, 'WORKFLOW_ACCESS_REVOKED', 'Workflow', workflowId, { userId }); // @tenant-reviewed: phase262-pipeline-audit-log-pilot
    }

    // Spec §4.11 — Pipeline: notify the user whose access was revoked.
    const workflowName = await this.workflowNameOrId(workflowId);
    this.notifications?.notifyUsers(
      [userId],
      NOTIF_EVENTS.PIPELINE_ACCESS_CHANGED,
      'Workflow access revoked',
      `Your access to "${workflowName}" was revoked.`,
      'WORKFLOW',
      workflowId,
      {
        titleKey: 'events.pipelineAccessRevoked.title',
        messageKey: 'events.pipelineAccessRevoked.body',
        params: { workflowName },
      },
    ).catch(e => this.logger.error('Pipeline access-revoked notification error:', e));

    return { message: 'Access revoked' };
  }

  // ─── Stages ───────────────────────────────────────────────────────────────

  async addStage(workflowId: string, dto: CreateWorkflowStageDto, actorId?: string) {
    await this.findMutableWorkflowOrFail(workflowId); // @tenant-reviewed: phase263-workflow-stage-scope (stage add requires mutable parent)

    // Auto-assign order if not provided
    if (dto.order == null) {
      const last = await this.prisma.workflowStage.findFirst({ where: { workflowId }, orderBy: { order: 'desc' } });
      dto.order = last ? last.order + 1 : 1;
    }

    // Check for order conflict and shift if needed
    const conflict = await this.prisma.workflowStage.findFirst({ where: { workflowId, order: dto.order } });
    if (conflict) {
      await this.prisma.$executeRaw`
        UPDATE "workflow_stages"
        SET "order" = "order" + 1
        WHERE "workflowId" = ${workflowId} AND "order" >= ${dto.order}
      `;
    }

    const {
      assignedUserIds, approverUserIds, responsibleUserIds,
      requiredDocTypeIds, minApprovals, approvalMode, ...stageData
    } = dto as any;
    const effectiveApprovers   = approverUserIds   ?? assignedUserIds ?? [];
    const effectiveResponsible = responsibleUserIds ?? [];
    const clampedMin = Math.max(
      1,
      Math.min(Number(minApprovals ?? 1) || 1, Math.max(effectiveApprovers.length, 1)),
    );
    // Whitelist the approval mode — more modes can be added later.
    const normalizedMode = ['ANY', 'ALL'].includes(String(approvalMode ?? 'ANY').toUpperCase())
      ? String(approvalMode ?? 'ANY').toUpperCase()
      : 'ANY';
    const stageUsers = [
      ...effectiveApprovers.map((userId: string) => ({ userId, role: 'APPROVER' })),
      ...effectiveResponsible
        .filter((userId: string) => !effectiveApprovers.includes(userId))
        .map((userId: string) => ({ userId, role: 'RESPONSIBLE' })),
    ];
    const stage = await this.prisma.workflowStage.create({
      data: {
        ...stageData,
        workflowId,
        minApprovals: clampedMin,
        approvalMode: normalizedMode,
        assignedUsers: stageUsers.length ? { create: stageUsers } : undefined,
        requiredDocs: requiredDocTypeIds?.length
          ? { create: requiredDocTypeIds.map((documentTypeId: string) => ({ documentTypeId })) }
          : undefined,
      } as any,
      include: WORKFLOW_STAGE_INCLUDE,
    });
    if (actorId) {
      await this.auditLog(actorId, 'CREATE', 'WorkflowStage', stage.id, { workflowId }); // @tenant-reviewed: phase262-pipeline-audit-log-pilot
    }
    return stage;
  }

  async updateStage(stageId: string, dto: Partial<CreateWorkflowStageDto>, actorId?: string) {
    const stage = await this.prisma.workflowStage.findUnique({ where: { id: stageId } });
    if (!stage) throw new NotFoundException({ code: 'WORKFLOW.STAGE_NOT_FOUND', message: 'Stage not found' });
    await this.findMutableWorkflowOrFail(stage.workflowId); // @tenant-reviewed: phase263-workflow-stage-scope (stage derives tenant via parent workflow)

    const {
      assignedUserIds, approverUserIds, responsibleUserIds,
      requiredDocTypeIds, minApprovals, approvalMode, ...stageData
    } = dto as any;

    const updatePayload: any = { ...stageData };
    if (approvalMode !== undefined) {
      const normalized = String(approvalMode).toUpperCase();
      updatePayload.approvalMode = ['ANY', 'ALL'].includes(normalized) ? normalized : 'ANY';
    }

    const anyUserListProvided =
      assignedUserIds !== undefined ||
      approverUserIds !== undefined ||
      responsibleUserIds !== undefined;
    let effectiveApproversCount: number | null = null;
    if (anyUserListProvided) {
      const effectiveApprovers   = approverUserIds   ?? assignedUserIds ?? [];
      const effectiveResponsible = responsibleUserIds ?? [];
      effectiveApproversCount = effectiveApprovers.length;
      await this.prisma.workflowStageUser.deleteMany({ where: { stageId } });
      const rows = [
        ...effectiveApprovers.map((userId: string) => ({ stageId, userId, role: 'APPROVER' })),
        ...effectiveResponsible
          .filter((userId: string) => !effectiveApprovers.includes(userId))
          .map((userId: string) => ({ stageId, userId, role: 'RESPONSIBLE' })),
      ];
      if (rows.length) {
        await this.prisma.workflowStageUser.createMany({ data: rows, skipDuplicates: true });
      }
    }

    // Clamp minApprovals to [1, approvers.length] so the UI can't
    // ask for a value that can never be satisfied. If the caller
    // didn't send an approver list, use the current live count.
    if (minApprovals !== undefined) {
      if (effectiveApproversCount == null) {
        effectiveApproversCount = await this.prisma.workflowStageUser.count({
          where: { stageId, role: { in: ['APPROVER', 'REVIEWER'] } },
        });
      }
      const ceiling = Math.max(effectiveApproversCount, 1);
      updatePayload.minApprovals = Math.max(1, Math.min(Number(minApprovals) || 1, ceiling));
    } else if (anyUserListProvided && effectiveApproversCount != null) {
      // No minApprovals provided but the approver list changed —
      // make sure the existing value still fits.
      const current = await this.prisma.workflowStage.findUnique({
        where: { id: stageId }, select: { minApprovals: true },
      });
      if (current && current.minApprovals > Math.max(effectiveApproversCount, 1)) {
        updatePayload.minApprovals = Math.max(effectiveApproversCount, 1);
      }
    }

    // Replace required docs if provided
    if (requiredDocTypeIds !== undefined) {
      await this.prisma.workflowStageRequiredDoc.deleteMany({ where: { stageId } });
      if (requiredDocTypeIds.length) {
        await this.prisma.workflowStageRequiredDoc.createMany({
          data: requiredDocTypeIds.map((documentTypeId) => ({ stageId, documentTypeId })),
          skipDuplicates: true,
        });
      }
    }

    return this.prisma.workflowStage.update({
      where: { id: stageId },
      data: updatePayload,
      include: WORKFLOW_STAGE_INCLUDE,
    });
  }

  async deleteStage(stageId: string, actorId?: string) {
    const stage = await this.prisma.workflowStage.findUnique({ where: { id: stageId } });
    if (!stage) throw new NotFoundException({ code: 'WORKFLOW.STAGE_NOT_FOUND', message: 'Stage not found' });
    await this.findMutableWorkflowOrFail(stage.workflowId); // @tenant-reviewed: phase263-workflow-stage-scope (stage derives tenant via parent workflow)
    await this.prisma.workflowStage.delete({ where: { id: stageId } });
    return { message: 'Stage deleted' };
  }

  async reorderStages(workflowId: string, orderedIds: string[]) {
    await this.findMutableWorkflowOrFail(workflowId); // @tenant-reviewed: phase263-workflow-stage-scope (reorder requires mutable parent)
    // Use a transaction with sequential updates to avoid intermediate unique-constraint
    // violations on (workflowId, order). First shift all orders to a safe negative
    // range, then assign the final values sequentially.
    await this.prisma.$transaction(async (tx) => {
      // Step 1: move all to temporary negative values to vacate the constraint space
      for (let i = 0; i < orderedIds.length; i++) {
        await tx.workflowStage.update({ where: { id: orderedIds[i] }, data: { order: -(i + 1) } });
      }
      // Step 2: assign final positive order values
      for (let i = 0; i < orderedIds.length; i++) {
        await tx.workflowStage.update({ where: { id: orderedIds[i] }, data: { order: i + 1 } });
      }
    });
    return this.getWorkflow(workflowId);
  }

  // ─── Assignments ──────────────────────────────────────────────────────────

  async assignCandidate(
    dto: AssignCandidateToWorkflowDto,
    actorId?: string,
    actor?: { role?: string },
  ) {
    // Phase 2.62 — candidate parent gate (tenant predicate when pilot active).
    const [candidate, workflow] = await Promise.all([
      this.findCandidateForPipelineMutationOrFail(dto.candidateId), // @tenant-reviewed: phase262-pipeline-mutation-pilot
      this.getWorkflow(dto.workflowId),
    ]);

    // Business rule: a candidate is on exactly ONE active workflow at
    // any time. Reassignment to a different workflow is an
    // admin-only privilege.
    const activeAssignments = await this.prisma.candidateWorkflowAssignment.findMany({
      where: { candidateId: dto.candidateId, status: 'ACTIVE' },
      include: { workflow: { select: { id: true, name: true } } },
    });

    const existingOnSame = activeAssignments.find(a => a.workflowId === dto.workflowId);
    if (existingOnSame) {
      throw new ConflictException({ code: 'WORKFLOW.ALREADY_ASSIGNED', message: 'Candidate already has an active assignment in this workflow' });
    }

    const existingOnOther = activeAssignments.find(a => a.workflowId !== dto.workflowId);
    if (existingOnOther) {
      const isAdmin = actor?.role === 'System Admin';
      if (!isAdmin) {
        throw new ForbiddenException({
          code: 'WORKFLOW.REASSIGN_REQUIRES_ADMIN',
          message: `Candidate is already assigned to "${existingOnOther.workflow?.name ?? 'another workflow'}". ` +
            'Only a System Admin can reassign a candidate to a different workflow.',
          params: { workflowName: existingOnOther.workflow?.name ?? 'another workflow' },
        });
      }
      // Admin reassignment: withdraw the prior assignment (preserves
      // its stage-progress history) before creating the new one.
      await this.prisma.candidateWorkflowAssignment.update({
        where: { id: existingOnOther.id },
        data: { status: 'WITHDRAWN' as any, completedAt: new Date() },
      });
      await this.auditLog(actorId, 'WORKFLOW_REASSIGNED', 'CandidateWorkflowAssignment', existingOnOther.id, { // @tenant-reviewed: phase262-pipeline-audit-log-pilot
        candidateId: dto.candidateId,
        fromWorkflowId: existingOnOther.workflowId,
        toWorkflowId: dto.workflowId,
        reason: dto.notes ?? null,
      });
    }

    // Resolve Stage 1 — always the lowest-order active stage in the
    // workflow, independent of how the `stages` relation happens to
    // be ordered by Prisma's include. Per product spec: on assignment
    // the candidate is placed at Stage 1 with status IN_PROGRESS.
    const activeStages = ((workflow as any).stages ?? [])
      .filter((s: any) => s.isActive !== false)
      .slice()
      .sort((a: any, b: any) => (a.order ?? 0) - (b.order ?? 0));
    const firstStage = activeStages[0];

    const assignment = await this.prisma.candidateWorkflowAssignment.create({ // @tenant-reviewed: phase262-pipeline-mutation-pilot (tenantData stamping when pilot active)
      data: {
        candidateId: dto.candidateId,
        workflowId: dto.workflowId,
        assignedById: actorId,
        notes: dto.notes,
        ...this.scope().tenantData(),
        stageProgress: firstStage
          ? {
              create: {
                stageId: firstStage.id,
                // IN_PROGRESS — the candidate is now working through
                // Stage 1. Flips to COMPLETED when the stage is
                // approved / advanced.
                status: 'IN_PROGRESS' as any,
                slaDeadline: firstStage.slaHours
                  ? new Date(Date.now() + firstStage.slaHours * 3600 * 1000)
                  : undefined,
              },
            }
          : undefined,
      },
      include: {
        candidate: { select: { id: true, firstName: true, lastName: true, email: true, candidateNumber: true } },
        workflow: { select: { id: true, name: true } },
        stageProgress: { include: { stage: true } },
      },
    });

    if (actorId) {
      await this.auditLog(actorId, 'ASSIGN', 'CandidateWorkflowAssignment', assignment.id, { candidateId: dto.candidateId, workflowId: dto.workflowId }); // @tenant-reviewed: phase262-pipeline-audit-log-pilot
    }

    // Spec §4.11 — Pipeline: the candidate just entered the first
    // stage. Notify the people responsible for that stage; if the
    // stage requires sign-off we also flag the approvers separately.
    if (firstStage) {
      const candidateName = `${(assignment as any).candidate?.firstName ?? ''} ${(assignment as any).candidate?.lastName ?? ''}`.trim();
      const responsibles = await this.stageAssigneeIds(firstStage.id, ['RESPONSIBLE']);
      this.notifications?.notifyUsers(
        responsibles,
        NOTIF_EVENTS.PIPELINE_STAGE_ENTERED,
        'Candidate entered your stage',
        `${candidateName || 'A candidate'} is now in "${firstStage.name}".`,
        'APPLICANT',
        dto.candidateId,
        {
          titleKey: 'events.pipelineStageEntered.title',
          messageKey: 'events.pipelineStageEntered.body',
          params: { candidateName, stageName: firstStage.name },
        },
      ).catch(e => this.logger.error('Pipeline stage-entered notification error:', e));

      if ((firstStage as any).requiresApproval) {
        const approvers = await this.stageAssigneeIds(firstStage.id, ['APPROVER', 'REVIEWER']);
        this.notifications?.notifyUsers(
          approvers,
          NOTIF_EVENTS.PIPELINE_AWAITING_APPROVAL,
          'Candidate awaiting your approval',
          `${candidateName || 'A candidate'} is waiting for approval at "${firstStage.name}".`,
          'APPLICANT',
          dto.candidateId,
          {
            titleKey: 'events.pipelineAwaitingApproval.title',
            messageKey: 'events.pipelineAwaitingApproval.body',
            params: { candidateName, stageName: firstStage.name },
          },
        ).catch(e => this.logger.error('Pipeline awaiting-approval notification error:', e));
      }
    }

    return assignment;
  }

  /**
   * Phase 2B (#41) — candidates that have NO active
   * CandidateWorkflowAssignment, scoped to the caller's tenant. Used by
   * the "Assign Candidate" searchable picker so the user can no longer
   * paste a stale id. Returns up to 50 rows with the fields the picker
   * surfaces (name, candidate id, email, phone).
   */
  async listUnassignedCandidates(search: string | undefined, caller: any, workflowId?: string) {
    const t = this.scope().tenantWhere();
    // When a workflowId is supplied the picker is opened in the context of
    // a specific workflow; the right candidate pool is the WORKFLOW'S
    // tenant, not the caller's session tenant. Otherwise we fall back to
    // the caller's active tenant. Without this, a SUPER on Tenant A
    // assigning candidates to a workflow that belongs to Tenant B saw
    // zero results — Tenant B's candidates were filtered out.
    let scopedTenantId: string | null = null;
    if (workflowId) {
      const wf = await this.prisma.workflow.findUnique({
        where: { id: workflowId },
        select: { tenantId: true } as any,
      });
      scopedTenantId = (wf as any)?.tenantId ?? null;
    }
    // SUPER admins AND System Admin role users see every unassigned
    // candidate — the picker is cross-tenant for them. (PlatformAdmin
    // SUPER and the System Admin role are both expected to operate
    // across tenants; relying on agencyIsSystem alone missed System
    // Admin role users who weren't also stamped as platform admins.)
    // Non-admins stay tenant-locked.
    const isSuper = caller?.agencyIsSystem === true || caller?.role === 'System Admin';
    let tenantClause: any = {};
    if (!isSuper) {
      const effectiveTenantId = scopedTenantId ?? caller?.tenantId ?? null;
      if (effectiveTenantId) {
        tenantClause = {
          OR: [
            { tenantId: effectiveTenantId },
            { tenantId: null, agency: { tenantId: effectiveTenantId } },
          ],
        };
      }
    }
    const where: any = {
      tier: 'CANDIDATE',
      deletedAt: null,
      ...t,
      ...tenantClause,
      // Anti-join: only candidates with no ACTIVE workflow assignment.
      workflowAssignments: { none: { status: 'ACTIVE' as any } },
    };
    if (search && search.trim()) {
      const q = search.trim();
      where.OR = [
        { firstName: { contains: q, mode: 'insensitive' } },
        { lastName: { contains: q, mode: 'insensitive' } },
        { email: { contains: q, mode: 'insensitive' } },
        { candidateNumber: { contains: q, mode: 'insensitive' } },
        { leadNumber: { contains: q, mode: 'insensitive' } },
      ];
    }
    const rows = await this.prisma.applicant.findMany({ // @tenant-reviewed: phase2b-pipeline-picker
      where, take: 50,
      orderBy: [{ candidateNumber: 'desc' }, { createdAt: 'desc' }],
      select: {
        id: true, firstName: true, lastName: true,
        email: true, phone: true, candidateNumber: true, leadNumber: true,
      },
    });
    return rows;
  }

  /**
   * Assign a workflow to many candidates in one call. Each candidate
   * goes through the single-assignment path, so the one-active-
   * workflow-per-candidate rule + the admin-only reassignment check
   * are reused without duplication. Per-candidate outcomes are
   * returned so the UI can show a meaningful summary.
   */
  async assignCandidatesBulk(
    dto: { candidateIds: string[]; workflowId: string; notes?: string },
    actorId?: string,
    actor?: { role?: string },
  ) {
    if (!Array.isArray(dto.candidateIds) || dto.candidateIds.length === 0) {
      throw new BadRequestException({ code: 'WORKFLOW.CANDIDATE_IDS_REQUIRED', message: 'candidateIds is required and must be non-empty' });
    }
    if (dto.candidateIds.length > 500) {
      throw new BadRequestException({ code: 'WORKFLOW.BULK_LIMIT_EXCEEDED', message: 'Refusing to process more than 500 candidates in a single bulk assign', params: { limit: 500 } });
    }
    // Pre-resolve the workflow once so every iteration doesn't re-
    // query the same row. The per-candidate path revalidates too, so
    // this is purely a perf short-circuit.
    await this.getWorkflow(dto.workflowId);

    const results: Array<{
      candidateId: string;
      outcome: 'assigned' | 'reassigned' | 'skipped_same_workflow' | 'forbidden' | 'error';
      assignmentId?: string;
      error?: string;
    }> = [];

    for (const candidateId of [...new Set(dto.candidateIds)]) {
      try {
        const assignment = await this.assignCandidate(
          { candidateId, workflowId: dto.workflowId, notes: dto.notes } as any,
          actorId,
          actor,
        );
        // assignCandidate withdraws the prior row when an admin
        // reassigns — detect that by checking whether a WITHDRAWN
        // row on the same candidate exists with a recent timestamp.
        const hadPrior = await this.prisma.candidateWorkflowAssignment.count({
          where: {
            candidateId,
            status: 'WITHDRAWN' as any,
            completedAt: { gte: new Date(Date.now() - 30 * 1000) },
          },
        });
        results.push({
          candidateId,
          outcome: hadPrior > 0 ? 'reassigned' : 'assigned',
          assignmentId: (assignment as any).id,
        });
      } catch (err: any) {
        // Map the single-assign failure modes onto a stable outcome
        // vocabulary the frontend can render.
        const msg = err?.message ?? 'Unknown error';
        if (err?.status === 409) {
          results.push({ candidateId, outcome: 'skipped_same_workflow', error: msg });
        } else if (err?.status === 403) {
          results.push({ candidateId, outcome: 'forbidden', error: msg });
        } else {
          results.push({ candidateId, outcome: 'error', error: msg });
        }
      }
    }

    const summary = {
      requested: dto.candidateIds.length,
      assigned:              results.filter(r => r.outcome === 'assigned').length,
      reassigned:            results.filter(r => r.outcome === 'reassigned').length,
      skipped_same_workflow: results.filter(r => r.outcome === 'skipped_same_workflow').length,
      forbidden:             results.filter(r => r.outcome === 'forbidden').length,
      errors:                results.filter(r => r.outcome === 'error').length,
    };

    if (actorId) {
      await this.auditLog(actorId, 'WORKFLOW_BULK_ASSIGN', 'Workflow', dto.workflowId, { ...summary, candidateIds: dto.candidateIds }); // @tenant-reviewed: phase262-pipeline-audit-log-pilot
    }

    // Spec §4.11 — SYSTEM_BULK_JOB_RESULT auto-emit at the tail of a
    // bulk assignment so admins see the rollup without polling.
    // Tenant scope is the active ALS frame when available (workflow
    // assignments live in a tenant); undefined falls back to a
    // platform-wide broadcast which the role gates further down.
    const tid = this.scope().tenantId ?? undefined;
    const ok = (summary.errors ?? 0) === 0 && (summary.forbidden ?? 0) === 0;
    this.notifications?.notifyAllUsers(
      tid,
      NOTIF_EVENTS.SYSTEM_BULK_JOB_RESULT,
      ok ? 'Bulk candidate assignment completed' : 'Bulk candidate assignment finished with errors',
      `${summary.assigned ?? 0} assigned, ${summary.skipped_same_workflow ?? 0} skipped (same workflow), ${summary.forbidden ?? 0} forbidden, ${summary.errors ?? 0} errors.`,
      'WORKFLOW',
      dto.workflowId,
      {
        titleKey: 'events.systemBulkJobResult.title',
        messageKey: 'events.systemBulkJobResult.body',
        params: { jobId: `bulk-assign:${dto.workflowId}`, success: ok, ...summary },
      },
      ok ? 'NORMAL' : 'HIGH',
    ).catch(() => undefined);

    return { summary, results };
  }

  async getCandidateAssignments(candidateId: string) {
    return this.prisma.candidateWorkflowAssignment.findMany({
      where: { candidateId },
      include: {
        workflow: {
          select: {
            id: true, name: true, color: true,
            stages: {
              where: { isActive: true },
              orderBy: { order: 'asc' },
              include: {
                requiredDocs: { include: { documentType: { select: { id: true, name: true, category: true } } } },
                assignedUsers: { include: { user: { select: { id: true, firstName: true, lastName: true } } } },
              },
            },
          },
        },
        stageProgress: {
          orderBy: { enteredAt: 'asc' },
          include: {
            stage: true,
            approvals: {
              orderBy: { createdAt: 'desc' },
              take: 1,
              include: { approvedBy: { select: { id: true, firstName: true, lastName: true } } },
            },
            notes: { where: { deletedAt: null }, orderBy: { createdAt: 'desc' } },
          },
        },
        assignedBy: { select: { id: true, firstName: true, lastName: true } },
      },
      orderBy: { assignedAt: 'desc' },
    });
  }

  async removeCandidateAssignment(candidateId: string, assignmentId: string) {
    const assignment = await this.prisma.candidateWorkflowAssignment.findFirst({
      where: { id: assignmentId, candidateId },
    });
    if (!assignment) throw new NotFoundException({ code: 'WORKFLOW.ASSIGNMENT_NOT_FOUND', message: 'Assignment not found' });
    await this.prisma.candidateWorkflowAssignment.delete({ where: { id: assignmentId } });
    return { success: true };
  }

  // ─── Employee Assignments ─────────────────────────────────────────────────

  async assignEmployee(_dto: AssignEmployeeToWorkflowDto, _actorId?: string) {
    // Workflows are candidate-only per product spec — the recruitment
    // pipeline ends when the candidate is converted to an employee.
    // Return a 400 so any legacy caller / stale UI surfaces the
    // reason plainly instead of silently 500-ing. Historical
    // EmployeeWorkflowAssignment rows are still readable via the
    // getEmployee* endpoints so operators can clean up.
    throw new BadRequestException({
      code: 'WORKFLOW.EMPLOYEE_ASSIGN_FORBIDDEN',
      message: 'Workflows can only be assigned to candidates. Assign this person while still on the Candidates list.',
    });
    // The body below is kept commented-out for clarity of the old
    // behaviour — do not re-enable without a product decision.
    /*
    const [employee] = await Promise.all([
      this.prisma.employee.findFirst({ where: { id: dto.employeeId, deletedAt: null } }),
      this.getWorkflow(dto.workflowId),
    ]);
    if (!employee) throw new NotFoundException({ code: 'EMPLOYEE.NOT_FOUND', message: 'Employee not found' });

    // Delete any existing assignment (one-per-employee rule)
    await this.prisma.employeeWorkflowAssignment.deleteMany({ where: { employeeId: dto.employeeId } });

    const assignment = await this.prisma.employeeWorkflowAssignment.create({
      data: {
        employeeId: dto.employeeId,
        workflowId: dto.workflowId,
        assignedById: actorId,
        notes: dto.notes,
      },
      include: {
        employee: { select: { id: true, firstName: true, lastName: true, email: true, employeeNumber: true } },
        workflow: { include: { stages: { orderBy: { order: 'asc' } } } },
        currentStage: true,
        assignedBy: { select: { id: true, firstName: true, lastName: true } },
      },
    });

    if (actorId) {
      await this.prisma.auditLog.create({
        data: {
          userId: actorId,
          action: 'ASSIGN',
          entity: 'EmployeeWorkflowAssignment',
          entityId: assignment.id,
          changes: { employeeId: dto.employeeId, workflowId: dto.workflowId } as any,
        },
      });
    }
    return assignment;
    */
  }

  async getEmployeeWorkflows(employeeId: string) {
    const [assignment, approvals] = await Promise.all([
      this.prisma.employeeWorkflowAssignment.findFirst({
        where: { employeeId },
        include: {
          workflow: {
            include: {
              stages: {
                orderBy: { order: 'asc' },
                include: {
                  requiredDocs: { include: { documentType: { select: { id: true, name: true, category: true } } } },
                  assignedUsers: { include: { user: { select: { id: true, firstName: true, lastName: true, email: true } } } },
                },
              },
            },
          },
          currentStage: true,
          assignedBy: { select: { id: true, firstName: true, lastName: true } },
        },
      }),
      this.prisma.employeeStageApproval.findMany({
        where: { employeeId },
        include: { approvedBy: { select: { id: true, firstName: true, lastName: true } } },
      }),
    ]);

    if (!assignment) return null;
    return { ...assignment, stageApprovals: approvals };
  }

  async approveEmployeeStage(employeeId: string, stageId: string, actorId: string, notes?: string) {
    const assignment = await this.prisma.employeeWorkflowAssignment.findUnique({ where: { employeeId } });
    if (!assignment) throw new NotFoundException({ code: 'WORKFLOW.ASSIGNMENT_NOT_FOUND', message: 'No workflow assignment found for this employee' });

    const stage = await this.prisma.workflowStage.findFirst({
      where: { id: stageId, workflowId: assignment.workflowId },
      include: { assignedUsers: true },
    });
    if (!stage) throw new NotFoundException({ code: 'WORKFLOW.STAGE_NOT_IN_WORKFLOW', message: 'Stage not found in this employee\'s workflow' });

    const approval = await this.prisma.employeeStageApproval.upsert({
      where: { employeeId_stageId: { employeeId, stageId } },
      create: { id: require('crypto').randomUUID(), employeeId, stageId, approvedById: actorId, notes },
      update: { approvedById: actorId, approvedAt: new Date(), notes },
      include: { approvedBy: { select: { id: true, firstName: true, lastName: true } } },
    });

    return approval;
  }

  async setEmployeeCurrentStage(_employeeId: string, _stageId: string, _actorId?: string) {
    // Workflows are candidate-only — advancing an employee through a
    // pipeline stage no longer makes sense. Reads / deletes still
    // work on legacy rows.
    throw new BadRequestException({
      code: 'WORKFLOW.EMPLOYEE_MODIFY_FORBIDDEN',
      message: 'Workflows can only be modified on candidates. Employees no longer move through workflow stages.',
    });
    /* Legacy body preserved for reference:
    const assignment = await this.prisma.employeeWorkflowAssignment.findUnique({
      where: { employeeId },
    });
    if (!assignment) throw new NotFoundException({ code: 'WORKFLOW.ASSIGNMENT_NOT_FOUND', message: 'No workflow assignment found for this employee' });

    const stage = await this.prisma.workflowStage.findFirst({
      where: { id: stageId, workflowId: assignment.workflowId },
    });
    if (!stage) throw new NotFoundException({ code: 'WORKFLOW.STAGE_NOT_IN_WORKFLOW', message: 'Stage does not belong to this employee\'s workflow' });

    const [updated, approvals] = await Promise.all([
      this.prisma.employeeWorkflowAssignment.update({
        where: { employeeId },
        data: { currentStageId: stageId },
        include: {
          workflow: {
            include: {
              stages: {
                orderBy: { order: 'asc' },
                include: {
                  requiredDocs: { include: { documentType: { select: { id: true, name: true, category: true } } } },
                  assignedUsers: { include: { user: { select: { id: true, firstName: true, lastName: true, email: true } } } },
                },
              },
            },
          },
          currentStage: true,
          assignedBy: { select: { id: true, firstName: true, lastName: true } },
        },
      }),
      this.prisma.employeeStageApproval.findMany({
        where: { employeeId },
        include: { approvedBy: { select: { id: true, firstName: true, lastName: true } } },
      }),
    ]);
    return { ...updated, stageApprovals: approvals };
    */
  }

  async removeEmployeeWorkflow(employeeId: string, workflowId: string, actorId?: string) {
    const assignment = await this.prisma.employeeWorkflowAssignment.findFirst({
      where: { employeeId, workflowId },
    });
    if (!assignment) throw new NotFoundException({ code: 'WORKFLOW.ASSIGNMENT_NOT_FOUND', message: 'Assignment not found' });
    await this.prisma.employeeWorkflowAssignment.delete({ where: { id: assignment.id } });
    if (actorId) {
      await this.auditLog(actorId, 'DELETE', 'EmployeeWorkflowAssignment', assignment.id); // @tenant-reviewed: phase262-pipeline-audit-log-pilot
    }
    return { message: 'Employee removed from workflow' };
  }

  async getWorkflowCandidates(workflowId: string) {
    await this.getWorkflow(workflowId);
    return this.prisma.candidateWorkflowAssignment.findMany({ // @tenant-reviewed: phase261-pipeline-pilot-scope (assignment-keyed; CandidateWorkflowAssignment.tenantId)
      where: { workflowId, status: 'ACTIVE', ...this.scope().tenantWhere() },
      include: {
        candidate: { select: { id: true, firstName: true, lastName: true, email: true, phone: true, candidateNumber: true, photoUrl: true, nationality: true, status: true } },
        stageProgress: {
          // ACTIVE and IN_PROGRESS both indicate "currently on this stage".
          where: { status: { in: ['ACTIVE', 'IN_PROGRESS'] as any } },
          include: { stage: { select: { id: true, name: true, color: true, order: true } } },
        },
      },
      orderBy: { assignedAt: 'desc' },
    });
  }

  async getWorkflowBoardView(workflowId: string) {
    const workflow = await this.getWorkflow(workflowId);
    const stages = ((workflow as any).stages as any[]).filter((s: any) => s.isActive !== false);

    // Fetch ALL employee assignments for this workflow once, group by currentStageId in JS
    // (avoid enum/text cast issue by not filtering status in Prisma)
    const tenantWhere = this.scope().tenantWhere();
    const allEmpAssignments = await this.prisma.employeeWorkflowAssignment.findMany({ // @tenant-reviewed: phase261-pipeline-pilot-scope
      where: { workflowId, ...tenantWhere },
      select: { currentStageId: true, status: true },
    });
    const empCountByStage = allEmpAssignments
      .filter(ea => ea.status === 'ACTIVE' && ea.currentStageId)
      .reduce<Record<string, number>>((acc, ea) => {
        acc[ea.currentStageId!] = (acc[ea.currentStageId!] ?? 0) + 1;
        return acc;
      }, {});

    const columns = await Promise.all(
      stages.map(async (stage: any) => {
        const progressItems = await this.prisma.candidateStageProgress.findMany({ // @tenant-reviewed: phase261-pipeline-pilot-scope (scope via parent assignment.tenantId)
          // Phase 2 (#39) — assignCandidate stamps IN_PROGRESS on the
          // first stage; this filter was ACTIVE-only and hid every newly
          // assigned candidate from the board. Both values mean "the
          // candidate is currently at this stage", matching line 1138.
          where: { stageId: stage.id, status: { in: ['ACTIVE', 'IN_PROGRESS'] as any }, assignment: { workflowId, ...tenantWhere } },
          include: {
            assignment: {
              include: {
                candidate: { select: { id: true, firstName: true, lastName: true, email: true, candidateNumber: true, photoUrl: true, nationality: true } },
              },
            },
            approvals: { orderBy: { createdAt: 'desc' }, take: 1 },
            notes: { where: { deletedAt: null, isPrivate: false }, orderBy: { createdAt: 'desc' }, take: 3 },
          },
          orderBy: { enteredAt: 'asc' },
        });

        const empCount = empCountByStage[stage.id] ?? 0;

        return {
          stage,
          // Skip orphaned progress rows whose parent assignment has gone
          // missing (cascade delete should prevent this, but historical
          // data and direct DB edits can leave them behind). Without the
          // guard the .map dereferences null and crashes the endpoint.
          candidates: progressItems
            .filter((p: any) => p.assignment)
            .map((p) => ({
              progressId: p.id,
              assignmentId: p.assignmentId,
              status: p.status,
              enteredAt: p.enteredAt,
              slaDeadline: p.slaDeadline,
              flagged: p.flagged,
              flagReason: p.flagReason,
              latestApproval: (p.approvals as any[])[0] ?? null,
              recentNotes: p.notes,
              candidate: (p.assignment as any)?.candidate ?? null,
          })),
          // count = active candidates + active employees in this stage
          count: progressItems.length + empCount,
        };
      }),
    );

    return { workflow, columns };
  }

  // ─── Stage Progress ───────────────────────────────────────────────────────

  async advanceToStage(assignmentId: string, stageId: string, actorId?: string) {
    // Phase 2.62 — parent gate: cross-tenant assignment ids raise NotFound BEFORE any write.
    await this.findCandidateAssignmentForMutationOrFail(assignmentId); // @tenant-reviewed: phase262-pipeline-transition-pilot
    const assignment = await this.prisma.candidateWorkflowAssignment.findUnique({
      where: { id: assignmentId },
      include: {
        workflow: {
          include: {
            stages: {
              orderBy: { order: 'asc' },
              include: { assignedUsers: true },
            },
          },
        },
        stageProgress: { include: { stage: { include: { assignedUsers: true } }, approvals: true } },
      },
    });
    if (!assignment) throw new NotFoundException({ code: 'WORKFLOW.ASSIGNMENT_NOT_FOUND', message: 'Assignment not found' });

    const stage = (assignment.workflow as any).stages.find((s: any) => s.id === stageId);
    if (!stage) throw new BadRequestException({ code: 'WORKFLOW.STAGE_NOT_IN_WORKFLOW', message: 'Stage does not belong to this workflow' });

    // Guard the CURRENT (source) stage's approval + responsibility
    // rules before allowing advance. The candidate is advanced FROM
    // the most recent IN_PROGRESS / ACTIVE stage TO the requested
    // target stage.
    const sourceProgress = (assignment as any).stageProgress.find(
      (p: any) => p.status === 'IN_PROGRESS' || p.status === 'ACTIVE',
    );
    if (sourceProgress) {
      const srcStage = sourceProgress.stage;
      const srcApprovers   = (srcStage.assignedUsers ?? []).filter((u: any) => u.role === 'APPROVER' || u.role === 'REVIEWER');
      const srcResponsible = (srcStage.assignedUsers ?? []).filter((u: any) => u.role === 'RESPONSIBLE');

      // Rule 1 — approval gate.
      //   Empty approver list = "None" → Responsible users advance
      //     the candidate freely.
      //   approvalMode = "ALL"  → every listed approver must
      //     individually approve.
      //   approvalMode = "ANY"  (default) → at least `minApprovals`
      //     distinct listed approvers must approve.
      if (srcApprovers.length > 0) {
        const approverIds = new Set(srcApprovers.map((u: any) => u.userId));
        const approvedBy = new Set(
          (sourceProgress.approvals ?? [])
            .filter((a: any) =>
              a.decision === 'APPROVED' &&
              a.approvedById &&
              approverIds.has(a.approvedById),
            )
            .map((a: any) => a.approvedById),
        );
        const mode = String(srcStage.approvalMode ?? 'ANY').toUpperCase();
        const required = mode === 'ALL'
          ? srcApprovers.length
          : Math.max(1, Math.min(Number(srcStage.minApprovals ?? 1) || 1, srcApprovers.length));
        if (approvedBy.size < required) {
          throw new ForbiddenException({
            code: 'WORKFLOW.APPROVAL_PENDING',
            message:
              `Stage "${srcStage.name}" is awaiting approval. ` +
              `${approvedBy.size} of ${required} required approver(s) have approved` +
              (mode === 'ALL' ? ' (mode: All approvers).' : '.'),
            params: { stageName: srcStage.name, approved: approvedBy.size, required, mode },
          });
        }
      }

      // Rule 2 — responsibility gate. When the stage is not set to
      // "Any" and no approvers are assigned, only the RESPONSIBLE
      // users can advance. When approvers exist the responsibility
      // gate is skipped (Rule 1 already covered it).
      const hasApprovers = srcApprovers.length > 0 && srcStage.requiresApproval;
      if (!hasApprovers && !srcStage.responsibleAny && srcResponsible.length > 0) {
        const allowed = new Set(srcResponsible.map((u: any) => u.userId));
        if (!actorId || !allowed.has(actorId)) {
          throw new ForbiddenException({
            code: 'WORKFLOW.RESPONSIBLE_ONLY',
            message: `Only the responsible users assigned to "${srcStage.name}" may advance the candidate.`,
            params: { stageName: srcStage.name },
          });
        }
      }

      // Close out the source stage so the per-stage history reads
      // cleanly: source → COMPLETED, then target → IN_PROGRESS below.
      await this.prisma.candidateStageProgress.update({
        where: { id: sourceProgress.id },
        data: { status: 'COMPLETED' as any, completedAt: new Date() },
      });
    }

    const existing = await this.prisma.candidateStageProgress.findFirst({
      where: { assignmentId, stageId, status: { in: ['ACTIVE', 'IN_PROGRESS'] as any } },
    });
    if (existing) throw new ConflictException({ code: 'WORKFLOW.ALREADY_AT_STAGE', message: 'Candidate is already active in this stage' });

    const slaDeadline = stage.slaHours ? new Date(Date.now() + stage.slaHours * 3600 * 1000) : null;

    const progress = await this.prisma.candidateStageProgress.create({
      data: {
        assignmentId,
        stageId,
        // IN_PROGRESS once the candidate enters the new stage —
        // aligns with the initial-assignment semantics.
        status: 'IN_PROGRESS' as any,
        slaDeadline: slaDeadline ?? undefined,
        ...(stage.requiresApproval ? { approvals: { create: { decision: 'PENDING' } } } : {}),
      },
      include: { stage: true, approvals: true },
    });

    if (actorId) {
      await this.auditLog(actorId, 'STAGE_ADVANCE', 'CandidateStageProgress', progress.id, { stageId, stageN: stage.name }); // @tenant-reviewed: phase262-pipeline-audit-log-pilot
    }

    // Spec §4.11 — Pipeline: a candidate moved between two stages.
    // Two audiences emit in parallel:
    //   - target stage RESPONSIBLEs → STAGE_ENTERED (their queue grew)
    //   - source stage RESPONSIBLEs → STAGE_ADVANCED (their candidate
    //     moved on, FYI)
    // If the target requires approval, target APPROVERs also receive
    // AWAITING_APPROVAL.
    const candidateId = (assignment as any).candidateId as string;
    const candidateRow = await this.prisma.applicant.findUnique({
      where: { id: candidateId },
      select: { firstName: true, lastName: true },
    });
    const candidateName = `${candidateRow?.firstName ?? ''} ${candidateRow?.lastName ?? ''}`.trim();

    const targetResponsibles = await this.stageAssigneeIds(stage.id, ['RESPONSIBLE']);
    this.notifications?.notifyUsers(
      targetResponsibles,
      NOTIF_EVENTS.PIPELINE_STAGE_ENTERED,
      'Candidate entered your stage',
      `${candidateName || 'A candidate'} is now in "${stage.name}".`,
      'APPLICANT',
      candidateId,
      {
        titleKey: 'events.pipelineStageEntered.title',
        messageKey: 'events.pipelineStageEntered.body',
        params: { candidateName, stageName: stage.name },
      },
    ).catch(e => this.logger.error('Pipeline stage-entered (advance) notification error:', e));

    if (sourceProgress) {
      const sourceResponsibles = await this.stageAssigneeIds(sourceProgress.stageId, ['RESPONSIBLE']);
      this.notifications?.notifyUsers(
        sourceResponsibles,
        NOTIF_EVENTS.PIPELINE_STAGE_ADVANCED,
        'Candidate advanced',
        `${candidateName || 'A candidate'} advanced from "${sourceProgress.stage.name}" to "${stage.name}".`,
        'APPLICANT',
        candidateId,
        {
          titleKey: 'events.pipelineStageAdvanced.title',
          messageKey: 'events.pipelineStageAdvanced.body',
          params: { candidateName, fromStage: sourceProgress.stage.name, toStage: stage.name },
        },
      ).catch(e => this.logger.error('Pipeline stage-advanced notification error:', e));
    }

    if ((stage as any).requiresApproval) {
      const targetApprovers = await this.stageAssigneeIds(stage.id, ['APPROVER', 'REVIEWER']);
      this.notifications?.notifyUsers(
        targetApprovers,
        NOTIF_EVENTS.PIPELINE_AWAITING_APPROVAL,
        'Candidate awaiting your approval',
        `${candidateName || 'A candidate'} is waiting for approval at "${stage.name}".`,
        'APPLICANT',
        candidateId,
        {
          titleKey: 'events.pipelineAwaitingApproval.title',
          messageKey: 'events.pipelineAwaitingApproval.body',
          params: { candidateName, stageName: stage.name },
        },
      ).catch(e => this.logger.error('Pipeline awaiting-approval (advance) notification error:', e));
    }

    return progress;
  }

  async updateProgress(progressId: string, dto: UpdateWorkflowStageProgressDto, actorId?: string) {
    // Phase 2.62 — progress parent gate via assignment.tenantId.
    const progress = await this.findProgressForMutationOrFail(progressId); // @tenant-reviewed: phase262-pipeline-transition-pilot

    const data: any = { status: dto.status };
    if (dto.status === 'COMPLETED') data.completedAt = new Date();
    if (dto.flagged !== undefined) data.flagged = dto.flagged;
    if (dto.flagReason !== undefined) data.flagReason = dto.flagReason;

    // If completing a non-final stage, check if we should auto-complete assignment
    const updated = await this.prisma.candidateStageProgress.update({
      where: { id: progressId },
      data,
      include: { stage: true, assignment: true },
    });

    // If final stage completed, complete the assignment
    if (dto.status === 'COMPLETED' && (progress.stage as any).isFinal) {
      await this.prisma.candidateWorkflowAssignment.update({
        where: { id: (updated as any).assignmentId },
        data: { status: 'COMPLETED', completedAt: new Date() },
      });
    }

    // Spec §4.11 — Pipeline: a stage progress was rejected. Audience
    // is the workflow's access users + the source stage RESPONSIBLEs,
    // so anyone tracking the candidate hears about it.
    if (dto.status === 'REJECTED') {
      const assignment = await this.prisma.candidateWorkflowAssignment.findUnique({
        where: { id: (updated as any).assignmentId },
        select: { candidateId: true, workflowId: true },
      });
      if (assignment) {
        const candidateRow = await this.prisma.applicant.findUnique({
          where: { id: assignment.candidateId },
          select: { firstName: true, lastName: true },
        });
        const candidateName = `${candidateRow?.firstName ?? ''} ${candidateRow?.lastName ?? ''}`.trim();
        const stageName = (updated as any).stage?.name ?? '';
        const reason = (dto as any).flagReason ?? (progress as any).flagReason ?? '';
        const audience = Array.from(new Set([
          ...await this.workflowAudienceIds(assignment.workflowId),
          ...await this.stageAssigneeIds((updated as any).stageId, ['RESPONSIBLE']),
        ]));
        this.notifications?.notifyUsers(
          audience,
          NOTIF_EVENTS.PIPELINE_STAGE_REJECTED,
          'Candidate rejected at a stage',
          reason
            ? `${candidateName || 'A candidate'} was rejected at "${stageName}": ${reason}`
            : `${candidateName || 'A candidate'} was rejected at "${stageName}".`,
          'APPLICANT',
          assignment.candidateId,
          {
            titleKey: 'events.pipelineStageRejected.title',
            messageKey: 'events.pipelineStageRejected.body',
            params: { candidateName, stageName, reason },
          },
        ).catch(e => this.logger.error('Pipeline stage-rejected notification error:', e));
      }
    }

    return updated;
  }

  // ─── Notes ────────────────────────────────────────────────────────────────

  async addNote(progressId: string, dto: CreateStageNoteDto, actorId?: string) {
    const progress = await this.prisma.candidateStageProgress.findUnique({ where: { id: progressId } });
    if (!progress) throw new NotFoundException({ code: 'WORKFLOW.PROGRESS_NOT_FOUND', message: 'Progress record not found' });
    return this.prisma.candidateStageNote.create({
      data: { progressId, content: dto.content, isPrivate: dto.isPrivate ?? false, authorId: actorId },
      include: { author: { select: { id: true, firstName: true, lastName: true } } },
    });
  }

  async deleteNote(noteId: string, actorId?: string) {
    const note = await this.prisma.candidateStageNote.findUnique({ where: { id: noteId } });
    if (!note) throw new NotFoundException({ code: 'WORKFLOW.NOTE_NOT_FOUND', message: 'Note not found' });
    await this.prisma.candidateStageNote.update({ where: { id: noteId }, data: { deletedAt: new Date() } });
    return { message: 'Note deleted' };
  }

  // ─── Flag ─────────────────────────────────────────────────────────────────

  async toggleProgressFlag(progressId: string, flagged: boolean, reason: string | null, actorId?: string) {
    // Phase 2.62 — progress parent gate via assignment.tenantId.
    const progress = await this.findProgressForMutationOrFail(progressId); // @tenant-reviewed: phase262-pipeline-transition-pilot
    const updated = await this.prisma.candidateStageProgress.update({
      where: { id: progressId },
      data: {
        flagged,
        flagReason: flagged ? (reason ?? progress.flagReason ?? null) : null,
      },
    });
    // @tenant-reviewed: phase262-pipeline-audit-log-pilot
    await this.auditLog(actorId, flagged ? 'STAGE_PROGRESS_FLAG' : 'STAGE_PROGRESS_UNFLAG',
      'WORKFLOW_STAGE_PROGRESS', progressId, { flagged, reason: reason ?? null });

    // Spec §4.11 — Pipeline: a candidate was flagged for attention.
    // Emit only on flag-up (un-flagging is informational, not an
    // alert). Audience: workflow access list + stage RESPONSIBLEs.
    if (flagged) {
      const assignment = await this.prisma.candidateWorkflowAssignment.findUnique({
        where: { id: (updated as any).assignmentId },
        select: { candidateId: true, workflowId: true },
      });
      if (assignment) {
        const candidateRow = await this.prisma.applicant.findUnique({
          where: { id: assignment.candidateId },
          select: { firstName: true, lastName: true },
        });
        const candidateName = `${candidateRow?.firstName ?? ''} ${candidateRow?.lastName ?? ''}`.trim();
        const audience = Array.from(new Set([
          ...await this.workflowAudienceIds(assignment.workflowId),
          ...await this.stageAssigneeIds((updated as any).stageId, ['RESPONSIBLE']),
        ]));
        this.notifications?.notifyUsers(
          audience,
          NOTIF_EVENTS.PIPELINE_FLAGGED,
          'Candidate flagged for attention',
          reason
            ? `${candidateName || 'A candidate'} was flagged: ${reason}`
            : `${candidateName || 'A candidate'} was flagged for attention.`,
          'APPLICANT',
          assignment.candidateId,
          {
            titleKey: 'events.pipelineFlagged.title',
            messageKey: 'events.pipelineFlagged.body',
            params: { candidateName, reason: reason ?? '' },
          },
        ).catch(e => this.logger.error('Pipeline flagged notification error:', e));
      }
    }
    return updated;
  }

  // ─── Approvals ────────────────────────────────────────────────────────────

  async submitApproval(progressId: string, dto: CreateStageApprovalDto, actorId?: string) {
    // Phase 2.62 — progress parent gate via assignment.tenantId.
    await this.findProgressForMutationOrFail(progressId); // @tenant-reviewed: phase262-pipeline-transition-pilot
    const progress = await this.prisma.candidateStageProgress.findUnique({
      where: { id: progressId },
      include: { stage: { include: { assignedUsers: true } } },
    });
    if (!progress) throw new NotFoundException({ code: 'WORKFLOW.PROGRESS_NOT_FOUND', message: 'Progress record not found' });
    if (!(progress.stage as any).requiresApproval) throw new BadRequestException({ code: 'WORKFLOW.APPROVAL_NOT_REQUIRED', message: 'This stage does not require approval' });

    // Only users assigned with role APPROVER (or legacy REVIEWER)
    // may submit approval decisions. Responsible-only users can
    // process the candidate but cannot sign off on approvals.
    const approvers = ((progress.stage as any).assignedUsers ?? [])
      .filter((u: any) => u.role === 'APPROVER' || u.role === 'REVIEWER');
    if (approvers.length > 0 && actorId && !approvers.some((u: any) => u.userId === actorId)) {
      throw new ForbiddenException({
        code: 'WORKFLOW.NOT_AN_APPROVER',
        message: `You are not an approver for "${(progress.stage as any).name}". Only assigned approvers may approve this stage.`,
        params: { stageName: (progress.stage as any).name },
      });
    }

    // Upsert approval for this actor on this progress
    const existing = await this.prisma.candidateStageApproval.findFirst({ where: { progressId, approvedById: actorId } });
    if (existing) {
      return this.prisma.candidateStageApproval.update({
        where: { id: existing.id },
        data: { decision: dto.decision as any, notes: dto.notes, decidedAt: new Date(), approvedById: actorId },
        include: { approvedBy: { select: { id: true, firstName: true, lastName: true } } },
      });
    }

    return this.prisma.candidateStageApproval.create({
      data: { progressId, decision: dto.decision as any, notes: dto.notes, decidedAt: new Date(), approvedById: actorId },
      include: { approvedBy: { select: { id: true, firstName: true, lastName: true } } },
    });
  }

  // ─── WorkflowStage Detail ─────────────────────────────────────────────────

  async getWorkflowStageDetails(stageId: string) {
    const stage = await this.prisma.workflowStage.findUnique({
      where: { id: stageId },
      include: {
        requiredDocs: { include: { documentType: { select: { id: true, name: true, category: true } } } },
        assignedUsers: { include: { user: { select: { id: true, firstName: true, lastName: true, email: true } } } },
        workflow: { select: { id: true, name: true } },
      },
    });
    if (!stage) throw new NotFoundException({ code: 'WORKFLOW.STAGE_NOT_FOUND', message: 'Stage not found' });

    // All stages in the workflow for "Stage X of Y"
    const allStages = await this.prisma.workflowStage.findMany({
      where: { workflowId: stage.workflowId },
      orderBy: { order: 'asc' },
      select: { id: true, order: true, name: true },
    });

    // Active candidates in this stage (via CandidateStageProgress).
    // assignCandidate / advanceToStage write status='IN_PROGRESS'; the
    // legacy code path that pre-dated the in-progress flag wrote 'ACTIVE'.
    // Both represent "currently on this stage" — accept either.
    const ACTIVE_STAGE_STATUSES = ['ACTIVE', 'IN_PROGRESS'] as any;
    const [progressItems, employeeAssignments] = await Promise.all([
      this.prisma.candidateStageProgress.findMany({
        where: { stageId, status: { in: ACTIVE_STAGE_STATUSES } },
        include: {
          assignment: {
            include: {
              candidate: {
                select: {
                  id: true, firstName: true, lastName: true, email: true,
                  candidateNumber: true, leadNumber: true, photoUrl: true, nationality: true,
                },
              },
            },
          },
          approvals: {
            orderBy: { createdAt: 'desc' },
            include: { approvedBy: { select: { id: true, firstName: true, lastName: true } } },
          },
          notes: {
            orderBy: { createdAt: 'desc' },
            take: 5,
            include: { author: { select: { id: true, firstName: true, lastName: true } } },
          },
        },
        orderBy: { enteredAt: 'asc' },
      }),
      // Active employees whose currentStageId === this stage
      // Note: filter status in JS to avoid Prisma enum/text cast issue with pg adapter
      this.prisma.employeeWorkflowAssignment.findMany({
        where: { currentStageId: stageId },
        include: {
          employee: {
            select: {
              id: true, firstName: true, lastName: true, email: true,
              employeeNumber: true, photoUrl: true, nationality: true, status: true,
            },
          },
        },
        orderBy: { assignedAt: 'asc' },
      }),
    ]);

    const requiredDocTypeIds = (stage.requiredDocs as any[])
      .filter(rd => rd.isRequired)
      .map(rd => rd.documentTypeId);
    const requiredDocsTotal = requiredDocTypeIds.length;

    // Batch load documents for all candidate entityIds at once
    const candidateIds = progressItems
      .map(p => (p.assignment as any)?.candidate?.id)
      .filter(Boolean);
    const employeeIds = employeeAssignments
      .map(ea => (ea as any)?.employee?.id)
      .filter(Boolean);

    const [candidateDocs, employeeDocs] = await Promise.all([
      candidateIds.length > 0 && requiredDocTypeIds.length > 0
        ? this.prisma.document.findMany({
            where: {
              entityType: 'APPLICANT' as any,
              entityId:   { in: candidateIds },
              documentTypeId: { in: requiredDocTypeIds },
              deletedAt: null,
            },
            select: { entityId: true, documentTypeId: true, status: true },
          })
        : Promise.resolve([] as any[]),
      employeeIds.length > 0 && requiredDocTypeIds.length > 0
        ? this.prisma.document.findMany({
            where: {
              entityType: 'EMPLOYEE' as any,
              entityId:   { in: employeeIds },
              documentTypeId: { in: requiredDocTypeIds },
              deletedAt: null,
            },
            select: { entityId: true, documentTypeId: true, status: true },
          })
        : Promise.resolve([] as any[]),
    ]);

    const buildDocSummary = (docs: any[], entityId: string) => {
      // Count unique required-doc-types that have at least one non-rejected doc
      const uploadedTypeIds = new Set<string>();
      const verifiedTypeIds = new Set<string>();
      const rejectedTypeIds = new Set<string>();
      for (const d of docs) {
        if (d.entityId !== entityId) continue;
        if (d.status === 'REJECTED') {
          if (!uploadedTypeIds.has(d.documentTypeId)) rejectedTypeIds.add(d.documentTypeId);
          continue;
        }
        uploadedTypeIds.add(d.documentTypeId);
        if (d.status === 'VERIFIED') verifiedTypeIds.add(d.documentTypeId);
      }
      // Overall stage document status: derive from required types
      let overallStatus: 'APPROVED' | 'PENDING_REVIEW' | 'REJECTED' | 'NOT_STARTED';
      if (requiredDocsTotal === 0) {
        overallStatus = 'NOT_STARTED';
      } else if (rejectedTypeIds.size > 0 && uploadedTypeIds.size < requiredDocsTotal) {
        overallStatus = 'REJECTED';
      } else if (verifiedTypeIds.size >= requiredDocsTotal) {
        overallStatus = 'APPROVED';
      } else if (uploadedTypeIds.size === 0) {
        overallStatus = 'NOT_STARTED';
      } else {
        overallStatus = 'PENDING_REVIEW';
      }
      return {
        requiredDocsTotal,
        requiredDocsUploaded: uploadedTypeIds.size,
        requiredDocsVerified: verifiedTypeIds.size,
        documentStatus: overallStatus,
      };
    };

    const WARNING_WINDOW_MS = 3 * 86400000; // warn when <3 days remain
    const computeDeadlineStatus = (slaDeadline: Date | null): 'ON_TIME' | 'WARNING' | 'OVERDUE' | 'NO_DEADLINE' => {
      if (!slaDeadline) return 'NO_DEADLINE';
      const diff = new Date(slaDeadline).getTime() - Date.now();
      if (diff < 0) return 'OVERDUE';
      if (diff <= WARNING_WINDOW_MS) return 'WARNING';
      return 'ON_TIME';
    };

    // Responsible users for the stage (filter by role)
    const responsibleUsers = (stage.assignedUsers as any[])
      .filter(u => String(u.role).toUpperCase() === 'RESPONSIBLE')
      .map(u => ({
        id:        u.user?.id,
        firstName: u.user?.firstName,
        lastName:  u.user?.lastName,
        email:     u.user?.email,
      }))
      .filter(u => u.id);

    // Map candidates. Skip orphaned progress rows (assignment hard-
    // deleted out from under them) instead of crashing on the deref.
    const candidateEntries = progressItems
      .filter((p: any) => p.assignment)
      .map((p) => {
      const daysInStage = Math.floor((Date.now() - new Date(p.enteredAt).getTime()) / 86400000);
      const candidate = (p.assignment as any)?.candidate ?? null;
      const docSummary = buildDocSummary(candidateDocs as any[], candidate?.id ?? '');
      const approvalsArr = (p.approvals as any[]) ?? [];
      const notesArr = (p.notes as any[]) ?? [];
      return {
        progressId: p.id,
        assignmentId: p.assignmentId,
        personType: 'CANDIDATE' as const,
        personId:   candidate?.id,
        firstName:  candidate?.firstName,
        lastName:   candidate?.lastName,
        email:      candidate?.email,
        systemId:   candidate?.candidateNumber,
        applicationId: candidate?.candidateNumber ?? candidate?.leadNumber ?? null,
        photoUrl:   candidate?.photoUrl,
        nationality: candidate?.nationality,
        enteredAt:  p.enteredAt,
        slaDeadline: p.slaDeadline,
        flagged:    p.flagged,
        flagReason: (p as any).flagReason ?? null,
        daysInStage,
        ...docSummary,
        checklistCompleted: 0,
        checklistTotal: 0,
        deadlineStatus: computeDeadlineStatus(p.slaDeadline),
        responsibleUsers,
        latestApproval: approvalsArr[0] ?? null,
        recentNotes: notesArr,
        profileLink: `/dashboard/applicants/${candidate?.id}`,
      };
    });

    // Map employees (filter ACTIVE in JS — avoids Prisma enum/text cast issue with pg adapter)
    const employeeEntries = employeeAssignments.filter(ea => ea.status === 'ACTIVE').map((ea) => {
      const emp = (ea as any).employee;
      const daysInStage = Math.floor((Date.now() - new Date(ea.assignedAt).getTime()) / 86400000);
      const docSummary = buildDocSummary(employeeDocs as any[], emp?.id ?? '');
      return {
        progressId:  ea.id,
        assignmentId: ea.id,
        personType:  'EMPLOYEE' as const,
        personId:    emp?.id,
        firstName:   emp?.firstName,
        lastName:    emp?.lastName,
        email:       emp?.email,
        systemId:    emp?.employeeNumber,
        applicationId: emp?.employeeNumber ?? null,
        photoUrl:    emp?.photoUrl,
        nationality: emp?.nationality,
        enteredAt:   ea.assignedAt,
        slaDeadline: null,
        flagged:     false,
        flagReason:  null,
        daysInStage,
        ...docSummary,
        checklistCompleted: 0,
        checklistTotal: 0,
        deadlineStatus: 'NO_DEADLINE' as const,
        responsibleUsers,
        latestApproval: null,
        recentNotes: [] as any[],
        profileLink: `/dashboard/employees/${emp?.id}`,
      };
    });

    const allPeople = [...candidateEntries, ...employeeEntries];
    const avgDays = allPeople.length > 0
      ? Math.round(allPeople.reduce((s, c) => s + c.daysInStage, 0) / allPeople.length)
      : 0;
    const atRiskCount = allPeople.filter(c => c.daysInStage > 14).length;

    return {
      stage,
      allStages,
      people: allPeople,
      stats: {
        total:          allPeople.length,
        candidatesCount: candidateEntries.length,
        employeesCount:  employeeEntries.length,
        avgDays,
        atRiskCount,
      },
    };
  }

  // ─── Stats ────────────────────────────────────────────────────────────────

  async getWorkflowStats(workflowId: string) {
    await this.getWorkflow(workflowId);
    const tenantWhere = this.scope().tenantWhere(); // @tenant-reviewed: phase261-pipeline-pilot-scope
    const [candidateActive, candidateCompleted, flaggedCount, slaBreached, empAssignments] = await Promise.all([
      this.prisma.candidateWorkflowAssignment.count({ where: { workflowId, status: 'ACTIVE',    ...tenantWhere } }), // @tenant-reviewed: phase261-pipeline-pilot-scope
      this.prisma.candidateWorkflowAssignment.count({ where: { workflowId, status: 'COMPLETED', ...tenantWhere } }), // @tenant-reviewed: phase261-pipeline-pilot-scope
      // status filter accepts both ACTIVE and IN_PROGRESS — see comment in
      // getWorkflowStageDetails. Stays in sync with the stage details view
      // so badge counts and the in-stage roster never disagree.
      this.prisma.candidateStageProgress.count({ where: { assignment: { workflowId, ...tenantWhere }, flagged: true, status: { in: ['ACTIVE', 'IN_PROGRESS'] as any } } }), // @tenant-reviewed: phase261-pipeline-pilot-scope
      this.prisma.candidateStageProgress.count({ where: { assignment: { workflowId, ...tenantWhere }, status: { in: ['ACTIVE', 'IN_PROGRESS'] as any }, slaDeadline: { lt: new Date() } } }), // @tenant-reviewed: phase261-pipeline-pilot-scope
      // Fetch employee assignments and filter in JS (avoid enum/text cast issue)
      this.prisma.employeeWorkflowAssignment.findMany({ // @tenant-reviewed: phase261-pipeline-pilot-scope
        where: { workflowId, ...tenantWhere },
        select: { status: true },
      }),
    ]);

    const empActive    = empAssignments.filter(ea => ea.status === 'ACTIVE').length;
    const empCompleted = empAssignments.filter(ea => ea.status === 'COMPLETED').length;

    return {
      totalActive:    candidateActive    + empActive,
      totalCompleted: candidateCompleted + empCompleted,
      flaggedCount,
      slaBreached,
    };
  }
}
