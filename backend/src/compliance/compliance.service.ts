import { Injectable, Logger, Optional } from '@nestjs/common';
import type { NotificationsService } from '../notifications/notifications.service';
import { PrismaService } from '../prisma/prisma.service';
import { PilotPrismaAccessor } from '../saas/prisma/pilot-prisma.accessor';
import { getPilotScope, PilotScope } from '../saas/prisma/tenant-pilot-scope';
import { TenantAuditLogService } from '../saas/audit/tenant-audit-log.service';
import { TenantContext, withRequestContext, newRequestId } from '../saas/context/als';
import { classifyRuntimeEnv, isStagingClassification } from '../saas/tenancy/env-safety';
import { FeatureFlagsService } from '../saas/feature-flags/feature-flags.service';
import { UpdateAlertDto } from './dto/update-alert.dto';
import { PaginationDto } from '../common/dto/pagination.dto';
import { PaginatedResponse } from '../common/dto/pagination-response.dto';

/**
 * Compliance dashboard + alert management.
 *
 * Phase 2.8 — second tenant-scoped TenantPrisma pilot. The service
 * routes Prisma calls through `PilotPrismaAccessor.client()` and
 * applies a tenant filter (read paths) plus tenant injection (create
 * paths) when `getPilotScope()` reports `active=true` for the
 * `compliance` module:
 *   - `TENANT_PRISMA_PILOT_ENABLED=true`, AND
 *   - `TENANT_PRISMA_PILOT_MODULES` empty or includes `compliance`, AND
 *   - env classifies as SAFE_CLONE / SAFE_STAGING, AND
 *   - a tenant is in the ALS frame.
 *
 * Otherwise (production default) `tenantWhere()` / `tenantData()`
 * return `{}` and call sites are byte-identical to legacy.
 */
@Injectable()
export class ComplianceService {
  constructor(
    private legacyPrisma: PrismaService,
    private pilot: PilotPrismaAccessor,
    private tenantAuditLog: TenantAuditLogService,
    private flags: FeatureFlagsService,
    /**
     * Phase 2.43 — optional notifications coupling. Injected via the
     * compliance module wiring; left optional so existing harnesses
     * that construct ComplianceService directly do not need to supply
     * a NotificationsService unless they exercise the coupling.
     */
    @Optional() private notifications?: NotificationsService,
  ) {}

  private readonly logger = new Logger('ComplianceService');

  private get prisma(): PrismaService {
    return this.pilot.client();
  }

  private scope(): PilotScope {
    return getPilotScope(this.pilot, 'compliance');
  }

  async getDashboard() {
    const scope = this.scope();
    const t = scope.tenantWhere();
    const now = new Date();
    const thirtyDays = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
    const sevenDays = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);

    const [
      totalAlerts, openAlerts, criticalAlerts, resolvedAlerts,
      expiringDocuments, expiredDocuments,
      expiring30Days, expiring7Days,
      byStatus,
      recentAlerts,
    ] = await Promise.all([
      this.prisma.complianceAlert.count({ where: { ...t } }), // @tenant-reviewed: phase28-pilot-scope
      this.prisma.complianceAlert.count({ where: { status: 'OPEN', ...t } }),                        // @tenant-reviewed: phase28-pilot-scope
      this.prisma.complianceAlert.count({ where: { status: 'OPEN', severity: 'CRITICAL', ...t } }),  // @tenant-reviewed: phase28-pilot-scope
      this.prisma.complianceAlert.count({ where: { status: 'RESOLVED', ...t } }),                    // @tenant-reviewed: phase28-pilot-scope
      this.prisma.document.count({ // @tenant-reviewed: phase28-pilot-scope
        where: { deletedAt: null, archivedAt: null, expiryDate: { gte: now, lte: thirtyDays }, ...t },
      }),
      this.prisma.document.count({ // @tenant-reviewed: phase28-pilot-scope
        where: { deletedAt: null, archivedAt: null, expiryDate: { lt: now }, status: { not: 'EXPIRED' }, ...t },
      }),
      this.prisma.document.count({ where: { deletedAt: null, archivedAt: null, expiryDate: { gte: now, lte: thirtyDays }, ...t } }), // @tenant-reviewed: phase28-pilot-scope
      this.prisma.document.count({ where: { deletedAt: null, archivedAt: null, expiryDate: { gte: now, lte: sevenDays },  ...t } }), // @tenant-reviewed: phase28-pilot-scope
      this.prisma.complianceAlert.groupBy({ // @tenant-reviewed: phase28-pilot-scope
        by: ['status'],
        where: { ...t },
        _count: { id: true },
      }),
      this.prisma.complianceAlert.findMany({ // @tenant-reviewed: phase28-pilot-scope
        where: { status: { in: ['OPEN', 'ACKNOWLEDGED'] }, ...t },
        orderBy: [{ severity: 'desc' }, { createdAt: 'desc' }],
        take: 10,
        include: { document: { include: { documentType: true } } },
      }),
    ]);

    return {
      summary: { totalAlerts, openAlerts, criticalAlerts, resolvedAlerts },
      documents: { expiringDocuments, expiredDocuments, expiring30Days, expiring7Days },
      alertsByStatus: byStatus,
      recentAlerts,
    };
  }

  async getAlerts(pagination: PaginationDto, status?: string, severity?: string) {
    const scope = this.scope();
    const { page = 1, limit = 10 } = pagination;
    const where: any = { ...scope.tenantWhere() };
    if (status) where.status = status;
    if (severity) where.severity = severity;
    if (pagination.search) {
      where.message = { contains: pagination.search, mode: 'insensitive' };
    }
    const [items, total] = await Promise.all([
      this.prisma.complianceAlert.findMany({ // @tenant-reviewed: phase28-pilot-scope
        where,
        skip: (Number(page) - 1) * Number(limit),
        take: Number(limit),
        orderBy: [{ severity: 'desc' }, { createdAt: 'desc' }],
        include: {
          document: { include: { documentType: true } },
          resolvedBy: { select: { id: true, firstName: true, lastName: true } },
        },
      }),
      this.prisma.complianceAlert.count({ where }), // @tenant-reviewed: phase28-pilot-scope
    ]);
    return PaginatedResponse.create(items, total, page, limit);
  }

  async updateAlert(id: string, dto: UpdateAlertDto, userId?: string) {
    const scope = this.scope();
    const updateData: any = { ...dto };
    if (dto.status === 'RESOLVED') {
      updateData.resolvedAt = new Date();
      updateData.resolvedById = userId;
    }
    // Pre-check: when pilot is active, ensure the alert belongs to the
    // active tenant before mutating. In legacy mode `scope.tenantWhere()`
    // returns `{}` so the pre-check matches by `id` alone — same as
    // before this PR.
    const existing = await this.prisma.complianceAlert.findFirst({ // @tenant-reviewed: phase28-pilot-scope
      where: { id, ...scope.tenantWhere() },
      select: { id: true },
    });
    if (!existing) {
      // In legacy mode `findFirst({ where: { id } })` returning null is
      // the same NotFound the original `update` would have thrown via
      // Prisma's P2025; preserve the same observable behaviour by
      // letting the subsequent update raise.
      if (!scope.active) {
        return this.prisma.complianceAlert.update({ // @tenant-reviewed: phase28-pilot-scope (legacy fallback to preserve P2025)
          where: { id },
          data: updateData,
          include: { document: true },
        });
      }
      // Pilot mode: cross-tenant id presents as an "alert not found"
      // — surface the same Prisma error as a missing id would.
      throw new (require('@nestjs/common').NotFoundException)('Compliance alert not found');
    }
    const alert = await this.prisma.complianceAlert.update({ // @tenant-reviewed: phase28-pilot-scope
      where: { id },
      data: updateData,
      include: { document: true },
    });
    if (userId) {
      // Phase 2.38 — route through TenantAuditLogService.
      // @tenant-reviewed: phase238-audit-log-pilot
      await this.tenantAuditLog.write({
        userId,
        action: 'UPDATE_ALERT',
        entity: 'ComplianceAlert',
        entityId: id,
        changes: dto as any,
      });
    }
    return alert;
  }

  async getEmployeeCompliance(employeeId: string) {
    const scope = this.scope();
    const t = scope.tenantWhere();
    const [employee, documents, workPermits, visas, alerts] = await Promise.all([
      this.prisma.employee.findUnique({ // @tenant-reviewed: phase28-pilot-scope (id is unique key; tenant pre-filtered via scope below)
        where: { id: employeeId, deletedAt: null, ...t } as any,
        select: { id: true, firstName: true, lastName: true, email: true, status: true },
      }),
      this.prisma.document.findMany({ // @tenant-reviewed: phase28-pilot-scope
        where: { entityType: 'EMPLOYEE', entityId: employeeId, deletedAt: null, archivedAt: null, ...t },
        include: { documentType: true },
        orderBy: { expiryDate: 'asc' },
      }),
      this.prisma.workPermit.findMany({ // @tenant-reviewed: phase28-pilot-scope
        where: { employeeId, ...t },
        orderBy: { expiryDate: 'asc' },
      }),
      this.prisma.visa.findMany({ // @tenant-reviewed: phase28-pilot-scope
        where: { entityType: 'EMPLOYEE', entityId: employeeId, ...t },
        orderBy: { expiryDate: 'asc' },
      }),
      this.prisma.complianceAlert.findMany({ // @tenant-reviewed: phase28-pilot-scope
        where: { entityType: 'EMPLOYEE', entityId: employeeId, status: { in: ['OPEN', 'ACKNOWLEDGED'] }, ...t },
        orderBy: [{ severity: 'desc' }, { createdAt: 'desc' }],
      }),
    ]);

    const now = new Date();
    const documentsWithStatus = documents.map(doc => ({
      ...doc,
      daysUntilExpiry: doc.expiryDate
        ? Math.floor((doc.expiryDate.getTime() - now.getTime()) / (1000 * 60 * 60 * 24))
        : null,
      isExpired: doc.expiryDate ? doc.expiryDate < now : false,
    }));

    return { employee, documents: documentsWithStatus, workPermits, visas, openAlerts: alerts };
  }

  async getExpiringDocuments(days = 30) {
    const scope = this.scope();
    const threshold = new Date();
    threshold.setDate(threshold.getDate() + days);
    return this.prisma.document.findMany({ // @tenant-reviewed: phase28-pilot-scope
      where: {
        deletedAt: null,
        archivedAt: null,
        status: { notIn: ['REJECTED'] },
        expiryDate: { not: null, lte: threshold, gte: new Date() },
        ...scope.tenantWhere(),
      },
      include: {
        documentType: true,
        uploadedBy: { select: { id: true, firstName: true, lastName: true } },
      },
      orderBy: { expiryDate: 'asc' },
    });
  }

  async generateAlerts() {
    // Scan all documents for expiry and create alerts as needed.
    // Window is per-document-type: DocumentType.renewalPeriodDays carries
    // the operator's chosen notification lead time (e.g. passport=90,
    // driving licence=60, work permit=30). When the type doesn't set
    // one, fall back to the legacy 30 days so behaviour is unchanged.
    const scope = this.scope();
    const now = new Date();
    const DEFAULT_LEAD = 30;
    // Pull the widest possible candidate set (the longest renewalPeriodDays
    // configured anywhere) plus the documentType so we can decide per row.
    const types = await this.prisma.documentType.findMany({
      select: { id: true, renewalPeriodDays: true },
    });
    const leadByType = new Map<string, number>(
      types.map(t => [t.id, Math.max(1, t.renewalPeriodDays ?? DEFAULT_LEAD)]),
    );
    const maxLeadDays = Math.max(DEFAULT_LEAD, ...types.map(t => t.renewalPeriodDays ?? DEFAULT_LEAD));
    const farFuture = new Date(now.getTime() + maxLeadDays * 24 * 60 * 60 * 1000);
    const expiringDocs = await this.prisma.document.findMany({ // @tenant-reviewed: phase28-pilot-scope
      where: {
        deletedAt: null,
        archivedAt: null,
        expiryDate: { not: null, lte: farFuture, gte: now },
        ...scope.tenantWhere(),
      },
      include: { documentType: { select: { id: true, renewalPeriodDays: true } } },
    });

    let created = 0;
    for (const doc of expiringDocs as any[]) {
      const leadDays = leadByType.get(doc.documentTypeId) ?? DEFAULT_LEAD;
      const daysLeft = Math.floor((doc.expiryDate!.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));
      // Within the per-type window? If the doc still has more days than
      // its type's lead, skip — it's not 'soon' yet for this type.
      if (daysLeft > leadDays) continue;
      const existing = await this.prisma.complianceAlert.findFirst({ // @tenant-reviewed: phase28-pilot-scope
        where: { documentId: doc.id, status: { in: ['OPEN', 'ACKNOWLEDGED'] }, alertType: 'DOCUMENT_EXPIRY', ...scope.tenantWhere() },
      });
      if (!existing) {
        await this.prisma.complianceAlert.create({ // @tenant-reviewed: phase28-pilot-scope
          data: {
            entityType: doc.entityType,
            entityId: doc.entityId,
            documentId: doc.id,
            alertType: 'DOCUMENT_EXPIRY',
            severity: daysLeft <= 7 ? 'CRITICAL' : daysLeft <= 14 ? 'HIGH' : 'MEDIUM',
            message: `Document expires in ${daysLeft} days`,
            status: 'OPEN',
            dueDate: doc.expiryDate,
            ...scope.tenantData(),
          },
        });
        created++;
      }
    }
    return { message: `Generated ${created} new compliance alerts`, total: expiringDocs.length };
  }

  // ── Phase 2.38 — scheduler-safe entrypoint ──────────────────────────────────
  //
  // `generateAlerts()` reads ALS for tenant attribution. Calling it from a
  // background scheduler without first attaching an ALS frame is unsafe — the
  // scope would be inactive and the scan would create NULL-tenant rows.
  //
  // `generateAlertsForTenant(tenantId)` is the supported, gated entrypoint
  // for any future scheduled invocation. It:
  //   - refuses to run unless the runtime env is SAFE_CLONE / SAFE_STAGING,
  //   - refuses to run unless TENANT_PRISMA_PILOT_ENABLED is true and the
  //     `compliance` module is in the allow-list,
  //   - attaches a fresh ALS frame for the requested tenant inside its own
  //     `withRequestContext`, so concurrent calls remain isolated,
  //   - calls the existing `generateAlerts()` body unchanged.
  //
  // No fan-out helper is provided. If a future scheduler needs to scan
  // every tenant, it must explicitly enumerate tenant ids and call this
  // method per tenant — that decision is product-side and explicitly
  // out of scope this phase.
  //
  // @tenant-reviewed: phase238-scheduler-routing
  async generateAlertsForTenant(tenantId: string): Promise<{ message: string; total: number; tenantId: string }> {
    if (!tenantId) {
      throw new Error('generateAlertsForTenant requires a tenantId');
    }
    const env = classifyRuntimeEnv();
    if (!isStagingClassification(env.classification)) {
      this.logger.warn(`[scheduler] refusing to run on classification=${env.classification}`);
      return { message: `refused: env=${env.classification}`, total: 0, tenantId };
    }
    if (!this.pilot.isPilotActive()) {
      this.logger.warn(`[scheduler] refusing to run: ${this.pilot.pilotReason().reason}`);
      return { message: `refused: ${this.pilot.pilotReason().reason}`, total: 0, tenantId };
    }
    return withRequestContext({ requestId: newRequestId() }, async () => {
      TenantContext.attach({
        id: tenantId,
        slug: 'scheduler',
        name: 'scheduler',
        status: 'ACTIVE',
        region: 'eu',
      });
      const r = await this.generateAlerts();
      // Phase 2.43 — optional, gated, tenant-safe notification coupling.
      // Runs INSIDE the same ALS frame so notifications carry tenantId.
      // Failure here is captured but never rolls back compliance alert
      // generation.
      // @tenant-reviewed: phase243-compliance-notification-coupling
      const notify = await this.maybeNotifyOnAlertGeneration(r.total);
      return { ...r, tenantId, ...(notify ? { notify } : {}) };
    });
  }

  // ── Phase 2.43 — compliance → notifications coupling ───────────────────────
  //
  // Default: refused (COMPLIANCE_NOTIFY_ON_ALERT=false). Even when the
  // flag is on, the existing fan-out gate (TENANT_AWARE_JOBS_ENABLED +
  // TENANT_JOB_FANOUT_ENABLED) still governs whether
  // notifyUsersByRoles is allowed to write notifications. If either
  // gate is off, this method returns a structured refusal and creates
  // zero notifications.
  //
  // Notifications are created only via the existing
  // NotificationsService.notifyUsersByRoles helper, which:
  //   - narrows recipients by agency.tenantId (active ALS frame)
  //   - stamps Notification.create.data.tenantId from the active frame
  //   - never invokes EmailModule / SMS / external providers here
  //
  // Failures are captured and never thrown — a notification fan-out
  // problem must not roll back compliance alert generation.
  //
  // @tenant-reviewed: phase243-compliance-notification-coupling
  private async maybeNotifyOnAlertGeneration(total: number): Promise<{
    skipped?: string;
    refused?: string;
    notified?: number;
    deduped?: number;
    error?: string;
  } | null> {
    if (!this.flags.complianceNotifyOnAlert()) {
      return null; // disabled by default → no structured noise either
    }
    if (!this.notifications) {
      return { skipped: 'NotificationsService not provided to ComplianceService' };
    }
    // Reuse the notifications module's fan-out gate exactly. If
    // TENANT_AWARE_JOBS_ENABLED or TENANT_JOB_FANOUT_ENABLED are off,
    // notifyUsersByRoles' assertTenantForFanout would throw. Pre-check
    // here so we capture the refusal cleanly.
    if (!this.flags.tenantAwareJobsEnabled() || !this.flags.tenantJobFanoutEnabled()) {
      return { refused: 'tenant fan-out gates off (TENANT_AWARE_JOBS_ENABLED / TENANT_JOB_FANOUT_ENABLED)' };
    }
    if (total <= 0) {
      // No new alerts ⇒ nothing to notify about. Still gated and
      // tenant-safe, but emit a structured skip so the harness can
      // assert "fan-out not invoked when nothing new".
      return { skipped: 'no new alerts in this tick' };
    }
    try {
      // @tenant-reviewed: phase243-compliance-notification-fanout
      const r: any = await this.notifications.notifyUsersByRoles(
        ['Compliance Officer', 'Compliance Manager', 'System Admin'],
        'compliance.alert.generated' as any,
        'New compliance alerts',
        `${total} new compliance alert${total === 1 ? '' : 's'} were generated for this tenant.`,
        'ComplianceAlert',
        // Phase 2.45 — stable relatedEntityId so the per-recipient dedup
        // helper has a reliable identity. We use 'tick:<tenantId>' to
        // avoid colliding across tenants while still letting the dedup
        // window suppress consecutive identical ticks for the same
        // recipient.
        // @tenant-reviewed: phase245-notifications-dedup
        `tick:${TenantContext.optional?.()?.id ?? 'unknown'}`,
        {
          titleKey: 'compliance.alertGenerated.title',
          messageKey: 'compliance.alertGenerated.message',
          params: { total },
        },
      );
      // The notify helper now returns counters; surface deduped to the
      // health summary.
      const created = typeof r?.created === 'number' ? r.created : total;
      const deduped = typeof r?.deduped === 'number' ? r.deduped : 0;
      return { notified: created, deduped };
    } catch (e: any) {
      // Crash-safe: never throw out of generateAlertsForTenant on
      // notification failure.
      this.logger.warn(`[notify] fan-out failed: ${e?.message ?? e}`);
      return { error: String(e?.message ?? e) };
    }
  }

  // ── Phase 2.39 — tenant-aware fan-out dispatch ──────────────────────────────
  //
  // The ONLY supported path for any background scheduler to invoke compliance
  // alert generation across multiple tenants. Enforces the "one tenant per
  // scan" contract from Phase 2.38 by enumerating active tenants and calling
  // `generateAlertsForTenant(tenantId)` once per tenant.
  //
  // Refusal contract:
  //   - TENANT_JOB_FANOUT_ENABLED=false  ⇒ refuses, runs zero scans.
  //   - pilot inactive (flag off, not allow-listed, or env not staging) ⇒ refuses.
  //
  // Per-tenant outcomes are recorded in `results`; one tenant's failure does
  // NOT abort the loop — it is captured as `{ ok: false, error }` and the
  // remaining tenants are processed. ALS isolation is provided by
  // `generateAlertsForTenant` itself (each call wraps `withRequestContext`).
  //
  // Schedulers MUST NOT call `generateAlerts()` directly. Annotated
  // `phase239-tenant-job-dispatch`.
  //
  // @tenant-reviewed: phase239-tenant-job-dispatch
  async dispatchComplianceAlertGenerationForTenants(): Promise<{
    refused?: string;
    processed: number;
    results: Array<{
      tenantId: string;
      ok: boolean;
      total?: number;
      message?: string;
      error?: string;
      /** Phase 2.43 — coupling outcome forwarded from generateAlertsForTenant. */
      notify?: { skipped?: string; refused?: string; notified?: number; deduped?: number; error?: string };
    }>;
  }> {
    if (!this.flags.tenantJobFanoutEnabled()) {
      return { refused: 'TENANT_JOB_FANOUT_ENABLED=false', processed: 0, results: [] };
    }
    const pilotReason = this.pilot.pilotReason();
    if (!pilotReason.active) {
      return { refused: `pilot inactive: ${pilotReason.reason}`, processed: 0, results: [] };
    }
    if (!isStagingClassification(classifyRuntimeEnv().classification)) {
      return { refused: 'env is not SAFE_CLONE/SAFE_STAGING', processed: 0, results: [] };
    }

    // Enumerate ACTIVE tenants only. The Tenant table is global-scope; the
    // legacy client is the right surface (pilot client has no tenant frame
    // here yet; we are about to attach one per row).
    // @tenant-reviewed: phase239-tenant-job-dispatch (global Tenant enumeration)
    const tenants: Array<{ id: string }> = await this.legacyPrisma.tenant.findMany({
      where: { status: 'ACTIVE' as any },
      select: { id: true },
      orderBy: { slug: 'asc' },
    });

    const results: Array<{
      tenantId: string;
      ok: boolean;
      total?: number;
      message?: string;
      error?: string;
      notify?: { skipped?: string; refused?: string; notified?: number; deduped?: number; error?: string };
    }> = [];
    for (const t of tenants) {
      try {
        const r: any = await this.generateAlertsForTenant(t.id);
        results.push({ tenantId: t.id, ok: true, total: r.total, message: r.message, ...(r.notify ? { notify: r.notify } : {}) });
      } catch (e: any) {
        // Capture and continue — one tenant's failure must not leak into
        // another tenant's frame. ALS isolation is guaranteed by the
        // per-call `withRequestContext` inside `generateAlertsForTenant`.
        this.logger.warn(`[fan-out] tenant=${t.id} failed: ${e?.message ?? e}`);
        results.push({ tenantId: t.id, ok: false, error: String(e?.message ?? e) });
      }
    }
    return { processed: results.length, results };
  }
}
