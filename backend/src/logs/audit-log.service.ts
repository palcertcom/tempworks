import { Injectable, Logger } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { PrismaService } from '../prisma/prisma.service';
import { TenantContext } from '../saas/context/als';

export interface AuditLogData {
  userId?: string;
  userEmail?: string;
  action: string;
  entity: string;
  entityId: string;
  changes?: Record<string, any> | null;
  ipAddress?: string;
  userAgent?: string;
  /** Optional tenant attribution. When omitted, the helper falls back
   *  to the active ALS tenant frame so call sites running inside a
   *  request context are auto-stamped — operators reported NULL-tenant
   *  rows for events like TENANT_SWITCH, Role UPDATE, document VERIFY
   *  because the legacy callers never passed this field. Pass `null`
   *  explicitly to keep the pre-2C behaviour (NULL tenantId). */
  tenantId?: string | null;
}

@Injectable()
export class AuditLogService {
  private readonly logger = new Logger(AuditLogService.name);
  /** Cached critical-action list parsed from env. Empty = feature off. */
  private readonly criticalActions: Set<string>;

  constructor(
    private prisma: PrismaService,
    /** ModuleRef lookup avoids a hard NotificationsService injection
     *  and the circular-import risk that would come with it. We grab
     *  the service at the moment we need it; if it isn't bound (e.g.
     *  in a test that doesn't load NotificationsModule), the audit
     *  log still records and we just skip the broadcast. */
    private readonly moduleRef: ModuleRef,
  ) {
    const raw = String(process.env.AUDIT_CRITICAL_ACTIONS ?? '').trim();
    this.criticalActions = new Set(
      raw ? raw.split(',').map(s => s.trim()).filter(Boolean) : [],
    );
  }

  /** Create an audit log entry. Never throws – logging must not break the main flow. */
  async log(data: AuditLogData): Promise<void> {
    try {
      const { tenantId, ...rest } = data;
      // Resolve precedence: explicit non-null arg → ALS frame → null.
      // `tenantId === null` (explicit) opts out of the fallback so the
      // legacy contract (write a NULL row on purpose) still works.
      const resolvedTenantId =
        tenantId === undefined
          ? (TenantContext.optional?.()?.id ?? null)
          : tenantId;
      await this.prisma.auditLog.create({
        data: {
          ...rest,
          ...(resolvedTenantId ? { tenantId: resolvedTenantId } : {}),
        },
      });

      // Spec §4.11 — SYSTEM_AUDIT_ALERT auto-emit. When the action
      // matches an operator-configured list of critical actions, also
      // broadcast a system notification so every user in the tenant
      // sees it. The list is env-tuned (defaults to empty so this
      // never fires by accident); typical entries are HARD_DELETE,
      // DELETE_ROLE, TENANT_SWITCH, etc.
      if (this.criticalActions.size > 0 && this.criticalActions.has(data.action)) {
        await this.broadcastAuditAlert(data, resolvedTenantId);
      }
    } catch (err: any) {
      this.logger.error(`Failed to write audit log: ${err?.message}`, err?.stack);
    }
  }

  private async broadcastAuditAlert(data: AuditLogData, tenantId: string | null): Promise<void> {
    // Late-bind to avoid the cyclic dep. `strict: false` searches the
    // whole app, not just LogsModule. If NotificationsService isn't
    // registered we silently skip — audit row is already persisted.
    let notifications: any;
    try {
      const { NotificationsService } = await import('../notifications/notifications.service');
      notifications = this.moduleRef.get(NotificationsService as any, { strict: false });
    } catch { notifications = null; }
    if (!notifications?.notifyAllUsers) return;

    const title = `Critical action: ${data.action}`;
    const message = `User ${data.userEmail ?? data.userId ?? 'unknown'} performed "${data.action}" on ${data.entity}${data.entityId ? ` (${data.entityId})` : ''}.`;
    try {
      await notifications.notifyAllUsers(
        tenantId ?? undefined,
        'SYSTEM_AUDIT_ALERT',
        title,
        message,
        data.entity || 'SYSTEM',
        data.entityId || undefined,
        {
          titleKey: 'events.systemAuditAlert.title',
          messageKey: 'events.systemAuditAlert.body',
          params: { action: data.action, actorId: data.userId, actorEmail: data.userEmail, entity: data.entity, entityId: data.entityId },
        },
      );
    } catch (err: any) {
      this.logger.warn(`SYSTEM_AUDIT_ALERT broadcast failed: ${err?.message}`);
    }
  }
}
