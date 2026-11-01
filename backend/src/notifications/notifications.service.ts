import { Injectable, NotFoundException, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { NotificationType } from '@prisma/client';
import {
  EVENT_TO_TYPE, NotifEventKey,
  NOTIF_EVENT_META, NOTIF_EVENTS,
  metaFor, mergeWithDefaults, getDefaultPrefs,
  type UserNotifPrefs,
} from './notification-events';
import { tServer, ServerLocale } from '../common/i18n/server-translate';
import { PilotPrismaAccessor } from '../saas/prisma/pilot-prisma.accessor';
import { getPilotScope, PilotScope } from '../saas/prisma/tenant-pilot-scope';
import { activeTenantWhere } from '../saas/prisma/active-tenant-where';
import { buildSuperUserTenantWhereDirect, assertRequestedTenantExists } from '../saas/prisma/super-user-tenant-filter';
import { FeatureFlagsService } from '../saas/feature-flags/feature-flags.service';
import {
  TenantJobFanoutPlanner,
  runForTenantBatch,
} from '../saas/jobs';
import { TenantContext, MissingTenantContextError } from '../saas/context/als';
import { classifyRuntimeEnv, isStagingClassification } from '../saas/tenancy/env-safety';

/**
 * Phase 2.10 — fourth tenant-scoped TenantPrisma pilot.
 *
 * IN SCOPE for tenant-safe routing:
 *   - getUserNotifications, getUnreadCount, markAsRead, markAllAsRead
 *   - wasHighBalanceAlertRecentlySent (read probe)
 *
 * EXPLICITLY OUT OF SCOPE (continue to use `legacyPrisma`; these will
 * be revisited in a later phase that introduces a job-context for
 * background workers):
 *   - checkExpiringCompliance / checkServiceDue / checkOverdue /
 *     checkScheduledMaintenance / runAllChecks
 *   - notifyUploaderAndRoles / notifyUsersByRoles
 *   - getOrCreatePreferences / updatePreferences (NotificationPreference
 *     has NO `tenantId` — it is a per-user global record)
 *
 * The pilot scope is active iff:
 *   - `TENANT_PRISMA_PILOT_ENABLED=true`, AND
 *   - `TENANT_PRISMA_PILOT_MODULES` empty or includes `notifications`, AND
 *   - env classifies as SAFE_CLONE / SAFE_STAGING, AND
 *   - a tenant is in the active ALS frame.
 *
 * With the flag OFF (production default) the spreads return `{}` and
 * every read path is byte-identical to before this PR.
 */
@Injectable()
export class NotificationsService {
  private readonly logger = new Logger('NotificationsService');

  constructor(
    private readonly legacyPrisma: PrismaService,
    private readonly pilot: PilotPrismaAccessor,
    /** Optional: when undefined, the tenant-aware paths default to
     *  legacy behaviour (flags treated as off). The harness can pass
     *  a configured FeatureFlagsService to drive the new path. */
    private readonly flags?: FeatureFlagsService,
  ) {}

  /** True iff Phase 2.14's tenant-aware scheduler path is engaged. */
  private tenantAwareSchedulerActive(): boolean {
    if (!this.flags) return false;
    if (!this.flags.tenantAwareJobsEnabled()) return false;
    if (!this.flags.tenantJobFanoutEnabled()) return false;
    const env = classifyRuntimeEnv();
    return isStagingClassification(env.classification);
  }

  /**
   * Phase 2.14.1 — per-method tenant narrowing helper.
   *
   * Returns the active tenant id when:
   *   - the tenant-aware scheduler path is engaged, AND
   *   - a tenant is in the active ALS frame.
   *
   * Returns `null` in every other case — including:
   *   - any flag off,
   *   - production / unsafe env,
   *   - inside `runAllChecks` (legacy path; never wrapped in
   *     `runForTenant`),
   *   - direct test calls without an ALS frame.
   *
   * Each `check*` method consults this once at the top of its body
   * and spreads the result into its `where` / `data`. When `null`,
   * the spread is `{}` and the method runs byte-identically to its
   * pre-Phase-2.14.1 form.
   */
  private narrowingTenantId(): string | null {
    if (!this.tenantAwareSchedulerActive()) return null;
    return TenantContext.optional()?.id ?? null;
  }

  /** Prisma surface for in-scope read paths. Background workers keep
   *  using `this.legacyPrisma` directly — see scope-split doc. */
  private get prisma(): PrismaService {
    return this.pilot.client();
  }

  private scope(): PilotScope {
    return getPilotScope(this.pilot, 'notifications');
  }

  /**
   * Translate a stored notification row into the active locale.
   *
   * Lookup order per field:
   *   1. `tServer(<key>, params, locale)` when `titleKey`/`messageKey`
   *      is set AND the catalog has a matching entry
   *   2. the stored English `title`/`message` (always populated)
   *
   * `tServer()` already falls back through (locale → en → verbatim key),
   * so a brand-new producer key with no catalog entry yet shows the key
   * string in dev — making missing translations easy to spot — without
   * losing the legacy English message that the reader returns alongside.
   */
  private translateRow<T extends { title: string; message: string; titleKey: string | null; messageKey: string | null; params: any }>(
    row: T,
    locale: ServerLocale,
  ): T {
    const params = (row.params && typeof row.params === 'object' ? row.params : {}) as Record<string, unknown>;
    const translatedTitle = row.titleKey
      ? tServer(row.titleKey, params, locale, 'notifications')
      : null;
    const translatedMessage = row.messageKey
      ? tServer(row.messageKey, params, locale, 'notifications')
      : null;
    // Translate the priority rank back to its display name so the UI
    // never has to know about the integer encoding. NULL/undefined
    // (legacy rows on a host that hasn't backfilled yet) renders as
    // NORMAL — the same default the column uses.
    const priorityRank = (row as any).priority;
    const priorityName = NotificationsService.priorityRankToName(priorityRank);
    return {
      ...row,
      priority: priorityName,
      // Replace the field with the translated value when available.
      // Crucially we never overwrite when the key is null — legacy rows
      // (where titleKey is null) keep the original English text intact.
      title: translatedTitle && translatedTitle !== row.titleKey ? translatedTitle : row.title,
      message: translatedMessage && translatedMessage !== row.messageKey ? translatedMessage : row.message,
    };
  }

  /** Priority encoding (§4.11.4). Stored as INT so natural numeric
   *  sort = priority order; exposed to clients as the display name. */
  static readonly PRIORITY_NAMES = ['URGENT', 'HIGH', 'NORMAL', 'LOW'] as const;
  static priorityNameToRank(name: string | null | undefined): number | null {
    if (!name) return null;
    const idx = NotificationsService.PRIORITY_NAMES.indexOf(name.toUpperCase() as any);
    return idx < 0 ? null : idx + 1;
  }
  static priorityRankToName(rank: number | null | undefined): string {
    if (typeof rank !== 'number') return 'NORMAL';
    const i = rank - 1;
    return NotificationsService.PRIORITY_NAMES[i] ?? 'NORMAL';
  }

  /// Get notifications for a user with pagination.
  /// `locale` is the resolved `Accept-Language` value; defaults to 'en'.
  /// `caller` is passed through so external actors (Agency User/Manager
  /// + custom roles tied to a non-system agency) only see notifications
  /// about entities they can actually access — see callerEntityFilter().
  async getUserNotifications(
    userId: string,
    skip = 0,
    take = 20,
    locale: ServerLocale = 'en',
    caller?: { agencyId?: string; agencyIsSystem?: boolean; tenantId?: string | null },
    tenantIdQuery?: string,
    filters?: {
      isRead?: boolean;
      type?: string;
      eventType?: string;
      category?: string;
      channel?: string;
      priority?: string;
      relatedPerson?: string;
      search?: string;
      dateFrom?: string;
      dateTo?: string;
      sortBy?: 'createdAt' | 'priority' | 'category';
      sortOrder?: 'asc' | 'desc';
    },
  ) {
    const t = this.scope().tenantWhere();
    const entityFilter = await this.callerEntityFilter(caller);
    // Phase F2 (SPIKE-010 Batch 2) — SUPER USER tenant override.
    await assertRequestedTenantExists(caller, tenantIdQuery, this.legacyPrisma.tenant);
    const superTenantPredicate = buildSuperUserTenantWhereDirect(caller, tenantIdQuery);
    // Phase 2 (#5) — also enforce the caller's active tenant.
    // SUPER's explicit per-page tenant override wins over the session's
    // active tenant. When SUPER hasn't supplied an override, also skip
    // the active-tenant predicate so they see every notification
    // addressed to their userId across tenants — otherwise a SUPER
    // viewing s.r.o would miss notifications stamped to Europe (e.g.
    // birthday reminders cross-tenant) even though the notification is
    // addressed directly to them.
    const isSuper = caller?.agencyIsSystem === true || (caller as any)?.role === 'System Admin';
    // Non-SUPER tenant scope: match the active tenant OR rows with no
    // tenant stamped. Legacy notifications (the vast majority for any
    // tenant that pre-dates Phase 2) carry tenantId=NULL — without the
    // null-pass-through every user lost access to their own historical
    // notifications the moment tenant scoping shipped.
    const tenantScope: any = superTenantPredicate || isSuper
      ? {}
      : (() => {
          const aw = activeTenantWhere(caller);
          if (!(aw as any).tenantId) return {};
          return { OR: [aw, { tenantId: null }] };
        })();
    const where: any = {
      userId, deletedAt: null, ...t,
      ...tenantScope,
      ...entityFilter,
    };
    if (superTenantPredicate) where.AND = [...(where.AND ?? []), superTenantPredicate];

    // Spec §4.11.4 — server-side filters / search. All optional;
    // omitted filters fall through to the legacy behaviour.
    if (filters?.isRead !== undefined) where.isRead = filters.isRead;
    if (filters?.type) where.type = filters.type as NotificationType;
    if (filters?.eventType) where.eventType = filters.eventType;
    // Channel filter. The row is written with channel='in_app'; an
    // 'email' value reflects rows that were also dispatched via the
    // outbox (today, every row created by a fanout also queues an
    // email when the user opts in, so this filter is mostly useful
    // when the operator wants to look at rows whose email actually
    // sent vs. only stayed in the in-app inbox).
    if (filters?.channel) where.channel = filters.channel;
    if (filters?.priority) {
      const rank = NotificationsService.priorityNameToRank(filters.priority);
      if (rank != null) (where as any).priority = rank;
    }

    // Related-person filter (§4.11.4). The string can be a name part,
    // an email, or a business id (E2026…, C2026…, A2026…). We resolve
    // it server-side to a set of matching APPLICANT/EMPLOYEE ids and
    // filter notifications whose relatedEntityId is in that set.
    // Cheap because the matchset is small per user and is bounded by
    // the existing per-entity tenant scopes.
    if (filters?.relatedPerson) {
      const q = filters.relatedPerson.trim();
      if (q) {
        const [emps, apps] = await Promise.all([
          this.legacyPrisma.employee.findMany({
            where: {
              deletedAt: null,
              OR: [
                { firstName:      { contains: q, mode: 'insensitive' } },
                { lastName:       { contains: q, mode: 'insensitive' } },
                { email:          { contains: q, mode: 'insensitive' } },
                { employeeNumber: { contains: q, mode: 'insensitive' } },
              ],
            },
            select: { id: true },
            take: 200,
          }),
          this.legacyPrisma.applicant.findMany({
            where: {
              deletedAt: null,
              OR: [
                { firstName:       { contains: q, mode: 'insensitive' } },
                { lastName:        { contains: q, mode: 'insensitive' } },
                { email:           { contains: q, mode: 'insensitive' } },
                { candidateNumber: { contains: q, mode: 'insensitive' } },
                { leadNumber:      { contains: q, mode: 'insensitive' } },
              ],
            },
            select: { id: true },
            take: 200,
          }),
        ]);
        const ids = [...emps.map(e => e.id), ...apps.map(a => a.id)];
        // Empty match-set should still produce an empty result, not
        // disable the filter — so we send an impossible id.
        where.relatedEntityId = { in: ids.length ? ids : ['__none__'] };
      }
    }
    if (filters?.category) {
      // Translate the high-level matrix category (Documents / Pipeline /
      // …) into the set of event keys that belong to it, so a single
      // filter pill covers every event in the bucket.
      const eventKeys = NOTIF_EVENT_META
        .filter(m => m.category === filters.category)
        .map(m => m.key);
      if (eventKeys.length) where.eventType = { in: eventKeys };
    }
    if (filters?.dateFrom || filters?.dateTo) {
      where.createdAt = {};
      if (filters.dateFrom) where.createdAt.gte = new Date(filters.dateFrom);
      if (filters.dateTo)   where.createdAt.lte = new Date(filters.dateTo);
    }
    if (filters?.search) {
      // Search title + message; the i18n keyed strings (titleKey /
      // messageKey) aren't searchable without the locale bundle, so
      // we accept the limitation and search the English fallback.
      const q = filters.search.trim();
      if (q) {
        where.AND = [
          ...(where.AND ?? []),
          { OR: [
            { title:   { contains: q, mode: 'insensitive' } },
            { message: { contains: q, mode: 'insensitive' } },
          ] },
        ];
      }
    }

    const sortOrder = filters?.sortOrder === 'asc' ? 'asc' : 'desc';
    // Sort by createdAt (default), priority, or category. The priority
    // column stores numeric ranks (1=URGENT through 4=LOW), so asc
    // puts URGENT first and desc puts LOW first. "category" is a
    // proxy sort on `eventType` — every event key is prefixed with
    // its category (DOCUMENT_*, FINANCIAL_*, APPLICANT_*, EMPLOYEE_*,
    // PIPELINE_*, SYSTEM_*), so alphabetical eventType ordering also
    // groups by category. A secondary createdAt desc keeps order
    // stable within a tier.
    const orderBy: any =
      filters?.sortBy === 'priority'
        ? [{ priority: sortOrder }, { createdAt: 'desc' }]
        : filters?.sortBy === 'category'
          ? [{ eventType: sortOrder }, { createdAt: 'desc' }]
          : [{ createdAt: sortOrder }];

    const [notifications, total] = await Promise.all([
      this.prisma.notification.findMany({ // @tenant-reviewed: phase210-pilot-scope
        where,
        orderBy,
        skip,
        take,
      }),
      this.prisma.notification.count({ // @tenant-reviewed: phase210-pilot-scope
        where,
      }),
    ]);
    return { data: notifications.map(n => this.translateRow(n as any, locale)), total };
  }

  /// Get unread notification count for a user
  async getUnreadCount(
    userId: string,
    caller?: { agencyId?: string; agencyIsSystem?: boolean; tenantId?: string | null },
  ): Promise<number> {
    const t = this.scope().tenantWhere();
    const entityFilter = await this.callerEntityFilter(caller);
    // Phase 3 (#1 R-2) — also enforce the caller's active tenant so the
    // bell badge matches the list. Without this, SUPER + pilot-off
    // returns a global unread count even though getUserNotifications
    // (which renders the list) is correctly tenant-scoped.
    // SUPER bypasses the active-tenant predicate so the badge counts
    // every unread the user holds across tenants — matches the list.
    // Non-SUPER also OR-includes tenantId=null rows so legacy unstamped
    // notifications stay counted (same justification as the list path).
    const isSuper = caller?.agencyIsSystem === true || (caller as any)?.role === 'System Admin';
    const tenantScope: any = isSuper
      ? {}
      : (() => {
          const aw = activeTenantWhere(caller);
          if (!(aw as any).tenantId) return {};
          return { OR: [aw, { tenantId: null }] };
        })();
    return this.prisma.notification.count({ // @tenant-reviewed: phase210-pilot-scope
      where: {
        userId, isRead: false, deletedAt: null, ...t,
        ...tenantScope,
        ...entityFilter,
      },
    });
  }

  /**
   * Phase 3.22 — restrict notifications about Employees/Applicants to
   * the entities the caller can actually view. Without this filter an
   * Officer (or any custom external role) sees notifications about
   * every employee in the tenant simply because finance/document
   * fan-out broadcast their notification to every user with the
   * relevant role at creation time. Returns `{}` for PlatformAdmin
   * and System Admin so they keep the global view.
   *
   * Filter shape:
   *   • Notifications with no relatedEntity              → pass
   *   • Notifications about anything except Employee /
   *     Applicant (Vehicle, MaintenanceRecord, Document,
   *     etc.)                                            → pass
   *   • Notifications about Employee / Applicant         → only if
   *     relatedEntityId is one the caller has access to
   *
   * The Employee accessible set comes from
   * EmployeeAgencyAccess(canView=true), the same source
   * EmployeesService.findAll uses. The Applicant set comes from
   * agencyId == caller.agencyId (mirrors ApplicantsService.findAll).
   * Entity type strings cover both `'Employee'` (vehicle/scan side)
   * and `'EMPLOYEE'` (finance side) since the codebase doesn't
   * normalise them.
   */
  private async callerEntityFilter(
    caller?: { agencyId?: string; agencyIsSystem?: boolean },
  ): Promise<Record<string, any>> {
    if (!caller || !caller.agencyId || caller.agencyIsSystem === true) return {};
    const t = this.scope().tenantWhere();
    const [empGrants, applicants] = await Promise.all([
      this.prisma.employeeAgencyAccess.findMany({ // @tenant-reviewed: phase322-notifications-entity-scope
        where: { agencyId: caller.agencyId, canView: true },
        select: { employeeId: true },
      }),
      this.prisma.applicant.findMany({ // @tenant-reviewed: phase322-notifications-entity-scope
        where: { agencyId: caller.agencyId, deletedAt: null, ...t },
        select: { id: true },
      }),
    ]);
    const accessibleIds = [
      ...empGrants.map((g: any) => g.employeeId),
      ...applicants.map((a: any) => a.id),
    ];
    const RESTRICTED = ['Employee', 'EMPLOYEE', 'Applicant', 'APPLICANT'];
    return {
      OR: [
        { relatedEntity: null },
        { relatedEntity: { notIn: RESTRICTED } },
        {
          AND: [
            { relatedEntity: { in: RESTRICTED } },
            // Sentinel '__none__' keeps the IN clause non-empty when
            // the user has zero accessible entities — Prisma would
            // otherwise translate `in: []` to a no-op match.
            { relatedEntityId: { in: accessibleIds.length > 0 ? accessibleIds : ['__none__'] } },
          ],
        },
      ],
    };
  }

  /// Mark a notification as read.
  ///
  /// Pilot mode adds a tenant-scoped pre-check so a foreign-tenant
  /// notification id presents as 404 instead of mutating across
  /// tenants. Legacy mode keeps the original `update(by id)` behaviour
  /// — Prisma's P2025 path remains the contract for missing ids.
  async markAsRead(notificationId: string) {
    const scope = this.scope();
    if (scope.active) {
      const existing = await this.prisma.notification.findFirst({ // @tenant-reviewed: phase210-pilot-scope
        where: { id: notificationId, deletedAt: null, ...scope.tenantWhere() },
        select: { id: true },
      });
      if (!existing) throw new NotFoundException('Notification not found');
    }
    return this.prisma.notification.update({ // @tenant-reviewed: phase210-pilot-scope
      where: { id: notificationId },
      data: { isRead: true, readAt: new Date() },
    });
  }

  /// Mark all notifications as read for a user
  async markAllAsRead(userId: string) {
    const t = this.scope().tenantWhere();
    return this.prisma.notification.updateMany({ // @tenant-reviewed: phase210-pilot-scope
      where: { userId, isRead: false, deletedAt: null, ...t },
      data: { isRead: true, readAt: new Date() },
    });
  }

  /// Mark a single notification as UN-read (toggle back).
  async markAsUnread(notificationId: string) {
    const t = this.scope().tenantWhere();
    const existing = await this.prisma.notification.findFirst({ // @tenant-reviewed: phase210-pilot-scope
      where: { id: notificationId, deletedAt: null, ...t },
    });
    if (!existing) throw new NotFoundException(`Notification ${notificationId} not found`);
    return this.prisma.notification.update({ // @tenant-reviewed: phase210-pilot-scope
      where: { id: notificationId },
      data: { isRead: false, readAt: null },
    });
  }

  /// Soft-delete a single notification.
  ///
  /// Spec §4.11.3/4: users may dismiss individual notifications from
  /// their inbox. The row stays in the table with `deletedAt` set so
  /// audit can still see it; every read path already filters by
  /// `deletedAt: null`.
  async softDelete(notificationId: string, userId: string) {
    const t = this.scope().tenantWhere();
    // Ownership gate so user A can't dismiss user B's notification by
    // guessing an id. Tenant scope is applied by the spread.
    const existing = await this.prisma.notification.findFirst({ // @tenant-reviewed: phase210-pilot-scope
      where: { id: notificationId, userId, deletedAt: null, ...t },
    });
    if (!existing) throw new NotFoundException(`Notification ${notificationId} not found`);
    await this.prisma.notification.update({ // @tenant-reviewed: phase210-pilot-scope
      where: { id: notificationId },
      data: { deletedAt: new Date() },
    });
    return { success: true };
  }

  /// Mark a list of user-owned notifications as read in one call.
  /// Skips rows owned by another user, already read, soft-deleted, or
  /// in a different tenant. Returns the actual updated count so the
  /// UI can report "marked N as read".
  async bulkMarkAsRead(notificationIds: string[], userId: string) {
    if (!notificationIds?.length) return { updated: 0 };
    const t = this.scope().tenantWhere();
    const res = await this.prisma.notification.updateMany({ // @tenant-reviewed: phase210-pilot-scope
      where: { id: { in: notificationIds }, userId, isRead: false, deletedAt: null, ...t },
      data: { isRead: true, readAt: new Date() },
    });
    return { updated: res.count };
  }

  /// Mark a list of notifications as unread.
  ///
  /// Mirror of `bulkMarkAsRead` — restricted to rows the caller owns
  /// and only updates ones currently read so the count reflects real
  /// transitions.
  async bulkMarkAsUnread(notificationIds: string[], userId: string) {
    if (!notificationIds?.length) return { updated: 0 };
    const t = this.scope().tenantWhere();
    const res = await this.prisma.notification.updateMany({ // @tenant-reviewed: phase210-pilot-scope
      where: { id: { in: notificationIds }, userId, isRead: true, deletedAt: null, ...t },
      data: { isRead: false, readAt: null },
    });
    return { updated: res.count };
  }

  /// Soft-delete a list of notifications owned by the user. Returns
  /// the count actually deleted (rows owned by another user, already
  /// deleted, or in a different tenant are silently skipped).
  async bulkSoftDelete(notificationIds: string[], userId: string) {
    if (!notificationIds?.length) return { deleted: 0 };
    const t = this.scope().tenantWhere();
    const res = await this.prisma.notification.updateMany({ // @tenant-reviewed: phase210-pilot-scope
      where: { id: { in: notificationIds }, userId, deletedAt: null, ...t },
      data: { deletedAt: new Date() },
    });
    return { deleted: res.count };
  }

  /// Get or create notification preferences for a user.
  ///
  /// `NotificationPreference` has NO `tenantId` — it is a per-user
  /// global record. Phase 2.10 does NOT route this through the pilot
  /// accessor; preferences are reached via `legacyPrisma` directly.
  async getOrCreatePreferences(userId: string) {
    const row = await this.legacyPrisma.notificationPreference.upsert({ // @tenant-reviewed: phase210-global (NotificationPreference is per-user global)
      where: { userId },
      update: {},
      create: { userId },
    });
    // Effective matrix: user-saved → role-default → global-default,
    // merged at the per-channel cell level. Stage 10 introduced the
    // role tier; before that the matrix was a 2-tier user→global
    // merge. The settings UI renders this as the user's "current"
    // matrix — gaps inherit from role/global so the operator sees
    // what they'll actually receive.
    const matrix = await this.resolveEffectiveMatrix(userId);
    return {
      ...row,
      ...matrix,
      meta: NOTIF_EVENT_META,
    };
  }

  /// Update notification preferences (per-user global record).
  ///
  /// Accepts either:
  ///   - the legacy shape (top-level model fields like
  ///     `complianceDaysBefore`, `enableEmailNotifications`, …), OR
  ///   - the new matrix shape `{ preferences: { [eventKey]: { in_app,
  ///     email, sms } } }`, OR
  ///   - both, in the same payload.
  async updatePreferences(userId: string, data: any) {
    const payload = data ?? {};
    // Partition the payload: any object value with at least one of the
    // channel slots is treated as a matrix entry; everything else is a
    // model field. This handles BOTH shapes the frontend may send:
    //   - flat: { DOCUMENT_UPLOADED: {in_app,email}, complianceDaysBefore: 30 }
    //   - nested: { preferences: { DOCUMENT_UPLOADED: {...} } }
    const isChannelPrefs = (v: any) =>
      v && typeof v === 'object' && !Array.isArray(v) &&
      ('in_app' in v || 'email' in v || 'sms' in v);

    const incomingMatrix: Partial<UserNotifPrefs> = {};
    const modelFields: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(payload)) {
      if (k === 'meta') continue; // legacy round-trip — ignore
      if (k === 'preferences' && v && typeof v === 'object') {
        // nested shape — flatten into incomingMatrix
        Object.assign(incomingMatrix, v as object);
        continue;
      }
      if (isChannelPrefs(v)) {
        (incomingMatrix as any)[k] = v;
      } else {
        modelFields[k] = v;
      }
    }

    // Ensure the parent row exists (matrix lives there via raw SQL).
    await this.legacyPrisma.notificationPreference.upsert({ // @tenant-reviewed: phase210-global
      where: { userId },
      update: {},
      create: { userId },
    });

    if (Object.keys(modelFields).length) {
      await this.legacyPrisma.notificationPreference.update({ // @tenant-reviewed: phase210-global
        where: { userId },
        data: modelFields,
      });
    }

    if (Object.keys(incomingMatrix).length) {
      // Merge with previously-saved matrix so a partial save (e.g. one
      // toggle flipped) doesn't blank out events that weren't sent.
      const previous = mergeWithDefaults(await this.readMatrix(userId));
      const merged = mergeWithDefaults({ ...previous, ...incomingMatrix });
      await this.writeMatrix(userId, merged);

      // Cancel any PENDING outbox rows for events whose effective
      // email channel ended up false. Without this, a row queued
      // moments before the toggle would still drain on the next
      // 60s worker tick. CANCELLED is a terminal status; the worker
      // skips it and the claim query excludes non-PENDING rows.
      const emailOffEvents: string[] = [];
      for (const meta of NOTIF_EVENT_META) {
        if (merged[meta.key]?.email !== true) emailOffEvents.push(meta.key);
      }
      if (emailOffEvents.length > 0) {
        try {
          await this.legacyPrisma.$executeRawUnsafe(
            `UPDATE "notification_email_outbox"
                SET "status" = 'CANCELLED',
                    "lastError" = 'user opted out of email for this event'
              WHERE "userId" = $1
                AND "status"  = 'PENDING'
                AND "eventType" = ANY($2::text[])`,
            userId,
            emailOffEvents,
          );
        } catch (e) {
          this.logger.warn(`outbox cancel for ${userId} failed: ${(e as Error)?.message}`);
        }
      }
    }

    return this.getOrCreatePreferences(userId);
  }

  /** Raw-SQL read of the per-event preferences JSON. Returns null when
   *  the user has never saved a matrix, so callers fall back to
   *  defaults via `mergeWithDefaults`. */
  private async readMatrix(userId: string): Promise<Partial<UserNotifPrefs> | null> {
    try {
      const rows = await this.legacyPrisma.$queryRawUnsafe<{ preferences: any }[]>(
        `SELECT "preferences" FROM "notification_preferences" WHERE "userId" = $1 LIMIT 1`,
        userId,
      );
      const raw = rows?.[0]?.preferences;
      if (!raw) return null;
      // pg's JSONB driver returns the parsed value directly; string
      // form only appears in older deployments using TEXT columns.
      return typeof raw === 'string' ? JSON.parse(raw) : raw;
    } catch (e) {
      this.logger.warn(`readMatrix failed for user ${userId}: ${(e as Error)?.message}`);
      return null;
    }
  }

  private async writeMatrix(userId: string, matrix: UserNotifPrefs): Promise<void> {
    await this.legacyPrisma.$executeRawUnsafe(
      `UPDATE "notification_preferences" SET "preferences" = $2::jsonb, "updatedAt" = NOW() WHERE "userId" = $1`,
      userId,
      JSON.stringify(matrix),
    );
  }

  /** Decide whether a specific user wants a specific channel for a
   *  specific event. Used by the fanout helpers to skip in-app writes
   *  for users who opted out, without each emitter having to know
   *  about the matrix. Resolution order is user-saved →
   *  role-default → global-default, merged at the per-channel cell
   *  level by resolveEffectiveMatrix. */
  private async userWantsChannel(
    userId: string,
    event: NotifEventKey,
    channel: 'in_app' | 'email' | 'sms',
  ): Promise<boolean> {
    const matrix = await this.resolveEffectiveMatrix(userId);
    const slot = matrix[event];
    if (!slot) return getDefaultPrefs()[event]?.[channel] ?? false;
    return slot[channel] === true;
  }

  /** Public wrapper for callers outside this service (e.g. the email
   *  worker, which re-checks the preference at dispatch time so rows
   *  queued before a user opted out are dropped instead of sent). */
  async wantsChannel(
    userId: string,
    event: string,
    channel: 'in_app' | 'email' | 'sms',
  ): Promise<boolean> {
    return this.userWantsChannel(userId, event as NotifEventKey, channel);
  }

  /**
   * Three-tier matrix resolver. Each cell (event-key, channel) reads
   * the first non-undefined value out of:
   *   1. user-saved matrix      (Partial<UserNotifPrefs>)
   *   2. role-default matrix    (Partial<UserNotifPrefs>)
   *   3. global default         (always defined; from registry)
   *
   * Per-cell precedence is critical: if a role default sets
   * `{in_app:false, email:true}` and the user saved `{in_app:true}`,
   * the user keeps in_app=true AND inherits email=true from the role.
   * A pure event-level spread would lose the role's email value.
   *
   * SMS is force-false regardless of any saved value (no provider).
   */
  private async resolveEffectiveMatrix(userId: string): Promise<UserNotifPrefs> {
    const [userSaved, roleDefaults] = await Promise.all([
      this.readMatrix(userId),
      this.readRoleDefaultsForUser(userId),
    ]);
    const globalDefaults = getDefaultPrefs();
    const out = {} as UserNotifPrefs;
    for (const meta of NOTIF_EVENT_META) {
      const k = meta.key;
      const u = userSaved?.[k];
      const r = roleDefaults?.[k];
      const g = globalDefaults[k];
      out[k] = {
        in_app: u?.in_app ?? r?.in_app ?? g.in_app,
        email:  u?.email  ?? r?.email  ?? g.email,
        sms: false,
      };
    }
    return out;
  }

  /** Per-role default matrix (Stage 10). Raw SQL because the JSONB
   *  column was added by healAdditiveDrift and isn't in the Prisma
   *  schema. Returns null when no defaults are stored, so the
   *  resolver falls through to the global registry defaults. */
  private async readRoleDefaultsForUser(userId: string): Promise<Partial<UserNotifPrefs> | null> {
    try {
      const rows = await this.legacyPrisma.$queryRawUnsafe<{ defaults: any }[]>(
        `SELECT r."notificationDefaults" AS defaults
           FROM "users" u
           JOIN "roles" r ON r.id = u."roleId"
          WHERE u.id = $1 LIMIT 1`,
        userId,
      );
      const raw = rows?.[0]?.defaults;
      if (!raw) return null;
      return typeof raw === 'string' ? JSON.parse(raw) : raw;
    } catch (e) {
      this.logger.warn(`readRoleDefaultsForUser failed for ${userId}: ${(e as Error)?.message}`);
      return null;
    }
  }

  /** Public read for the admin UI. Returns the saved role defaults
   *  (or null) and the merged "effective" matrix the role currently
   *  produces — handy for the admin to see what a new user with this
   *  role would actually receive. */
  async getRoleDefaults(roleId: string): Promise<{
    roleId: string;
    saved: Partial<UserNotifPrefs> | null;
    effective: UserNotifPrefs;
    meta: typeof NOTIF_EVENT_META;
  }> {
    let saved: Partial<UserNotifPrefs> | null = null;
    try {
      const rows = await this.legacyPrisma.$queryRawUnsafe<{ defaults: any }[]>(
        `SELECT "notificationDefaults" AS defaults FROM "roles" WHERE id = $1 LIMIT 1`,
        roleId,
      );
      const raw = rows?.[0]?.defaults;
      if (raw) saved = typeof raw === 'string' ? JSON.parse(raw) : raw;
    } catch (e) {
      this.logger.warn(`getRoleDefaults failed for ${roleId}: ${(e as Error)?.message}`);
    }
    // Effective view = role-default merged onto global, per cell.
    const globalDefaults = getDefaultPrefs();
    const effective = {} as UserNotifPrefs;
    for (const meta of NOTIF_EVENT_META) {
      const r = saved?.[meta.key];
      const g = globalDefaults[meta.key];
      effective[meta.key] = {
        in_app: r?.in_app ?? g.in_app,
        email:  r?.email  ?? g.email,
        sms: false,
      };
    }
    return { roleId, saved, effective, meta: NOTIF_EVENT_META };
  }

  /** Persist a role's notification defaults. Accepts either the flat
   *  shape ({ EVENT_KEY: ChannelPrefs, … }) or the nested shape
   *  ({ preferences: { … } }) so the admin UI can send either. */
  async setRoleDefaults(roleId: string, data: any): Promise<{
    roleId: string;
    saved: Partial<UserNotifPrefs>;
    effective: UserNotifPrefs;
    meta: typeof NOTIF_EVENT_META;
  }> {
    const incoming = this.coerceMatrixPayload(data);
    // Round-trip through mergeWithDefaults so unknown / stale event
    // keys are dropped and SMS is force-false.
    const sanitised = mergeWithDefaults(incoming);
    await this.legacyPrisma.$executeRawUnsafe(
      `UPDATE "roles" SET "notificationDefaults" = $2::jsonb, "updatedAt" = NOW() WHERE id = $1`,
      roleId,
      JSON.stringify(sanitised),
    );
    return this.getRoleDefaults(roleId).then(r => ({ ...r, saved: sanitised }));
  }

  /** Shared helper used by both updatePreferences (per-user) and
   *  setRoleDefaults (per-role) to accept both the flat shape and the
   *  nested-under-preferences shape from the UI. */
  private coerceMatrixPayload(data: any): Partial<UserNotifPrefs> {
    const payload = data ?? {};
    const isChannelPrefs = (v: any) =>
      v && typeof v === 'object' && !Array.isArray(v) &&
      ('in_app' in v || 'email' in v || 'sms' in v);
    const out: Partial<UserNotifPrefs> = {};
    for (const [k, v] of Object.entries(payload)) {
      if (k === 'meta' || k === 'effective' || k === 'roleId') continue;
      if (k === 'preferences' || k === 'saved') {
        if (v && typeof v === 'object') Object.assign(out, v as object);
        continue;
      }
      if (isChannelPrefs(v)) (out as any)[k] = v;
    }
    return out;
  }

  /**
   * Stage 6 — enqueue an email for a single user when they want the
   * email channel for this event. The row lands in the
   * notification_email_outbox table (added by healAdditiveDrift); a
   * background worker (NotificationEmailWorker) drains the table on a
   * 60s tick and dispatches through EmailService. Failures retry with
   * a backoff; after 3 attempts the row moves to FAILED status.
   *
   * Callers must already have:
   *   - confirmed the recipient passes the event's permission gate,
   *   - decided that an in-app row is being created (the email is the
   *     parallel channel, not a substitute — both can fire).
   *
   * No throws on enqueue failure; an unreachable DB is logged and we
   * fall through. Email is best-effort: missing a row is a worse
   * outcome than missing the in-app emission but not worth aborting
   * the underlying mutation.
   */
  private async enqueueEmail(
    userId: string,
    event: NotifEventKey,
    title: string,
    message: string,
    relatedEntity: string | undefined,
    relatedEntityId: string | undefined,
    tenantId: string | null,
    i18n?: { titleKey?: string; messageKey?: string; params?: Record<string, unknown> },
  ): Promise<void> {
    if (!(await this.userWantsChannel(userId, event, 'email'))) return;
    // Digest-only events do not emit per-row emails. The in-app
    // notification already fired from the calling fanout helper; the
    // DocumentDigestCron picks the row up the next morning and rolls
    // it into one consolidated table per recipient. Closes the
    // "emails every 2-3 hours" report — see §4.11 daily digest spec.
    try {
      const meta = metaFor(event);
      if (meta.digestOnly) return;
    } catch {
      // Unknown event keys fall through to legacy behaviour rather
      // than swallowing the email — better to over-send than to drop
      // a critical notification because of a registry mismatch.
    }
    try {
      const u = await this.legacyPrisma.user.findUnique({
        where: { id: userId },
        select: { email: true, firstName: true, lastName: true, preferredLanguage: true },
      });
      if (!u?.email) return; // no email on file; nothing to send.
      const name = `${u.firstName ?? ''} ${u.lastName ?? ''}`.trim() || u.email;
      const locale = (u as any).preferredLanguage ?? 'en';
      const params = i18n?.params ? JSON.stringify({
        // Pass the i18n keys + params down so the worker can choose
        // between rendering an English fallback (existing helper) or
        // a translated body once the email-i18n catalogue covers the
        // new event keys.
        titleKey: i18n.titleKey ?? null,
        messageKey: i18n.messageKey ?? null,
        ...(i18n.params ?? {}),
      }) : null;
      await this.legacyPrisma.$executeRawUnsafe(
        `INSERT INTO "notification_email_outbox"
            ("tenantId","userId","email","name","eventType","title","message",
             "locale","relatedEntity","relatedEntityId","params","status")
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,'PENDING')`,
        tenantId,
        userId,
        u.email,
        name,
        event,
        title,
        message,
        locale,
        relatedEntity ?? null,
        relatedEntityId ?? null,
        params,
      );
    } catch (e) {
      this.logger.warn(`enqueueEmail failed for ${userId}/${event}: ${(e as Error)?.message}`);
    }
  }

  /** Filter a candidate recipient set to those who hold the event's
   *  required permission. No-op when the event has no permission
   *  requirement (e.g. SYSTEM_MAINTENANCE). Recipients pass through
   *  either by holding the literal permission on their role, OR by
   *  being a System Admin (which bypasses all permission checks
   *  elsewhere in the codebase). */
  private async filterByEventPermission(
    userIds: string[],
    event: NotifEventKey,
  ): Promise<string[]> {
    if (!userIds.length) return userIds;
    const required = metaFor(event).requiredPermission;
    if (!required) return userIds;
    const rows = await this.legacyPrisma.user.findMany({
      where: {
        id: { in: userIds },
        deletedAt: null,
        OR: [
          { role: { name: 'System Admin' } },
          { role: { permissions: { some: { permission: { name: required } } } } },
        ],
      },
      select: { id: true },
    });
    return rows.map(r => r.id);
  }

  /// Check for vehicles with expiring compliance dates
  async checkExpiringCompliance(): Promise<void> {
    const tid = this.narrowingTenantId();
    try {
      const fleetManagers = await this.legacyPrisma.user.findMany({ // @tenant-reviewed: phase214-pilot-scope (narrowed via agency.tenantId when tid)
        where: {
          role: { name: { contains: 'Fleet Manager' } },
          status: 'ACTIVE',
          notificationPreference: { isNot: null },
          ...(tid ? { agency: { tenantId: tid } } : {}),
        },
        include: { notificationPreference: true, agency: true },
      });

      for (const manager of fleetManagers) {
      if (!manager.notificationPreference) continue;

      const daysBefore = manager.notificationPreference.complianceDaysBefore;
      const cutoffDate = new Date();
      cutoffDate.setDate(cutoffDate.getDate() + daysBefore);

      const complianceChecks = [
        { field: 'motExpiryDate', type: 'VEHICLE_MOT_EXPIRING', label: 'MOT' },
        { field: 'taxExpiryDate', type: 'VEHICLE_TAX_EXPIRING', label: 'Tax' },
        { field: 'insuranceExpiryDate', type: 'VEHICLE_INSURANCE_EXPIRING', label: 'Insurance' },
        { field: 'registrationExpiryDate', type: 'VEHICLE_REGISTRATION_EXPIRING', label: 'Registration' },
        { field: 'tachographCalibrationExpiry', type: 'VEHICLE_TACHOGRAPH_EXPIRING', label: 'Tachograph' },
        { field: 'atpCertificateExpiry', type: 'VEHICLE_ATP_EXPIRING', label: 'ATP Certificate' },
      ] as const;

      for (const check of complianceChecks) {
        // Build the where clause dynamically
        const whereClause: any = {
          agencyId: manager.agencyId,
          deletedAt: null,
          ...(tid ? { tenantId: tid } : {}),
        };
        whereClause[check.field] = { lte: cutoffDate, gt: new Date() };

        const vehicles = await this.legacyPrisma.vehicle.findMany({ // @tenant-reviewed: phase214-pilot-scope (narrowed via tenantId when tid)
          where: whereClause,
          select: { id: true, registrationNumber: true, motExpiryDate: true, taxExpiryDate: true, insuranceExpiryDate: true, registrationExpiryDate: true, tachographCalibrationExpiry: true, atpCertificateExpiry: true },
        });

        for (const vehicle of vehicles) {
          let expiryDate: Date | null = null;
          if (check.field === 'motExpiryDate') expiryDate = vehicle.motExpiryDate;
          else if (check.field === 'taxExpiryDate') expiryDate = vehicle.taxExpiryDate;
          else if (check.field === 'insuranceExpiryDate') expiryDate = vehicle.insuranceExpiryDate;
          else if (check.field === 'registrationExpiryDate') expiryDate = vehicle.registrationExpiryDate;
          else if (check.field === 'tachographCalibrationExpiry') expiryDate = vehicle.tachographCalibrationExpiry;
          else if (check.field === 'atpCertificateExpiry') expiryDate = vehicle.atpCertificateExpiry;

          if (!expiryDate) continue;

          const daysUntil = Math.ceil((expiryDate.getTime() - Date.now()) / (1000 * 60 * 60 * 24));
          const severity = daysUntil <= 7 ? 'HIGH' : daysUntil <= 14 ? 'MEDIUM' : 'LOW';

          const existing = await this.legacyPrisma.notification.findFirst({ // @tenant-reviewed: phase214-pilot-scope (dedupe scoped by tenantId when tid; see DEDUPE_KEY_REVIEW)
            where: {
              userId: manager.id,
              relatedEntityId: vehicle.id,
              type: check.type as NotificationType,
              isRead: false,
              createdAt: { gte: new Date(Date.now() - 86400000) },
              ...(tid ? { tenantId: tid } : {}),
            },
          });

          if (!existing) {
            await this.createInAppWithDedup({ // @tenant-reviewed: phase246-notifications-internal-scan-dedup (routes scan creates through dedup helper)
              userId: manager.id,
              // Pre-rendered English (legacy fallback for old clients).
              title: `${vehicle.registrationNumber}: ${check.label} Expiring Soon`,
              message: `${check.label} expires in ${daysUntil} days`,
              // i18n metadata: reader resolves these against the active
              // locale and falls back to `title`/`message` when missing.
              titleKey: 'events.vehicleCheckExpiring.title',
              messageKey: 'events.vehicleCheckExpiring.body',
              params: {
                registrationNumber: vehicle.registrationNumber,
                checkLabel: check.label,
                daysUntilDue: daysUntil,
              },
              type: check.type as NotificationType,
              channel: 'in_app',
              relatedEntity: 'Vehicle',
              relatedEntityId: vehicle.id,
              daysUntilDue: daysUntil,
              severity,
              ...(tid ? { tenantId: tid } : {}),
            }, tid);
          }
        }
      }
      }
    } catch (error: any) {
      // Gracefully handle missing notification_preferences table
      if (error?.code === 'P2021' || error?.message?.includes('does not exist')) {
        // Silently skip - migration not yet applied
      } else {
        throw error;
      }
    }
  }

  /// Check for vehicles needing service based on mileage
  async checkServiceDue(): Promise<void> {
    const tid = this.narrowingTenantId();
    try {
      const fleetManagers = await this.legacyPrisma.user.findMany({ // @tenant-reviewed: phase214-pilot-scope (narrowed via agency.tenantId when tid)
        where: {
          role: { name: { contains: 'Fleet Manager' } },
          status: 'ACTIVE',
          notificationPreference: { isNot: null },
          ...(tid ? { agency: { tenantId: tid } } : {}),
        },
        include: { notificationPreference: true, agency: true },
    });

    for (const manager of fleetManagers) {
      if (!manager.notificationPreference) continue;
      const kmBefore = manager.notificationPreference.serviceKmBefore;

      const vehicles = await this.legacyPrisma.vehicle.findMany({ // @tenant-reviewed: phase214-pilot-scope (narrowed via tenantId when tid)
        where: {
          agencyId: manager.agencyId,
          deletedAt: null,
          ...(tid ? { tenantId: tid } : {}),
          maintenanceRecords: {
            some: { nextServiceMileage: { not: null }, deletedAt: null },
          },
        },
        include: {
          maintenanceRecords: {
            where: { deletedAt: null, nextServiceMileage: { not: null } },
            orderBy: { createdAt: 'desc' },
            take: 1,
            include: { maintenanceType: true },
          },
        },
      });

      for (const vehicle of vehicles) {
        if (!vehicle.maintenanceRecords.length || !vehicle.currentMileage) continue;

        const lastService = vehicle.maintenanceRecords[0];
        const kmRemaining = lastService.nextServiceMileage! - vehicle.currentMileage;

        if (kmRemaining > 0 && kmRemaining <= kmBefore) {
          const severity = kmRemaining <= 100 ? 'HIGH' : kmRemaining <= 250 ? 'MEDIUM' : 'LOW';

          const existing = await this.legacyPrisma.notification.findFirst({ // @tenant-reviewed: phase214-pilot-scope (dedupe scoped by tenantId when tid)
            where: {
              userId: manager.id,
              relatedEntityId: vehicle.id,
              type: 'VEHICLE_SERVICE_DUE',
              isRead: false,
              createdAt: { gte: new Date(Date.now() - 86400000) },
              ...(tid ? { tenantId: tid } : {}),
            },
          });

          if (!existing) {
            await this.createInAppWithDedup({ // @tenant-reviewed: phase246-notifications-internal-scan-dedup (routes scan creates through dedup helper)
              userId: manager.id,
              title: `${vehicle.registrationNumber}: Service Due Soon`,
              message: `Service due in ${kmRemaining} km`,
              titleKey: 'events.vehicleServiceDueKm.title',
              messageKey: 'events.vehicleServiceDueKm.body',
              params: {
                registrationNumber: vehicle.registrationNumber,
                kmRemaining,
              },
              type: 'VEHICLE_SERVICE_DUE',
              channel: 'in_app',
              relatedEntity: 'Vehicle',
              relatedEntityId: vehicle.id,
              kmUntilDue: kmRemaining,
              severity,
              ...(tid ? { tenantId: tid } : {}),
            }, tid);
          }
        }
      }
      }
    } catch (error: any) {
      // Gracefully handle missing notification_preferences table
      if (error?.code === 'P2021' || error?.message?.includes('does not exist')) {
        // Silently skip - migration not yet applied
      } else {
        throw error;
      }
    }
  }

  /// Check for overdue compliance
  async checkOverdue(): Promise<void> {
    const tid = this.narrowingTenantId();
    try {
      const fleetManagers = await this.legacyPrisma.user.findMany({ // @tenant-reviewed: phase214-pilot-scope (narrowed via agency.tenantId when tid)
        where: {
          role: { name: { contains: 'Fleet Manager' } },
          status: 'ACTIVE',
          ...(tid ? { agency: { tenantId: tid } } : {}),
        },
        include: { agency: true },
    });

    for (const manager of fleetManagers) {
      const overduedVehicles = await this.legacyPrisma.vehicle.findMany({ // @tenant-reviewed: phase214-pilot-scope (narrowed via tenantId when tid)
        where: {
          agencyId: manager.agencyId,
          deletedAt: null,
          ...(tid ? { tenantId: tid } : {}),
          OR: [
            { motExpiryDate: { lt: new Date() } },
            { taxExpiryDate: { lt: new Date() } },
            { insuranceExpiryDate: { lt: new Date() } },
            { registrationExpiryDate: { lt: new Date() } },
          ],
        },
        select: { id: true, registrationNumber: true },
      });

      for (const vehicle of overduedVehicles) {
        const existing = await this.legacyPrisma.notification.findFirst({ // @tenant-reviewed: phase214-pilot-scope (dedupe scoped by tenantId when tid)
          where: {
            userId: manager.id,
            relatedEntityId: vehicle.id,
            severity: 'HIGH',
            isRead: false,
            ...(tid ? { tenantId: tid } : {}),
          },
        });

        if (!existing) {
          await this.createInAppWithDedup({ // @tenant-reviewed: phase246-notifications-internal-scan-dedup (routes scan creates through dedup helper)
            userId: manager.id,
            title: `🚨 ${vehicle.registrationNumber}: Compliance Overdue`,
            message: 'Vehicle has expired compliance. Service immediately.',
            titleKey: 'events.vehicleComplianceOverdue.title',
            messageKey: 'events.vehicleComplianceOverdue.body',
            params: {
              registrationNumber: vehicle.registrationNumber,
            },
            type: 'VEHICLE_SERVICE_OVERDUE',
            channel: 'in_app',
            relatedEntity: 'Vehicle',
            relatedEntityId: vehicle.id,
            severity: 'HIGH',
            ...(tid ? { tenantId: tid } : {}),
          }, tid);
        }
      }
      }
    } catch (error: any) {
      // Gracefully handle missing notification_preferences table
      if (error?.code === 'P2021' || error?.message?.includes('does not exist')) {
        // Silently skip - migration not yet applied
      } else {
        throw error;
      }
    }
  }

  /// Check for scheduled maintenance records coming up
  async checkScheduledMaintenance(): Promise<void> {
    const tid = this.narrowingTenantId();
    try {
      const fleetManagers = await this.legacyPrisma.user.findMany({ // @tenant-reviewed: phase214-pilot-scope (narrowed via agency.tenantId when tid)
        where: {
          role: { name: { contains: 'Fleet Manager' } },
          status: 'ACTIVE',
          notificationPreference: { isNot: null },
          ...(tid ? { agency: { tenantId: tid } } : {}),
        },
        include: { notificationPreference: true, agency: true },
      });

      for (const manager of fleetManagers) {
        if (!manager.notificationPreference) continue;
        const maintenanceAlertDays = manager.notificationPreference.complianceDaysBefore ?? 7;

        const upcomingDate = new Date();
        upcomingDate.setDate(upcomingDate.getDate() + maintenanceAlertDays);

        const scheduledRecords = await this.legacyPrisma.maintenanceRecord.findMany({ // @tenant-reviewed: phase214-pilot-scope (narrowed via tenantId when tid)
          where: {
            vehicle: { agencyId: manager.agencyId, deletedAt: null },
            status: 'SCHEDULED',
            scheduledDate: { lte: upcomingDate, gte: new Date() },
            deletedAt: null,
            ...(tid ? { tenantId: tid } : {}),
          },
          include: { vehicle: true, maintenanceType: true, workshop: true },
        });

        for (const record of scheduledRecords) {
          const existing = await this.legacyPrisma.notification.findFirst({ // @tenant-reviewed: phase214-pilot-scope (dedupe scoped by tenantId when tid)
            where: {
              userId: manager.id,
              relatedEntityId: record.id,
              type: 'VEHICLE_SERVICE_DUE',
              isRead: false,
              createdAt: { gte: new Date(Date.now() - 86400000) },
              ...(tid ? { tenantId: tid } : {}),
            },
          });

          if (!existing) {
            const daysUntil = Math.ceil((record.scheduledDate!.getTime() - Date.now()) / (1000 * 60 * 60 * 24));
            const severity = daysUntil <= 3 ? 'HIGH' : daysUntil <= 7 ? 'MEDIUM' : 'LOW';

            await this.createInAppWithDedup({ // @tenant-reviewed: phase246-notifications-internal-scan-dedup (routes scan creates through dedup helper)
              userId: manager.id,
              title: `${record.vehicle.registrationNumber}: Scheduled Maintenance`,
              message: `${record.maintenanceType?.name ?? 'Maintenance'} scheduled in ${daysUntil} days at ${record.workshop?.name ?? 'workshop'}`,
              titleKey: 'events.vehicleScheduledMaintenance.title',
              messageKey: 'events.vehicleScheduledMaintenance.body',
              params: {
                registrationNumber: record.vehicle.registrationNumber,
                maintenanceTypeName: record.maintenanceType?.name ?? 'Maintenance',
                daysUntil,
                workshopName: record.workshop?.name ?? 'workshop',
              },
              type: 'VEHICLE_SERVICE_DUE',
              channel: 'in_app',
              relatedEntity: 'MaintenanceRecord',
              relatedEntityId: record.id,
              daysUntilDue: daysUntil,
              severity,
              ...(tid ? { tenantId: tid } : {}),
            }, tid);
          }
        }
      }
    } catch (error: any) {
      if (error?.code === 'P2021' || error?.message?.includes('does not exist')) {
        // Silently skip - migration not yet applied
      } else {
        throw error;
      }
    }
  }

  /// Run all checks (LEGACY: cross-tenant iteration, unchanged behaviour).
  ///
  /// Phase 2.14 keeps this method untouched so the scheduler can fall
  /// back to it when the tenant-aware flags are off. Production
  /// continues to run THIS method.
  async runAllChecks(): Promise<void> {
    // Each check is isolated so a transient pg-pool timeout in one of
    // them (the Notifications batch fans out a lot of small queries and
    // can race the pool under load) doesn't skip the others. Failures
    // log at warn — the cron re-fires on the next tick, so transient
    // pool exhaustion is self-healing.
    const checks: Array<[string, () => Promise<void>]> = [
      ['expiringCompliance',  () => this.checkExpiringCompliance()],
      ['serviceDue',          () => this.checkServiceDue()],
      ['scheduledMaintenance',() => this.checkScheduledMaintenance()],
      ['overdue',             () => this.checkOverdue()],
      ['documentExpiry',      () => this.checkDocumentExpiry()],
      ['pipelineDeadlines',   () => this.checkPipelineDeadlines()],
      ['employeeContracts',   () => this.checkEmployeeContracts()],
    ];
    for (const [name, run] of checks) {
      try {
        await run();
      } catch (error: any) {
        // eslint-disable-next-line no-console
        console.warn(
          `Notification check '${name}' failed (will retry on next tick): ${
            error?.message ?? error
          }`,
        );
      }
    }
  }

  /**
   * Phase 2.14 — tenant-aware runAllChecks.
   *
   * REQUIRES:
   *   - `TENANT_AWARE_JOBS_ENABLED=true`
   *   - `TENANT_JOB_FANOUT_ENABLED=true`
   *   - env classifies as SAFE_CLONE / SAFE_STAGING
   *   - FeatureFlagsService injected
   *
   * Discovers ACTIVE tenants, plans per-tenant fanout via
   * `TenantJobFanoutPlanner`, then executes each tenant's
   * `runAllChecksForTenant(tenantId)` inside a `runForTenant` ALS frame.
   *
   * Failures of one tenant do NOT abort other tenants. Per-tenant
   * results (ok/duration/error) are logged.
   */
  async runAllChecksTenantAware(): Promise<{
    plannedTenants: number;
    executedTenants: number;
    failedTenants: number;
    skipped: number;
  }> {
    if (!this.tenantAwareSchedulerActive()) {
      // Defensive: the scheduler should never call this when flags are
      // off, but if a test/harness invokes it directly, fall back to
      // legacy and report zero plan.
      this.logger.warn('[tenant-aware] flags not set — falling back to legacy runAllChecks');
      await this.runAllChecks();
      return { plannedTenants: 0, executedTenants: 0, failedTenants: 0, skipped: 0 };
    }

    // Tenant discovery. Uses `legacyPrisma` because tenant lookup is a
    // platform-global read; the per-tenant work routes through the
    // pilot accessor inside `runAllChecksForTenant`.
    const tenants = await this.legacyPrisma.tenant.findMany({ // @tenant-reviewed: phase214-pilot-scope (tenant catalog discovery)
      select: { id: true, slug: true, status: true },
    }) as Array<{ id: string; slug: string; status: 'ACTIVE' | 'SUSPENDED' | 'INACTIVE' }>;

    const planner = new TenantJobFanoutPlanner();
    const plan = planner.plan(
      'notifications.runAllChecks',
      tenants,
      () => ({}),
      { activeOnly: true, excludeSystem: true },
    );

    this.logger.log(
      `[tenant-aware] plan: ${plan.tenants.length} tenants, ${plan.skipped.length} skipped`,
    );

    const outcome = await runForTenantBatch(
      plan.tenants.map((p) => p.tenantId),
      (tid) => this.runAllChecksForTenant(tid),
      { concurrency: 4, perTenantTimeoutMs: 60_000 },
    );

    const failed = outcome.results.filter((r) => !r.ok);
    if (failed.length > 0) {
      for (const f of failed) {
        this.logger.error(
          `[tenant-aware] tenant ${f.tenantId} failed: ${f.error?.name}: ${f.error?.message}`,
        );
      }
    }

    return {
      plannedTenants: plan.tenants.length,
      executedTenants: outcome.results.length,
      failedTenants: failed.length,
      skipped: plan.skipped.length + outcome.skipped.length,
    };
  }

  /**
   * Per-tenant entry point used by the fanout runner. The tenant id
   * is in ALS by the time this runs; the existing `check*` methods
   * read it via `TenantContext.optional()` if they need it.
   *
   * Phase 2.14 keeps the existing `check*` bodies on `legacyPrisma`
   * (they iterate `User` across all tenants today). They will be
   * narrowed to the active tenant in a follow-up pass — for now,
   * the tenant boundary is enforced by the surrounding ALS frame +
   * the read-path pilot scope on `notification.findFirst` /
   * `notification.create` calls.
   */
  async runAllChecksForTenant(_tenantId: string): Promise<void> {
    // The four legacy `check*` methods are not yet narrowed by tenant
    // (Phase 2.14 ships the framework + adapter; the per-check tenant
    // narrowing is the Phase 2.14.1 follow-up). Calling them inside a
    // tenant ALS frame is still safe because:
    //   - they only READ User/Vehicle (no pilot-scoped writes here),
    //   - their `notification.create` calls land tenantId via the
    //     existing pilot scope when the pilot module flag is on.
    // See SAAS_PHASE2_NOTIFICATIONS_SCHEDULER_PILOT_RESULTS.md §6 for
    // the migration plan to a fully tenant-narrowed check loop.
    try {
      await this.checkExpiringCompliance();
      await this.checkServiceDue();
      await this.checkScheduledMaintenance();
      await this.checkOverdue();
      await this.checkDocumentExpiry();
      await this.checkPipelineDeadlines();
      await this.checkEmployeeContracts();
    } catch (error) {
      // Re-throw so the batch runner records the failure per tenant.
      throw error;
    }
  }

  /// Phase 2.14 fanout-writer contract.
  ///
  /// When the tenant-aware scheduler path is active
  /// (`TENANT_AWARE_JOBS_ENABLED && TENANT_JOB_FANOUT_ENABLED &&
  ///  staging`), the fanout writers REQUIRE a tenant in ALS. Calling
  /// them without context raises `MissingTenantContextError`. This
  /// closes the cross-tenant fanout hole described in Phase 2.10's
  /// scope-split doc.
  ///
  /// When the tenant-aware path is OFF (production default), the
  /// writers preserve their pre-Phase-2.14 behaviour byte-identically.
  private assertTenantForFanout(method: string): void {
    if (!this.tenantAwareSchedulerActive()) return;
    if (!TenantContext.optional()) {
      throw new MissingTenantContextError(`notifications.${method}`);
    }
  }

  // ── Phase 2.45 — per-recipient notification dedup ────────────────────────
  //
  // Default: disabled (NOTIFICATION_DEDUP_ENABLED=false). When the flag is
  // off, callers fall through to a plain `notification.create` and the path
  // is byte-identical to pre-2.45.
  //
  // When the flag is on, we look up an existing in-app notification for the
  // SAME tenant + recipient + type + relatedEntity + relatedEntityId within
  // the configured window (default 360 minutes). If one is found, we
  // SUPPRESS the create and report a `deduped` count. Tenant scoping is
  // mandatory — the dedup query always carries the active tenantId so it
  // CANNOT match cross-tenant rows. Missing tenant context is handled by
  // refusing the dedup probe and falling through to legacy behaviour
  // (caller's `assertTenantForFanout` already gates this earlier).
  //
  // Identity: (tenantId, userId, type, relatedEntity, relatedEntityId,
  //            createdAt >= now - window).
  // Limitations:
  //   - relatedEntityId is required to dedup; without it the lookup falls
  //     back to type-only matching, which is too coarse for general use,
  //     so we explicitly do NOT dedup when relatedEntityId is absent.
  //
  // @tenant-reviewed: phase245-notifications-dedup
  private dedupWindowMinutes(): number {
    const raw = process.env.NOTIFICATION_DEDUP_WINDOW_MINUTES;
    const n = raw ? Number(raw) : 360;
    return Number.isFinite(n) && n > 0 ? n : 360;
  }

  private async createInAppWithDedup(data: any, tid: string | null): Promise<{ created: number; deduped: number }> {
    const dedupOn = !!this.flags?.notificationDedupEnabled();
    // Dedup requires both: flag on, an explicit tenantId, AND a
    // (relatedEntity, relatedEntityId) pair. If any are missing we fall
    // through to a plain create.
    if (dedupOn && tid && data.relatedEntity && data.relatedEntityId) {
      const since = new Date(Date.now() - this.dedupWindowMinutes() * 60 * 1000);
      // @tenant-reviewed: phase245-notifications-dedup (tenantId always present in lookup)
      const existing = await this.legacyPrisma.notification.findFirst({
        where: {
          tenantId: tid,
          userId: data.userId,
          type: data.type,
          relatedEntity: data.relatedEntity,
          relatedEntityId: data.relatedEntityId,
          createdAt: { gte: since },
          deletedAt: null,
        },
        select: { id: true },
      });
      if (existing) {
        return { created: 0, deduped: 1 };
      }
    }
    await this.legacyPrisma.notification.create({ data });
    return { created: 1, deduped: 0 };
  }

  /// Notify uploader and users with specific roles.
  ///
  /// `i18n` is optional — pass `{ titleKey, messageKey?, params? }` to
  /// have the reader render translations against the requester's locale.
  /// When omitted, the existing English `title`/`message` flow is used
  /// unchanged (backward compatible with all current callers).
  ///
  /// Phase 2.14: refuses without a tenant in ALS when the tenant-aware
  /// scheduler path is active.
  async notifyUploaderAndRoles(
    uploaderId: string,
    roles: string[],
    eventKey: NotifEventKey,
    title: string,
    message: string,
    relatedEntity?: string,
    relatedEntityId?: string,
    i18n?: { titleKey?: string; messageKey?: string; params?: Record<string, unknown> },
  ): Promise<{ created: number; deduped: number }> {
    this.assertTenantForFanout('notifyUploaderAndRoles');
    const tid = this.narrowingTenantId();
    const userIds = new Set<string>();

    if (uploaderId) {
      if (tid) {
        // Phase 2.15 — in tenant-aware mode, the uploader must belong
        // to the active tenant. Cross-tenant uploader ids are ignored
        // (the caller should never pass one; this is defence in depth).
        const ok = await this.legacyPrisma.user.findFirst({ // @tenant-reviewed: phase215-pilot-scope (uploader tenant probe)
          where: { id: uploaderId, agency: { tenantId: tid } },
          select: { id: true },
        });
        if (ok) userIds.add(uploaderId);
      } else {
        userIds.add(uploaderId);
      }
    }

    if (roles && roles.length > 0) {
      const users = await this.legacyPrisma.user.findMany({ // @tenant-reviewed: phase215-pilot-scope (role fanout narrowed via agency.tenantId when tid)
        where: {
          role: { name: { in: roles } },
          status: 'ACTIVE',
          ...(tid ? { agency: { tenantId: tid } } : {}),
        },
        select: { id: true },
      });
      users.forEach(u => userIds.add(u.id));
    }

    // Spec 4.11.1: "if a user does not have the permission for documents,
    // he/she should not receive notifications related to documents".
    // Filter by the event's requiredPermission before any DB write.
    const gatedIds = new Set(await this.filterByEventPermission(Array.from(userIds), eventKey));
    const type = (EVENT_TO_TYPE[eventKey] || 'INFO') as NotificationType;

    let created = 0, deduped = 0;
    for (const userId of gatedIds) {
      // Spec 4.11.2 — per-user, per-event channel toggles. In-app and
      // email are independent: a user who turned in-app off but kept
      // email on still gets a row in the outbox.
      if (await this.userWantsChannel(userId, eventKey, 'in_app')) {
        // @tenant-reviewed: phase215-pilot-scope (writes tenantId when tid)
        const r = await this.createInAppWithDedup({
          userId,
          title,
          message,
          titleKey:   i18n?.titleKey   ?? null,
          messageKey: i18n?.messageKey ?? null,
          params:     (i18n?.params ?? null) as any,
          type,
          channel: 'in_app',
          relatedEntity: relatedEntity || 'Document',
          relatedEntityId,
          ...(tid ? { tenantId: tid } : {}),
        }, tid);
        created += r.created;
        deduped += r.deduped;
      }
      await this.enqueueEmail(userId, eventKey, title, message, relatedEntity, relatedEntityId, tid, i18n);
    }
    return { created, deduped };
  }

  /// Notify users with specific roles.
  ///
  /// Same `i18n` opt-in as `notifyUploaderAndRoles` — see that doc for
  /// fallback semantics.
  ///
  /// Phase 2.14: refuses without a tenant in ALS when the tenant-aware
  /// scheduler path is active.
  async notifyUsersByRoles(
    roles: string[],
    eventKey: NotifEventKey,
    title: string,
    message: string,
    relatedEntity?: string,
    relatedEntityId?: string,
    i18n?: { titleKey?: string; messageKey?: string; params?: Record<string, unknown> },
  ): Promise<{ created: number; deduped: number }> {
    this.assertTenantForFanout('notifyUsersByRoles');
    const tid = this.narrowingTenantId();
    const users = await this.legacyPrisma.user.findMany({ // @tenant-reviewed: phase215-pilot-scope (role fanout narrowed via agency.tenantId when tid)
      where: {
        role: { name: { in: roles } },
        status: 'ACTIVE',
        ...(tid ? { agency: { tenantId: tid } } : {}),
      },
      select: { id: true },
    });

    // Permission + preferences gates — see notifyUploaderAndRoles
    // comments for the rationale; same spec sections drive both helpers.
    const gatedIds = new Set(await this.filterByEventPermission(users.map(u => u.id), eventKey));
    const type = (EVENT_TO_TYPE[eventKey] || 'INFO') as NotificationType;

    let created = 0, deduped = 0;
    for (const userId of gatedIds) {
      if (await this.userWantsChannel(userId, eventKey, 'in_app')) {
        // @tenant-reviewed: phase215-pilot-scope (writes tenantId when tid)
        const r = await this.createInAppWithDedup({
          userId,
          title,
          message,
          titleKey:   i18n?.titleKey   ?? null,
          messageKey: i18n?.messageKey ?? null,
          params:     (i18n?.params ?? null) as any,
          type,
          channel: 'in_app',
          relatedEntity,
          relatedEntityId,
          ...(tid ? { tenantId: tid } : {}),
        }, tid);
        created += r.created;
        deduped += r.deduped;
      }
      await this.enqueueEmail(userId, eventKey, title, message, relatedEntity, relatedEntityId, tid, i18n);
    }
    return { created, deduped };
  }

  /**
   * Notify a specific list of user ids. Used by emitters that already
   * know the exact recipients (e.g. pipeline stage assignees, workflow
   * access grants). Applies the same permission gate + per-event matrix
   * check that notifyUsersByRoles uses, so a recipient who lacks the
   * event's requiredPermission or opted out of in-app for the event
   * still gets nothing.
   */
  async notifyUsers(
    userIds: string[],
    eventKey: NotifEventKey,
    title: string,
    message: string,
    relatedEntity?: string,
    relatedEntityId?: string,
    i18n?: { titleKey?: string; messageKey?: string; params?: Record<string, unknown> },
    /** Optional priority name (URGENT | HIGH | NORMAL | LOW). Mostly
     *  used by SYSTEM admin endpoints — routine fanouts let the DB
     *  default (3 = NORMAL) handle it without a row-level write. */
    priority?: string,
  ): Promise<{ created: number; deduped: number }> {
    this.assertTenantForFanout('notifyUsers');
    const tid = this.narrowingTenantId();
    const deduped0 = Array.from(new Set(userIds.filter(Boolean)));
    if (!deduped0.length) return { created: 0, deduped: 0 };

    // When tenant-aware, drop any id that isn't in the active tenant
    // (defence in depth — callers should never pass cross-tenant ids).
    let candidateIds = deduped0;
    if (tid) {
      const rows = await this.legacyPrisma.user.findMany({
        where: { id: { in: candidateIds }, agency: { tenantId: tid } },
        select: { id: true },
      });
      candidateIds = rows.map(r => r.id);
    }

    const gatedIds = new Set(await this.filterByEventPermission(candidateIds, eventKey));
    const type = (EVENT_TO_TYPE[eventKey] || 'INFO') as NotificationType;
    const priorityRank = NotificationsService.priorityNameToRank(priority);

    let created = 0, deduped = 0;
    for (const userId of gatedIds) {
      if (await this.userWantsChannel(userId, eventKey, 'in_app')) {
        const r = await this.createInAppWithDedup({
          userId,
          title,
          message,
          titleKey:   i18n?.titleKey   ?? null,
          messageKey: i18n?.messageKey ?? null,
          params:     (i18n?.params ?? null) as any,
          ...(priorityRank != null ? { priority: priorityRank } : {}),
          type,
          channel: 'in_app',
          relatedEntity,
          relatedEntityId,
          ...(tid ? { tenantId: tid } : {}),
        }, tid);
        created += r.created;
        deduped += r.deduped;
      }
      await this.enqueueEmail(userId, eventKey, title, message, relatedEntity, relatedEntityId, tid, i18n);
    }
    return { created, deduped };
  }

  /**
   * Broadcast a notification to every active user in a scope. Used by
   * the SYSTEM_* events (maintenance announcements, bulk-job results,
   * audit alerts) where the audience isn't a single role list.
   *
   * Scope rules:
   *   - `scopeTenantId === undefined`: fan out to every active user
   *     across every tenant. Reserved for SUPER USERs.
   *   - `scopeTenantId === <id>`: fan out to active users whose
   *     primary agency belongs to that tenant. Same predicate the
   *     two role-based fanouts already use.
   *
   * Permission gate + per-event preferences matrix run as usual
   * inside notifyUsers, so a user who lacks the event's
   * requiredPermission (or muted in-app for the event) still hears
   * nothing. SYSTEM_MAINTENANCE has no permission gate by design —
   * every user sees it.
   */
  async notifyAllUsers(
    scopeTenantId: string | undefined,
    eventKey: NotifEventKey,
    title: string,
    message: string,
    relatedEntity?: string,
    relatedEntityId?: string,
    i18n?: { titleKey?: string; messageKey?: string; params?: Record<string, unknown> },
    priority?: string,
  ): Promise<{ created: number; deduped: number; recipients: number }> {
    const users = await this.legacyPrisma.user.findMany({
      where: {
        status: 'ACTIVE',
        deletedAt: null,
        ...(scopeTenantId ? { agency: { tenantId: scopeTenantId } } : {}),
      },
      select: { id: true },
    });
    if (!users.length) return { created: 0, deduped: 0, recipients: 0 };
    const r = await this.notifyUsers(
      users.map(u => u.id),
      eventKey,
      title,
      message,
      relatedEntity,
      relatedEntityId,
      i18n,
      priority,
    );
    return { ...r, recipients: users.length };
  }

  /// Check if high balance alert was recently sent
  async wasHighBalanceAlertRecentlySent(entityId: string): Promise<boolean> {
    const t = this.scope().tenantWhere();
    const recent = await this.prisma.notification.findFirst({ // @tenant-reviewed: phase210-pilot-scope
      where: {
        relatedEntityId: entityId,
        type: 'WARNING',
        createdAt: { gte: new Date(Date.now() - 86400000) },
        ...t,
      },
    });
    return !!recent;
  }

  // ── Document expiry tiers ────────────────────────────────────────────────
  //
  // Spec §4.11.2 — Documents & Compliance: notify "60/30/14/7 days
  // before expiry". The upload-time emission already fires when a doc
  // is uploaded already-expiring, but multi-tier reminders need a
  // scan. This method runs from the notifications cron (legacy +
  // tenant-aware paths) every 6 hours and emits one notification per
  // (document, tier) pair the first time it crosses the threshold.

  private static readonly DOC_EXPIRY_TIERS = [60, 30, 14, 7] as const;
  private static readonly DOC_NOTIFY_ROLES_FOR_SCAN =
    ['System Admin', 'HR Manager', 'Compliance Officer'];

  /**
   * Has a tiered DOCUMENT_EXPIRING_SOON notification already been
   * emitted for this (documentId, tierDays) pair?
   *
   * Uses raw SQL because Prisma JSONB-key equality requires a Prisma
   * version-specific helper that doesn't ship in our generated client.
   * The `params->>'tierDays'` lookup is dialect-portable on Postgres.
   * Returns false on any error so a transient query failure leans
   * toward "re-emit" rather than "silently skip".
   */
  private async wasExpiryTierNotified(
    documentId: string,
    tierDays: number,
    tenantId: string | null,
  ): Promise<boolean> {
    try {
      const rows = await this.legacyPrisma.$queryRawUnsafe<{ exists: boolean }[]>(
        `SELECT EXISTS(
           SELECT 1 FROM "notifications"
            WHERE "relatedEntityId" = $1
              AND "eventType" = 'DOCUMENT_EXPIRING_SOON'
              AND "deletedAt" IS NULL
              AND ("params"->>'tierDays') = $2
              AND ($3::text IS NULL OR "tenantId" = $3::text)
            LIMIT 1
         ) AS "exists"`,
        documentId,
        String(tierDays),
        tenantId,
      );
      return !!rows?.[0]?.exists;
    } catch (e) {
      this.logger.warn(`wasExpiryTierNotified probe failed: ${(e as Error)?.message}`);
      return false;
    }
  }

  /** Same probe for the already-expired tier so DOCUMENT_EXPIRED
   *  doesn't re-fire on every scan once a doc passes its date. */
  private async wasExpiredNotified(
    documentId: string,
    tenantId: string | null,
  ): Promise<boolean> {
    try {
      const rows = await this.legacyPrisma.$queryRawUnsafe<{ exists: boolean }[]>(
        `SELECT EXISTS(
           SELECT 1 FROM "notifications"
            WHERE "relatedEntityId" = $1
              AND "eventType" = 'DOCUMENT_EXPIRED'
              AND "deletedAt" IS NULL
              AND ($2::text IS NULL OR "tenantId" = $2::text)
            LIMIT 1
         ) AS "exists"`,
        documentId,
        tenantId,
      );
      return !!rows?.[0]?.exists;
    } catch (e) {
      this.logger.warn(`wasExpiredNotified probe failed: ${(e as Error)?.message}`);
      return false;
    }
  }

  /**
   * Walk the document set for tenant-scoped (or all-tenants legacy)
   * documents with an expiryDate inside the alert window, and emit
   * one notification per (doc, tier) pair the first time the tier
   * is crossed.
   *
   * Trigger semantics:
   *   - For each doc, find the smallest tier T with daysLeft <= T
   *     that hasn't already fired. Emit that tier only and stop.
   *     This avoids emitting both tier 60 AND tier 30 on the same
   *     scan when the doc was uploaded mid-window.
   *   - When daysLeft <= 0 (already expired), emit DOCUMENT_EXPIRED
   *     instead — once.
   *
   * The audience is the uploader + DOC_NOTIFY_ROLES, mirroring the
   * upload-time emission. Stage 1's permission gate filters recipients
   * who don't hold `documents:read`; Stage 1's matrix lets them opt
   * out of in-app for this event.
   */
  async checkDocumentExpiry(): Promise<void> {
    const tid = this.narrowingTenantId();
    const now = new Date();
    const horizonDays = Math.max(...NotificationsService.DOC_EXPIRY_TIERS);
    const horizon = new Date(now.getTime() + horizonDays * 24 * 60 * 60 * 1000);

    // Pull a tight slice: documents in the alert window plus those
    // already expired so the EXPIRED branch fires too. REJECTED docs
    // are skipped — a rejected doc is no longer in the compliance
    // pipeline. We don't filter by status='EXPIRED' on the read so we
    // can detect freshly-expired rows that the upload-time emitter
    // missed.
    const docs = await this.legacyPrisma.document.findMany({
      where: {
        deletedAt: null,
        archivedAt: null, // archived docs no longer raise expiry reminders
        expiryDate: { not: null, lte: horizon },
        status: { not: 'REJECTED' as any },
        ...(tid ? { tenantId: tid } : {}),
      },
      select: {
        id: true, docId: true, name: true, expiryDate: true,
        uploadedById: true, entityType: true, entityId: true, tenantId: true,
        documentType: { select: { name: true } },
      },
      take: 5000, // safety ceiling per scan; cron re-runs every 6h.
    });

    const msPerDay = 24 * 60 * 60 * 1000;
    let emitted = 0;
    for (const doc of docs) {
      if (!doc.expiryDate) continue;
      const daysLeft = Math.ceil((doc.expiryDate.getTime() - now.getTime()) / msPerDay);

      if (daysLeft <= 0) {
        if (await this.wasExpiredNotified(doc.id, doc.tenantId ?? null)) continue;
        await this.notifyUploaderAndRoles(
          doc.uploadedById ?? '',
          NotificationsService.DOC_NOTIFY_ROLES_FOR_SCAN,
          NOTIF_EVENTS.DOCUMENT_EXPIRED,
          'Document Expired',
          `Document "${doc.name}" (${doc.docId}) is past its expiry date.`,
          doc.entityType as string,
          doc.entityId,
          {
            titleKey: 'events.documentExpired.title',
            messageKey: 'events.documentExpired.body',
            // Full document context so the daily digest can render
            // every column without re-deriving it. relatedEntityId
            // is the PERSON id (entityId) — the digest reads the
            // document fields from here, not from a doc-id lookup.
            params: {
              documentName: doc.name,
              docId: doc.docId,
              documentId: doc.id,
              documentType: doc.documentType?.name ?? null,
              expiryDate: doc.expiryDate ? doc.expiryDate.toISOString() : null,
              entityType: doc.entityType,
              entityId: doc.entityId,
            },
          },
        ).catch(e => this.logger.warn(`document-expiry expired emit failed (${doc.id}): ${(e as Error)?.message}`));
        emitted += 1;
        continue;
      }

      // Pick the SMALLEST tier (most urgent) still un-fired. Walking
      // ascending lets us emit tier 7 in preference to tier 14 if both
      // hadn't fired (catch-up on a doc that slipped past the longer
      // tiers).
      for (const tier of NotificationsService.DOC_EXPIRY_TIERS.slice().sort((a, b) => a - b)) {
        if (daysLeft > tier) continue;
        if (await this.wasExpiryTierNotified(doc.id, tier, doc.tenantId ?? null)) continue;
        await this.notifyUploaderAndRoles(
          doc.uploadedById ?? '',
          NotificationsService.DOC_NOTIFY_ROLES_FOR_SCAN,
          NOTIF_EVENTS.DOCUMENT_EXPIRING_SOON,
          'Document Expiring Soon',
          `Document "${doc.name}" (${doc.docId}) expires in ${daysLeft} day${daysLeft === 1 ? '' : 's'}.`,
          doc.entityType as string,
          doc.entityId,
          {
            titleKey: 'events.documentExpiringSoon.title',
            messageKey: 'events.documentExpiringSoon.body',
            // tierDays is the dedup key for future scans — see
            // wasExpiryTierNotified above. daysUntilExpiry is the
            // human number rendered in the message; they aren't the
            // same (a doc with 8 days left fires tier 14 with
            // daysUntilExpiry=8).
            params: {
              documentName: doc.name,
              docId: doc.docId,
              documentId: doc.id,
              documentType: doc.documentType?.name ?? null,
              expiryDate: doc.expiryDate ? doc.expiryDate.toISOString() : null,
              entityType: doc.entityType,
              entityId: doc.entityId,
              tierDays: tier,
              daysUntilExpiry: daysLeft,
            },
          },
        ).catch(e => this.logger.warn(`document-expiry tier${tier} emit failed (${doc.id}): ${(e as Error)?.message}`));
        emitted += 1;
        break; // most-urgent tier only per doc per scan
      }
    }
    if (emitted > 0) {
      this.logger.log(`[document-expiry] emitted ${emitted} notification(s)`);
    }
  }

  // ── Pipeline stage SLA tiers ─────────────────────────────────────────────
  //
  // Spec §4.11.2 — Workflow Pipeline: "Stage deadline approaching".
  // Each stage may carry an slaHours value; the per-candidate progress
  // row stamps slaDeadline = enteredAt + slaHours. Mirrors the
  // document-expiry pattern from Stage 5: two tiers, dedup by tier
  // via raw SQL on params->>'tierHours', smallest-unfired-tier wins
  // per scan.

  private static readonly PIPELINE_SLA_TIERS_HOURS = [24, 4] as const;

  /** Probe: was this (progress, tier) pair already notified? */
  private async wasPipelineDeadlineNotified(
    progressId: string,
    tierHours: number,
    tenantId: string | null,
  ): Promise<boolean> {
    try {
      const rows = await this.legacyPrisma.$queryRawUnsafe<{ exists: boolean }[]>(
        `SELECT EXISTS(
           SELECT 1 FROM "notifications"
            WHERE "relatedEntityId" = $1
              AND "eventType" = 'PIPELINE_DEADLINE_NEAR'
              AND "deletedAt" IS NULL
              AND ("params"->>'tierHours') = $2
              AND ($3::text IS NULL OR "tenantId" = $3::text)
            LIMIT 1
         ) AS "exists"`,
        progressId,
        String(tierHours),
        tenantId,
      );
      return !!rows?.[0]?.exists;
    } catch (e) {
      this.logger.warn(`wasPipelineDeadlineNotified probe failed: ${(e as Error)?.message}`);
      return false;
    }
  }

  /**
   * Scan active stage-progress rows whose slaDeadline falls inside the
   * widest tier (24h) and emit PIPELINE_DEADLINE_NEAR to the stage's
   * RESPONSIBLE assignees, once per (progress, tier).
   *
   * Audience: the stage's responsibles (mirrors the in-flow emission
   * pattern used by Stage 3 — same group already gets STAGE_ENTERED
   * for the same candidate, so the recipients are consistent).
   *
   * Tenant scoping:
   *   - In tenant-aware mode we narrow by the active ALS tenant via
   *     the join through CandidateWorkflowAssignment.tenantId.
   *   - In legacy mode we run cross-tenant; recipient resolution
   *     still respects each notification's tenantId stamp.
   */
  async checkPipelineDeadlines(): Promise<void> {
    const tid = this.narrowingTenantId();
    const now = new Date();
    const widestMs = Math.max(...NotificationsService.PIPELINE_SLA_TIERS_HOURS) * 3600 * 1000;
    const horizon = new Date(now.getTime() + widestMs);

    type ProgressRow = {
      id: string;
      assignmentId: string;
      stageId: string;
      slaDeadline: Date | null;
      stageName: string;
      tenantId: string | null;
      candidateId: string;
      candidateFirst: string | null;
      candidateLast: string | null;
    };

    const progresses = await this.legacyPrisma.$queryRawUnsafe<ProgressRow[]>(
      `SELECT p.id, p."assignmentId", p."stageId", p."slaDeadline",
              s.name AS "stageName",
              a."tenantId" AS "tenantId",
              a."candidateId" AS "candidateId",
              c."firstName" AS "candidateFirst",
              c."lastName"  AS "candidateLast"
         FROM "candidate_stage_progress" p
         JOIN "workflow_stages" s ON s.id = p."stageId"
         JOIN "candidate_workflow_assignments" a ON a.id = p."assignmentId"
         LEFT JOIN "applicants" c ON c.id = a."candidateId"
        WHERE p.status IN ('IN_PROGRESS','ACTIVE')
          AND p."slaDeadline" IS NOT NULL
          AND p."slaDeadline" > $1
          AND p."slaDeadline" <= $2
          AND ($3::text IS NULL OR a."tenantId" = $3::text)
        ORDER BY p."slaDeadline" ASC
        LIMIT 2000`,
      now,
      horizon,
      tid,
    );

    if (!progresses.length) return;

    let emitted = 0;
    for (const p of progresses) {
      if (!p.slaDeadline) continue;
      const hoursLeft = Math.ceil((p.slaDeadline.getTime() - now.getTime()) / (3600 * 1000));
      const tiers = NotificationsService.PIPELINE_SLA_TIERS_HOURS.slice().sort((a, b) => a - b);
      for (const tier of tiers) {
        if (hoursLeft > tier) continue;
        if (await this.wasPipelineDeadlineNotified(p.id, tier, p.tenantId)) continue;

        const responsibleRows = await this.legacyPrisma.$queryRawUnsafe<{ userId: string }[]>(
          `SELECT "userId" FROM "workflow_stage_users"
            WHERE "stageId" = $1 AND "role" = 'RESPONSIBLE'`,
          p.stageId,
        );
        const responsibleIds = responsibleRows.map(r => r.userId);
        if (!responsibleIds.length) {
          // No-one to ping for this stage — skip but DO NOT mark as
          // notified, so a later assignment edit picks the tier up.
          break;
        }

        const candidateName = `${p.candidateFirst ?? ''} ${p.candidateLast ?? ''}`.trim();
        try {
          await this.notifyUsers(
            responsibleIds,
            NOTIF_EVENTS.PIPELINE_DEADLINE_NEAR,
            'Stage deadline approaching',
            `${candidateName || 'A candidate'} at "${p.stageName}" has ${hoursLeft} hour${hoursLeft === 1 ? '' : 's'} until the SLA deadline.`,
            'APPLICANT',
            p.candidateId,
            {
              titleKey: 'events.pipelineDeadlineNear.title',
              messageKey: 'events.pipelineDeadlineNear.body',
              params: {
                candidateName,
                stageName: p.stageName,
                hoursLeft,
                tierHours: tier,
                progressId: p.id,
              },
            },
          );
          emitted += 1;
        } catch (e) {
          this.logger.warn(`pipeline-deadline tier${tier} emit failed (${p.id}): ${(e as Error)?.message}`);
        }
        break; // smallest unfired tier per progress per scan
      }
    }

    if (emitted > 0) {
      this.logger.log(`[pipeline-deadlines] emitted ${emitted} notification(s)`);
    }
  }

  // ── Employee contract lifecycle ─────────────────────────────────────────
  //
  // §4.11.2 — "Contract expiring soon" (tiered) and "Contract ended"
  // (one-shot once expiry is past). Mirrors the document-expiry
  // pattern from Stage 5 but on a tighter cadence — contracts are
  // shorter-lived than passports / visas so the tiers are
  // proportionally tighter.

  private static readonly EMPLOYEE_CONTRACT_TIERS = [30, 14, 7] as const;
  private static readonly EMPLOYEE_NOTIFY_ROLES_FOR_SCAN =
    ['System Admin', 'HR Manager', 'Recruiter'];

  /** Probe: was this (employee, tier) pair already notified? */
  private async wasContractTierNotified(
    employeeId: string,
    tierDays: number,
    tenantId: string | null,
  ): Promise<boolean> {
    try {
      const rows = await this.legacyPrisma.$queryRawUnsafe<{ exists: boolean }[]>(
        `SELECT EXISTS(
           SELECT 1 FROM "notifications"
            WHERE "relatedEntityId" = $1
              AND "eventType" = 'EMPLOYEE_CONTRACT_EXPIRING'
              AND "deletedAt" IS NULL
              AND ("params"->>'tierDays') = $2
              AND ($3::text IS NULL OR "tenantId" = $3::text)
            LIMIT 1
         ) AS "exists"`,
        employeeId,
        String(tierDays),
        tenantId,
      );
      return !!rows?.[0]?.exists;
    } catch (e) {
      this.logger.warn(`wasContractTierNotified probe failed: ${(e as Error)?.message}`);
      return false;
    }
  }

  /** Probe: was the once-only ENDED notification already sent? */
  private async wasContractEndedNotified(
    employeeId: string,
    tenantId: string | null,
  ): Promise<boolean> {
    try {
      const rows = await this.legacyPrisma.$queryRawUnsafe<{ exists: boolean }[]>(
        `SELECT EXISTS(
           SELECT 1 FROM "notifications"
            WHERE "relatedEntityId" = $1
              AND "eventType" = 'EMPLOYEE_CONTRACT_ENDED'
              AND "deletedAt" IS NULL
              AND ($2::text IS NULL OR "tenantId" = $2::text)
            LIMIT 1
         ) AS "exists"`,
        employeeId,
        tenantId,
      );
      return !!rows?.[0]?.exists;
    } catch (e) {
      this.logger.warn(`wasContractEndedNotified probe failed: ${(e as Error)?.message}`);
      return false;
    }
  }

  async checkEmployeeContracts(): Promise<void> {
    const tid = this.narrowingTenantId();
    const now = new Date();
    const horizonDays = Math.max(...NotificationsService.EMPLOYEE_CONTRACT_TIERS);
    const horizon = new Date(now.getTime() + horizonDays * 24 * 60 * 60 * 1000);

    type Row = {
      id: string;
      firstName: string | null;
      lastName: string | null;
      employeeNumber: string | null;
      contractEndDate: Date;
      tenantId: string | null;
      status: string;
    };

    // Single query for both branches: rows with contractEndDate inside
    // the look-ahead window OR already past. RENEWED events are not
    // produced by the cron (that's the update-path detection); we only
    // emit EXPIRING / ENDED here.
    const rows = await this.legacyPrisma.$queryRawUnsafe<Row[]>(
      `SELECT id, "firstName", "lastName", "employeeNumber",
              "contractEndDate", "tenantId", status
         FROM "employees"
        WHERE "deletedAt" IS NULL
          AND "contractEndDate" IS NOT NULL
          AND "contractEndDate" <= $1
          AND ($2::text IS NULL OR "tenantId" = $2::text)
        ORDER BY "contractEndDate" ASC
        LIMIT 5000`,
      horizon,
      tid,
    );

    if (!rows.length) return;
    const msPerDay = 24 * 60 * 60 * 1000;
    let emitted = 0;

    for (const e of rows) {
      const daysLeft = Math.ceil((e.contractEndDate.getTime() - now.getTime()) / msPerDay);
      const displayName = [e.firstName, e.lastName].filter(Boolean).join(' ');

      if (daysLeft <= 0) {
        // Skip rows that are already TERMINATED — the contract ended
        // because we explicitly closed the employment; the spec's
        // CONTRACT_ENDED event is about the contract date passing
        // while the employee is still otherwise active.
        if (e.status === 'TERMINATED') continue;
        if (await this.wasContractEndedNotified(e.id, e.tenantId)) continue;
        try {
          await this.notifyUsersByRoles(
            NotificationsService.EMPLOYEE_NOTIFY_ROLES_FOR_SCAN,
            NOTIF_EVENTS.EMPLOYEE_CONTRACT_ENDED,
            'Contract ended',
            `${displayName || 'An employee'} (${e.employeeNumber ?? e.id.slice(0, 8)}) — contract end date has passed (${e.contractEndDate.toISOString().slice(0, 10)}).`,
            'EMPLOYEE',
            e.id,
            {
              titleKey: 'events.employeeContractEnded.title',
              messageKey: 'events.employeeContractEnded.body',
              params: {
                fullName: displayName,
                employeeNumber: e.employeeNumber,
                contractEndDate: e.contractEndDate.toISOString().slice(0, 10),
              },
            },
          );
          emitted += 1;
        } catch (err) {
          this.logger.warn(`contract-ended emit failed (${e.id}): ${(err as Error)?.message}`);
        }
        continue;
      }

      // Smallest unfired tier wins per scan; mirrors the
      // document-expiry walk.
      const tiers = NotificationsService.EMPLOYEE_CONTRACT_TIERS.slice().sort((a, b) => a - b);
      for (const tier of tiers) {
        if (daysLeft > tier) continue;
        if (await this.wasContractTierNotified(e.id, tier, e.tenantId)) continue;
        try {
          await this.notifyUsersByRoles(
            NotificationsService.EMPLOYEE_NOTIFY_ROLES_FOR_SCAN,
            NOTIF_EVENTS.EMPLOYEE_CONTRACT_EXPIRING,
            'Contract expiring soon',
            `${displayName || 'An employee'} (${e.employeeNumber ?? e.id.slice(0, 8)}) — contract expires in ${daysLeft} day${daysLeft === 1 ? '' : 's'} (${e.contractEndDate.toISOString().slice(0, 10)}).`,
            'EMPLOYEE',
            e.id,
            {
              titleKey: 'events.employeeContractExpiring.title',
              messageKey: 'events.employeeContractExpiring.body',
              params: {
                fullName: displayName,
                employeeNumber: e.employeeNumber,
                tierDays: tier,
                daysUntilEnd: daysLeft,
                contractEndDate: e.contractEndDate.toISOString().slice(0, 10),
              },
            },
          );
          emitted += 1;
        } catch (err) {
          this.logger.warn(`contract-expiring tier${tier} emit failed (${e.id}): ${(err as Error)?.message}`);
        }
        break; // most-urgent tier only per scan
      }
    }

    if (emitted > 0) {
      this.logger.log(`[employee-contracts] emitted ${emitted} notification(s)`);
    }
  }
}
