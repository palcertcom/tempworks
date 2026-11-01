/**
 * Phase 2.30 — Shared tenant-aware audit-log emitter.
 *
 * Consolidates the per-module `legacyPrisma.auditLog.create` call sites
 * (finance, documents, vehicles, workflow, applicants — and any future
 * piloted module) behind a single helper.
 *
 * Behaviour:
 *
 *   - With `TENANT_AUDIT_LOG_PILOT_ENABLED=false` (default) OR a runtime
 *     environment that is NOT SAFE_CLONE / SAFE_STAGING: writes the row
 *     with NO `tenantId` — byte-identical to the pre-2.30 behaviour.
 *
 *   - With the pilot flag ON AND a SAFE_CLONE/SAFE_STAGING env AND an
 *     ALS tenant frame in scope (or an explicit `tenantId` argument):
 *     writes `tenantId` alongside the rest of the row.
 *
 *   - Never throws. The audit emission is fire-and-forget by contract;
 *     a failure is logged at warn level and swallowed so the caller's
 *     main flow is never disturbed.
 *
 * The shared helper is the ONLY place that decides whether to attach
 * `tenantId` to an audit row, so future modules don't need their own
 * `*-audit-log` annotation tag — they just call `auditLog.write(...)`.
 */
import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { FeatureFlagsService } from '../feature-flags/feature-flags.service';
import { TenantContext } from '../context/als';
import { classifyRuntimeEnv, isStagingClassification } from '../tenancy/env-safety';

export interface TenantAuditLogInput {
  userId?: string | null;
  userEmail?: string | null;
  action: string;
  entity: string;
  entityId: string;
  changes?: Record<string, any> | null;
  ipAddress?: string | null;
  userAgent?: string | null;
  /**
   * Explicit tenant override for system jobs / cron paths that do not
   * have an ALS frame. Optional — when omitted, the helper reads the
   * active ALS tenant.
   */
  tenantId?: string | null;
}

export interface AuditDecision {
  active: boolean;
  tenantId: string | null;
  reason: string;
}

@Injectable()
export class TenantAuditLogService {
  private readonly logger = new Logger('TenantAuditLog');

  constructor(
    private readonly prisma: PrismaService,
    private readonly flags: FeatureFlagsService,
  ) {}

  /**
   * Emit a single audit row. Never throws.
   *
   * Tenant attribution rules:
   *   • Explicit `tenantId` argument is always honoured.
   *   • Otherwise the active ALS tenant frame is used.
   *   • A row is written without `tenantId` only when neither source
   *     yields one (legacy or out-of-context jobs).
   *
   * The old pilot/env gate is gone — operators reported "logs not
   * filterable by tenant" because production never matched the gate,
   * so every audit row landed with tenantId=NULL and was invisible
   * to the per-tenant filter on the Logs page. Writing the tenantId
   * whenever we have one fixes that going forward.
   */
  async write(input: TenantAuditLogInput): Promise<void> {
    const resolvedTenantId = this.resolveTenantId(input.tenantId ?? null);
    try {
      await this.prisma.auditLog.create({
        data: {
          userId: input.userId ?? undefined,
          userEmail: input.userEmail ?? undefined,
          action: input.action,
          entity: input.entity,
          entityId: input.entityId,
          changes: (input.changes ?? undefined) as any,
          ipAddress: input.ipAddress ?? undefined,
          userAgent: input.userAgent ?? undefined,
          ...(resolvedTenantId ? { tenantId: resolvedTenantId } : {}),
        },
      });
    } catch (err) {
      this.logger.warn(
        `audit emit failed (entity=${input.entity} action=${input.action}): ${
          (err as Error)?.message ?? err
        }`,
      );
      // Audit must never crash the main flow.
    }
  }

  /** Resolve the tenantId to stamp: explicit arg wins, then the ALS
   *  frame, then null. Pure helper, used by `write` and `decide`. */
  private resolveTenantId(explicit: string | null): string | null {
    if (explicit) return explicit;
    const ctx = TenantContext.optional?.();
    return ctx?.id ?? null;
  }

  /**
   * Phase 2.52 — Tenant-scoped read helpers. Always non-destructive.
   * `listForTenant` and `countForTenant` apply the explicit/active
   * tenantId equality filter. NULL-tenant rows are excluded by
   * design — callers wanting the legacy union must use the legacy
   * `LogsService.findAll` path with the pilot flag off.
   */
  async listForTenant(opts: {
    tenantId: string;
    entity?: string;
    entityId?: string;
    action?: string;
    userId?: string;
    fromDate?: string | Date;
    toDate?: string | Date;
    page?: number;
    limit?: number;
  }): Promise<{ items: any[]; total: number }> {
    const where = this.buildTenantWhere(opts);
    const skip = ((opts.page ?? 1) - 1) * (opts.limit ?? 20);
    const [items, total] = await Promise.all([
      this.prisma.auditLog.findMany({ // @tenant-reviewed: phase252-audit-log-read-pilot
        where,
        skip,
        take: opts.limit ?? 20,
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.auditLog.count({ where }), // @tenant-reviewed: phase252-audit-log-read-pilot
    ]);
    return { items, total };
  }

  async countForTenant(opts: {
    tenantId: string;
    entity?: string;
    entityId?: string;
    action?: string;
    userId?: string;
    fromDate?: string | Date;
    toDate?: string | Date;
  }): Promise<number> {
    return this.prisma.auditLog.count({ where: this.buildTenantWhere(opts) }); // @tenant-reviewed: phase252-audit-log-read-pilot
  }

  async getByIdForTenant(tenantId: string, id: string): Promise<any | null> {
    return this.prisma.auditLog.findFirst({ // @tenant-reviewed: phase252-audit-log-read-pilot
      where: { id, tenantId, deletedAt: null },
    });
  }

  /**
   * Phase 2.52 — Retention PREVIEW. Read-only by contract; never
   * deletes or modifies rows. With `AUDIT_LOG_RETENTION_ENABLED=false`
   * (default) the helper still returns counts, but it documents the
   * disabled state in the result so operators can confirm the gate.
   *
   * `tenantId === null` ⇒ count NULL-tenant legacy rows (legacy mode).
   * `tenantId === <id>` ⇒ count rows for that tenant only.
   */
  async previewRetention(opts: {
    tenantId: string | null;
    days?: number;
  }): Promise<{
    enabled: boolean;
    days: number;
    cutoffIso: string;
    candidateCount: number;
    tenantId: string | null;
  }> {
    const enabled = String(process.env.AUDIT_LOG_RETENTION_ENABLED ?? '').toLowerCase() === 'true';
    const rawDays = opts.days ?? Number(process.env.AUDIT_LOG_RETENTION_DAYS);
    const days = Number.isFinite(rawDays) && rawDays! > 0 ? Math.floor(rawDays!) : 365;
    const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    const where: any = { deletedAt: null, createdAt: { lt: cutoff } };
    if (opts.tenantId === null) where.tenantId = null;
    else where.tenantId = opts.tenantId;
    const candidateCount = await this.prisma.auditLog.count({ where }); // @tenant-reviewed: phase252-audit-log-retention-preview
    return {
      enabled,
      days,
      cutoffIso: cutoff.toISOString(),
      candidateCount,
      tenantId: opts.tenantId,
    };
  }

  private buildTenantWhere(opts: {
    tenantId: string;
    entity?: string;
    entityId?: string;
    action?: string;
    userId?: string;
    fromDate?: string | Date;
    toDate?: string | Date;
  }): Record<string, unknown> {
    const where: any = { tenantId: opts.tenantId, deletedAt: null };
    if (opts.entity) where.entity = opts.entity;
    if (opts.entityId) where.entityId = opts.entityId;
    if (opts.action) where.action = { contains: opts.action, mode: 'insensitive' };
    if (opts.userId) where.userId = opts.userId;
    if (opts.fromDate || opts.toDate) {
      where.createdAt = {};
      if (opts.fromDate) where.createdAt.gte = new Date(opts.fromDate);
      if (opts.toDate) where.createdAt.lte = new Date(opts.toDate);
    }
    return where;
  }

  /**
   * Diagnostic for harnesses. Pure; no DB writes.
   * `active=true` whenever a tenantId can be resolved (explicit arg
   * OR ALS frame). The pilot/env flags are still inspected so older
   * harness assertions on the `reason` field keep working, but they
   * no longer suppress the write.
   */
  decide(explicit: string | null): AuditDecision {
    const tenantId = this.resolveTenantId(explicit);
    if (!tenantId) {
      return { active: false, tenantId: null, reason: 'no tenant in scope' };
    }
    const pilotOn = this.flags.tenantAuditLogPilotEnabled();
    const env = classifyRuntimeEnv();
    const envOk = isStagingClassification(env.classification);
    const reason = explicit
      ? 'explicit tenantId override'
      : `ALS tenant frame (pilot=${pilotOn} env=${env.classification}${envOk ? '' : ' [non-staging]'})`;
    return { active: true, tenantId, reason };
  }
}
