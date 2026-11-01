import { Module } from '@nestjs/common';
import { NotificationsService } from './notifications.service';
import { NotificationsController } from './notifications.controller';
import { NotificationsAdminController } from './notifications-admin.controller';
import { NotificationsSchedulerService } from './notifications-scheduler.service';
import { BirthdayNotificationCron } from './birthday-notification.cron';
import { DocumentDigestCron } from './document-digest.cron';
import { NotificationEmailWorker } from './notification-email-worker.service';
import { VersionWatcherService } from './version-watcher.service';
import { FeatureFlagsModule } from '../saas/feature-flags/feature-flags.module';
import { TenantPrismaService } from '../saas/prisma/tenant-prisma.service';
import { PilotPrismaAccessor } from '../saas/prisma/pilot-prisma.accessor';
import { EmailModule } from '../email/email.module';

/**
 * Phase 2.10 — fourth tenant-scoped TenantPrisma pilot.
 *
 * Imports the pilot dependencies for the read-facing service paths.
 * The scheduler + background notification-creation paths
 * (`checkExpiringCompliance`, `checkServiceDue`, `checkOverdue`,
 * `checkScheduledMaintenance`, `runAllChecks`, `notifyUploaderAndRoles`,
 * `notifyUsersByRoles`) are EXPLICITLY out of scope and continue to
 * run on `legacyPrisma`. See `SAAS_PHASE2_NOTIFICATIONS_SCOPE_SPLIT.md`.
 */
@Module({
  imports: [FeatureFlagsModule, EmailModule],
  controllers: [NotificationsController, NotificationsAdminController],
  providers: [
    NotificationsService,
    NotificationsSchedulerService,
    BirthdayNotificationCron,
    DocumentDigestCron,
    NotificationEmailWorker,
    VersionWatcherService,
    TenantPrismaService,
    PilotPrismaAccessor,
  ],
  exports: [NotificationsService, VersionWatcherService],
})
export class NotificationsModule {}
