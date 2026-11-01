/**
 * Phase 2C (#37) — Employee birthday reminders for HR Managers.
 *
 * Runs daily at 09:00 Europe/Bratislava. For each tenant, finds
 * employees whose birthday falls 7 days from "today (CET)" and
 * notifies every ACTIVE HR Manager in that tenant. Dedup is based on
 * (userId, eventType, relatedEntityId, relatedEntity) where
 * `relatedEntityId = employeeId` and `relatedEntity = "Birthday-YYYY"` —
 * so the same employee can be notified again next year but not twice in
 * the same calendar year.
 *
 * Tenant scoping is enforced by routing every notification's `tenantId`
 * to the EMPLOYEE'S tenant (or to the employee's agency.tenantId
 * when the row itself has none) and only fanning out to HR Managers
 * within that same tenant.
 */
import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { NOTIF_EVENTS } from './notification-events';

// 09:00 every day, Europe/Bratislava — picked to land in HR's morning.
const CRON_EXPRESSION = process.env.BIRTHDAY_REMINDER_CRON?.trim() || '0 9 * * *';
const LOOKAHEAD_DAYS = 7;

/**
 * Roles that receive the reminder. HR Manager is the original audience;
 * System Admin gives platform/tenant admins oversight, and Agency Manager
 * gives the employee's direct manager a heads-up. Override via the
 * BIRTHDAY_REMINDER_ROLES env var (comma-separated role names) when an
 * operator wants a different fan-out without redeploying.
 *
 * Agency Manager is scoped further below to managers within the
 * employee's own agency — otherwise a tenant with many agencies would
 * spam every Agency Manager for every employee's birthday.
 */
const DEFAULT_NOTIFY_ROLES = ['HR Manager', 'System Admin', 'Agency Manager'];
const NOTIFY_ROLES: string[] = (process.env.BIRTHDAY_REMINDER_ROLES ?? '')
  .split(',').map(s => s.trim()).filter(Boolean);
const ROLES = NOTIFY_ROLES.length > 0 ? NOTIFY_ROLES : DEFAULT_NOTIFY_ROLES;
/** Roles that should be limited to users in the employee's own agency. */
const AGENCY_SCOPED_ROLES = new Set(['Agency Manager']);

@Injectable()
export class BirthdayNotificationCron {
  private readonly logger = new Logger('BirthdayNotificationCron');

  constructor(private readonly prisma: PrismaService) {}

  @Cron(CRON_EXPRESSION, { name: 'employee-birthday-reminders', timeZone: 'Europe/Bratislava' })
  async tick(): Promise<void> {
    try {
      const result = await this.runOnce();
      this.logger.log(`[birthday] matched=${result.matchedEmployees} created=${result.created} deduped=${result.deduped}`);
    } catch (err: any) {
      this.logger.warn(`[birthday] tick failed: ${err?.message ?? err}`);
    }
  }

  /**
   * Runs one pass; exposed for tests. Reading by `dateOfBirth` columns
   * is safer than expressing PostgreSQL `EXTRACT(month FROM …)` through
   * Prisma — we just scan the active employee set (small) and match
   * month+day in memory.
   */
  async runOnce(): Promise<{ matchedEmployees: number; created: number; deduped: number }> {
    const tomorrowPlus7 = this.cetDateInLookahead();
    const wantMonth = tomorrowPlus7.month;
    const wantDay = tomorrowPlus7.day;
    const yearTag = `Birthday-${tomorrowPlus7.year}`;

    const employees = await this.prisma.employee.findMany({
      where: { deletedAt: null, status: 'ACTIVE' as any, dateOfBirth: { not: null } },
      select: {
        id: true, firstName: true, lastName: true,
        dateOfBirth: true, tenantId: true, agencyId: true,
        agency: { select: { tenantId: true } } as any,
      } as any,
    });

    let matched = 0;
    let created = 0;
    let deduped = 0;

    for (const emp of employees) {
      const dob = (emp as any).dateOfBirth as Date | null;
      if (!dob) continue;
      // dateOfBirth is stored as a UTC date; compare components in UTC.
      const d = new Date(dob);
      if (d.getUTCMonth() + 1 !== wantMonth || d.getUTCDate() !== wantDay) continue;
      matched++;

      // The employee's tenant is the row's own tenantId; legacy/null
      // rows fall back to their agency's tenant.
      const tenantId: string | null =
        (emp as any).tenantId ?? (emp as any).agency?.tenantId ?? null;
      if (!tenantId) continue; // no tenant context → can't fan out

      // Fan out across every configured role. Agency-scoped roles
      // (e.g. Agency Manager) are limited to managers in the employee's
      // own agency so the reminder lands with the right team, not every
      // agency in the tenant. Tenant-wide roles (HR Manager, System Admin)
      // match every active user in that role for the tenant.
      const empAgencyId = (emp as any).agencyId ?? null;
      const recipientIds = new Set<string>();
      for (const roleName of ROLES) {
        const isAgencyScoped = AGENCY_SCOPED_ROLES.has(roleName);
        // Skip agency-scoped roles when the employee row has no agency —
        // we have no way to pick the right manager set.
        if (isAgencyScoped && !empAgencyId) continue;
        const rows = await this.prisma.user.findMany({
          where: {
            status: 'ACTIVE' as any,
            deletedAt: null,
            role: { name: roleName },
            agency: {
              tenantId,
              ...(isAgencyScoped ? { id: empAgencyId } : {}),
            },
          },
          select: { id: true },
        });
        for (const r of rows) recipientIds.add(r.id);
      }
      if (recipientIds.size === 0) continue;

      const fullName = `${(emp as any).firstName ?? ''} ${(emp as any).lastName ?? ''}`.trim();
      const birthdayIso = `${tomorrowPlus7.year}-${String(wantMonth).padStart(2, '0')}-${String(wantDay).padStart(2, '0')}`;
      const age = tomorrowPlus7.year - d.getUTCFullYear();
      // Phase 2C #37 — i18n. titleKey/messageKey/params are resolved at
      // read time by NotificationsService.getUserNotifications against
      // backend/src/common/i18n/locales/<lang>/notifications.json. The
      // English fallbacks below keep legacy clients working when no
      // server locale matches the user's Accept-Language.
      const ageLabel = Number.isFinite(age) && age > 0 ? ` (turning ${age})` : '';
      const params = { name: fullName, date: birthdayIso, ageLabel };
      const fallbackTitle = `Birthday reminder: ${fullName}`;
      const fallbackMessage = `${fullName} has a birthday on ${birthdayIso}${ageLabel}. Open the profile to send a note.`;

      for (const userId of recipientIds) {
        // Dedup: skip if a notification with the same composite key
        // already exists this calendar year.
        const existing = await this.prisma.notification.findFirst({
          where: {
            userId,
            eventType: NOTIF_EVENTS.EMPLOYEE_BIRTHDAY_REMINDER,
            relatedEntityId: (emp as any).id,
            relatedEntity: yearTag,
          },
          select: { id: true },
        });
        if (existing) { deduped++; continue; }

        await this.prisma.notification.create({
          data: {
            userId,
            title: fallbackTitle,
            message: fallbackMessage,
            titleKey: 'events.employeeBirthdayReminder.title',
            messageKey: 'events.employeeBirthdayReminder.body',
            params,
            type: 'INFO' as any,
            eventType: NOTIF_EVENTS.EMPLOYEE_BIRTHDAY_REMINDER,
            channel: 'in_app',
            relatedEntity: yearTag,
            relatedEntityId: (emp as any).id,
            tenantId,
          },
        });
        created++;
      }
    }

    return { matchedEmployees: matched, created, deduped };
  }

  /** Today's date in CET shifted by LOOKAHEAD_DAYS, decomposed. */
  private cetDateInLookahead(): { year: number; month: number; day: number } {
    const now = new Date();
    const target = new Date(now.getTime() + LOOKAHEAD_DAYS * 24 * 60 * 60 * 1000);
    const fmt = new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Europe/Bratislava',
      year: 'numeric', month: '2-digit', day: '2-digit',
    });
    const parts = fmt.formatToParts(target);
    const get = (k: string) => Number(parts.find(p => p.type === k)?.value ?? '0');
    return { year: get('year'), month: get('month'), day: get('day') };
  }
}
