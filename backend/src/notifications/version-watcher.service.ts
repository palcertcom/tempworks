import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { NotificationsService } from './notifications.service';
import { NOTIF_EVENTS } from './notification-events';

/**
 * Detects platform version changes between boots and broadcasts a
 * SYSTEM_VERSION_UPDATED notification to every active user the first
 * time a new build comes up. The previously-announced version is kept
 * in `system_settings` under `system.lastAnnouncedAppVersion`; the
 * announcement is idempotent — a restart on the same version is a no-op.
 *
 * On a clean install the first observed version is recorded silently
 * (no announcement) so a brand-new tenant doesn't get a confusing
 * "new version" ping on day zero.
 */
@Injectable()
export class VersionWatcherService implements OnModuleInit {
  private readonly logger = new Logger('VersionWatcher');
  private static readonly KEY = 'system.lastAnnouncedAppVersion';

  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
  ) {}

  async onModuleInit() {
    try {
      const current = this.currentVersion();
      if (!current) return;

      const row = await (this.prisma as any).systemSetting.findUnique({
        where: { key: VersionWatcherService.KEY },
        select: { value: true },
      });
      const previous: string | null = row?.value ?? null;

      if (previous === current) return;

      if (previous && previous !== current) {
        await this.announce(previous, current);
      }

      await (this.prisma as any).systemSetting.upsert({
        where:  { key: VersionWatcherService.KEY },
        update: { value: current },
        create: {
          key:         VersionWatcherService.KEY,
          value:       current,
          description: 'Last platform version that triggered a SYSTEM_VERSION_UPDATED broadcast.',
          category:    'system',
          isPublic:    false,
        },
      });
    } catch (err: any) {
      this.logger.error('Version watcher failed', err?.stack ?? err);
    }
  }

  /**
   * Manually trigger the version announcement to every active user.
   * Used by the admin endpoint; bypasses the previous-version dedup so
   * an admin can re-broadcast on demand.
   */
  async broadcast(opts: { tenantId?: string; message?: string; priority?: string } = {}) {
    const current = this.currentVersion() ?? 'unknown';
    return this.announce(null, current, opts);
  }

  private currentVersion(): string | null {
    try {
      const pkg = require('../../package.json'); // eslint-disable-line @typescript-eslint/no-var-requires
      return typeof pkg?.version === 'string' ? pkg.version : null;
    } catch {
      return null;
    }
  }

  private async announce(
    previous: string | null,
    current: string,
    opts: { tenantId?: string; message?: string; priority?: string } = {},
  ) {
    const title = `New version available — v${current}`;
    const body =
      opts.message?.trim() ||
      (previous
        ? `The platform has been upgraded from v${previous} to v${current}. Refresh your browser to load the latest build.`
        : `The platform is now running v${current}. Refresh your browser to load the latest build.`);

    await this.notifications.notifyAllUsers(
      opts.tenantId,
      NOTIF_EVENTS.SYSTEM_VERSION_UPDATED,
      title,
      body,
      'SYSTEM',
      current,
      {
        titleKey:   'events.systemVersionUpdated.title',
        messageKey: 'events.systemVersionUpdated.body',
        params:     { previousVersion: previous, currentVersion: current },
      },
      opts.priority || 'NORMAL',
    );
    this.logger.log(`Broadcast SYSTEM_VERSION_UPDATED ${previous ?? '∅'} → ${current}`);
  }
}
