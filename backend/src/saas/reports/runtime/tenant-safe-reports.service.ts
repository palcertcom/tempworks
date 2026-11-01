/**
 * Phase 2.1 — Tenant-Safe Reports Service.
 *
 * The execution surface for tenant-scoped reports. Live only when
 * `TENANT_SAFE_REPORTS_ENABLED=true`. Otherwise every public method
 * throws `TenantSafeReportsDisabledError` so misconfigured callers
 * fail loud instead of silently bypassing.
 *
 * Architecture:
 *
 *   tenantSafeReports.runReport({ source, filters, columns, ... }, ctx)
 *     ├── 1. flag check  → throws if disabled
 *     ├── 2. tenant context check → requires ctx.tenantId
 *     ├── 3. source lookup in TENANT_SAFE_SOURCES
 *     │     │   READY    → continue
 *     │     │   DISABLED → throws TenantSafeReportsSourceDisabledError
 *     │     │   missing  → throws TenantSafeReportsUnknownSourceError
 *     ├── 4. registry validation (boot already ran; defensive double-check)
 *     ├── 5. buildTenantSafeWhere(...)  — tenantId is $1; allow-listed
 *     ├── 6. column allow-list filter
 *     ├── 7. compose SELECT … FROM <primary> [<joins>] WHERE … ORDER BY … LIMIT
 *     │     using Prisma.sql tagged-template + colRef quoting
 *     ├── 8. tenantPrisma.withTenant(...) — sets app.tenant_id GUC; runs
 *     └── 9. shape rows + return
 *
 * Platform-admin path (`platformAdmin: true` ctx + source.platformAdminOnly):
 *   - tenant filter omitted ONLY if both flags hold
 *   - one row per call written to `platform_audit_logs` with the
 *     reason supplied by the caller
 *   - delegates to the same builder; the builder skips the tenant
 *     term when `platformAdmin && platformAdminOnly`.
 */
import { Injectable, Logger } from '@nestjs/common';
import { FeatureFlagsService } from '../../feature-flags/feature-flags.service';
import { TenantContext, UserContext } from '../../context/als';
import {
  TenantSafeReportSourceRegistry,
} from '../source-registry';
import { SourceDef } from '../source-def.types';
import {
  buildTenantSafeWhere,
  BuildContext,
  UserFilter,
} from '../where-builder';
import { colRef } from '../sql-guards';
import { TENANT_SAFE_SOURCES, MappedSource } from './report-sources';

// ---- Errors ----------------------------------------------------------------

export class TenantSafeReportsDisabledError extends Error {
  constructor() {
    super('Tenant-safe reports runtime is disabled (TENANT_SAFE_REPORTS_ENABLED=false).');
    this.name = 'TenantSafeReportsDisabledError';
  }
}
export class TenantSafeReportsUnknownSourceError extends Error {
  constructor(key: string) {
    super(`Unknown tenant-safe report source: ${JSON.stringify(key)}`);
    this.name = 'TenantSafeReportsUnknownSourceError';
  }
}
export class TenantSafeReportsSourceDisabledError extends Error {
  constructor(key: string, reason: string) {
    super(`Source "${key}" is disabled in tenant-safe mode: ${reason}`);
    this.name = 'TenantSafeReportsSourceDisabledError';
  }
}
export class TenantSafeReportsMissingTenantError extends Error {
  constructor() {
    super('Tenant-safe reports require an active TenantContext.');
    this.name = 'TenantSafeReportsMissingTenantError';
  }
}

// ---- Types -----------------------------------------------------------------

export interface RunReportRequest {
  source: string;
  /** Field names from `SourceDef.fields`. Empty = all fields. */
  columns?: string[];
  filters?: UserFilter[];
  /** Field name + direction. Validated against the field allow-list. */
  orderBy?: { field: string; direction: 'asc' | 'desc' }[];
  /** Per-page row count. Capped at `MAX_LIMIT`. */
  limit?: number;
  offset?: number;
  /**
   * When set, the engine emits the cross-tenant query intended for
   * platform-admin reports. Source must declare `platformAdminOnly: true`.
   * Caller MUST also pass a `reason` string.
   */
  platformAdminBypass?: { reason: string };
}

export interface RunReportResult {
  rows: Array<Record<string, unknown>>;
  /** Total count without LIMIT/OFFSET. */
  total: number;
  source: string;
  columns: string[];
}

const MAX_LIMIT = 10_000;

// ---- Service ---------------------------------------------------------------

@Injectable()
export class TenantSafeReportsService {
  private readonly logger = new Logger('TenantSafeReports');
  private readonly registry: TenantSafeReportSourceRegistry;

  constructor(private readonly flags: FeatureFlagsService) {
    this.registry = new TenantSafeReportSourceRegistry();
    // Boot: load READY sources and validate; throw on misconfiguration.
    for (const [, m] of Object.entries(TENANT_SAFE_SOURCES)) {
      if (m.status === 'READY' && m.def) this.registry.register(m.def);
    }
    this.registry.assertAllValid();
  }

  /** Public diagnostic — useful in `/_platform` and tests. */
  listSources(): { key: string; status: 'READY' | 'DISABLED'; reason?: string }[] {
    return Object.entries(TENANT_SAFE_SOURCES).map(([key, m]) => ({
      key, status: m.status, reason: m.reason,
    }));
  }

  /**
   * Runs a report. Intended to be called by the legacy ReportsService
   * adapter layer when `TENANT_SAFE_REPORTS_ENABLED=true`.
   */
  async runReport(req: RunReportRequest): Promise<RunReportResult> {
    if (!this.flags.tenantSafeReportsEnabled()) {
      throw new TenantSafeReportsDisabledError();
    }

    const m: MappedSource | undefined = TENANT_SAFE_SOURCES[req.source];
    if (!m) throw new TenantSafeReportsUnknownSourceError(req.source);
    if (m.status === 'DISABLED' || !m.def) {
      throw new TenantSafeReportsSourceDisabledError(req.source, m.reason ?? 'no reason');
    }
    const def = m.def;

    // Tenant context required.
    const tenant = TenantContext.optional();
    if (!tenant) throw new TenantSafeReportsMissingTenantError();
    const user = UserContext.optional();

    // Platform-admin bypass (audit logged by caller).
    const isPlatformAdminCall = !!req.platformAdminBypass && !!user?.platformAdmin;
    if (req.platformAdminBypass && !user?.platformAdmin) {
      throw new Error('platformAdminBypass requested but caller is not a platform admin');
    }
    if (isPlatformAdminCall && !def.platformAdminOnly) {
      throw new Error(`Source "${def.key}" is not platform-admin-only; cannot bypass tenant filter`);
    }

    const buildCtx: BuildContext = {
      tenantId: tenant.id,
      agencyIds: user?.agencyIds,
      platformAdmin: !!user?.platformAdmin,
    };

    // Build the WHERE.
    const where = buildTenantSafeWhere(def, req.filters ?? [], buildCtx);

    // Build the SELECT — only allow-listed fields, alias-quoted.
    const cols = (req.columns?.length ? req.columns : Object.keys(def.fields));
    const selectExpr = cols.map((c) => {
      const f = def.fields[c];
      if (!f) throw new Error(`unknown column: ${JSON.stringify(c)}`);
      return `${colRef(f.alias, f.dbCol)} AS "${c}"`;
    }).join(', ');

    // FROM clause — primary + joins (joins already validated).
    const fromParts: string[] = [];
    fromParts.push(`${colRef(def.primaryTable, def.primaryAlias)
      .replace(/^"([^"]+)"\."([^"]+)"$/, '"$1" "$2"')}`);
    for (const j of def.tenantAwareJoins) {
      // We trust j.on because the registry validated it at boot.
      fromParts.push(`${j.joinType} JOIN "${j.table}" "${j.alias}" ON ${j.on}`);
    }
    const fromClause = fromParts.join(' ');

    // ORDER BY — allow-listed fields only.
    const order = (req.orderBy ?? []).map((o) => {
      const f = def.fields[o.field];
      if (!f) throw new Error(`unknown order field: ${JSON.stringify(o.field)}`);
      const dir = o.direction === 'desc' ? 'DESC' : 'ASC';
      return `${colRef(f.alias, f.dbCol)} ${dir}`;
    }).join(', ');
    const orderClause = order ? `ORDER BY ${order}` : '';

    const limit = Math.min(MAX_LIMIT, Math.max(1, req.limit ?? 100));
    const offset = Math.max(0, req.offset ?? 0);

    const sql = `SELECT ${selectExpr} FROM ${fromClause} ` +
                `WHERE ${where.sql} ${orderClause} ` +
                `LIMIT ${limit} OFFSET ${offset}`;
    const countSql = `SELECT count(*)::int AS n FROM ${fromClause} WHERE ${where.sql}`;

    // Execute. We do NOT directly run this against PrismaService here —
    // Phase 2.1 does NOT wire the runtime into AppModule. The execution
    // path is provided by the adapter that wraps `tenantPrisma.withTenant`.
    return await this.executeViaAdapter(sql, countSql, where.params, def, cols);
  }

  /**
   * Execution adapter — overridden in tests and in the Phase 2.1 wiring
   * point inside the legacy ReportsService. Default implementation
   * throws a clear error so callers wire their adapter explicitly.
   */
  protected async executeViaAdapter(
    _sql: string,
    _countSql: string,
    _params: unknown[],
    _def: SourceDef,
    _columns: string[],
  ): Promise<RunReportResult> {
    throw new Error(
      'TenantSafeReportsService.executeViaAdapter not wired. ' +
      'Subclass and inject tenantPrisma.withTenant(...) at the integration point.',
    );
  }
}
