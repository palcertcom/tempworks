/**
 * Daily document-compliance digest cron.
 *
 * Replaces the per-row emails that used to leak out every 60s on the
 * heels of the 6h `checkDocumentExpiry` scan. Each morning this cron:
 *   1. Selects un-digested in-app notifications whose eventType
 *      identifies a document-compliance event (DOCUMENT_EXPIRING_SOON,
 *      DOCUMENT_EXPIRED, DOCUMENT_REJECTED — extend the constant below
 *      to add a new digestable event, e.g. a future
 *      DOCUMENT_MISSING).
 *   2. Groups the rows by recipient `userId`. One email per user.
 *   3. Enriches each row with the underlying document name, document
 *      type, and the linked employee/applicant name.
 *   4. Skips users who opted out of email for the underlying event
 *      via their notification matrix (preserves §4.11.2 channel
 *      toggles).
 *   5. Renders one HTML table per recipient and queues it through
 *      EmailService, then stamps `digestedAt = NOW()` on every row
 *      it included so subsequent passes skip them.
 *
 * Design notes:
 *   - Tenant isolation: every `notifications.tenantId` was already
 *     stamped by the upstream fanout (`notifyUploaderAndRoles` runs
 *     `users.agency.tenantId = tid`). We do not widen that scope —
 *     a user only ever receives rows that were fanned out to them,
 *     so SUPER users keep whatever scope they were emitted under and
 *     agency users see only their own tenant.
 *   - Dedup: by (userId, documentId, eventType). One scan may emit
 *     DOCUMENT_EXPIRING_SOON at tier 30 and later DOCUMENT_EXPIRED;
 *     both are valid table rows. Two rows with the same eventType
 *     for the same doc would only happen on a back-fill bug —
 *     `Map` keyed by `${userId}|${documentId}|${eventType}` drops
 *     the duplicates defensively.
 *   - Empty days: when a user has no un-digested rows, no email goes
 *     out. The cron does not emit an "all clear" empty summary.
 *   - Idempotent: `digestedAt IS NULL` is the gate. If a send fails
 *     halfway through a batch, the surviving rows stay un-digested
 *     and roll into the next pass.
 */
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { SchedulerRegistry } from '@nestjs/schedule';
import { CronJob } from 'cron';
import { PrismaService } from '../prisma/prisma.service';
import { EmailService } from '../email/email.service';
import { NotificationsService } from './notifications.service';
import { NOTIF_EVENTS } from './notification-events';

/** Events the digest covers — used only to read each recipient's
 *  per-event email channel preference. The table content itself comes
 *  from a live document scan, not these event rows. */
const DIGEST_EVENT_TYPES: string[] = [
  NOTIF_EVENTS.DOCUMENT_EXPIRING_SOON,
  NOTIF_EVENTS.DOCUMENT_EXPIRED,
  NOTIF_EVENTS.DOCUMENT_REJECTED,
];

/** Roles that receive the scheduled / "Send All" digest. Mirrors the
 *  document-notify group the upload/expiry emitters already fan out to. */
const DIGEST_NOTIFY_ROLES: string[] = ['System Admin', 'HR Manager', 'Compliance Officer'];

/** Expiring-soon window (days) — matches the Documents & Compliance
 *  dashboard's "expiring soon" tile so the email and the dashboard agree. */
const EXPIRING_WINDOW_DAYS = 60;

interface DigestRow {
  documentName: string;
  documentType: string;
  personName: string;
  personType: 'Employee' | 'Applicant' | 'Other';
  reason: string;
  expiryDate: string | null;
  tenantLabel?: string | null;
  agencyLabel?: string | null;
  /** Relative SPA paths; EmailService prefixes the frontend origin to
   *  turn the document name / person name into one-click deep links. */
  documentPath?: string | null;
  personPath?: string | null;
}

// Defaults when no admin schedule is saved. 08:00 Europe/Bratislava —
// early enough that morning teams see the digest first thing. The env
// vars seed the very first boot; once a SUPER user saves a schedule
// it lives in `system_settings` and wins.
const DEFAULT_HOUR = (() => {
  const h = Number(process.env.DOCUMENT_DIGEST_HOUR);
  return Number.isInteger(h) && h >= 0 && h <= 23 ? h : 8;
})();
const DEFAULT_MINUTE = (() => {
  const m = Number(process.env.DOCUMENT_DIGEST_MINUTE);
  return Number.isInteger(m) && m >= 0 && m <= 59 ? m : 0;
})();
const DEFAULT_TIMEZONE = process.env.DOCUMENT_DIGEST_TZ?.trim() || 'Europe/Bratislava';

export interface DigestSchedule {
  hour: number;
  minute: number;
  timezone: string;
}
export interface DigestRunResult {
  recipients: number;
  rows: number;
  emailsSent: number;
  skippedNoOptIn: number;
}

@Injectable()
export class DocumentDigestCron implements OnModuleInit {
  private readonly logger = new Logger('DocumentDigestCron');
  private static readonly JOB_NAME = 'document-digest';
  /** system_settings key holding {hour, minute, timezone} as JSON. */
  private static readonly SETTING_KEY = 'system.documentDigestSchedule';

  constructor(
    private readonly prisma: PrismaService,
    private readonly email: EmailService,
    private readonly notifications: NotificationsService,
    private readonly scheduler: SchedulerRegistry,
  ) {}

  async onModuleInit(): Promise<void> {
    try {
      await this.reschedule();
    } catch (err: any) {
      this.logger.warn(`[document-digest] initial schedule failed: ${err?.message ?? err}`);
    }
  }

  /** Cron callback. Runs the full (all-recipients) digest. */
  private async tick(): Promise<void> {
    try {
      const result = await this.runOnce();
      this.logger.log(
        `[document-digest] users=${result.recipients} rows=${result.rows} sent=${result.emailsSent} skipped=${result.skippedNoOptIn}`,
      );
    } catch (err: any) {
      this.logger.warn(`[document-digest] tick failed: ${err?.message ?? err}`);
    }
  }

  // ── Schedule management ──────────────────────────────────────────────────

  /** Read the saved schedule, falling back to env/defaults. */
  async getSchedule(): Promise<DigestSchedule> {
    try {
      const row = await this.prisma.systemSetting.findUnique({
        where: { key: DocumentDigestCron.SETTING_KEY },
        select: { value: true },
      });
      if (row?.value) {
        const parsed = JSON.parse(row.value);
        const hour = Number(parsed.hour);
        const minute = Number(parsed.minute);
        if (Number.isInteger(hour) && hour >= 0 && hour <= 23 &&
            Number.isInteger(minute) && minute >= 0 && minute <= 59) {
          return { hour, minute, timezone: parsed.timezone || DEFAULT_TIMEZONE };
        }
      }
    } catch (e) {
      this.logger.warn(`[document-digest] getSchedule failed: ${(e as Error)?.message}`);
    }
    return { hour: DEFAULT_HOUR, minute: DEFAULT_MINUTE, timezone: DEFAULT_TIMEZONE };
  }

  /** Persist a new schedule (validated) and re-register the cron job. */
  async setSchedule(input: { hour: number; minute: number; timezone?: string }, actorId?: string): Promise<DigestSchedule> {
    const hour = Number(input.hour);
    const minute = Number(input.minute);
    if (!Number.isInteger(hour) || hour < 0 || hour > 23) {
      throw new Error('hour must be an integer 0-23');
    }
    if (!Number.isInteger(minute) || minute < 0 || minute > 59) {
      throw new Error('minute must be an integer 0-59');
    }
    const timezone = (input.timezone && input.timezone.trim()) || DEFAULT_TIMEZONE;
    // Validate the timezone by attempting to format with it — throws
    // RangeError on an unknown zone, surfaced to the caller as 400.
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: timezone });
    } catch {
      throw new Error(`invalid timezone: ${timezone}`);
    }

    const value = JSON.stringify({ hour, minute, timezone });
    await this.prisma.systemSetting.upsert({
      where: { key: DocumentDigestCron.SETTING_KEY },
      update: { value, updatedById: actorId ?? null },
      create: {
        key: DocumentDigestCron.SETTING_KEY,
        value,
        description: 'Daily document digest schedule (hour/minute/timezone).',
        category: 'notifications',
        isPublic: false,
        updatedById: actorId ?? null,
      },
    });

    await this.reschedule();
    return { hour, minute, timezone };
  }

  /** (Re)register the dynamic cron job from the saved schedule. */
  private async reschedule(): Promise<void> {
    const { hour, minute, timezone } = await this.getSchedule();
    const cronExpr = `${minute} ${hour} * * *`;

    // Remove any prior registration so a re-schedule doesn't stack.
    try {
      this.scheduler.deleteCronJob(DocumentDigestCron.JOB_NAME);
    } catch {
      // no existing job — first registration
    }

    const job = CronJob.from({
      cronTime: cronExpr,
      onTick: () => { void this.tick(); },
      timeZone: timezone,
    });
    this.scheduler.addCronJob(DocumentDigestCron.JOB_NAME, job as any);
    job.start();
    this.logger.log(`[document-digest] scheduled at ${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')} ${timezone} (cron "${cronExpr}")`);
  }
  /**
   * One digest pass — a LIVE scan of the current document-compliance
   * state (not a replay of notification rows). Each recipient receives
   * a table of the documents in their tenant that are, right now,
   * expired / expiring within the window / rejected — guaranteeing the
   * email matches the Documents & Compliance dashboard.
   *
   * Tenant resolution mirrors the dashboard: a document's owning tenant
   * is taken from its linked Employee/Applicant (Document.tenantId is a
   * denorm that is NULL until backfill, so it can't be relied on). A
   * platform-authority recipient (System Admin with no single tenant)
   * sees every tenant's documents, each annotated with its tenant.
   *
   * @param opts.onlyUserId  Scope the run to a single recipient
   *   (the SUPER-user "Send Me" button). Omitted = every active user
   *   in the document-notify roles ("Send All" / scheduled run).
   */
  async runOnce(opts: { onlyUserId?: string } = {}): Promise<DigestRunResult> {
    const recipients = await this.loadRecipients(opts.onlyUserId);
    if (!recipients.length) {
      return { recipients: 0, rows: 0, emailsSent: 0, skippedNoOptIn: 0 };
    }

    const now = new Date();
    const fwd = new Date(now.getTime() + EXPIRING_WINDOW_DAYS * 24 * 60 * 60 * 1000);

    // One global scan of every document in a compliance-alert state,
    // enriched with the owning person + that person's tenant. Reused
    // across all recipients (filtered per recipient below).
    const alerts = await this.scanAndEnrich(now, fwd);
    if (!alerts.length) {
      return { recipients: 0, rows: 0, emailsSent: 0, skippedNoOptIn: 0 };
    }

    // Tenant display-name map for annotation / subject lines.
    const tenantIds = Array.from(new Set(alerts.map(a => a.tenantId).filter((x): x is string => !!x)));
    const tenants = tenantIds.length
      ? await this.prisma.tenant.findMany({ where: { id: { in: tenantIds } }, select: { id: true, name: true } })
      : [];
    const tenantNameById = new Map(tenants.map(t => [t.id, t.name]));

    let emailsSent = 0;
    let skipped = 0;
    let totalRows = 0;
    let recipientsWithData = 0;

    for (const u of recipients) {
      if (!u.email) { skipped += 1; continue; }
      if (!(await this.recipientWantsDigestEmail(u.id))) { skipped += 1; continue; }

      // Scope: a System Admin with no single tenant is platform
      // authority and sees every tenant; everyone else is scoped to
      // their own tenant. A non-platform user with no tenant can't be
      // scoped safely → skip.
      const homeTenant: string | null = (u as any).agency?.tenantId ?? null;
      const isPlatform = (u as any).roleName === 'System Admin';
      let scopeAll = false;
      let scopeTenant: string | null = null;
      if (homeTenant) scopeTenant = homeTenant;
      else if (isPlatform) scopeAll = true;
      else continue;

      const visible = scopeAll ? alerts : alerts.filter(a => a.tenantId === scopeTenant);
      if (!visible.length) continue;

      const tableRows: DigestRow[] = visible.map(a => ({
        documentName: a.documentName,
        documentType: a.documentType,
        personName: a.personName,
        personType: a.personType,
        reason: a.reason,
        expiryDate: a.expiryDate,
        documentPath: a.documentPath,
        personPath: a.personPath,
        // Annotate the tenant/agency when the recipient spans tenants
        // (platform view) or the doc is from another tenant.
        tenantLabel: (scopeAll || a.tenantId !== scopeTenant)
          ? (a.tenantId ? (tenantNameById.get(a.tenantId) ?? null) : null)
          : null,
        agencyLabel: (scopeAll || a.tenantId !== scopeTenant) ? a.agencyName : null,
      }));

      recipientsWithData += 1;
      const recipientTenantLabel = scopeTenant ? (tenantNameById.get(scopeTenant) ?? null) : null;
      const fullName = `${u.firstName ?? ''} ${u.lastName ?? ''}`.trim() || u.email;
      try {
        await this.email.sendDocumentDigestEmail(
          u.email,
          fullName,
          tableRows,
          recipientTenantLabel,
          ((u as any).preferredLanguage ?? 'en') as any,
        );
        emailsSent += 1;
        totalRows += tableRows.length;
      } catch (e) {
        this.logger.warn(`[document-digest] send failed for ${u.email}: ${(e as Error)?.message ?? e}`);
      }
    }

    return { recipients: recipientsWithData, rows: totalRows, emailsSent, skippedNoOptIn: skipped };
  }

  /**
   * Recipients for the run. "Send Me" (onlyUserId) targets exactly that
   * user regardless of role — the SUPER-only button gates access. The
   * scheduled / "Send All" run targets every ACTIVE user holding a
   * document-notify role; each is scoped to their tenant downstream.
   */
  private async loadRecipients(onlyUserId?: string) {
    const where: any = onlyUserId
      ? { id: onlyUserId }
      : { status: 'ACTIVE', deletedAt: null, role: { name: { in: DIGEST_NOTIFY_ROLES } } };
    const rows = await this.prisma.user.findMany({
      where,
      select: {
        id: true, email: true, firstName: true, lastName: true, preferredLanguage: true,
        role: { select: { name: true } },
        agency: { select: { name: true, tenantId: true } },
      },
    });
    return rows.map((r: any) => ({ ...r, roleName: r.role?.name ?? null }));
  }

  /** True if the user has email enabled for at least one digest event. */
  private async recipientWantsDigestEmail(userId: string): Promise<boolean> {
    for (const ev of DIGEST_EVENT_TYPES) {
      const wants = await this.notifications.wantsChannel(userId, ev, 'email').catch(() => true);
      if (wants) return true;
    }
    return false;
  }

  /**
   * Scan every document currently in a compliance-alert state
   * (rejected / stored-EXPIRED / past expiry / expiring within the
   * window), then enrich each with its owning Employee/Applicant name
   * and that person's tenant. Returns flat, display-ready rows.
   */
  private async scanAndEnrich(now: Date, fwd: Date): Promise<Array<{
    documentName: string; documentType: string;
    personName: string; personType: DigestRow['personType'];
    reason: string; expiryDate: string | null;
    tenantId: string | null; agencyName: string | null;
    documentPath: string | null; personPath: string | null;
  }>> {
    const docs = await this.prisma.document.findMany({
      where: {
        deletedAt: null,
        archivedAt: null, // archived ("no longer valid") docs drop out of the digest
        OR: [
          { status: 'REJECTED' as any },
          { status: 'EXPIRED' as any },
          { expiryDate: { not: null, lt: now } },
          { expiryDate: { not: null, gt: now, lte: fwd } },
        ],
      },
      select: {
        id: true, docId: true, name: true, expiryDate: true, status: true,
        entityType: true, entityId: true, tenantId: true,
        documentType: { select: { name: true } },
      },
      orderBy: { expiryDate: 'asc' },
      take: 5000,
    });
    if (!docs.length) return [];

    const empIds = Array.from(new Set(docs.filter((d: any) => d.entityType === 'EMPLOYEE').map((d: any) => d.entityId)));
    const appIds = Array.from(new Set(docs.filter((d: any) => d.entityType === 'APPLICANT').map((d: any) => d.entityId)));
    const [emps, apps] = await Promise.all([
      empIds.length
        ? this.prisma.employee.findMany({ where: { id: { in: empIds } }, select: { id: true, firstName: true, lastName: true, tenantId: true, agency: { select: { name: true, tenantId: true } } } })
        : Promise.resolve([] as any[]),
      appIds.length
        ? this.prisma.applicant.findMany({ where: { id: { in: appIds } }, select: { id: true, firstName: true, lastName: true, tenantId: true, agency: { select: { name: true, tenantId: true } } } })
        : Promise.resolve([] as any[]),
    ]);
    const empById = new Map(emps.map((e: any) => [e.id, e]));
    const appById = new Map(apps.map((a: any) => [a.id, a]));

    return docs.map((d: any) => {
      let personName = '—';
      let personType: DigestRow['personType'] = 'Other';
      let tenantId: string | null = d.tenantId ?? null;
      let agencyName: string | null = null;
      if (d.entityType === 'EMPLOYEE') {
        const e: any = empById.get(d.entityId);
        personType = 'Employee';
        personName = e ? (`${e.firstName ?? ''} ${e.lastName ?? ''}`.trim() || 'Employee') : 'Employee';
        tenantId = e?.tenantId ?? e?.agency?.tenantId ?? d.tenantId ?? null;
        agencyName = e?.agency?.name ?? null;
      } else if (d.entityType === 'APPLICANT') {
        const a: any = appById.get(d.entityId);
        personType = 'Applicant';
        personName = a ? (`${a.firstName ?? ''} ${a.lastName ?? ''}`.trim() || 'Candidate') : 'Candidate';
        tenantId = a?.tenantId ?? a?.agency?.tenantId ?? d.tenantId ?? null;
        agencyName = a?.agency?.name ?? null;
      }
      // Deep-link targets (relative SPA paths; EmailService adds the
      // frontend origin). Document → the document detail view; person
      // → their employee / candidate profile.
      const documentPath = `/dashboard/documents/${d.id}`;
      const personPath =
        d.entityType === 'EMPLOYEE'  ? `/dashboard/employees/${d.entityId}` :
        d.entityType === 'APPLICANT' ? `/dashboard/applicants/${d.entityId}` :
        null;

      return {
        documentName: d.name || '—',
        documentType: d.documentType?.name || '—',
        personName,
        personType,
        reason: DocumentDigestCron.deriveReason(d, now, fwd),
        expiryDate: d.expiryDate ? new Date(d.expiryDate).toISOString().slice(0, 10) : null,
        tenantId,
        agencyName,
        documentPath,
        personPath,
      };
    });
  }

  /** Human reason string from a document's live compliance state. */
  private static deriveReason(d: any, now: Date, fwd: Date): string {
    if (d.status === 'REJECTED') return 'Rejected';
    if (d.status === 'EXPIRED') return 'Expired';
    if (d.expiryDate && new Date(d.expiryDate).getTime() < now.getTime()) return 'Expired';
    if (d.expiryDate && new Date(d.expiryDate).getTime() <= fwd.getTime()) return 'Expiring soon';
    return 'Document notification';
  }
}
