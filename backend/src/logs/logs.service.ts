import { Injectable, ForbiddenException, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { PilotPrismaAccessor } from '../saas/prisma/pilot-prisma.accessor';
import { getPilotScope, isModuleAllowed, PilotScope } from '../saas/prisma/tenant-pilot-scope';
import { buildSuperUserTenantWhereDirect, assertRequestedTenantExists } from '../saas/prisma/super-user-tenant-filter';
import { TenantAuditLogService } from '../saas/audit/tenant-audit-log.service';
import { PaginationDto } from '../common/dto/pagination.dto';
import { PaginatedResponse } from '../common/dto/pagination-response.dto';

/** Roles that can see ALL logs with no per-user restriction. Whether
 *  they see ALL TENANTS depends on the global-read gate (Phase 2.56). */
export const FULL_ACCESS_ROLES = ['System Admin', 'HR Manager', 'Compliance Officer'];

export interface CallerScope {
  role: string;
  userId: string;
  agencyId?: string;
  agencyIsSystem?: boolean;
  /** SUPER USER per-page tenant filter (?tenantId=…). Threaded through
   *  to getStats so the dashboard cards match the per-page filter
   *  shown in the toolbar. Ignored for non-platform callers. */
  tenantId?: string;
}

/**
 * Phase 2.52 — Tenant-scoped audit-log read pilot.
 *
 * Read paths (`findAll`, `getStats`) spread `scope.tenantWhere()`
 * into the `where` clause when the pilot is active. With the flag
 * off `tenantWhere()` returns `{}`, so the queries are byte-identical
 * to pre-2.52. Mutation paths (`clearLogs`, `deleteOne`) stay on
 * `legacyPrisma` — Phase 2.52 explicitly excludes audit deletion.
 */
@Injectable()
export class LogsService {
  constructor(
    private legacyPrisma: PrismaService,
    private pilot: PilotPrismaAccessor,
    private tenantAuditLog: TenantAuditLogService,
  ) {}

  private get prisma(): PrismaService {
    return this.pilot.client();
  }

  private scope(): PilotScope {
    return getPilotScope(this.pilot, 'audit-logs');
  }

  /** Phase 2.56 — global-read gate. Even FULL_ACCESS roles are
   *  tenant-bound by default; bypass requires the explicit env flag.
   *  Tag: phase256-audit-log-global-read-gate. */
  private isGlobalReadEnabled(): boolean {
    return String(process.env.AUDIT_LOG_GLOBAL_READ_ENABLED ?? '').toLowerCase() === 'true';
  }

  /** Phase 2.56 — actor-bound tenant predicate.
   *  - Pilot inactive ⇒ `{}` (legacy union; byte-identical to pre-2.52).
   *  - Pilot active + global-read enabled + caller in FULL_ACCESS_ROLES
   *      ⇒ `{}` (explicit global visibility).
   *  - Otherwise pilot active ⇒ the regular `tenantWhere()` from the
   *    pilot scope (i.e. `tenantId = <ALS>`).
   *  Tag: phase256-audit-log-actor-scope. */
  private auditTenantWhereForActor(scope?: CallerScope): Record<string, unknown> {
    const s = this.scope();
    if (!s.active) return {};
    if (this.isGlobalReadEnabled() && scope && FULL_ACCESS_ROLES.includes(scope.role)) {
      return {};
    }
    return s.tenantWhere();
  }

  /** Phase 2.56 — explicit refusal contract. With the pilot active and
   *  the caller is NOT in FULL_ACCESS_ROLES (or is FULL_ACCESS but the
   *  global-read gate is OFF), the active ALS tenant frame is required.
   *  Returns silently when the gate is satisfied; throws
   *  ForbiddenException otherwise.
   *  Tag: phase256-audit-log-rbac-tenant-binding. */
  private assertAuditReadAccess(scope?: CallerScope): void {
    const r = this.pilot.pilotReason();
    if (!r.active) return; // pilot inactive ⇒ legacy union; nothing to assert
    // Module opt-out (TENANT_PRISMA_PILOT_MODULES=nothing or absent
    // 'audit-logs') is an explicit operator decision — fall through to
    // legacy union without refusing.
    if (!isModuleAllowed('audit-logs')) return;
    const isFull = !!scope && FULL_ACCESS_ROLES.includes(scope.role);
    if (isFull && this.isGlobalReadEnabled()) return; // explicit global override
    // Tenant-scoped (or FULL_ACCESS without global gate) requires ALS.
    if (!this.scope().active) {
      throw new ForbiddenException('Audit-log read requires an active tenant context');
    }
  }

  /**
   * Resolve the set of userIds whose logs the caller may see.
   * Returns undefined  → no restriction (full access)
   * Returns string[]   → restrict to these userIds only
   */
  private async resolveVisibleUserIds(scope: CallerScope): Promise<string[] | undefined> {
    if (FULL_ACCESS_ROLES.includes(scope.role)) return undefined; // full access

    if (scope.role === 'Agency Manager' && scope.agencyId) {
      // Agency Manager sees their own logs + all users in their agency
      const agencyUsers = await this.prisma.user.findMany({
        where: { agencyId: scope.agencyId, deletedAt: null },
        select: { id: true },
      });
      return agencyUsers.map(u => u.id);
    }

    // Everyone else: only their own activity
    return [scope.userId];
  }

  async findAll(
    pagination: PaginationDto,
    filters: {
      userId?: string;
      entity?: string;
      entityId?: string;
      action?: string;
      fromDate?: string;
      toDate?: string;
      tenantId?: string;
    } = {},
    scope?: CallerScope,
  ) {
    const { page = 1, limit = 20, search } = pagination;
    const skip = (Number(page) - 1) * Number(limit);

    this.assertAuditReadAccess(scope); // @tenant-reviewed: phase256-audit-log-rbac-tenant-binding
    // Phase F2 (SPIKE-010 Batch 3) — SUPER USER tenant override.
    await assertRequestedTenantExists(scope, filters.tenantId, this.legacyPrisma.tenant);
    const superTenantPredicate = buildSuperUserTenantWhereDirect(scope, filters.tenantId);
    const where: any = { deletedAt: null, ...this.auditTenantWhereForActor(scope) }; // @tenant-reviewed: phase256-audit-log-actor-scope
    if (superTenantPredicate) where.AND = [...(where.AND ?? []), superTenantPredicate];

    // ── Scope restriction ────────────────────────────────────────────────────
    if (scope) {
      const visibleIds = await this.resolveVisibleUserIds(scope);
      if (visibleIds !== undefined) {
        // If caller also passed a userId filter, intersect with their visible set
        if (filters.userId) {
          where.userId = visibleIds.includes(filters.userId) ? filters.userId : '__none__';
        } else {
          where.userId = { in: visibleIds };
        }
      } else if (filters.userId) {
        where.userId = filters.userId;
      }
    } else if (filters.userId) {
      where.userId = filters.userId;
    }

    // ── Other filters ────────────────────────────────────────────────────────
    if (filters.entity) where.entity = filters.entity;
    if (filters.entityId) where.entityId = filters.entityId;
    if (filters.action) where.action = { contains: filters.action, mode: 'insensitive' };
    if (filters.fromDate || filters.toDate) {
      where.createdAt = {};
      if (filters.fromDate) where.createdAt.gte = new Date(filters.fromDate);
      if (filters.toDate) where.createdAt.lte = new Date(filters.toDate);
    }
    if (search) {
      where.OR = [
        { action: { contains: search, mode: 'insensitive' } },
        { entity: { contains: search, mode: 'insensitive' } },
        { userEmail: { contains: search, mode: 'insensitive' } },
      ];
    }

    const [items, total] = await Promise.all([
      this.prisma.auditLog.findMany({
        where,
        skip,
        take: Number(limit),
        orderBy: { createdAt: 'desc' },
        include: {
          user: { select: { id: true, firstName: true, lastName: true, email: true } },
        },
      }),
      this.prisma.auditLog.count({ where }),
    ]);

    return PaginatedResponse.create(items, total, page, limit);
  }

  async getStats(scope?: CallerScope) {
    const now = new Date();
    const last24h = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const last7d = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

    // Build the base scope filter
    this.assertAuditReadAccess(scope); // @tenant-reviewed: phase256-audit-log-rbac-tenant-binding
    const tenantWhere = this.auditTenantWhereForActor(scope); // @tenant-reviewed: phase256-audit-log-actor-scope
    // SUPER USER per-page tenant filter — same plumbing as findAll so the
    // stats cards line up with the rows below them. The legacy union
    // (pilot off + FULL_ACCESS) returns {} from auditTenantWhereForActor;
    // without this the dashboard counts every tenant's row even when the
    // operator has narrowed the toolbar to one tenant.
    await assertRequestedTenantExists(scope, scope?.tenantId, this.legacyPrisma.tenant);
    const superTenantPredicate = buildSuperUserTenantWhereDirect(scope, scope?.tenantId);
    let scopeWhere: any = { deletedAt: null, ...tenantWhere };
    if (superTenantPredicate) scopeWhere = { ...scopeWhere, AND: [superTenantPredicate] };
    if (scope) {
      const visibleIds = await this.resolveVisibleUserIds(scope);
      if (visibleIds !== undefined) {
        scopeWhere = { userId: { in: visibleIds }, ...scopeWhere };
      }
    }

    const [total, last24hCount, last7dCount, byEntity, byAction, topUsers] = await Promise.all([
      this.prisma.auditLog.count({ where: scopeWhere }),
      this.prisma.auditLog.count({ where: { ...scopeWhere, createdAt: { gte: last24h } } }),
      this.prisma.auditLog.count({ where: { ...scopeWhere, createdAt: { gte: last7d } } }),
      this.prisma.auditLog.groupBy({
        by: ['entity'],
        where: scopeWhere,
        _count: { id: true },
        orderBy: { _count: { id: 'desc' } },
        take: 10,
      }),
      this.prisma.auditLog.groupBy({
        by: ['action'],
        where: scopeWhere,
        _count: { id: true },
        orderBy: { _count: { id: 'desc' } },
        take: 10,
      }),
      this.prisma.auditLog.groupBy({
        by: ['userId'],
        _count: { id: true },
        where: { ...scopeWhere, userId: { not: null } },
        orderBy: { _count: { id: 'desc' } },
        take: 5,
      }),
    ]);

    return { total, last24hCount, last7dCount, byEntity, byAction, topUsers };
  }

  async clearLogs(filters: { fromDate?: string; toDate?: string; entity?: string } = {}) {
    const where: any = {};
    if (filters.entity) where.entity = filters.entity;
    if (filters.fromDate || filters.toDate) {
      where.createdAt = {};
      if (filters.fromDate) where.createdAt.gte = new Date(filters.fromDate);
      if (filters.toDate) where.createdAt.lte = new Date(filters.toDate);
    }
    where.deletedAt = null;
    const { count } = await this.prisma.auditLog.updateMany({ where, data: { deletedAt: new Date() } });
    return { deleted: count, message: `${count} log entries deleted` };
  }

  async deleteOne(id: string) {
    const log = await this.prisma.auditLog.findFirst({ where: { id, deletedAt: null } });
    if (!log) return { message: 'Not found' };
    await this.prisma.auditLog.update({ where: { id }, data: { deletedAt: new Date() } });
    return { message: 'Log entry deleted' };
  }

  /**
   * Phase 2.57 — tenant-scoped by-id read for HTTP endpoints.
   * Reuses Phase 2.56's RBAC tenant binding. Returns the row only
   * when it satisfies the active tenant predicate AND role visibility;
   * otherwise raises NotFoundException so cross-tenant ids are
   * indistinguishable from missing ids. Tag: phase257-audit-log-http-read.
   */
  async findOneForActor(id: string, scope?: CallerScope) {
    this.assertAuditReadAccess(scope); // @tenant-reviewed: phase256-audit-log-rbac-tenant-binding
    const tenantWhere = this.auditTenantWhereForActor(scope); // @tenant-reviewed: phase256-audit-log-actor-scope
    const where: any = { id, deletedAt: null, ...tenantWhere };
    if (scope) {
      const visibleIds = await this.resolveVisibleUserIds(scope);
      if (visibleIds !== undefined) where.userId = { in: visibleIds };
    }
    const row = await this.prisma.auditLog.findFirst({ // @tenant-reviewed: phase257-audit-log-http-read
      where,
      include: { user: { select: { id: true, firstName: true, lastName: true, email: true } } },
    });
    if (!row) throw new NotFoundException('Audit log entry not found');
    return row;
  }

  /**
   * Phase 2.57 — tenant-scoped retention preview for HTTP endpoints.
   * Read-only; delegates to TenantAuditLogService.previewRetention.
   * The tenant id is taken from the active ALS frame; a missing frame
   * is rejected by `assertAuditReadAccess`. With the global-read gate
   * on AND a FULL_ACCESS caller, the helper returns a NULL-tenant
   * preview only if the caller explicitly supplies `null` (out of
   * scope today — defaults to active tenant). Tag:
   * phase257-audit-log-http-retention-preview.
   */
  async previewRetentionForActor(scope?: CallerScope, days?: number) {
    this.assertAuditReadAccess(scope); // @tenant-reviewed: phase256-audit-log-rbac-tenant-binding
    const s = this.scope();
    // When pilot is inactive or not allow-listed, default to NULL-tenant
    // legacy preview to mirror legacy behaviour. When active, use the
    // ALS tenant id.
    const tenantId = s.active ? s.tenantId : null;
    return this.tenantAuditLog.previewRetention({ tenantId, days }); // @tenant-reviewed: phase257-audit-log-http-retention-preview
  }

  /**
   * Phase 2.58 — tenant-scoped CSV export. Read-only by contract;
   * never mutates audit_logs. Reuses Phase 2.56's RBAC tenant
   * binding (`assertAuditReadAccess` + `auditTenantWhereForActor`)
   * so cross-tenant rows cannot be exported, NULL-tenant rows are
   * excluded for tenant-scoped actors, and global export requires
   * the explicit FULL_ACCESS + `AUDIT_LOG_GLOBAL_READ_ENABLED=true`
   * gate.
   *
   * Row cap: `AUDIT_LOG_EXPORT_MAX_ROWS` (default 50000; invalid
   * non-positive values fall back to 50000). The query takes the
   * top N rows by `createdAt desc` so the export is always finite.
   *
   * Tag: phase258-audit-log-export-csv.
   */
  async exportCsvForActor(
    filters: {
      entity?: string;
      entityId?: string;
      action?: string;
      userId?: string;
      fromDate?: string;
      toDate?: string;
    } = {},
    scope?: CallerScope,
  ): Promise<{ filename: string; contentType: string; body: string; rowCount: number; capped: boolean; maxRows: number }> {
    this.assertAuditReadAccess(scope); // @tenant-reviewed: phase256-audit-log-rbac-tenant-binding
    const tenantWhere = this.auditTenantWhereForActor(scope); // @tenant-reviewed: phase256-audit-log-actor-scope
    const where: any = { deletedAt: null, ...tenantWhere };
    if (scope) {
      const visibleIds = await this.resolveVisibleUserIds(scope);
      if (visibleIds !== undefined) where.userId = { in: visibleIds };
    }
    if (filters.entity) where.entity = filters.entity;
    if (filters.entityId) where.entityId = filters.entityId;
    if (filters.action) where.action = { contains: filters.action, mode: 'insensitive' };
    if (filters.userId) where.userId = filters.userId;
    if (filters.fromDate || filters.toDate) {
      where.createdAt = {};
      if (filters.fromDate) where.createdAt.gte = new Date(filters.fromDate);
      if (filters.toDate) where.createdAt.lte = new Date(filters.toDate);
    }

    const maxRows = resolveExportMaxRows();
    const rows = await this.prisma.auditLog.findMany({ // @tenant-reviewed: phase258-audit-log-export-csv
      where,
      orderBy: { createdAt: 'desc' },
      take: maxRows + 1, // request one extra to detect cap
    });

    const capped = rows.length > maxRows;
    const slice = capped ? rows.slice(0, maxRows) : rows;
    const body = renderAuditCsv(slice); // @tenant-reviewed: phase258-audit-log-export-csv
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    return {
      filename: `audit-export-${ts}.csv`,
      contentType: 'text/csv; charset=utf-8',
      body,
      rowCount: slice.length,
      capped,
      maxRows,
    };
  }
}

// ── CSV helpers (module-private; pure) ──────────────────────────────────────

/** Phase 2.58 — `AUDIT_LOG_EXPORT_MAX_ROWS` resolution.
 *  Invalid / non-positive ⇒ 50000 default.
 *  Tag: phase258-audit-log-export-row-cap. */
function resolveExportMaxRows(): number {
  const raw = Number(process.env.AUDIT_LOG_EXPORT_MAX_ROWS);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 50000;
}

/** Phase 2.58 — RFC-4180-style CSV escaping. Quotes fields that
 *  contain comma, double-quote, CR, or LF; doubles internal quotes.
 *  Lines joined with CRLF for Excel compatibility.
 *  Tag: phase258-audit-log-export-csv. */
function renderAuditCsv(rows: any[]): string {
  const cols = ['id','tenantId','createdAt','userId','userEmail','action','entity','entityId','ipAddress','userAgent'] as const;
  const esc = (v: unknown): string => {
    if (v === null || v === undefined) return '';
    const s = v instanceof Date ? v.toISOString() : String(v);
    if (/[",\r\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
    return s;
  };
  const lines = [cols.join(',')];
  for (const r of rows) lines.push(cols.map((c) => esc((r as any)[c])).join(','));
  return lines.join('\r\n') + '\r\n';
}
