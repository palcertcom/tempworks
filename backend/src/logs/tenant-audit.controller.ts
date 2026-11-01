import { Controller, Get, HttpException, HttpStatus, Param, Query, Res, UseGuards } from '@nestjs/common';
import { Response } from 'express';
import { ApiTags, ApiOperation, ApiBearerAuth, ApiQuery } from '@nestjs/swagger';
import { LogsService, FULL_ACCESS_ROLES } from './logs.service';
import { AuditLogRateLimiter } from './audit-log-rate-limiter.service';
import { TenantContext } from '../saas/context/als';
import { PaginationDto } from '../common/dto/pagination.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';

/**
 * Phase 2.57 — Tenant-scoped audit search/read HTTP endpoints.
 *
 * Read-ONLY endpoints. Reuse Phase 2.56's RBAC tenant binding via
 * `LogsService.findAll` / `getStats` / `findOneForActor` /
 * `previewRetentionForActor`. NO destructive routes (no
 * retention apply, no soft-delete, no hard-delete) — those remain
 * script-only by Phase 2.53/2.54 contract.
 *
 * Roles: System Admin and Compliance Officer only. The service
 * still applies the Phase 2.56 contract from inside, so even an
 * elevated role cannot read another tenant's rows in pilot mode
 * unless `AUDIT_LOG_GLOBAL_READ_ENABLED=true` AND the role is in
 * `FULL_ACCESS_ROLES`.
 */
@ApiTags('Tenant Audit Logs')
@ApiBearerAuth('access-token')
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('admin/tenant-audit')
export class TenantAuditController {
  constructor(
    private readonly logsService: LogsService,
    private readonly rateLimiter: AuditLogRateLimiter,
  ) {}

  /** Phase 2.59 — derive a per-tenant or per-user rate-limit key.
   *  - tenant-scoped roles ⇒ `tenant:<ALS-tenant-id>` (or `tenant:none`
   *    when ALS is missing; the caller's RBAC layer will refuse before
   *    the limiter can mask the access error).
   *  - FULL_ACCESS roles + global-read gate ⇒ `global:<userId>` so an
   *    elevated global reader does NOT consume a tenant's quota.
   *  Tag: phase259-audit-log-rate-limit-keying. */
  private rateLimitKey(caller: any): string {
    const isFull = caller && FULL_ACCESS_ROLES.includes(caller.role);
    const globalGate = String(process.env.AUDIT_LOG_GLOBAL_READ_ENABLED ?? '').toLowerCase() === 'true';
    if (isFull && globalGate) return `global:${caller.id ?? 'unknown'}`;
    const tid = TenantContext.optional?.()?.id ?? 'none';
    return `tenant:${tid}`;
  }

  /** Phase 2.59 — single throttle hook. ALL TenantAuditController
   *  GET routes call this BEFORE invoking LogsService so a rejected
   *  request never reaches the data path.
   *
   *  Phase 2.60 — on rejection sets `Retry-After` (when `res` is
   *  available) and throws a structured envelope:
   *    {
   *      error: 'rate_limited', message: 'Too Many Requests',
   *      retryAfterSeconds, limit, remaining, windowSeconds
   *    }
   *  Tags: phase259-audit-log-http-rate-limit,
   *  phase260-audit-log-rate-limit-envelope,
   *  phase260-audit-log-retry-after-header.
   */
  private enforceRateLimit(caller: any, res?: Response): void {
    const decision = this.rateLimiter.tryConsume(this.rateLimitKey(caller));
    if (res && decision.enabled) {
      res.set?.({
        'X-RateLimit-Limit':     String(decision.limit),
        'X-RateLimit-Remaining': String(decision.remaining),
        'X-RateLimit-Window':    String(decision.windowSeconds),
      });
    }
    if (decision.enabled && !decision.allowed) {
      // @tenant-reviewed: phase260-audit-log-retry-after-header (Retry-After header hint)
      if (res) res.set?.({ 'Retry-After': String(decision.retryAfterSeconds) });
      // @tenant-reviewed: phase260-audit-log-rate-limit-envelope (stable JSON envelope)
      throw new HttpException(
        {
          statusCode: 429,
          error: 'rate_limited',
          message: 'Too Many Requests',
          retryAfterSeconds: decision.retryAfterSeconds,
          limit: decision.limit,
          remaining: 0,
          windowSeconds: decision.windowSeconds,
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
  }

  @Get()
  @Roles('System Admin', 'Compliance Officer')
  @ApiOperation({ summary: 'Tenant-scoped audit log list (read-only)' })
  @ApiQuery({ name: 'entity',   required: false })
  @ApiQuery({ name: 'entityId', required: false })
  @ApiQuery({ name: 'action',   required: false })
  @ApiQuery({ name: 'userId',   required: false })
  @ApiQuery({ name: 'fromDate', required: false })
  @ApiQuery({ name: 'toDate',   required: false })
  // @tenant-reviewed: phase257-audit-log-http-read (delegates to RBAC-bound LogsService.findAll)
  list(
    @Query() pagination: PaginationDto,
    @CurrentUser() caller: any,
    @Query('entity')   entity?: string,
    @Query('entityId') entityId?: string,
    @Query('action')   action?: string,
    @Query('userId')   userId?: string,
    @Query('fromDate') fromDate?: string,
    @Query('toDate')   toDate?: string,
    @Res({ passthrough: true }) res?: Response,
  ) {
    this.enforceRateLimit(caller, res); // @tenant-reviewed: phase260-audit-log-retry-after-header
    return this.logsService.findAll(
      pagination,
      { entity, entityId, action, userId, fromDate, toDate },
      { role: caller.role, userId: caller.id, agencyId: caller.agencyId },
    );
  }

  @Get('stats')
  @Roles('System Admin', 'Compliance Officer')
  @ApiOperation({ summary: 'Tenant-scoped audit log statistics (read-only)' })
  // @tenant-reviewed: phase257-audit-log-http-read (delegates to RBAC-bound LogsService.getStats)
  stats(@CurrentUser() caller: any, @Res({ passthrough: true }) res?: Response) {
    this.enforceRateLimit(caller, res); // @tenant-reviewed: phase260-audit-log-retry-after-header
    return this.logsService.getStats({
      role: caller.role, userId: caller.id, agencyId: caller.agencyId,
    });
  }

  @Get('retention-preview')
  @Roles('System Admin', 'Compliance Officer')
  @ApiOperation({ summary: 'Tenant-scoped audit retention preview (count-only; never modifies data)' })
  @ApiQuery({ name: 'days', required: false })
  // @tenant-reviewed: phase257-audit-log-http-retention-preview (count-only; no destructive call)
  retentionPreview(
    @CurrentUser() caller: any,
    @Query('days') days?: string,
    @Res({ passthrough: true }) res?: Response,
  ) {
    this.enforceRateLimit(caller, res); // @tenant-reviewed: phase260-audit-log-retry-after-header
    const parsedDays = days ? Number(days) : undefined;
    return this.logsService.previewRetentionForActor(
      { role: caller.role, userId: caller.id, agencyId: caller.agencyId },
      Number.isFinite(parsedDays) ? parsedDays : undefined,
    );
  }

  @Get('export.csv')
  @Roles('System Admin', 'Compliance Officer')
  @ApiOperation({ summary: 'Tenant-scoped audit log CSV export (read-only; row-capped)' })
  @ApiQuery({ name: 'entity',   required: false })
  @ApiQuery({ name: 'entityId', required: false })
  @ApiQuery({ name: 'action',   required: false })
  @ApiQuery({ name: 'userId',   required: false })
  @ApiQuery({ name: 'fromDate', required: false })
  @ApiQuery({ name: 'toDate',   required: false })
  // @tenant-reviewed: phase258-audit-log-export-csv (row-capped read-only export; reuses Phase 2.56 RBAC binding inside the service)
  async exportCsv(
    @CurrentUser() caller: any,
    @Res() res: Response,
    @Query('entity')   entity?: string,
    @Query('entityId') entityId?: string,
    @Query('action')   action?: string,
    @Query('userId')   userId?: string,
    @Query('fromDate') fromDate?: string,
    @Query('toDate')   toDate?: string,
  ): Promise<void> {
    this.enforceRateLimit(caller, res); // @tenant-reviewed: phase259-audit-log-http-rate-limit
    const out = await this.logsService.exportCsvForActor(
      { entity, entityId, action, userId, fromDate, toDate },
      { role: caller.role, userId: caller.id, agencyId: caller.agencyId },
    );
    res.set({
      'Content-Type': out.contentType,
      'Content-Disposition': `attachment; filename="${out.filename}"`,
      // @tenant-reviewed: phase258-audit-log-export-row-cap
      'X-Audit-Export-Row-Count': String(out.rowCount),
      'X-Audit-Export-Max-Rows':  String(out.maxRows),
      'X-Audit-Export-Capped':    String(out.capped),
    });
    res.send(out.body);
  }

  @Get(':id')
  @Roles('System Admin', 'Compliance Officer')
  @ApiOperation({ summary: 'Tenant-scoped audit log by id (read-only)' })
  // @tenant-reviewed: phase257-audit-log-http-read
  byId(@Param('id') id: string, @CurrentUser() caller: any, @Res({ passthrough: true }) res?: Response) {
    this.enforceRateLimit(caller, res); // @tenant-reviewed: phase260-audit-log-retry-after-header
    return this.logsService.findOneForActor(id, {
      role: caller.role, userId: caller.id, agencyId: caller.agencyId,
    });
  }
}

// @tenant-reviewed: phase257-audit-log-http-no-destructive-routes
// This controller exposes ONLY GET routes (list / stats /
// retention-preview / by-id). Retention enforcement (Phase 2.53)
// and hard-delete (Phase 2.54) remain script-only and are not
// surfaced as HTTP endpoints by Phase 2.57 — see
// SAAS_PHASE2_AUDIT_LOG_HTTP_ENDPOINTS.md.
