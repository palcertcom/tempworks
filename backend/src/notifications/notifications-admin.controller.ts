import { BadRequestException, Body, Controller, Get, Param, Post, Put, Request, UseGuards } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { NotificationsService } from './notifications.service';
import { VersionWatcherService } from './version-watcher.service';
import { DocumentDigestCron } from './document-digest.cron';
import { NOTIF_EVENTS } from './notification-events';

/**
 * Stage 7 — admin entry points for the SYSTEM_* events.
 *
 * Three controlled endpoints let an admin publish the three
 * non-automatic SYSTEM events the spec calls out:
 *   - SYSTEM_MAINTENANCE     (downtime / maintenance announcement)
 *   - SYSTEM_AUDIT_ALERT     (an audit-defined critical event)
 *   - SYSTEM_BULK_JOB_RESULT (manual hook for ad-hoc bulk runs;
 *                             internal callers should prefer
 *                             NotificationsService.notifyAllUsers
 *                             directly so the wiring is explicit.)
 *
 * Scope:
 *   - tenantId on the body narrows the audience to one tenant.
 *     Omitting it broadcasts to every active user. Only a System
 *     Admin may omit; the @Roles gate here enforces the role, and
 *     non-platform admins can simply not call these endpoints.
 *   - Recipients still pass through the Stage 1 permission gate
 *     (per the event's registry entry) and the per-user matrix, so
 *     a user who muted in-app for SYSTEM_AUDIT_ALERT still gets
 *     nothing; the email channel still queues.
 */
@Controller('notifications/admin')
@UseGuards(JwtAuthGuard, RolesGuard)
export class NotificationsAdminController {
  constructor(
    private readonly notifications: NotificationsService,
    private readonly prisma: PrismaService,
    private readonly versionWatcher: VersionWatcherService,
    private readonly documentDigest: DocumentDigestCron,
  ) {}

  // ── Daily document digest — manual triggers + schedule (SUPER user) ──────
  //
  // The @Roles('System Admin') gate here is the platform-SUPER gate used
  // by every other admin endpoint in this controller (isPlatformAuthority
  // treats 'System Admin' / agencyIsSystem as SUPER). The frontend only
  // renders these controls when the same predicate holds.

  /**
   * "Send Me" — run the document digest for the calling user only.
   * Processes and stamps just this recipient's un-digested document
   * notifications, so a SUPER user can preview the digest without
   * touching everyone else's queue.
   */
  @Post('document-digest/send-me')
  @Roles('System Admin')
  async digestSendMe(@Request() req: any) {
    const result = await this.documentDigest.runOnce({ onlyUserId: req.user.id });
    return { scope: 'me', ...result };
  }

  /**
   * "Send All" — run the full scheduled digest immediately, for every
   * recipient with un-digested document notifications. Same code path
   * the cron fires on its daily schedule.
   */
  @Post('document-digest/send-all')
  @Roles('System Admin')
  async digestSendAll() {
    const result = await this.documentDigest.runOnce();
    return { scope: 'all', ...result };
  }

  /** Current daily-digest schedule (hour/minute/timezone). */
  @Get('document-digest/schedule')
  @Roles('System Admin')
  async getDigestSchedule() {
    return this.documentDigest.getSchedule();
  }

  /**
   * Update the daily-digest schedule. Body: { hour, minute, timezone? }.
   * Persists to system_settings and re-registers the cron job live —
   * no redeploy needed.
   */
  @Put('document-digest/schedule')
  @Roles('System Admin')
  async setDigestSchedule(
    @Request() req: any,
    @Body() body: { hour: number; minute: number; timezone?: string },
  ) {
    try {
      return await this.documentDigest.setSchedule(
        { hour: body?.hour, minute: body?.minute, timezone: body?.timezone },
        req.user?.id,
      );
    } catch (e) {
      throw new BadRequestException((e as Error)?.message ?? 'Invalid schedule');
    }
  }

  /**
   * Spec §4.11.2 — System Admin defines sensible defaults per role.
   *
   * GET (no roleId) — list every role with its saved defaults flag.
   * GET /:roleId   — the saved + effective matrix for one role.
   * PUT /:roleId   — replace the role's saved defaults.
   *
   * Defaults are global (the Role model is global) so a single
   * admin edit covers every tenant where users carry that role.
   */
  @Get('role-defaults')
  @Roles('System Admin')
  async listRoleDefaults() {
    const roles = await this.prisma.role.findMany({
      where: { deletedAt: null },
      select: { id: true, name: true, description: true },
      orderBy: { name: 'asc' },
    });
    // Surface a `hasDefaults` flag so the UI can mark roles that
    // have been customised without rendering the full matrix here.
    const rows = await this.prisma.$queryRawUnsafe<{ id: string; hasDefaults: boolean }[]>(
      `SELECT id, ("notificationDefaults" IS NOT NULL) AS "hasDefaults" FROM "roles" WHERE "deletedAt" IS NULL`,
    );
    const map = new Map(rows.map(r => [r.id, r.hasDefaults]));
    return roles.map(r => ({ ...r, hasDefaults: !!map.get(r.id) }));
  }

  @Get('role-defaults/:roleId')
  @Roles('System Admin')
  async getRoleDefaults(@Param('roleId') roleId: string) {
    return this.notifications.getRoleDefaults(roleId);
  }

  @Put('role-defaults/:roleId')
  @Roles('System Admin')
  async setRoleDefaults(@Param('roleId') roleId: string, @Body() data: any) {
    return this.notifications.setRoleDefaults(roleId, data);
  }

  @Post('maintenance')
  @Roles('System Admin')
  async announceMaintenance(
    @Request() req: any,
    @Body() body: {
      title: string;
      message: string;
      /** Omit to broadcast to every active user. */
      tenantId?: string;
      /** Optional scheduled-for ISO timestamp; surfaced in params so
       *  the UI / email body can render "scheduled for X". */
      scheduledFor?: string;
      /** URGENT | HIGH | NORMAL | LOW. Defaults to HIGH for maintenance
       *  so a routine NORMAL inbox doesn't bury the announcement. */
      priority?: string;
    },
  ) {
    return this.notifications.notifyAllUsers(
      body.tenantId,
      NOTIF_EVENTS.SYSTEM_MAINTENANCE,
      body.title?.trim() || 'System Maintenance',
      body.message?.trim() || 'A maintenance window is scheduled.',
      'SYSTEM',
      undefined,
      {
        titleKey: 'events.systemMaintenance.title',
        messageKey: 'events.systemMaintenance.body',
        params: { scheduledFor: body.scheduledFor ?? null, actorId: req.user?.id },
      },
      body.priority || 'HIGH',
    );
  }

  @Post('audit-alert')
  @Roles('System Admin')
  async announceAuditAlert(
    @Request() req: any,
    @Body() body: {
      title: string;
      message: string;
      tenantId?: string;
      entityType?: string;
      entityId?: string;
      /** URGENT | HIGH | NORMAL | LOW. Audit alerts default URGENT —
       *  the spec frames these as "audit / critical action logged". */
      priority?: string;
    },
  ) {
    return this.notifications.notifyAllUsers(
      body.tenantId,
      NOTIF_EVENTS.SYSTEM_AUDIT_ALERT,
      body.title?.trim() || 'Audit Alert',
      body.message?.trim() || 'A critical audit event was logged.',
      body.entityType?.toUpperCase() || 'SYSTEM',
      body.entityId,
      {
        titleKey: 'events.systemAuditAlert.title',
        messageKey: 'events.systemAuditAlert.body',
        params: { actorId: req.user?.id },
      },
      body.priority || 'URGENT',
    );
  }

  @Post('bulk-job-result')
  @Roles('System Admin')
  async announceBulkJobResult(
    @Request() req: any,
    @Body() body: {
      title: string;
      message: string;
      tenantId?: string;
      /** Application-defined job identifier; round-tripped via params. */
      jobId?: string;
      success?: boolean;
      /** URGENT | HIGH | NORMAL | LOW. Successful bulk runs stay
       *  NORMAL; failures default HIGH so they don't drown in
       *  routine traffic. */
      priority?: string;
    },
  ) {
    return this.notifications.notifyAllUsers(
      body.tenantId,
      NOTIF_EVENTS.SYSTEM_BULK_JOB_RESULT,
      body.title?.trim() || (body.success ? 'Bulk job completed' : 'Bulk job finished with errors'),
      body.message?.trim() || '',
      'SYSTEM',
      body.jobId,
      {
        titleKey: 'events.systemBulkJobResult.title',
        messageKey: 'events.systemBulkJobResult.body',
        params: { jobId: body.jobId ?? null, success: body.success ?? null, actorId: req.user?.id },
      },
      body.priority || (body.success === false ? 'HIGH' : 'NORMAL'),
    );
  }

  /**
   * Re-broadcast the SYSTEM_VERSION_UPDATED notification for the
   * running build. The automatic detector already fires on boot when
   * the version changes; this endpoint lets an admin force a
   * re-announcement (e.g. after a hotfix that bumped the version while
   * users were already mid-session).
   */
  @Post('version-updated')
  @Roles('System Admin')
  async announceVersionUpdate(
    @Body() body: {
      tenantId?: string;
      message?: string;
      /** URGENT | HIGH | NORMAL | LOW. Defaults to NORMAL. */
      priority?: string;
    } = {},
  ) {
    return this.versionWatcher.broadcast({
      tenantId: body.tenantId,
      message:  body.message,
      priority: body.priority,
    });
  }
}
